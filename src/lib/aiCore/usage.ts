/**
 * 3.0 · W1-4 AI 消耗统计 —— 调用用量上报总线（**叶子模块，零依赖**）
 *
 * 🔴 为什么单独成文件：`aiCore`（底层）不该反向依赖账本 / 存储层。这里只做一个**极简总线** ——
 *    底层 `chat()` 把每次调用的「模型 / 耗时 / tokens / finish_reason」上报，
 *    由上层（运行账本 `aiRunLedger`）决定怎么存。没有订阅者时零开销（只判一个 null）。
 *
 * 🔴 统计失败**绝不打断 AI 调用**（`reportUsage` 内 try/catch 吞掉）—— 统计是旁路。
 */

export interface ChatUsage {
  /** 模型名（provider 配置里的 model） */
  model: string
  /** 本次调用耗时（毫秒） */
  ms: number
  promptTokens?: number
  completionTokens?: number
  /**
   * 这次上报的 token 是**估算值**（3.2.0 · WQ7）。
   * 🔴 厂商返回真实 usage 时为 undefined/false；只有拿不到时才置 true。
   *    统计页必须能区分两者 —— 否则估算值会被当成账单依据。
   */
  tokensEstimated?: boolean
  /** 结束原因（stop / length / content_filter…） */
  finishReason?: string
  /** 来源通道 */
  source: 'openai' | 'ollama'
  at: number
}

export type UsageSink = (u: ChatUsage) => void

let sink: UsageSink | null = null

/** 订阅用量（传 null 取消）—— 由上层在任务开始时挂上、结束时摘掉 */
export function setUsageSink(fn: UsageSink | null): void {
  sink = fn
}

/** 上报一次调用用量（底层调；无订阅者时静默） */
export function reportUsage(u: ChatUsage): void {
  try { sink?.(u) } catch { /* 统计是旁路，绝不打断调用 */ }
}
