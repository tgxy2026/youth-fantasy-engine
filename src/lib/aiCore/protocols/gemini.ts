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
import {
  budgetExhaustedMessage, fetchWithWireDegrade, initialWireFlags,
  MAX_REQUESTS_PER_CALL, type WireFlags,
} from '@/lib/aiCore/protocols/shared'

/** baseUrl 归一：允许填 `…/v1beta` 或不带版本段 */
function geminiBaseOf(raw: string): string {
  const base = stripSlash(raw || '')
  if (!base) return ''
  return /\/v1(beta)?\d*$/.test(base) ? base : `${base}/v1beta`
}

/** GET /v1beta/models：取支持 generateContent 的模型（去掉 `models/` 前缀） */
export async function listGeminiModels(config: Pick<AIProvider, 'baseUrl' | 'apiKey' | 'headers'>): Promise<string[]> {
  const base = geminiBaseOf(config.baseUrl || '')
  if (!base) throw new Error('未填写 API 接口地址（baseUrl）。Gemini 官方地址为 https://generativelanguage.googleapis.com。')
  if (!config.apiKey.trim()) throw new Error('未填写 Gemini API 密钥（x-goog-api-key）。')
  let res: Response
  try {
    res = await fetchWithTimeout(`${base}/models`, {
      headers: mergeHeaders({ 'x-goog-api-key': config.apiKey }, config.headers),
    }, 10_000)
  } catch (e) {
    if (isAbortError(e)) throw new Error('获取 Gemini 模型列表超时（10 秒）：请检查接口地址与网络。')
    throw new Error('无法连接 Gemini：请检查接口地址与网络；网页版还可能受到浏览器跨域（CORS）限制。')
  }
  if (!res.ok) throw new Error(describeApiError(res.status, await res.text().catch(() => '')))
  const data = await res.json().catch(() => ({}))
  const rows = Array.isArray(data?.models) ? data.models as { name?: unknown; supportedGenerationMethods?: unknown }[] : []
  return rows
    .filter(r => {
      if (!r || typeof r !== 'object') return false
      const methods = r.supportedGenerationMethods
      // 字段缺失时保留（老接口兼容）；有字段时必须明确支持 generateContent
      return !Array.isArray(methods) || methods.includes('generateContent')
    })
    .map(r => {
      const name = typeof r.name === 'string' ? r.name : ''
      return name.startsWith('models/') ? name.slice('models/'.length) : name
    })
    .filter(Boolean)
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
  // 🔴 3.4.2 · D-1：可选参数分两档（结构字段 / 采样），400 时逐档撤。
  //    Gemini 的 temperature 是 [0, 2]，个别模型只收 [0, 1]；老网关也常不认 responseJsonSchema。
  const canFormat = o.wireFormat === 'json-schema' && !!o.jsonSchema
  const canJsonObject = o.wireFormat === 'json-object'
  let flags: WireFlags = initialWireFlags(canFormat || canJsonObject)
  const buildBody = (f: WireFlags): Record<string, unknown> => {
    const gen: Record<string, unknown> = { ...(f.sampling ? { temperature: o.temperature } : {}) }
    // 官方 structured outputs：responseMimeType + responseJsonSchema（JSON Schema 子集）
    if (f.format && canFormat) {
      gen.responseMimeType = 'application/json'
      gen.responseJsonSchema = o.jsonSchema
    } else if (f.format && canJsonObject) {
      gen.responseMimeType = 'application/json'
    }
    return {
      contents,
      generationConfig: gen,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    }
  }

  const modelPath = encodeURIComponent(config.model)
  const streaming = !!o.onToken
  const urlOf = (stream: boolean) => stream
    ? `${base}/models/${modelPath}:streamGenerateContent?alt=sse`
    : `${base}/models/${modelPath}:generateContent`
  const headers = mergeHeaders({
    'Content-Type': 'application/json',
    'x-goog-api-key': config.apiKey,
  }, config.headers)

  let res: Response
  let clearTimer: (() => void) | null = null
  /** 本次逻辑调用实际发了几次请求 */
  let attempts = 0
  /** 已读过的 400 响应体（流已消费，重读只会得到空串） */
  let lastErrorText = ''
  const doFetch = (f: WireFlags, stream: boolean) => fetchWithTimeout(
    urlOf(stream),
    { method: 'POST', headers, body: JSON.stringify(buildBody(f)) },
    timeoutMs,
    o.signal,
    stream ? (ct) => { clearTimer = ct } : undefined,
  )
  /** 非流式响应体 → 结果（直接非流式与「流式解析不出内容」的降级重试共用） */
  const nonStreamOf = (data: unknown): DriverResult => {
    const d = data as { promptFeedback?: { blockReason?: unknown }; candidates?: GeminiCandidate[] }
    const block = d?.promptFeedback?.blockReason
    if (typeof block === 'string' && block) throw new AIRefusalError('content-filter', `blockReason=${block}`)
    const cand = (d?.candidates ?? [])[0]
    const content = candidateText(cand)
    const finishReason = typeof cand?.finishReason === 'string' ? cand.finishReason : ''
    if (GEMINI_REFUSAL_REASONS.has(finishReason)) throw new AIRefusalError('content-filter', `finishReason=${finishReason}`)
    if (!content.trim()) throw new Error('Gemini 未返回内容：请确认模型名称正确、该模型已开通，且请求未被安全策略拦截。')
    return { content: stripThink(content), loadMs: 0, usage: usageFromGemini(d) }
  }
  try {
    const out = await fetchWithWireDegrade(doFetch, flags, {
      streaming,
      singleAttempt: !!o.disableCompatibilityRetry,
    })
    res = out.res
    flags = out.flags
    attempts = out.attempts
    lastErrorText = out.lastErrorText
  } catch (e) {
    if (isCancelled(e)) throw e
    if (isAbortError(e)) throw new Error(`Gemini 响应超时（超过 ${secs(timeoutMs)} 秒）：请检查网络与接口地址。`)
    throw new Error('无法连接 Gemini API：请检查网络与接口地址；网页版还可能受到浏览器跨域（CORS）限制。')
  }

  if (!res.ok) {
    const txt = lastErrorText || await res.text().catch(() => '')
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
    if (!content.trim()) {
      // 🔴 3.4.2 · D-1：`alt=sse` 不是所有兼容网关都实现（有的直接吐整段 JSON）⇒ 退一次**非流式**。
      if (o.disableCompatibilityRetry) throw new Error('Gemini 未返回内容：请确认模型名称正确、该模型已开通，且请求未被安全策略拦截。')
      if (attempts >= MAX_REQUESTS_PER_CALL) throw new Error(budgetExhaustedMessage('Gemini', attempts))
      attempts += 1
      const retry = await fetchWithTimeout(
        urlOf(false),
        { method: 'POST', headers, body: JSON.stringify(buildBody(flags)) },
        timeoutMs, o.signal,
      )
      if (retry.ok) {
        const out = nonStreamOf(await retry.json().catch(() => ({})))
        o.onToken?.(out.content)
        return { ...out, usage: { ...out.usage, attempts } }
      }
      throw new Error('Gemini 未返回可用内容（流式响应体无法解析，非流式重试也失败）：该接口地址可能不兼容 streamGenerateContent 的 SSE 格式——请确认中转站文档给出的接口地址与模型名。')
    }
    return {
      content: stripThink(content),
      loadMs: 0,
      // 无结束哨兵：内容可用，结束原因未知时记 eof
      usage: { ...usage, finishReason: finishReason || 'eof', ...(attempts > 1 ? { attempts } : {}) },
    }
  }

  const out = nonStreamOf(await res.json().catch(() => ({})))
  return { ...out, usage: { ...out.usage, ...(attempts > 1 ? { attempts } : {}) } }
}

export const geminiDriver: ChatDriver = defineDriver({
  protocol: 'gemini',
  label: 'Google Gemini generateContent',
  auth: 'x-goog-api-key',
  systemSlot: 'systemInstruction',
  assistantRole: 'model',
  streamEndpoint: 'separate',
  usageSource: 'gemini',
  capabilities: { stream: true, cancel: true, multiTurn: true, embedding: true, latency: 'medium', unattended: true, quota: 'metered' },
  structuredWire: true,
  parseStreamLine: geminiStreamParser,
  chat: geminiChat,
  listModels: config => listGeminiModels(config),
})