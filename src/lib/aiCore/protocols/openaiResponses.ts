/**
 * 3.4.2 · OpenAI Responses 协议 driver（`/v1/responses`）
 *
 * 与 Chat Completions 的关键差异：
 *   ① 系统提示在顶层 **`instructions`**，输入在 **`input`** items；
 *   ② 流式是**具名事件**（`response.output_text.delta` → `response.completed`）；
 *   ③ 用量字段是 `usage.input_tokens` / `usage.output_tokens`（不是 prompt/completion_tokens）。
 *
 * 🔴 结构化输出：本版不向厂商下发 `text.format`（未经当期官方文档取证），
 *    `structuredWire=false`，由 `chat()` 降级为提示词约束并如实记录。
 */

import type { AIProvider, ChatMessage } from '@/lib/aiCore/core'
import {
  fetchWithTimeout, readSSE, secs, stripSlash, stripThink, isAbortError, isCancelled,
  AICancelled, isStreamStalled, STREAM_IDLE_TIMEOUT_MS, AIStreamStalledError,
  describeApiError, AIRefusalError, listOpenAIModels,
  type SseLineOutcome, type StreamReport,
} from '@/lib/aiCore/transport'
import { mergeHeaders } from '@/lib/aiCore/headers'
import { mergeUsage, usageFromResponses, type RealUsage } from '@/lib/aiCore/usageParse'
import { defineDriver, type ChatDriver, type DriverCallOpts, type DriverResult } from '@/lib/aiCore/protocols/contract'
import {
  budgetExhaustedMessage, initialWireFlags, nextWireFlags,
  MAX_REQUESTS_PER_CALL, type WireFlags,
} from '@/lib/aiCore/protocols/shared'

/** baseUrl 归一：允许填 `…/v1` 或不带版本段 */
function responsesBaseOf(raw: string): string {
  const base = stripSlash(raw || '')
  if (!base) return ''
  return base.endsWith('/v1') ? base : `${base}/v1`
}

interface ResponsesOutputItem {
  type?: string
  content?: { type?: string; text?: unknown }[]
}

/** 从非流式响应里抽出 assistant 文本 */
function outputTextOf(data: { output?: ResponsesOutputItem[] }): string {
  const out: string[] = []
  for (const item of data.output ?? []) {
    if (item.type !== 'message') continue
    for (const c of item.content ?? []) {
      if (c.type === 'output_text' && typeof c.text === 'string') out.push(c.text)
    }
  }
  return out.join('')
}

/** SSE 单行解析：具名事件，无 `[DONE]` 哨兵 */
export function responsesStreamParser(payload: string): SseLineOutcome | null {
  if (payload === '[DONE]') return { done: true, progress: false }
  let obj: { type?: unknown; [k: string]: unknown }
  try { obj = JSON.parse(payload) as typeof obj } catch { return null }
  const type = typeof obj.type === 'string' ? obj.type : ''
  if (type === 'response.output_text.delta') return { json: obj, progress: true }
  if (type === 'response.completed') return { json: obj, done: true, progress: false }
  if (type === 'response.failed' || type === 'error') {
    const response = obj.response as { error?: { message?: unknown } } | undefined
    const err = obj.error as { message?: unknown } | undefined
    const msg = [response?.error?.message, err?.message, obj.message]
      .find(v => typeof v === 'string' && v) as string | undefined
    return { error: msg ?? 'Responses 流式错误' }
  }
  // response.created / in_progress / 未知事件：优雅忽略
  return null
}

async function responsesChat(config: AIProvider, messages: ChatMessage[], o: DriverCallOpts): Promise<DriverResult> {
  const { timeoutMs } = o
  const base = responsesBaseOf(config.baseUrl || '')
  if (!base) throw new Error('未填写 API 接口地址（baseUrl）。Responses 官方地址为 https://api.openai.com/v1。')
  if (!config.model) throw new Error('未填写模型名称。')

  const instructions = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const input = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))

  // 🔴 3.4.2 · D-1：可选参数分两档（结构字段 / 采样），400 时逐档撤。
  //    实测最常见的两种 400：① 推理系模型拒绝 `temperature ≠ 1`（原话还带 "with this model"）；
  //    ② 中转不认 `text.format`。撤掉能救回来；模型名 / 鉴权 / 额度写错就别白发请求。
  const canFormat = (o.wireFormat === 'json-schema' && !!o.jsonSchema) || o.wireFormat === 'json-object'
  let flags: WireFlags = initialWireFlags(canFormat)
  const buildBody = (f: WireFlags, stream: boolean): Record<string, unknown> => {
    const b: Record<string, unknown> = {
      model: config.model,
      input,
      stream,
      ...(instructions ? { instructions } : {}),
      ...(f.sampling ? { temperature: o.temperature } : {}),
    }
    // 官方 structured outputs：text.format（不是 response_format）
    if (f.format && o.wireFormat === 'json-schema' && o.jsonSchema) {
      b.text = { format: { type: 'json_schema', name: 'response', schema: o.jsonSchema } }
    } else if (f.format && o.wireFormat === 'json-object') {
      b.text = { format: { type: 'json_object' } }
    }
    return b
  }
  const streaming = !!o.onToken
  const headers = mergeHeaders({
    'Content-Type': 'application/json',
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  }, config.headers)

  let res: Response
  let clearTimer: (() => void) | null = null
  /** 本次逻辑调用实际发了几次请求 */
  let attempts = 0
  /** 已读过的 400 响应体（流已消费，重读只会得到空串） */
  let lastErrorText = ''
  const doFetch = (f: WireFlags, stream: boolean) => fetchWithTimeout(
    `${base}/responses`,
    { method: 'POST', headers, body: JSON.stringify(buildBody(f, stream)) },
    timeoutMs,
    o.signal,
    stream ? (ct) => { clearTimer = ct } : undefined,
  )
  /** 非流式响应体 → 结果（直接非流式与「流式解析不出内容」的降级重试共用） */
  const nonStreamOf = (data: unknown): DriverResult => {
    const d = data as { output?: ResponsesOutputItem[] }
    const content = outputTextOf(d)
    const usage = usageFromResponses(d)
    if (usage.finishReason === 'content_filter') throw new AIRefusalError('content-filter', '')
    if (!content.trim()) throw new Error('Responses 未返回内容：请确认模型名称正确、账户有额度，且该模型支持 Responses API。')
    return { content: stripThink(content), loadMs: 0, usage }
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
    if (isAbortError(e)) throw new Error(`Responses 响应超时（超过 ${secs(timeoutMs)} 秒）：请检查网络与接口地址。`)
    throw new Error('无法连接 Responses API：请检查网络与接口地址；网页版还可能受到浏览器跨域（CORS）限制。')
  }

  if (!res.ok) {
    const txt = lastErrorText || await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Responses 鉴权失败（HTTP ${res.status}）：请检查 API 密钥与模型权限。`)
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
        const chunk = obj as { type?: string; delta?: unknown; response?: unknown }
        if (chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string' && chunk.delta) {
          content += chunk.delta
          o.onToken!(chunk.delta)
        } else if (chunk.type === 'response.completed') {
          const u = usageFromResponses(chunk.response)
          usage = mergeUsage(usage, u)
          if (u.finishReason) finishReason = u.finishReason
        }
      }, () => clearTimer?.(), {
        idleTimeoutMs: o.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
        signal: o.signal,
        parseLine: responsesStreamParser,
      })
    } catch (e) {
      if (o.signal?.aborted) throw new AICancelled()
      if (isStreamStalled(e)) { (e as AIStreamStalledError).partialText = content; throw e }
      if (isAbortError(e)) throw new Error(`Responses 响应超时（超过 ${secs(timeoutMs)} 秒）：请检查网络与接口地址。`)
      throw e
    }
    if (report.errorMessage) throw new Error(`Responses 在生成过程中报错：${report.errorMessage}`)
    if (finishReason === 'content_filter') throw new AIRefusalError('content-filter', '')
    if (!content.trim()) {
      // 🔴 3.4.2 · D-1：`response.output_text.delta` 事件族不标准（兼容网关常见）⇒ 退一次**非流式**。
      if (o.disableCompatibilityRetry) throw new Error('Responses 未返回内容：请确认模型名称正确、账户有额度，且该模型支持 Responses API。')
      if (attempts >= MAX_REQUESTS_PER_CALL) throw new Error(budgetExhaustedMessage('Responses', attempts))
      attempts += 1
      const retry = await fetchWithTimeout(
        `${base}/responses`,
        { method: 'POST', headers, body: JSON.stringify(buildBody(flags, false)) },
        timeoutMs, o.signal,
      )
      if (retry.ok) {
        const out = nonStreamOf(await retry.json().catch(() => ({})))
        o.onToken?.(out.content)
        return { ...out, usage: { ...out.usage, attempts } }
      }
      throw new Error('Responses 未返回可用内容（流式响应体无法解析，非流式重试也失败）：该接口地址可能不兼容 Responses 的事件流格式——请确认中转站文档给出的接口地址与模型名。')
    }
    return {
      content: stripThink(content),
      loadMs: 0,
      usage: { ...usage, ...(finishReason ? { finishReason } : {}), ...(attempts > 1 ? { attempts } : {}) },
    }
  }

  const out = nonStreamOf(await res.json().catch(() => ({})))
  return { ...out, usage: { ...out.usage, ...(attempts > 1 ? { attempts } : {}) } }
}

export const responsesDriver: ChatDriver = defineDriver({
  protocol: 'openai-responses',
  label: 'OpenAI Responses',
  auth: 'bearer',
  systemSlot: 'instructions',
  assistantRole: 'assistant',
  streamEndpoint: 'same',
  usageSource: 'openai-responses',
  capabilities: { stream: true, cancel: true, multiTurn: true, embedding: true, latency: 'medium', unattended: true, quota: 'metered' },
  structuredWire: true,
  parseStreamLine: responsesStreamParser,
  chat: responsesChat,
  listModels: config => listOpenAIModels(config),
})