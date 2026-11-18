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
