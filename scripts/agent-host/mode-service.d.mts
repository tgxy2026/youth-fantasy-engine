// scripts/agent-host/mode-service.mjs 的类型声明（只覆盖测试 / 宿主接线用到的面）。
export type ConnectionModeName = 'api' | 'agent' | 'acp'

export interface ModeFileRecoveryOptions {
  dataDir: string
  confirm?: boolean
  confirmPid?: number | null
}

export interface ModeFileRecoveryResult {
  modeFile: string
  lockFile: string
}

export function recoverConnectionFiles(options: ModeFileRecoveryOptions): Promise<ModeFileRecoveryResult>

export interface ModeStatusLike {
  phase: 'stable' | 'switching' | 'blocked'
  mode: ConnectionModeName | null
  reason: string
  busy: boolean
  active: Record<ConnectionModeName, number>
  supportedModes: ConnectionModeName[]
  ownsLock: boolean
  lock: { pid: number | null; corrupt: boolean; alive: boolean | null } | null
  canRecover: boolean
  agent: Record<string, unknown> | null
}

export interface ModeServiceLike {
  status(): Promise<ModeStatusLike>
  acquire(mode: ConnectionModeName, owner: string): string
  release(id: string, owner: string): boolean
  setAgentConfig(patch: { enabled?: boolean; scope?: unknown }): Record<string, unknown>
  switchTo(to: ConnectionModeName, transitionId: string, signal?: AbortSignal): Promise<ModeStatusLike>
  canCancelSwitch(id: string): boolean
  switchAcpAgent(id: string, prepare: () => Promise<() => Promise<void>>, signal?: AbortSignal): Promise<ModeStatusLike>
  recover(options?: { confirm?: boolean; confirmPid?: number | null }): Promise<ModeStatusLike>
  close(): Promise<void>
}

export function createModeService(options: {
  dataDir: string
  callPage: (payload: unknown) => Promise<unknown>
  clientCount?: () => number
  acp?: { stop(): Promise<void>; verifyQuiescent(): Promise<void> }
  callReadonly?: (body: unknown, scope: { projects: { projectId: string }[] }) => unknown
}): Promise<ModeServiceLike>
