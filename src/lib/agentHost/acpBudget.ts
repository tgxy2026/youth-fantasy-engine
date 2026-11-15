/**
 * 3.5.6 · 渲染层读取 ACP 上下文预算
 *
 * 预算由运行层按「Agent + 实际模型」解析（`scripts/agent-host/acp-budget.mjs`），
 * 这里只做两件事：短 TTL 缓存、把「未知」如实返回为 `null`。
 *
 * 🔴 为什么必须缓存：酒馆一轮会连发多次子调用，每次都 `status()` 会反复读设置文件、
 *    探测隔离账户；1.5 秒 TTL 与 `tavernAcpSnapshot` 同口径，足够让同一轮复用结果。
 * 🔴 为什么未知返回 `null` 而不是 32K：调用方需要区分「已知窗口」与「保守兜底」——
 *    把兜底值当真实容量传下去，界面就会把 32K 说成模型的窗口。
 */
export interface AcpBudgetInfo {
  agentId: string | null
  agentName: string
  model: string | null
  modelLabel: string
  configured: { window: string; send: string; output: string }
  /** 手填或会话回报的窗口；都没有时为 null（未知） */
  windowTokens: number | null
  windowSource: 'user' | 'adapter' | 'unknown'
  /** 本次实际使用的窗口（未知时为保守兜底），仅供界面展示额度 */
  effectiveWindow: number
  fallbackWindow: number
  sendBudgetTokens: number
  sendBudgetSource: 'user' | 'auto'
  outputReserveTokens: number
  outputReserveSource: 'user' | 'auto'
  safetyMarginTokens: number
  inputAllowanceTokens: number
  fallbackUsed: boolean
  notice: string
}

interface AcpBudgetStatus {
  budget?: AcpBudgetInfo | null
}

interface AcpBudgetBridge {
  status(): Promise<AcpBudgetStatus | null>
}

const TTL_MS = 1500
let cached: { at: number; promise: Promise<AcpBudgetInfo | null> } | null = null

function bridge(): AcpBudgetBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { electronAcp?: AcpBudgetBridge }).electronAcp
}

/** 当前 Agent + 实际模型的预算；非桌面 / 非 ACP / 读取失败均返回 null。 */
export function acpBudgetSnapshot(): Promise<AcpBudgetInfo | null> {
  const api = bridge()
  if (!api) return Promise.resolve(null)
  const now = Date.now()
  if (cached && now - cached.at < TTL_MS) return cached.promise
  const promise = api.status()
    .then(status => status?.budget ?? null)
    .catch(() => null)
  cached = { at: now, promise }
  return promise
}

/** 已知窗口（手填/会话回报）；未知返回 null，调用方自行决定是否用保守兜底。 */
export async function acpKnownWindow(): Promise<number | null> {
  const budget = await acpBudgetSnapshot()
  return budget?.windowTokens ?? null
}

/** 仅测试用：清掉 TTL 缓存。 */
export function __resetAcpBudgetCache(): void {
  cached = null
}
