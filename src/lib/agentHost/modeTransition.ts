/** 互斥模式切换的纯状态机；本模块本身不控制进程、网络或持久化。 */
export type ConnectionMode = 'api' | 'agent'
export type ModeState =
  | { phase: 'stable'; mode: ConnectionMode }
  | { phase: 'switching'; from: ConnectionMode; to: ConnectionMode; transitionId: string }
  | { phase: 'blocked'; reason: string }

/** 严格解析持久化状态；缺失由调用方明确迁移，损坏或未知版本不能默认放行。 */
export function parsePersistedMode(raw: unknown): ModeState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { phase: 'blocked', reason: '模式状态缺失或损坏' }
  const record = raw as Record<string, unknown>
  if (record.version !== 1) return { phase: 'blocked', reason: '模式状态版本未知' }
  if (record.phase === 'stable' && (record.mode === 'api' || record.mode === 'agent')) return { phase: 'stable', mode: record.mode }
  // 进程崩溃后的切换是否完成无法从记录推断，需要显式恢复。
  return { phase: 'blocked', reason: '模式切换未完成或状态无效' }
}

export function canStartModeWork(state: ModeState, mode: ConnectionMode): boolean {
  return (mode === 'api' || mode === 'agent') && state.phase === 'stable' && state.mode === mode
}

/** 切换中禁止两侧新任务；未完成迁移或遇到错误时不能猜测稳定模式。 */
export function beginModeTransition(state: ModeState, to: ConnectionMode, transitionId: string): ModeState {
  if (state.phase !== 'stable') throw new Error('已有模式切换或模式状态不可用')
  if (to !== 'api' && to !== 'agent') throw new Error('未知目标模式')
  if (typeof transitionId !== 'string' || !transitionId.trim() || transitionId.length > 200) throw new Error('切换标识无效')
  if (state.mode === to) return state
  return { phase: 'switching', from: state.mode, to, transitionId }
}

export function finishModeTransition(state: ModeState, transitionId: string, proof: { previousDrained: boolean; targetReady: boolean; persisted: boolean }): ModeState {
  if (state.phase !== 'switching' || state.transitionId !== transitionId) throw new Error('模式切换标识不匹配')
  if (!proof.previousDrained || !proof.targetReady || !proof.persisted) return { phase: 'blocked', reason: '模式切换未确认完成，需要恢复或重试' }
  return { phase: 'stable', mode: state.to }
}

/** 单进程协调器：只负责计数，不是跨进程锁或持久化真源。 */
export function createModeCoordinator(initial: ModeState) {
  let state = { ...initial }
  const active: Record<ConnectionMode, number> = { api: 0, agent: 0 }
  const drainWaiters = new Set<() => void>()
  return {
    snapshot: () => ({ state: { ...state }, active: { ...active } }),
    acquire(mode: ConnectionMode): (() => void) | null {
      if (!canStartModeWork(state, mode)) return null
      active[mode]++
      let released = false
      return () => {
        if (released) return
        released = true
        active[mode]--
        if (!active.api && !active.agent) for (const wake of [...drainWaiters]) wake()
      }
    },
    waitForDrain(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return Promise.reject(new Error('等待在途任务已取消'))
      if (!active.api && !active.agent) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const cleanup = () => { drainWaiters.delete(wake); signal?.removeEventListener('abort', abort) }
        const wake = () => { cleanup(); resolve() }
        const abort = () => { cleanup(); reject(new Error('等待在途任务已取消')) }
        drainWaiters.add(wake)
        signal?.addEventListener('abort', abort, { once: true })
      })
    },
    begin(to: ConnectionMode, transitionId: string) {
      state = beginModeTransition(state, to, transitionId)
      return { ...state }
    },
    finish(transitionId: string, proof: { targetReady: boolean; persisted: boolean }) {
      if (state.phase !== 'switching' || state.transitionId !== transitionId) throw new Error('模式切换标识不匹配')
      if (active.api || active.agent) throw new Error('仍有在途任务，不能完成模式切换')
      state = finishModeTransition(state, transitionId, { previousDrained: true, ...proof })
      return { ...state }
    },
  }
}
