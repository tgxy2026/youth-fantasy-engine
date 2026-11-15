/** ACP 运行层的测试用类型声明（只声明测试与调用方实际使用的入口）。 */
export interface AcpRuntimeBudget {
  agentId: string | null
  windowTokens: number | null
  windowSource: 'user' | 'adapter' | 'unknown'
  effectiveWindow: number
  sendBudgetTokens: number
  outputReserveTokens: number
  fallbackUsed: boolean
}
export interface AcpRuntimeStatus {
  adapters: { id: string; name: string; available: boolean; componentVersion: string | null }[]
  selected: string | null
  generation: string
  options?: unknown
  ready?: boolean
  runAs?: 'current-user' | 'isolated' | null
  budget?: AcpRuntimeBudget | null
}
export interface AcpRuntime {
  status(): Promise<AcpRuntimeStatus>
  configure(service: unknown, patch: Record<string, string>): Promise<void>
  configureBudget(patch: Record<string, string>): Promise<void>
  verifyQuiescent(): Promise<void>
  generate(input: {
    service: unknown
    owner: unknown
    id: string
    text: string
    expectedGeneration: string
    reuseKey?: string
    onChunk?: (delta: string) => void
  }): Promise<string>
}
export function createAcpRuntime(options: {
  root: string
  adapters: { id: string; name: string }[]
  appVersion?: string
}): AcpRuntime
