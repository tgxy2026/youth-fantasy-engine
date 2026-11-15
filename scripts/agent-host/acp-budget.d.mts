/** 运行层 ACP 预算模块（纯逻辑）的测试用类型声明。 */
export const ACP_FALLBACK_WINDOW: number
export const MIN_ACP_BUDGET_WINDOW: number
export const MAX_ACP_BUDGET_WINDOW: number
export const DEFAULT_ACP_OUTPUT_RESERVE: number
export const ACP_BUDGET_FIELDS: string[]
export function parseBudgetNumber(value: unknown): number | null
export function budgetFieldError(key: string, value: string): string | null
export function readAdapterWindow(sessionOptions: unknown): number | null
export interface AcpBudget {
  agentId: string | null
  agentName: string
  model: string | null
  modelLabel: string
  configured: { window: string; send: string; output: string }
  windowTokens: number | null
  windowSource: 'user' | 'adapter' | 'unknown'
  effectiveWindow: number
  fallbackWindow: number
  sendBudgetTokens: number
  sendBudgetSource: 'user' | 'auto'
  outputReserveTokens: number
  outputReserveSource: 'user' | 'auto'
  safetyMarginTokens: number
  /** 运行层单次请求字节上限折算的 token 上限 */
  runtimeTokenCeiling: number
  /** 是否因为运行层字节上限（而不是窗口）被收敛 */
  sendClampedByRuntime: boolean
  inputAllowanceTokens: number
  fallbackUsed: boolean
  notice: string
}
export function resolveAcpBudget(input?: {
  agentId?: string | null
  agentName?: string
  model?: string | null
  modelLabel?: string
  config?: Record<string, unknown>
  sessionOptions?: unknown
}): AcpBudget
