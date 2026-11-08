// scripts/agent-host/core.mjs 的类型声明（只覆盖测试 / 构建脚本用到的面）。
export const HOST_FILE_NAME: string
export const LEDGER_FILE_NAME: string
export const HOST_VERSION: number
export const PAGE_HEADER: string
export const ACTIONS: string[]

export interface AgentScopeLike {
  projects: { projectId: string; actions: string[] }[]
}

export function emptyScope(): AgentScopeLike
export function normalizeScope(raw: unknown): AgentScopeLike
export function actionAllowed(scope: AgentScopeLike, projectId: string, action: string): boolean

export interface HostConfigLike {
  version: number
  enabled: boolean
  scope: AgentScopeLike
  port: number
  token: string
  updatedAt: number
}
export function loadConfig(file: string): HostConfigLike
export function saveConfig(file: string, config: HostConfigLike): HostConfigLike

export interface RequestRecordLike {
  requestId: string
  tool: string
  projectId: string
  state: 'pending' | 'success' | 'failed' | 'unknown'
  code?: string
  error?: string
  result?: unknown
  createdAt: number
  updatedAt: number
}

export interface LedgerLike {
  get(requestId: string): RequestRecordLike | null
  list(): RequestRecordLike[]
  begin(requestId: string, meta: { tool?: string; projectId?: string; sessionId?: string; args?: unknown }): { kind: 'replay' | 'unknown' | 'in-flight' | 'started' | 'conflict'; record?: RequestRecordLike }
  finish(requestId: string, result: unknown): void
  markUnknown(requestId: string, error: unknown): void
}
export function createLedger(file: string): LedgerLike

export interface PageQueueLike {
  clients: Map<string, number>
  push(payload: unknown): Promise<unknown>
  next(clientId: string): { id: string; payload: unknown } | null
  settle(id: string, clientId: string, result: unknown): boolean
  size(): number
}
export function createPageQueue(options?: { timeoutMs?: number }): PageQueueLike

export interface AgentHostLike {
  status(): Record<string, unknown>
  setConfig(patch: { enabled?: boolean; scope?: unknown }): Record<string, unknown>
  ledger: LedgerLike
  configFile: string
  start(): Promise<number>
  stop(): Promise<void>
}
export function createAgentHost(options: {
  configFile: string
  callPage: (payload: unknown) => Promise<unknown>
  clientCount?: () => number
}): AgentHostLike

export function isLocalHost(req: { headers: Record<string, string | string[] | undefined> }): boolean
export function sameOriginPage(req: { headers: Record<string, string | string[] | undefined> }): boolean
export function readBody(req: unknown, limit?: number): Promise<string>
export function sendJson(res: unknown, code: number, obj: unknown, extra?: Record<string, string>): void
