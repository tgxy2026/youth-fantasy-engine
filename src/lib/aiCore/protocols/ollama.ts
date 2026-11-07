/**
 * 3.4.2 · Ollama 原生协议 driver
 *
 * 从 `aiCore/chat.ts` 的 `ollamaChatRaw` 平移而来，请求体、SSE 解析、400 撤 format 重发
 * 与错误文案**逐字保留**，不改变 3.4.1 的任何行为。
 */

import { OLLAMA_DEFAULT_URL, type AIProvider, type ChatMessage } from '@/lib/aiCore/core'
import {
  fetchWithTimeout, readSSE, secs, stripSlash, stripThink, isAbortError, isCancelled,
  AICancelled, isStreamStalled, STREAM_IDLE_TIMEOUT_MS, withWebLocalConnectionHint,
  AIStreamStalledError, listOllamaModels, type SseChunk, type StreamReport,
} from '@/lib/aiCore/transport'
import { mergeUsage, usageFromOllama, usageFromStreamChunk, type RealUsage } from '@/lib/aiCore/usageParse'
import { defineDriver, type ChatDriver, type DriverCallOpts, type DriverResult } from '@/lib/aiCore/protocols/contract'
import { shouldDegradeOn400 } from '@/lib/aiCore/protocols/shared'

async function ollamaChat(config: AIProvider, messages: ChatMessage[], o: DriverCallOpts): Promise<DriverResult> {
  const { timeoutMs, think } = o
  const base = stripSlash(config.baseUrl || OLLAMA_DEFAULT_URL)
  if (!config.model) throw new Error('未选择 Ollama 模型，请先到「模型设置 → 模型配置」拉取并选择本地模型。')
  // 构建请求体：**只有关思考时才传 think:false**。
  // · 结构化输出任务：由 `chat()` 经 `resolveOutputProtocol` 归一（旧 `json:true` ⇒ false）⇒ 这里会收到 false；
  //   理由是思考型模型思考开会把 content 截到只剩几百字，JSON 必残。
  // · 长文创作（正文续写 / 改写 / 伴写 / 深度设定深化）：think 为 undefined ⇒ **不下发该字段**，
  //   由模型/平台默认 —— 思考型模型（deepseek-r1 / gemma4 / qwen3.5）保持思考，利于深度设定补全。
  // · 显式 `think: true`：同样不下发（等于保持模型默认，也就是保留思考），是逃生口。
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: !!o.onToken,
    options: { temperature: o.temperature, ...(o.extraOptions ?? {}) },
  }
  if (think === false) body.think = false
  // 3.2.0 · WQ5：作者确认过的端点才下发 `format`（默认只靠提示词约束）
  if (o.wireFormat === 'json-schema' && o.jsonSchema) body.format = o.jsonSchema
  else if (o.wireFormat === 'json-object' || o.wireFormat === 'json-schema') body.format = 'json'
  let res: Response
  let clearTimer: (() => void) | null = null
  const doFetch = () => fetchWithTimeout(
    `${base}/api/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    timeoutMs,
    o.signal,
    // 流式：把清总超时交出去，由 readSSE 在首 token 时调用，避免慢模型被一刀切
    o.onToken ? (ct) => { clearTimer = ct } : undefined,
  )
  try {
    res = await doFetch()
  } catch (e) {
    if (isCancelled(e)) throw e
    if (isAbortError(e)) {
      throw new Error(
        `Ollama 响应超时（超过 ${secs(timeoutMs)} 秒）。大参数模型首次调用需加载进显存，可稍后重试；` +
        '若长期超时，建议换用更小的模型或确认显存是否足够。',
      )
    }
    throw new Error(withWebLocalConnectionHint('无法连接 Ollama：请确认本机已启动 Ollama（ollama serve）且地址正确（默认 http://localhost:11434）。'))
  }
  // 🔴 格式是可选参数：端点临时不认（旧版 / 中转返回 400）时**只撤掉它**重发一次，
  //    其余参数（温度、采样、think）原样不动 —— 不因一个可选字段把整个功能弄坏。
  if (!o.disableCompatibilityRetry && !res.ok && res.status === 400 && body.format !== undefined) {
    const txt = await res.text().catch(() => '')
    if (shouldDegradeOn400(txt)) {
      delete body.format
      try {
        res = await doFetch()
      } catch (e) {
        if (isCancelled(e)) throw e
        if (isAbortError(e)) throw new Error(`Ollama 响应超时（超过 ${secs(timeoutMs)} 秒）。大参数模型首次调用需加载进显存，可稍后重试。`)
        throw new Error(withWebLocalConnectionHint('无法连接 Ollama：请确认本机已启动 Ollama（ollama serve）且地址正确（默认 http://localhost:11434）。'))
      }
    }
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    if (res.status === 404) throw new Error(`模型「${config.model}」不存在（HTTP 404），请确认已执行 ollama pull ${config.model}。`)
    throw new Error(`Ollama 调用失败（HTTP ${res.status}）：${txt.slice(0, 200)}`)
  }
  // 流式：边读边回调，本地大参数模型首字出来就不转圈
  if (o.onToken) {
    let content = ''
    // 🔴 流式用量在 `done:true` 的收尾块里（prompt_eval_count / eval_count），
    //    逐块合并 —— 只读最后一块会漏掉部分中转实现把计数放在中间块的情况。
    let usage: RealUsage = {}
    let report: StreamReport = { sawDone: false, chunks: 0 }
    try {
      report = await readSSE(res, (obj) => {
        const chunk = obj as SseChunk
        const delta = chunk?.message?.content
        if (typeof delta === 'string' && delta) { content += delta; o.onToken!(delta) }
        usage = mergeUsage(usage, usageFromStreamChunk(obj, 'ollama'))
      }, () => clearTimer?.(), { idleTimeoutMs: o.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS, signal: o.signal })
    } catch (e) {
      if (o.signal?.aborted) throw new AICancelled()
      // 停滞（3.2.0 · WQ6）原样抛：它自带「收到了几段、等了多久」，比一句"超时"有用得多
      // 3.2.0 · WQ1 贯通：把已收片段挂到错误上 —— 调用方可「保留片段标 incomplete」而非整段丢弃
      if (isStreamStalled(e)) { (e as AIStreamStalledError).partialText = content; throw e }
      if (isAbortError(e)) throw new Error(`Ollama 响应超时（超过 ${secs(timeoutMs)} 秒）。大参数模型首次调用需加载进显存，可稍后重试；若长期超时建议换用更小的模型。`)
      throw e
    }
    // 🔴 流里报错就不能算成功（HTTP 200 只是"连上了"）
    if (report.errorMessage) throw new Error(`Ollama 在生成过程中报错：${report.errorMessage}`)
    if (!content.trim()) throw new Error('Ollama 未返回内容，请确认模型名称正确且已拉取（ollama pull <模型名>）。')
    return {
      content: stripThink(content),
      loadMs: 0,
      // 缺 `done:true` 说明流是被对端直接收掉的：内容可用，但结束原因**未知**（不假装 stop）
      usage: report.sawDone ? usage : { ...usage, finishReason: usage.finishReason ?? 'eof' },
    }
  }
  const data = await res.json().catch(() => ({}))
  const msg = data?.message ?? {}
  let content: string = typeof msg.content === 'string' ? msg.content : ''
  // 新版 Ollama 把思维链单独放在 message.thinking，content 已是干净结论；
  // 极少数情况下模型只产出思考未给结论，此时退用思考内容，避免整轮等待白费。
  if (!content.trim() && typeof msg.thinking === 'string' && msg.thinking.trim()) {
    content = msg.thinking
  }
  if (!content.trim()) throw new Error('Ollama 未返回内容，请确认模型名称正确且已拉取（ollama pull <模型名>）。')
  // load_duration 单位为纳秒，转成毫秒
  const loadMs = Math.round(Number(data?.load_duration ?? 0) / 1e6)
  return {
    content: stripThink(content),
    loadMs: Number.isFinite(loadMs) ? loadMs : 0,
    usage: usageFromOllama(data),
  }
}

export const ollamaDriver: ChatDriver = defineDriver({
  protocol: 'ollama',
  label: 'Ollama 原生',
  auth: 'none',
  systemSlot: 'messages',
  assistantRole: 'assistant',
  streamEndpoint: 'same',
  usageSource: 'ollama',
  structuredWire: true,
  chat: ollamaChat,
  listModels: config => listOllamaModels(config.baseUrl),
})