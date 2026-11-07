/**
 * 3.4.2 · Anthropic Messages 协议 driver（`/v1/messages`）
 *
 * 与 OpenAI 兼容通道的关键差异（照抄 OpenAI 分支会静默失败的三处）：
 *   ① 系统提示在**顶层 `system`**，不在 messages 里；
 *   ② 鉴权是 `x-api-key` + `anthropic-version`，不是 Bearer；
 *   ③ 流式是**具名事件**（`content_block_delta` → `message_stop`），没有 `[DONE]`。
 *
 * 🔴 结构化输出：本版**不向厂商下发** structure 字段（字段名近年改名、未经当期官方文档取证），
 *    `structuredWire=false`，由 `chat()` 降级为提示词约束并如实记录。
 */

import type { AIProvider, ChatMessage } from '@/lib/aiCore/core'
import {
  fetchWithTimeout, readSSE, secs, stripSlash, stripThink, isAbortError, isCancelled,
  AICancelled, isStreamStalled, STREAM_IDLE_TIMEOUT_MS, AIStreamStalledError,
  describeApiError, AIRefusalError, type SseLineOutcome, type StreamReport,
} from '@/lib/aiCore/transport'
import { mergeHeaders } from '@/lib/aiCore/headers'
import { mergeUsage, usageFromAnthropic, type RealUsage } from '@/lib/aiCore/usageParse'
import { defineDriver, type ChatDriver, type DriverCallOpts, type DriverResult } from '@/lib/aiCore/protocols/contract'
import {
  budgetExhaustedMessage, initialWireFlags, nextWireFlags,
  MAX_REQUESTS_PER_CALL, type WireFlags,
} from '@/lib/aiCore/protocols/shared'
import { WEB } from '@/lib/app/platform'

/** Anthropic 的 API 版本头（官方 structured outputs 文档示例值） */
export const ANTHROPIC_VERSION = '2026-10-21'

/** baseUrl 归一：允许用户填 `…/v1` 或不带版本段 */
function anthropicBaseOf(raw: string): string {
  const base = stripSlash(raw || '')
  if (!base) return ''
  return base.endsWith('/v1') ? base : `${base}/v1`
}

/** SSE 单行解析：具名事件，无 `[DONE]` 哨兵 */
export function anthropicStreamParser(payload: string): SseLineOutcome | null {
  if (payload === '[DONE]') return { done: true, progress: false }
  let obj: { type?: unknown; [k: string]: unknown }
  try { obj = JSON.parse(payload) as typeof obj } catch { return null }
  const type = typeof obj.type === 'string' ? obj.type : ''
  if (type === 'error') {
    const err = obj.error as { message?: unknown } | undefined
    const msg = typeof err?.message === 'string' ? err.message : 'Anthropic 流式错误'
    return { error: msg }
  }
  if (type === 'content_block_delta') return { json: obj, progress: true }
  if (type === 'content_block_start') return { json: obj, progress: true }
  if (type === 'message_start' || type === 'message_delta') return { json: obj, progress: false }
  if (type === 'message_stop') return { json: obj, done: true, progress: false }
  // ping / content_block_stop / 未知事件：优雅忽略，不算进展
  return null
}

/** GET /v1/models：取可用模型（过滤已退役 lifecycle=retired） */
export async function listAnthropicModels(config: Pick<AIProvider, 'baseUrl' | 'apiKey' | 'headers'>): Promise<string[]> {
  const base = anthropicBaseOf(config.baseUrl || '')
  if (!base) throw new Error('未填写 API 接口地址（baseUrl）。Anthropic 官方地址为 https://api.anthropic.com。')
  if (!config.apiKey.trim()) throw new Error('未填写 Anthropic API 密钥（x-api-key）。')
  let res: Response
  try {
    res = await fetchWithTimeout(`${base}/models`, {
      headers: mergeHeaders({
        'x-api-key': config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        ...(WEB ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
      }, config.headers),
    }, 10_000)
  } catch (e) {
    if (isAbortError(e)) throw new Error('获取 Anthropic 模型列表超时（10 秒）：请检查接口地址与网络。')
    throw new Error('无法连接 Anthropic：请检查接口地址与网络；网页版还可能受到浏览器跨域（CORS）限制。')
  }
  if (!res.ok) throw new Error(describeApiError(res.status, await res.text().catch(() => '')))
  const data = await res.json().catch(() => ({}))
  const rows = Array.isArray(data?.data) ? data.data as { id?: unknown; lifecycle?: unknown }[] : []
  return rows
    .filter(r => r && typeof r === 'object' && r.lifecycle !== 'retired')
    .map(r => (typeof r.id === 'string' ? r.id.trim() : ''))
    .filter(Boolean)
}

interface AnthropicChunk {
  type?: string
  delta?: { type?: string; text?: unknown; stop_reason?: unknown }
  content_block?: { type?: string; text?: unknown }
  message?: unknown
  usage?: unknown
}

async function anthropicChat(config: AIProvider, messages: ChatMessage[], o: DriverCallOpts): Promise<DriverResult> {
  const { timeoutMs } = o
  const base = anthropicBaseOf(config.baseUrl || '')
  if (!base) throw new Error('未填写 API 接口地址（baseUrl）。Anthropic 官方地址为 https://api.anthropic.com。')
  if (!config.model) throw new Error('未填写模型名称。')
  if (!config.apiKey.trim()) throw new Error('未填写 Anthropic API 密钥（x-api-key）。')

  // 系统提示在顶层；其余消息去掉 system 后按 assistant / user 映射
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const rest = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))

  // 🔴 3.4.2 · D-1：可选参数分两档（结构字段 / 采样），400 时**逐档撤**而不是整轮失败。
  //    实测会撞的两种 400：① 部分模型只接受 temperature 0–1（作者填 1.2 就整轮挂）；
  //    ② 中转 / 兼容网关不认 output_config。撤掉能救回来，撤不掉（模型名、鉴权、额度）就别白发请求。
  const canFormat = o.wireFormat === 'json-schema' && !!o.jsonSchema
  let flags: WireFlags = initialWireFlags(canFormat)
  const buildBody = (f: WireFlags, stream: boolean): Record<string, unknown> => ({
    model: config.model,
    max_tokens: o.outputTokens ?? 8192,
    messages: rest,
    stream,
    ...(system ? { system } : {}),
    ...(f.sampling ? { temperature: o.temperature } : {}),
    // 官方 structured outputs：output_config.format（仅 json_schema；无无 schema 的 JSON 对象模式）
    ...(f.format && canFormat ? { output_config: { format: { type: 'json_schema', schema: o.jsonSchema } } } : {}),
  })
  const streaming = !!o.onToken

  const headers = mergeHeaders({
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    // 🔴 网页版是**浏览器直连厂商**：Anthropic 只有收到这个头才会回 CORS 响应头（官方要求）。
    //    桌面 / 便携版不加，请求逐字节与 3.4.1 一致（`WEB` 为假时整行消失）。
    ...(WEB ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
  }, config.headers)

  let res: Response
  let clearTimer: (() => void) | null = null
  /** 本次逻辑调用实际发了几次请求（预算与用量都可核对） */
  let attempts = 0
  /** 已读过的 400 响应体 —— 流已消费，重读只会得到空串 */
  let lastErrorText = ''
  const doFetch = (f: WireFlags, stream: boolean) => fetchWithTimeout(
    `${base}/messages`,
    { method: 'POST', headers, body: JSON.stringify(buildBody(f, stream)) },
    timeoutMs,
    o.signal,
    stream ? (ct) => { clearTimer = ct } : undefined,
  )
  /** 非流式响应体 → 结果（直接非流式请求与「流式解析不出内容」的降级重试共用同一段解析） */
  const nonStreamOf = (data: unknown): DriverResult => {
    const d = data as { content?: { type?: string; text?: unknown }[]; stop_reason?: string }
    const text = (d?.content ?? [])
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join('')
    if (d?.stop_reason === 'refusal') throw new AIRefusalError('content-filter', '')
    if (!text.trim()) throw new Error('Anthropic 未返回内容：请确认模型名称正确、账户有额度，且该模型支持 Messages API。')
    return { content: stripThink(text), loadMs: 0, usage: usageFromAnthropic(d) }
  }

  try {
    for (;;) {
      res = await doFetch(flags, streaming)
      attempts += 1
      if (o.disableCompatibilityRetry || res.status !== 400 || attempts >= MAX_REQUESTS_PER_CALL) break
      const txt = await res.text().catch(() => '')
      const next = nextWireFlags(flags, txt)
      if (!next) { lastErrorText = txt; break }
      flags = next
    }
  } catch (e) {
    if (isCancelled(e)) throw e
    if (isAbortError(e)) throw new Error(`Anthropic 响应超时（超过 ${secs(timeoutMs)} 秒）：请检查网络与接口地址。`)
    throw new Error('无法连接 Anthropic API：请检查网络与接口地址；网页版还可能受到浏览器跨域（CORS）限制。')
  }

  if (!res.ok) {
    const txt = lastErrorText || await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Anthropic 鉴权失败（HTTP ${res.status}）：请检查 x-api-key 是否正确、是否有该模型权限。`)
    }
    throw new Error(describeApiError(res.status, txt))
  }

  if (o.onToken) {
    let content = ''
    let stopReason = ''
    let usage: RealUsage = {}
    let report: StreamReport = { sawDone: false, chunks: 0 }
    try {
      report = await readSSE(res, (obj) => {
        const chunk = obj as AnthropicChunk
        const t = chunk.type
        if (t === 'content_block_start') {
          const text = chunk.content_block?.text
          if (typeof text === 'string' && text) { content += text; o.onToken!(text) }
        } else if (t === 'content_block_delta') {
          const text = chunk.delta?.text
          if (typeof text === 'string' && text) { content += text; o.onToken!(text) }
        } else if (t === 'message_start') {
          usage = mergeUsage(usage, usageFromAnthropic(chunk.message))
        } else if (t === 'message_delta') {
          const sr = chunk.delta?.stop_reason
          if (typeof sr === 'string' && sr) stopReason = sr
          usage = mergeUsage(usage, usageFromAnthropic(chunk))
        }
      }, () => clearTimer?.(), {
        idleTimeoutMs: o.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
        signal: o.signal,
        parseLine: anthropicStreamParser,
      })
    } catch (e) {
      if (o.signal?.aborted) throw new AICancelled()
      if (isStreamStalled(e)) { (e as AIStreamStalledError).partialText = content; throw e }
      if (isAbortError(e)) throw new Error(`Anthropic 响应超时（超过 ${secs(timeoutMs)} 秒）：请检查网络与接口地址。`)
      throw e
    }
    if (report.errorMessage) throw new Error(`Anthropic 在生成过程中报错：${report.errorMessage}`)
    if (stopReason === 'refusal') throw new AIRefusalError('content-filter', '')
    if (!content.trim()) {
      // 🔴 3.4.2 · D-1：流式解析不出内容（兼容网关的 SSE 事件族不标准）⇒ 退一次**非流式**。
      //    宁可多等一整轮，也要把「跑不通」变成「慢一点但能跑」；次数进同一本预算账。
      if (o.disableCompatibilityRetry) throw new Error('Anthropic 未返回内容：请确认模型名称正确、账户有额度，且该模型支持 Messages API。')
      if (attempts >= MAX_REQUESTS_PER_CALL) throw new Error(budgetExhaustedMessage('Anthropic', attempts))
      attempts += 1
      const retry = await fetchWithTimeout(
        `${base}/messages`,
        { method: 'POST', headers, body: JSON.stringify(buildBody(flags, false)) },
        timeoutMs, o.signal,
      )
      if (retry.ok) {
        const out = nonStreamOf(await retry.json().catch(() => ({})))
        o.onToken?.(out.content)
        return { ...out, usage: { ...out.usage, attempts } }
      }
      throw new Error('Anthropic 未返回可用内容（流式响应体无法解析，非流式重试也失败）：该接口地址可能不兼容 Messages 流式格式——请确认中转站文档给出的接口地址与模型名。')
    }
    return {
      content: stripThink(content),
      loadMs: 0,
      usage: {
        ...usage,
        ...(stopReason ? { finishReason: stopReason } : {}),
        ...(report.sawDone ? {} : { finishReason: stopReason || 'eof' }),
        ...(attempts > 1 ? { attempts } : {}),
      },
    }
  }

  const out = nonStreamOf(await res.json().catch(() => ({})))
  return { ...out, usage: { ...out.usage, ...(attempts > 1 ? { attempts } : {}) } }
}

export const anthropicDriver: ChatDriver = defineDriver({
  protocol: 'anthropic',
  label: 'Anthropic Messages',
  auth: 'x-api-key',
  systemSlot: 'top-level',
  assistantRole: 'assistant',
  streamEndpoint: 'same',
  usageSource: 'anthropic',
  capabilities: { stream: true, cancel: true, multiTurn: true, embedding: false, latency: 'medium', unattended: true, quota: 'metered' },
  structuredWire: 'json-schema',
  parseStreamLine: anthropicStreamParser,
  chat: anthropicChat,
  listModels: config => listAnthropicModels(config),
})