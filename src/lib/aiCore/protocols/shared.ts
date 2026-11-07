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

/**
 * 错误文案是否明确指向**采样参数**（temperature / top_p / top_k / 通用参数不支持）（3.4.2 · D-1）
 *
 * 🔴 为什么不能复用 `shouldDegradeOn400()`：它把 "model" 当硬失败关键词，但推理系模型的原话是
 *    「Unsupported parameter: 'temperature' is not supported with this model.」—— 里面就有 "model"，
 *    照那条判据会被判成「配置写错了、别重试」，于是温度导致的 400 永远降不下来。
 *    所以这里**先排硬失败、再认采样关键词**，两条判据分开、各管一段。
 */
const SAMPLING_REJECTED_RE = /(temperature|top[ _]?p\b|top[ _]?k\b|\bsampling\b|unsupported[ _]parameter|unrecognized[ _]request[ _]argument|invalid[ _]parameter|not supported with this model|does(?: not|n't) support)/i

/** 与可选参数无关的硬失败（模型名 / 鉴权 / 额度 / 内容政策 / 上下文）—— 撤参数也救不回来 */
const HARD_CONFIG_FAIL_RE = /(model[ _]not[ _]found|does(?: not|n't) exist|no such model|invalid[ _]api[ _]?key|api[ _]?key|unauthor|forbidden|quota|balance|insufficient|content[ _]policy|context[ _]length|too many tokens)/i

/**
 * 这条 400 是不是「采样参数不被接受」？（3.4.2 · D-1，三家官方协议共用）
 *
 * 🔴 空响应体**不降级**：与 OpenAI 兼容通道的兼容性降级不同 —— 那边空 400 常是老中转站的怪癖，
 *    这三家走的是官方字段，空错误体更可能是别的问题，撤采样只是白花一次钱。
 */
export function shouldDegradeSamplingOn400(errorText: string): boolean {
  const t = errorText.trim()
  if (!t) return false
  if (HARD_CONFIG_FAIL_RE.test(t)) return false
  return SAMPLING_REJECTED_RE.test(t)
}

/**
 * 官方协议（Anthropic / Gemini / Responses）的可选参数开关（3.4.2 · D-1）。
 *
 * 与 OpenAI 兼容通道的区别：这三家本版只下发 `temperature`（＋可选结构字段），没有思考开关，
 * 所以是两档：`format`（结构输出字段）、`sampling`（采样参数）。
 */
export interface WireFlags {
  /** 是否随请求下发结构输出字段 */
  format: boolean
  /** 是否随请求下发采样参数（temperature） */
  sampling: boolean
}

/** 初始开关：结构字段只在调用方确实要、且驱动能落成时才算「开着」 */
export function initialWireFlags(canFormat: boolean): WireFlags {
  return { format: canFormat, sampling: true }
}

/** 错误文案是否明确指向结构输出字段 */
export function isFormatRejected(errorText: string): boolean {
  return FORMAT_REJECTED_RE.test(errorText)
}

/**
 * 下一级请求参数；`null` ＝ 已无可撤的可选参数，别再发。
 *
 * 顺序固定：先撤被**明确点名**的结构字段 → 再撤采样 → 最后才在「说不清是什么」的 400 上撤结构字段。
 * 🔴 每轮只撤一档，且调用方必须把 `attempts` 记进 `MAX_REQUESTS_PER_CALL` 的同一本账。
 */
export function nextWireFlags(f: WireFlags, errorText: string): WireFlags | null {
  if (f.format && isFormatRejected(errorText)) return { ...f, format: false }
  if (f.sampling && shouldDegradeSamplingOn400(errorText)) return { ...f, sampling: false }
  if (f.format && shouldDegradeOn400(errorText)) return { ...f, format: false }
  return null
}

/**
 * 「流式解析不出内容 → 非流式重试一次」的预算文案（三家共用）。
 * 🔴 必须把**已发出的请求次数**写出来：否则作者以为只试了一次，实际付了三次钱、等了三个超时。
 */
export function budgetExhaustedMessage(label: string, attempts: number): string {
  return `${label} 没有返回可用内容，且本次调用已发出 ${attempts} 次请求（上限 ${MAX_REQUESTS_PER_CALL}）：`
    + '已停止重试。请确认接口地址与模型名是否匹配该服务商的文档。'
}

/** 下一级请求参数；`null` ＝ 已无可撤的可选参数 */
export function nextOpenAIFlags(f: OpenAIFlags, errorText: string): OpenAIFlags | null {
  if (f.format && FORMAT_REJECTED_RE.test(errorText)) return { ...f, format: false }
  if (f.thinkToggle) return { ...f, thinkToggle: false }
  if (f.sampling) return { ...f, sampling: false, ...(f.format ? { format: false } : {}) }
  if (f.format) return { ...f, format: false }
  return null
}