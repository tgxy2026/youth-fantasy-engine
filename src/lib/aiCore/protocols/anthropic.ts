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

/** Anthropic 的 API 版本头（官方当前稳定值；升级前按当期文档核对） */
export const ANTHROPIC_VERSION = '2023-06-01'

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

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: o.outputTokens ?? 8192,
    messages: rest,
    temperature: o.temperature,
    stream: !!o.onToken,
    ...(system ? { system } : {}),
  }

  const headers = mergeHeaders({
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  }, config.headers)

  let res: Response
  let clearTimer: (() => void) | null = null
  try {
    res = await fetchWithTimeout(
      `${base}/messages`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      timeoutMs,
      o.signal,
      o.onToken ? (ct) => { clearTimer = ct } : undefined,
    )
  } catch (e) {
    if (isCancelled(e)) throw e
    if (isAbortError(e)) throw new Error(`Anthropic 响应超时（超过 ${secs(timeoutMs)} 秒）：请检查网络与接口地址。`)
    throw new Error('无法连接 Anthropic API：请检查网络与接口地址；网页版还可能受到浏览器跨域（CORS）限制。')
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '')
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
    if (!content.trim()) throw new Error('Anthropic 未返回内容：请确认模型名称正确、账户有额度，且该模型支持 Messages API。')
    return {
      content: stripThink(content),
      loadMs: 0,
      usage: {
        ...usage,
        ...(stopReason ? { finishReason: stopReason } : {}),
        ...(report.sawDone ? {} : { finishReason: stopReason || 'eof' }),
      },
    }
  }

  const data = await res.json().catch(() => ({}))
  const content = ((data?.content ?? []) as { type?: string; text?: unknown }[])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('')
  if (data?.stop_reason === 'refusal') throw new AIRefusalError('content-filter', '')
  if (!content.trim()) throw new Error('Anthropic 未返回内容：请确认模型名称正确、账户有额度，且该模型支持 Messages API。')
  return {
    content: stripThink(content),
    loadMs: 0,
    usage: usageFromAnthropic(data),
  }
}

export const anthropicDriver: ChatDriver = defineDriver({
  protocol: 'anthropic',
  label: 'Anthropic Messages',
  auth: 'x-api-key',
  systemSlot: 'top-level',
  assistantRole: 'assistant',
  streamEndpoint: 'same',
  usageSource: 'anthropic',
  structuredWire: false,
  parseStreamLine: anthropicStreamParser,
  chat: anthropicChat,
})