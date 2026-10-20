/**
 * 3.2.0 · WQ7：从两条通道的响应里**提取真实 token 用量**
 *
 * 背景（MQ0 §16.8 第 77 行原文）：
 *   > usage 真实性：`aiCore/chat.ts` 成功上报未提取真实 token
 * 也就是说统计页此前的 token 是空的，只能按耗时猜。本文件只做一件事：
 * 把"哪种响应里哪个字段是真实用量"这件事**收成一处**，两条通道共用。
 *
 * 🔴 只认协议里**明确是 token 计数**的字段，不靠字符数反推：
 *   · Ollama：`prompt_eval_count` / `eval_count`（流式在 `done:true` 的那一块里）
 *   · OpenAI 兼容：`usage.prompt_tokens` / `usage.completion_tokens`
 * 拿不到就返回 `{}` —— 由调用方决定"退回估算并标注"，绝不在这里编一个数出来。
 */

export interface RealUsage {
  promptTokens?: number
  completionTokens?: number
  /** 结束原因（`stop` / `length` / `content_filter`…），有就带回去 */
  finishReason?: string
  /**
   * 这次**逻辑调用**实际发了几次请求（3.2.0 · WQ6）。
   * 🔴 只在 >1 时写：流式解析失败后降级非流式重试 = 2。方案 §16.7 要求"重试次数可核对"。
   */
  attempts?: number
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined
}

/** Ollama `/api/chat` 的一次**完整**响应体（非流式，或流式的最后一块） */
export function usageFromOllama(data: unknown): RealUsage {
  if (!data || typeof data !== 'object') return {}
  const d = data as Record<string, unknown>
  const promptTokens = num(d.prompt_eval_count)
  const completionTokens = num(d.eval_count)
  const doneReason = typeof d.done_reason === 'string' && d.done_reason ? d.done_reason : undefined
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(doneReason ? { finishReason: doneReason } : {}),
  }
}

/** OpenAI 兼容 `/chat/completions` 的一次响应体 */
export function usageFromOpenAI(data: unknown): RealUsage {
  if (!data || typeof data !== 'object') return {}
  const d = data as Record<string, unknown>
  const u = (d.usage ?? null) as Record<string, unknown> | null
  const promptTokens = num(u?.prompt_tokens)
  const completionTokens = num(u?.completion_tokens)
  const fr = (d.choices as { finish_reason?: unknown }[] | undefined)?.[0]?.finish_reason
  const finishReason = typeof fr === 'string' && fr ? fr : undefined
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(finishReason ? { finishReason } : {}),
  }
}

/**
 * 流式块里的用量。
 *
 * 🔴 Ollama 在 `done:true` 的收尾块里带计数；OpenAI 兼容端点**只有在请求里要求**
 *    `stream_options.include_usage` 时才会在最后一块带 `usage`。我们**不主动加那个字段**
 *    （中转站对未知字段很敏感，400 一次就是整轮失败），所以这里只做"有就收"。
 */
export function usageFromStreamChunk(obj: unknown, channel: 'ollama' | 'openai'): RealUsage {
  if (!obj || typeof obj !== 'object') return {}
  return channel === 'ollama' ? usageFromOllama(obj) : usageFromOpenAI(obj)
}

/** 合并多次提取的结果（后到的非空值覆盖先前的） */
export function mergeUsage(a: RealUsage, b: RealUsage): RealUsage {
  const promptTokens = b.promptTokens ?? a.promptTokens
  const completionTokens = b.completionTokens ?? a.completionTokens
  const finishReason = b.finishReason ?? a.finishReason
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(finishReason ? { finishReason } : {}),
  }
}

/** 是否有任何一项真实用量（没有就该退回估算并标注） */
export function hasRealUsage(u: RealUsage | undefined): boolean {
  return u != null && (u.promptTokens !== undefined || u.completionTokens !== undefined)
}
