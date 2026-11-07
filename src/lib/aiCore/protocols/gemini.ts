/**
 * 3.4.2 · Google Gemini generateContent 协议 driver
 *
 * 与 OpenAI 兼容通道的关键差异：
 *   ① 助手角色叫 **`model`**，不是 `assistant`；系统提示在顶层 **`systemInstruction`**；
 *   ② 流式走**独立端点** `:streamGenerateContent?alt=sse`，且**没有结束哨兵**（靠连接关闭）；
 *   ③ 鉴权用 `x-goog-api-key`（也支持 query `key=`，这里只用头，避免密钥进 URL）。
 *
 * 🔴 结构化输出：本版不向厂商下发 `generationConfig.responseMimeType`（未经当期官方文档取证），
 *    `structuredWire=false`，由 `chat()` 降级为提示词约束并如实记录。
 */

import type { AIProvider, ChatMessage } from '@/lib/aiCore/core'
import {
  fetchWithTimeout, readSSE, secs, stripSlash, stripThink, isAbortError, isCancelled,
  AICancelled, isStreamStalled, STREAM_IDLE_TIMEOUT_MS, AIStreamStalledError,
  describeApiError, AIRefusalError, type SseLineOutcome, type StreamReport,
} from '@/lib/aiCore/transport'
import { mergeHeaders } from '@/lib/aiCore/headers'
import { mergeUsage, usageFromGemini, type RealUsage } from '@/lib/aiCore/usageParse'
import { defineDriver, type ChatDriver, type DriverCallOpts, type DriverResult } from '@/lib/aiCore/protocols/contract'

/** baseUrl 归一：允许填 `…/v1beta` 或不带版本段 */
function geminiBaseOf(raw: string): string {
  const base = stripSlash(raw || '')
  if (!base) return ''
  return /\/v1(beta)?\d*$/.test(base) ? base : `${base}/v1beta`
}

interface GeminiPart { text?: unknown }
interface GeminiContent { role?: string; parts?: GeminiPart[] }
interface GeminiCandidate { content?: GeminiContent; finishReason?: unknown }

/** 取出一个 candidate 的纯文本（parts 可能有多段） */
function candidateText(cand: GeminiCandidate | undefined): string {
  const parts = cand?.content?.parts ?? []
  return parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('')
}

/** 安全 / 拒绝类 finishReason（Gemini 用大写枚举） */
const GEMINI_REFUSAL_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'])

/**
 * 消息映射：system → 顶层 systemInstruction；assistant → `model`。
 * 🔴 Gemini 要求 user / model 交替，故把相邻同角色合并（内容以空行拼接）。
 */
function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const out: GeminiContent[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    const role = m.role === 'assistant' ? 'model' : 'user'
    const last = out[out.length - 1]
    if (last && last.role === role) {
      last.parts = [{ text: `${(last.parts?.[0]?.text as string) ?? ''}\n\n${m.content}` }]
    } else {
      out.push({ role, parts: [{ text: m.content }] })
    }
  }
  return out
}

/** SSE 单行解析：无结束哨兵；promptFeedback.blockReason 视为错误 */
export function geminiStreamParser(payload: string): SseLineOutcome | null {
  if (payload === '[DONE]') return { done: true, progress: false }
  let obj: { promptFeedback?: { blockReason?: unknown }; [k: string]: unknown }
  try { obj = JSON.parse(payload) as typeof obj } catch { return null }
  const block = obj.promptFeedback?.blockReason
  if (typeof block === 'string' && block) return { error: `Gemini 拒绝生成（${block}）` }
  return { json: obj, progress: true }
}

async function geminiChat(config: AIProvider, messages: ChatMessage[], o: DriverCallOpts): Promise<DriverResult> {
  const { timeoutMs } = o
  const base = geminiBaseOf(config.baseUrl || '')
  if (!base) throw new Error('未填写 API 接口地址（baseUrl）。Gemini 官方地址为 https://generativelanguage.googleapis.com。')
  if (!config.model) throw new Error('未填写模型名称。')
  if (!config.apiKey.trim()) throw new Error('未填写 Gemini API 密钥（x-goog-api-key）。')

  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const contents = toGeminiContents(messages)
  const gen: Record<string, unknown> = { temperature: o.temperature }
  // 🔴 官方 structured outputs：responseMimeType + responseJsonSchema（JSON Schema 子集）
  if (o.wireFormat === 'json-schema' && o.jsonSchema) {
    gen.responseMimeType = 'application/json'
    gen.responseJsonSchema = o.jsonSchema
  } else if (o.wireFormat === 'json-object') {
    gen.responseMimeType = 'application/json'
  }
  const body: Record<string, unknown> = {
    contents,
    generationConfig: gen,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  }

  const modelPath = encodeURIComponent(config.model)
  const url = o.onToken
    ? `${base}/models/${modelPath}:streamGenerateContent?alt=sse`
    : `${base}/models/${modelPath}:generateContent`
  const headers = mergeHeaders({
    'Content-Type': 'application/json',
    'x-goog-api-key': config.apiKey,
  }, config.headers)

  let res: Response
  let clearTimer: (() => void) | null = null
  try {
    res = await fetchWithTimeout(
      url,
      { method: 'POST', headers, body: JSON.stringify(body) },
      timeoutMs,
      o.signal,
      o.onToken ? (ct) => { clearTimer = ct } : undefined,
    )
  } catch (e) {
    if (isCancelled(e)) throw e
    if (isAbortError(e)) throw new Error(`Gemini 响应超时（超过 ${secs(timeoutMs)} 秒）：请检查网络与接口地址。`)
    throw new Error('无法连接 Gemini API：请检查网络与接口地址；网页版还可能受到浏览器跨域（CORS）限制。')
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Gemini 鉴权失败（HTTP ${res.status}）：请检查 x-goog-api-key 是否有效、该模型是否已开通。`)
    }
    throw new Error(describeApiError(res.status, txt))
  }

  if (o.onToken) {
    let content = ''
    let finishReason = ''
    let usage: RealUsage = {}
    let report: StreamReport = { sawDone: false, chunks: 0 }
    try {
      report = await readSSE(res, (obj) => {
        const chunk = obj as { candidates?: GeminiCandidate[] }
        const cand = chunk.candidates?.[0]
        const text = candidateText(cand)
        if (text) { content += text; o.onToken!(text) }
        const fr = cand?.finishReason
        if (typeof fr === 'string' && fr) finishReason = fr
        usage = mergeUsage(usage, usageFromGemini(chunk))
      }, () => clearTimer?.(), {
        idleTimeoutMs: o.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
        signal: o.signal,
        parseLine: geminiStreamParser,
      })
    } catch (e) {
      if (o.signal?.aborted) throw new AICancelled()
      if (isStreamStalled(e)) { (e as AIStreamStalledError).partialText = content; throw e }
      if (isAbortError(e)) throw new Error(`Gemini 响应超时（超过 ${secs(timeoutMs)} 秒）：请检查网络与接口地址。`)
      throw e
    }
    if (report.errorMessage) throw new Error(`Gemini 在生成过程中报错：${report.errorMessage}`)
    if (GEMINI_REFUSAL_REASONS.has(finishReason)) throw new AIRefusalError('content-filter', `finishReason=${finishReason}`)
    if (!content.trim()) throw new Error('Gemini 未返回内容：请确认模型名称正确、该模型已开通，且请求未被安全策略拦截。')
    return {
      content: stripThink(content),
      loadMs: 0,
      // 无结束哨兵：内容可用，结束原因未知时记 eof
      usage: { ...usage, finishReason: finishReason || 'eof' },
    }
  }

  const data = await res.json().catch(() => ({}))
  const block = (data?.promptFeedback as { blockReason?: unknown } | undefined)?.blockReason
  if (typeof block === 'string' && block) throw new AIRefusalError('content-filter', `blockReason=${block}`)
  const cand = (data?.candidates ?? [])[0] as GeminiCandidate | undefined
  const content = candidateText(cand)
  const finishReason = typeof cand?.finishReason === 'string' ? cand.finishReason : ''
  if (GEMINI_REFUSAL_REASONS.has(finishReason)) throw new AIRefusalError('content-filter', `finishReason=${finishReason}`)
  if (!content.trim()) throw new Error('Gemini 未返回内容：请确认模型名称正确、该模型已开通，且请求未被安全策略拦截。')
  return {
    content: stripThink(content),
    loadMs: 0,
    usage: usageFromGemini(data),
  }
}

export const geminiDriver: ChatDriver = defineDriver({
  protocol: 'gemini',
  label: 'Google Gemini generateContent',
  auth: 'x-goog-api-key',
  systemSlot: 'systemInstruction',
  assistantRole: 'model',
  streamEndpoint: 'separate',
  usageSource: 'gemini',
  structuredWire: true,
  parseStreamLine: geminiStreamParser,
  chat: geminiChat,
})