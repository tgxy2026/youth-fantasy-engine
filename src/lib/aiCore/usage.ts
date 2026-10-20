/**
 * 3.0 · W1-4 AI 消耗统计 —— 调用用量上报总线（**叶子模块，零依赖**）
 *
 * 🔴 为什么单独成文件：`aiCore`（底层）不该反向依赖账本 / 存储层。这里只做一个**极简总线** ——
 *    底层 `chat()` 把每次调用的「模型 / 耗时 / tokens / finish_reason」上报，
 *    由上层（运行账本 `aiRunLedger`）决定怎么存。没有订阅者时零开销（只判一个 null）。
 *
 * 🔴 统计失败**绝不打断 AI 调用**（`reportUsage` 内 try/catch 吞掉）—— 统计是旁路。
 */

// 3.2.0 · WQ7：请求上下文（显式归属）。**纯类型导入**，运行时零依赖 ——
// `ai/callTracking` 本身不 import 任何东西，所以这里不构成 aiCore → ai 的环。
import type { CallRequestContext } from '@/lib/ai/callTracking'

export interface ChatUsage {
  /** 模型名（provider 配置里的 model） */
  model: string
  /** 本次调用耗时（毫秒） */
  ms: number
  /**
   * 本次调用的请求上下文（3.2.0 · WQ7）。
   * 🔴 账本按 `request.taskId` 精确归属；缺它就只能走\"唯一任务\"兼容路径，
   *    多任务并行时会如实判为未归属（不再塞给最近创建的那个任务）。
   */
  request?: CallRequestContext
  promptTokens?: number
  completionTokens?: number
  /**
   * 这次上报的 token 是**估算值**（3.2.0 · WQ7）。
   * 🔴 厂商返回真实 usage 时为 undefined/false；只有拿不到时才置 true。
   *    统计页必须能区分两者 —— 否则估算值会被当成账单依据。
   */
  tokensEstimated?: boolean
  /**
   * 首字耗时（毫秒，流式才有）：从发请求到第一个增量到达。
   * 🔴 这是作者最直观的"卡不卡"指标 —— 总耗时 30s 里如果是 25s 才出首字，体感和"20s 出字 + 10s 输出"完全不同。
   */
  firstByteMs?: number
  /**
   * 本次请求的输出协议与实际降级（3.2.0 · WQ5）。
   * 🔴 降级必须随**这次调用**一起留档（方案 §16.6 末条）：事后按全局状态回看，
   *    看不出「当时是哪个端点降了什么」。
   */
  protocol?: {
    output: string
    reasoning: string
    /** 与声明不一致的地方（空/缺省＝声明被完整满足） */
    limitations?: string[]
  }
  /** 本次逻辑调用实际发了几次请求（>1 才写：如流式失败→非流式重试） */
  attempts?: number
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
