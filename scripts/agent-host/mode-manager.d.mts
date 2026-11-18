// scripts/agent-host/mode-manager.mjs 的类型声明（只覆盖测试用到的面）。
//
// 🔴 为什么需要：`modeAuthority` 删除后，模式切换状态机的**唯一真源**就是这支宿主脚本；
//    单测要用假 store 穷举「成功 / 切换中重复 / blocked 需先恢复 / 回读不匹配」四条语义，
//    而 .mjs 没有类型信息会让 tsc 直接报 TS7016。
export type ModeName = 'api' | 'agent' | 'acp'

export interface ModeStoreLike {
  hasPending(): Promise<boolean>
  markPending(value: unknown): Promise<void>
  readPending(): Promise<unknown>
  clearPending(): Promise<void>
  read(): Promise<unknown>
  initialize(mode: ModeName): Promise<void>
  initializeApi(): Promise<void>
  write(value: unknown): Promise<void>
}

export type ModeSnapshotLike =
  | { phase: 'stable'; mode: ModeName; busy: boolean; active: Record<ModeName, number> }
  | { phase: 'switching'; from: ModeName; to: ModeName; transitionId: string; busy: boolean; active: Record<ModeName, number> }
  | { phase: 'blocked'; reason: string; busy: boolean; active: Record<ModeName, number> }

export interface ModeManagerLike {
  snapshot(): ModeSnapshotLike
  acquire(mode: ModeName, owner: string): string
  release(id: string, owner: string): boolean
  canCancel(id: string): boolean
  block(reason: string): void
  switchTo(
    to: ModeName,
    transitionId: string,
    // prepare 的返回值只有「是函数」时才当作提交动作，其余返回值一律忽略（宿主实现如此）
    prepare: (from: ModeName) => Promise<unknown>,
    signal?: AbortSignal,
    reconfigure?: boolean,
  ): Promise<ModeSnapshotLike>
}

export function createModeManager(
  store: ModeStoreLike,
  initialMode: ModeName | undefined,
  supportedModes: ModeName[],
  verifyQuiescent: () => Promise<void>,
): Promise<ModeManagerLike>
