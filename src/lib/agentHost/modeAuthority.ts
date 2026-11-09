import { createModeCoordinator, parsePersistedMode, type ConnectionMode, type ModeState } from './modeTransition'

/** 持久层由唯一宿主提供；此接口本身不提供跨进程原子锁。 */
export interface ModePersistence {
  read(): Promise<unknown>
  write(value: unknown): Promise<void>
}

/** 模式授权原型：持久化切换中状态，崩溃后重新读取时失败关闭。 */
export async function createModeAuthority(storage: ModePersistence) {
  let initial: ModeState
  try { initial = parsePersistedMode(await storage.read()) }
  catch { initial = { phase: 'blocked', reason: '无法读取模式状态' } }
  let coordinator = createModeCoordinator(initial)
  let busy = false
  return {
    snapshot: () => coordinator.snapshot(),
    acquire: (mode: ConnectionMode) => coordinator.acquire(mode),
    async switchTo(to: ConnectionMode, transitionId: string, prepare: () => Promise<boolean>, signal?: AbortSignal) {
      if (busy) throw new Error('模式切换正在进行')
      busy = true
      try {
        const previous = coordinator.snapshot().state
        if (previous.phase !== 'stable') throw new Error('模式状态不可用，需先恢复')
        if (previous.mode === to) return previous
        const switching = coordinator.begin(to, transitionId)
        try {
          await storage.write({ version: 1, ...switching })
          const written = await storage.read()
          if (!written || typeof written !== 'object' || Array.isArray(written)
            || (written as Record<string, unknown>).version !== 1
            || (written as Record<string, unknown>).phase !== 'switching'
            || (written as Record<string, unknown>).transitionId !== transitionId
            || (written as Record<string, unknown>).from !== previous.mode
            || (written as Record<string, unknown>).to !== to) throw new Error('切换记录未能确认')
          await coordinator.waitForDrain(signal)
          if (signal?.aborted) throw new Error('模式切换已取消')
          if (!await prepare()) throw new Error('目标模式未就绪')
          if (signal?.aborted) throw new Error('模式切换已取消')
          await storage.write({ version: 1, phase: 'stable', mode: to })
          const confirmed = parsePersistedMode(await storage.read())
          if (confirmed.phase !== 'stable' || confirmed.mode !== to) throw new Error('持久化回读不匹配')
          return coordinator.finish(transitionId, { targetReady: true, persisted: true })
        } catch (error) {
          coordinator = createModeCoordinator({ phase: 'blocked', reason: '切换未确认完成' })
          throw error
        }
      } finally { busy = false }
    },
  }
}

/**
 * 将一次完整任务纳入模式租约；流式任务应在响应体结束或取消后才返回，
 * 不能只包住 fetch 返回 Response 的阶段。跨进程任务须由唯一宿主持有租约。
 */
export async function withModeLease<T>(authority: { acquire(mode: ConnectionMode): (() => void) | null }, mode: ConnectionMode, work: () => Promise<T>): Promise<T> {
  const release = authority.acquire(mode)
  if (!release) throw new Error('当前连接模式不允许启动此任务')
  try { return await work() }
  finally { release() }
}
