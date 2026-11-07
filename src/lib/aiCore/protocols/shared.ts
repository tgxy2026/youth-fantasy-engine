/**
 * 3.4.2 · 协议 driver 共用工具
 *
 * 从 `aiCore/chat.ts` 平移而来（3.2.0 · WQ5/WQ6）：采样白名单、400 降级判据、
 * 请求参数三级开关。Ollama 与 OpenAI 兼容两条通道都用它，**判据逐字保留**。
 */

import type { DriverCallOpts } from '@/lib/aiCore/protocols/contract'

/**
 * OpenAI 兼容端点能安全接受的采样参数白名单。
 * 故意**不含** top_k / repeat_penalty / num_ctx —— 那是 Ollama 专有字段，
 * 发过去轻则被忽略、重则整条请求 400。
 */
export const OPENAI_SAFE_SAMPLING = ['top_p', 'presence_penalty', 'frequency_penalty'] as const

/**
 * 「混合思考」模型（Qwen3 系）在 OpenAI 兼容端点上的关思考字段。
 *
 * 🔴 为什么必须处理（2026-09-18 对照实验，硅基流动 `Qwen/Qwen3.5-35B-A3B`，同一 prompt 连跑）：
 *    · 思考**开**：50.5s，thinking 12687 字，**content 只剩 271 字且被截断** → JSON 必残
 *      （另一次更极端：216.8s、content 0 字、completion_tokens 0）
 *    · 思考**关**：14.9s，content 3298 字，JSON 直接可解析
 *    即：思考**吃光输出预算**、且思考内容不进 `delta.content`。表现出来就是
 *    「AI 生成静默失败 / 极慢 / 结构残缺」，极难排查 —— 所以这里不是偏好，是可用性问题。
 *
 * 只在**非本地**且模型名匹配时下发：
 *   · 本地 Ollama 走的是 `think` 字段，且项目**刻意保留思考**（利于深度设定补全），不在此处干预；
 *   · 其它云端端点不认这个字段，乱发会 400 —— 故另有「400 就退回重试」的兜底。
 * 调用方仍可用 `think:true` 显式要求保留思考（逃生口）。
 */
export const HYBRID_THINKING_RE = /(^|[/_\-. ])(qwen3|qwen-3|qwq)/i

/**
 * 一次**逻辑调用**最多允许几次实际请求（3.2.0 · WQ6）。
 *
 * 方案 §16.7：「每次逻辑调用默认最多两次实际请求；已登记的旧接口三级参数兼容路径
 * 允许上限三次，并在同一尝试预算内计数，**不能三级降级之后再额外乘两轮网络重试**」。
 *
 * 现状：full → noToggle → bare 已经是三级；「流式解析失败 → 非流式重试」是第四条。
 * 所以这里给出硬上限，第 4 条必须被拦住 —— 否则一个坏端点能被我们打 4 次，
 * 作者付 4 次钱、等 4 轮超时，还以为只试了一次。
 */
export const MAX_REQUESTS_PER_CALL = 3

/** 从显式额外参数里挑出 OpenAI 兼容端点认的白名单键 */
export function openaiSampling(o: DriverCallOpts): Record<string, number> {
  const src = o.extraOptions
  if (!src) return {}
  const out: Record<string, number> = {}
  for (const k of OPENAI_SAFE_SAMPLING) {
    if (typeof src[k] === 'number' && Number.isFinite(src[k])) out[k] = src[k]
  }
  return out
}

/**
 * 这条 400 该不该「降级重试」？（3.2.0 · WQ5）
 *
 * 🔴 方案 §16.6：「参数不支持时仅移除被明确拒绝的可选参数；**不把所有 400 都重试成裸请求**」。
 *    旧实现无条件降级 —— 模型名写错、密钥失效、messages 结构不对时都会白发一轮，
 *    还把真正的错误信息换成第三轮的结果（作者看到的原因全是错的）。
 *
 * 判据：错误文案**指向与本请求可选参数无关**的东西（模型/消息/鉴权/额度/内容政策）⇒ 不降级；
 *      其余（含空响应体，老中转站常见）⇒ 仍降级 —— 兼容性优先，但不再无脑。
 */
export function shouldDegradeOn400(errorText: string): boolean {
  const t = errorText.trim()
  if (!t) return true
  return !/(model|messages|api[-_ ]?key|unauthor|forbidden|auth|quota|balance|content[_ ]?policy|context length)/i.test(t)
}

/**
 * OpenAI 兼容请求的可选参数开关（3.2.0 · WQ5）。
 * 🔴 每降一级只关掉**一个**可选参数：先撤被明确点名的格式，再撤思考开关，最后撤采样。
 */
export interface OpenAIFlags {
  thinkToggle: boolean
  sampling: boolean
  format: boolean
}

/** 错误文案是否明确指向结构格式参数（response_format / json_schema） */
const FORMAT_REJECTED_RE = /(response[_ ]?format|json[_ ]?schema|structured[_ ]?output|\bformat\b)/i

/** 下一级请求参数；`null` ＝ 已无可撤的可选参数 */
export function nextOpenAIFlags(f: OpenAIFlags, errorText: string): OpenAIFlags | null {
  if (f.format && FORMAT_REJECTED_RE.test(errorText)) return { ...f, format: false }
  if (f.thinkToggle) return { ...f, thinkToggle: false }
  if (f.sampling) return { ...f, sampling: false, ...(f.format ? { format: false } : {}) }
  if (f.format) return { ...f, format: false }
  return null
}