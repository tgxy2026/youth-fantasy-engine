/**
 * 3.4.2 · OpenAI 兼容（Chat Completions）协议 driver
 *
 * 从 `aiCore/chat.ts` 的 `openaiChat` 平移而来，请求体、三级参数降级、流式转非流式重试
 * 与错误映射**逐字保留**，不改变 3.4.1 的任何行为。
 */

import type { AIProvider, ChatMessage } from '@/lib/aiCore/core'
import {
  fetchWithTimeout, readSSE, secs, openaiBaseOf, describeApiError, AIRefusalError,
  isRefusalStatus, looksLikeSafetyMessage, looksLikeRefusalText, extractPlatformMessage,
  isAbortError, isCancelled, AICancelled, isStreamStalled, STREAM_IDLE_TIMEOUT_MS, stripThink,
  AIStreamStalledError, listOpenAIModels, type SseChunk, type StreamReport,
} from '@/lib/aiCore/transport'
import { mergeHeaders } from '@/lib/aiCore/headers'
import { mergeUsage, usageFromOpenAI, usageFromStreamChunk, type RealUsage } from '@/lib/aiCore/usageParse'
import { defineDriver, type ChatDriver, type DriverCallOpts, type DriverResult } from '@/lib/aiCore/protocols/contract'
import {
  HYBRID_THINKING_RE, MAX_REQUESTS_PER_CALL, nextOpenAIFlags, openaiSampling,
  shouldDegradeOn400, type OpenAIFlags,
} from '@/lib/aiCore/protocols/shared'

async function openaiChat(config: AIProvider, messages: ChatMessage[], o: DriverCallOpts): Promise<DriverResult> {
  const { timeoutMs } = o
  const base = openaiBaseOf(config.baseUrl || '')
  if (!base) throw new Error('未填写 API 接口地址（baseUrl）。')
  if (!config.model) throw new Error('未填写模型名称。')
  let res: Response
  let clearTimer: (() => void) | null = null
  /** 本次逻辑调用实际发了几次请求（3.2.0 · WQ6：重试次数可核对） */
  let attempts = 0
  /** 已读取的 400 响应体 —— 不重读（流已被消费），否则错误原因会变成空串 */
  let lastErrorText = ''
  // 云端 Qwen3 系：思考开着就拿不到 content，等于静默废掉所有 AI 功能 —— 默认关掉（`think:true` 可显式保留）
  const thinkToggle = !config.local && o.think !== true && HYBRID_THINKING_RE.test(config.model)
  // 3.2.0 · WQ5：只有作者确认过端点能力才会走到这里（wireFormat 由协议层给出）
  const responseFormat = o.wireFormat === 'json-schema' && o.jsonSchema
    ? { type: 'json_schema', json_schema: { name: 'response', schema: o.jsonSchema } }
    : o.wireFormat === 'json-object' || o.wireFormat === 'json-schema'
      ? { type: 'json_object' }
      : undefined
  let flags: OpenAIFlags = { thinkToggle, sampling: true, format: !!responseFormat }
  // 请求体由开关决定：full（含 enable_thinking + temperature + 采样）→ noToggle（去 enable_thinking）
  //   → bare（再去 temperature 与采样惩罚——推理系模型（o1 / deepseek-r1 等）对 temperature ≠ 1 会直接 400；
  //     部分中转站也会拒绝不认识的字段）。响应格式是**独立**的一档，只在 400 时按需撤。
  const buildBody = (f: OpenAIFlags, stream: boolean): Record<string, unknown> => ({
    model: config.model, messages,
    ...(f.sampling ? { temperature: o.temperature, ...openaiSampling(o) } : {}),
    stream,
    ...(f.thinkToggle ? { enable_thinking: false } : {}),
    ...(f.format && responseFormat ? { response_format: responseFormat } : {}),
  })
  const doFetch = (f: OpenAIFlags) => fetchWithTimeout(
    `${base}/chat/completions`,
    {
      method: 'POST',
      // 🔴 自定义请求头统一走 mergeHeaders（3.1.1 第 4 项）：合法名放行、浏览器禁止的头不静默丢弃
      headers: mergeHeaders({
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      }, config.headers),
      body: JSON.stringify(buildBody(f, !!o.onToken)),
    },
    timeoutMs,
    o.signal,
    o.onToken ? (ct) => { clearTimer = ct } : undefined,
  )
  try {
    for (;;) {
      res = await doFetch(flags)
      attempts += 1
      if (o.disableCompatibilityRetry || res.status !== 400 || attempts >= MAX_REQUESTS_PER_CALL) break
      const txt = await res.text().catch(() => '')
      // 🔴 只降「不像别的原因」的 400 —— 模型名写错也降成裸请求的话，错误原因全变味
      if (!shouldDegradeOn400(txt)) { lastErrorText = txt; break }
      const next = nextOpenAIFlags(flags, txt)
      if (!next) { lastErrorText = txt; break }
      flags = next
    }
  } catch (e) {
    if (isCancelled(e)) throw e
    if (isAbortError(e)) throw new Error(`接口响应超时（超过 ${secs(timeoutMs)} 秒）：请检查网络；若连的是本机 / 局域网服务，确认它已经启动。`)
    throw new Error('无法连接该 API 地址：请检查网络与接口地址；若连的是本机 / 局域网服务，确认它已启动（浏览器 / 桌面端也可能因 CORS 拦下跨域请求）。')
  }
  if (!res.ok) {
    const txt = lastErrorText || await res.text().catch(() => '')
    // 3.0 · W1-3：先判「内容被平台拒绝」—— 它混在 400 / 403 里，别一律归因配置（§14.1）
    if (isRefusalStatus(res.status) && looksLikeSafetyMessage(txt)) {
      throw new AIRefusalError('safety-http', extractPlatformMessage(txt))
    }
    throw new Error(describeApiError(res.status, txt))
  }
  // 流式：边收边回调（联网模型首字出来即可见，本地慢模型不再整轮转圈）
  if (o.onToken) {
    let content = ''
    /** 3.0 · W1-3：`content_filter` 表示被内容过滤截断 —— 此前全仓不读它（§14.1） */
    let finishReason = ''
    // 3.2.0 · WQ7：兼容端点若在最后一块带 usage（需请求方要求 include_usage），有就收；
    // 不主动加那个字段 —— 中转站对未知字段很敏感，400 一次就是整轮失败。
    let streamUsage: RealUsage = {}
    let streamReport: StreamReport = { sawDone: false, chunks: 0 }
    try {
      streamReport = await readSSE(res, (obj) => {
        const chunk = obj as SseChunk
        const delta = chunk?.choices?.[0]?.delta?.content
        const fr = chunk?.choices?.[0]?.finish_reason
        if (typeof fr === 'string' && fr) finishReason = fr
        if (typeof delta === 'string' && delta) { content += delta; o.onToken!(delta) }
        streamUsage = mergeUsage(streamUsage, usageFromStreamChunk(obj, 'openai'))
      }, () => clearTimer?.(), { idleTimeoutMs: o.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS, signal: o.signal })
    } catch (e) {
      if (o.signal?.aborted) throw new AICancelled()
      // 3.2.0 · WQ1 贯通：同 Ollama 侧 —— 停滞时把已收片段挂到错误上，供调用方保留
      if (isStreamStalled(e)) { (e as AIStreamStalledError).partialText = content; throw e }
      if (isAbortError(e)) throw new Error(`接口响应超时（超过 ${secs(timeoutMs)} 秒）：请检查网络；若连的是本机 / 局域网服务，确认它已经启动。`)
      throw e
    }
    // 🔴 流里报错就不能算成功 —— 且**已收到的一半内容也不冒充完整结果**
    if (streamReport.errorMessage) {
      throw new Error(
        `接口在生成过程中报错：${streamReport.errorMessage}`
        + (content.trim() ? '（已收到的部分内容未采用，请重试）' : ''),
      )
    }
    // 3.0 · W1-3 判据①（结构化，最强）：被内容过滤截断 ⇒ 如实报「被拒」，不当正常产出用
    if (finishReason === 'content_filter') {
      throw new AIRefusalError('content-filter', '')
    }
    // 🔴 没有 `[DONE]` 说明是被对端直接收掉的：内容可用，但结束原因**未知**（方案 §16.7
    //    「已确认以正常 EOF 结束的兼容端点可接受 EOF，但记录 finishReason 未知」）
    if (!streamReport.sawDone && !finishReason && content.trim()) finishReason = 'eof'
    if (!content.trim()) {
      // 🔴 2.5.2 中转站兼容：部分中转对流式返回**非标准体**（每行 JSON.parse 失败被 readSSE
      //    静默跳过）→ content 恒为空，用户看到的就是「跑不通」。自动降级**非流式**重试一次——
      //    宁可多等一整轮，也要把「跑不通」变成「慢一点但能跑」。
      // ⚠️ 但这条是"第四条请求"：已用满预算时不再发，如实报「请求次数到了上限」。
      if (attempts >= MAX_REQUESTS_PER_CALL) {
        throw new Error(
          `接口没有返回可用内容，且本次调用已发出 ${attempts} 次请求（上限 ${MAX_REQUESTS_PER_CALL}）：`
          + '已停止重试。请确认接口地址与模型名是否匹配该中转站的文档。',
        )
      }
      attempts += 1
      const retry = await fetchWithTimeout(
        `${base}/chat/completions`,
        {
          method: 'POST',
          headers: mergeHeaders({
            'Content-Type': 'application/json',
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          }, config.headers),
          // 同一组参数换成非流式：格式开关沿用已经谈好的 flags，不再从头赌一次
          body: JSON.stringify(buildBody(flags, false)),
        },
        timeoutMs, o.signal,
      )
      if (retry.ok) {
        const data = await retry.json().catch(() => ({}))
        const c = data?.choices?.[0]?.message?.content
        if (typeof c === 'string' && c.trim()) {
          // 3.0 · W1-3：降级重试拿到的内容同样要过拒答判据（可能正是被拒的那段）
          if (looksLikeRefusalText(c)) throw new AIRefusalError('refusal-text', c.trim().slice(0, 200))
          const out = stripThink(c)
          o.onToken?.(out)
          // 一次逻辑调用发了**两次**实际请求（流式失败 + 非流式重试）—— 次数必须可核对
          return { content: out, loadMs: 0, usage: { ...usageFromOpenAI(data), attempts } }
        }
      }
      throw new Error('API 未返回内容（流式响应体无法解析，非流式重试也失败）：该接口地址可能不兼容 OpenAI 流式格式——请确认中转站文档给出的接口地址与模型名，或换官方接口测试。')
    }
    // 3.0 · W1-3 判据③（文本启发式，兜底）：200 却给一段拒答文字 ⇒ 提示作者（§14.3 ③）
    if (looksLikeRefusalText(content)) {
      throw new AIRefusalError('refusal-text', content.trim().slice(0, 200))
    }
    return {
      content: stripThink(content),
      loadMs: 0,
      usage: {
        ...streamUsage,
        ...(finishReason ? { finishReason } : {}),
        ...(attempts > 1 ? { attempts } : {}),
      },
    }
  }
  const data = await res.json().catch(() => ({}))
  const content = data?.choices?.[0]?.message?.content
  // 3.0 · W1-3：非流式同样要读 finish_reason 与拒答模板（此前只取 content）
  const finishReason = String(data?.choices?.[0]?.finish_reason ?? '')
  if (finishReason === 'content_filter') throw new AIRefusalError('content-filter', '')
  if (!content) throw new Error('API 未返回内容，请确认模型名称正确且账户有额度（也可能是模型拒绝了本次生成）。')
  if (looksLikeRefusalText(String(content))) {
    throw new AIRefusalError('refusal-text', String(content).trim().slice(0, 200))
  }
  return {
    content: stripThink(content),
    loadMs: 0,
    usage: {
      ...usageFromOpenAI(data),
      ...(finishReason ? { finishReason } : {}),
    },
  }
}

export const openaiChatDriver: ChatDriver = defineDriver({
  protocol: 'openai-chat',
  label: 'OpenAI 兼容（Chat Completions）',
  auth: 'bearer',
  systemSlot: 'messages',
  assistantRole: 'assistant',
  streamEndpoint: 'same',
  usageSource: 'openai',
  structuredWire: true,
  chat: openaiChat,
  listModels: config => listOpenAIModels(config),
})