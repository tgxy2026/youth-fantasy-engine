/**
 * AI 接入层 · 传输层（2.8.0 从 `lib/ai.ts` 拆出，见 `lib/ai.ts` 顶部说明）。
 *
 * 职责：把「发一次 HTTP、读一次 SSE 流、把失败翻译成中文」这三件事做干净，
 * 不掺业务语义（谁在调用、要什么结构，那是 `aiCore/chat.ts` 与上层的事）。
 *
 * 🔴 本文件是全项目**唯一**允许裸 `JSON.parse` 的 AI 链路文件之一（另一处是 `aiParse.ts`）：
 *    两处解析都是**传输信封**（SSE 每行 `data:{…}` / 裸 JSON 增量、服务商 HTTP 错误体），
 *    不是「模型正文 → 结构化数据」—— 后者必须走 `aiParse`。见 tests/structureGates 的 JSON_PARSE_OK。
 */

import { OLLAMA_DEFAULT_URL } from './core'
import type { AIProvider } from './core'

export function stripSlash(u: string) {
  return u.replace(/\/+$/, '')
}

/**
 * 剥离思考型模型（deepseek-r1 / qwen3-thinking / gemma-thinking 等）的思维链标签。
 * 这类模型会把内心独白裹在 <think>…</think> 里，对作者是纯噪音。
 * 若剥离后为空（模型只输出了思考没给结论），则回退返回原文，避免误判为「无返回」。
 */
export function stripThink(raw: string): string {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    // 未闭合的情况（被超时/截断）：从 <think> 起全部丢弃
    .replace(/<think>[\s\S]*$/i, '')
    .trim()
  return cleaned || raw.trim()
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message))
}

/** 作者主动点「停止」时抛出的哨兵错误：UI 不该把它当失败弹红字 */
export class AICancelled extends Error {
  constructor() {
    super('已取消')
    this.name = 'AICancelled'
  }
}
export function isCancelled(e: unknown): boolean {
  return e instanceof Error && e.name === 'AICancelled'
}

/**
 * OpenAI 兼容端点的 baseUrl 归一：剥掉误粘的 `/chat/completions` 尾段（中转站商家
 * 常给完整接口地址），得到「chat/completions 的前缀」——`/chat/completions` 与
 * `/models` 的拼接都从这里走（2.5.2 中转站兼容）。
 */
export function openaiBaseOf(raw: string): string {
  const base = stripSlash(raw || '')
  return base.endsWith('/chat/completions') ? base.slice(0, -'/chat/completions'.length) : base
}

/** 明显不是对话模型的条目（列模型时剔除）：向量化 / 画图 / 语音 / 审核类与退役补全引擎 */
const NON_CHAT_MODEL_RE = /embedding|dall-e|whisper|tts|moderation|babbage|davinci|-ada|rerank|guard|ocr|image|video|audio|sora/i

/**
 * 拉 OpenAI 兼容端点的可用模型清单（2.5.2）：`GET {base}/models`。
 * OpenAI 事实标准返回 `data[].id`；容错再认 `data[].name` 与 `models[].name` 两种形态。
 * 中转站的清单可能上百条且混入非对话模型 → 按 NON_CHAT_MODEL_RE 剔除后原序返回。
 * 失败抛中文可读原因（调用方 toast 展示，UI 保留手动填写，不阻塞配置）。
 */
export async function listOpenAIModels(config: Pick<AIProvider, 'baseUrl' | 'apiKey'>): Promise<string[]> {
  const base = openaiBaseOf(config.baseUrl)
  if (!base) throw new Error('未填写 API 接口地址（baseUrl）：先填地址再获取模型列表。')
  let res: Response
  try {
    res = await fetchWithTimeout(`${base}/models`, {
      headers: { ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
    }, 10_000)
  } catch (e) {
    if (isAbortError(e)) throw new Error('获取模型列表超时（10 秒）：请检查接口地址与网络。')
    throw new Error('无法获取模型列表：请检查接口地址与网络；浏览器 / 桌面端也可能因 CORS 拦下跨域请求。')
  }
  if (!res.ok) throw new Error(describeApiError(res.status, await res.text().catch(() => '')))
  const data = await res.json().catch(() => ({}))
  const rows: Array<Record<string, unknown>> =
    (Array.isArray(data?.data) && data.data) ||
    (Array.isArray(data?.models) && data.models) ||
    []
  const names = rows
    .map(r => String(r?.id ?? r?.name ?? '').trim())
    .filter(Boolean)
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    if (NON_CHAT_MODEL_RE.test(n)) continue
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

/**
 * 带超时的 fetch：
 * - 超时 → 内部 ctrl.abort()，调用方把 AbortError 翻译成友好超时提示；
 * - 外部 signal 触发 → 视为用户主动取消（抛 AICancelled）；
 * - 流式场景（onResponse 提供）把「清总超时定时器」交出去，由 readSSE 在收到首个 token 时调用，
 *   这样慢模型边出边显时不会被总超时一刀切中断（首字出来即代表模型活着）。
 */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, external?: AbortSignal, onResponse?: (clearTimer: () => void) => void): Promise<Response> {
  if (external?.aborted) throw new AICancelled()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onAbort = () => ctrl.abort()
  external?.addEventListener('abort', onAbort)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    if (onResponse) onResponse(() => clearTimeout(timer))
    else clearTimeout(timer)
    return res
  } catch (e) {
    clearTimeout(timer)
    if (external?.aborted) throw new AICancelled()
    throw e
  } finally {
    external?.removeEventListener('abort', onAbort)
  }
}

export function secs(ms: number) {
  return Math.round(ms / 1000)
}

/** 拉取 Ollama 本机已拉取的模型列表 */
export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const base = stripSlash(baseUrl || OLLAMA_DEFAULT_URL)
  let res: Response
  try {
    res = await fetchWithTimeout(`${base}/api/tags`, {}, 10_000)
  } catch (e) {
    if (isAbortError(e)) throw new Error('连接 Ollama 超时（10 秒）：请确认服务已启动且地址可达。')
    throw new Error('无法连接 Ollama：请确认本机已启动 Ollama（ollama serve）且地址可达（默认 http://localhost:11434）。')
  }
  if (!res.ok) throw new Error(`Ollama 返回错误（HTTP ${res.status}），请确认服务正常。`)
  const data = await res.json().catch(() => ({}))
  return (data.models ?? []).map((m: { name?: string; model?: string }) => m.name ?? m.model ?? '').filter(Boolean)
}

/**
 * 让本地 Ollama **立刻吐掉**这个模型（2026-09-16，老大反馈 #11）。
 *
 * 【解决什么】模型加载进显存后会按 keep_alive 一直挂着。作者「结束本轮对话」清理完记忆与日记后，
 * 那个模型**还带着上一场的上下文**留在显存里 —— 下一次开场它仍隐约记得刚才那些事，
 * 作者的表现就是「我明明清空了记忆，它还记得」。
 *
 * 【为什么用 `/api/generate` + `keep_alive: 0` 而不是 `ollama stop`】
 *   · `keep_alive: 0` 是官方 API 字段，跨版本稳定；`ollama stop` 是 CLI 子命令，
 *     桌面端进程里没有那条命令行可用（且要额外处理 Windows 上的路径/引号）。
 *   · 这条请求**不生成任何内容**（空 prompt + keep_alive 0）—— Ollama 收到后直接卸载并立即返回。
 *
 * 🔴 只对**本地 Ollama** 生效：云端后端（OpenAI 兼容）没有「卸载」这回事，
 *    非本地地址或非 ollama 类型一律静默跳过。调用方也**不该**因为这里失败而中断收尾流程 ——
 *    卸载是锦上添花，收尾（记忆/日记/数值）才是正事。
 *
 * @param timeoutMs 超时。卸载是收尾后的最后一件事，不值得为它多等 —— 默认 8 秒。
 * @returns 真的发出并成功了才返回 true；跳过或失败返回 false（调用方据此提示）
 */
export async function unloadOllamaModel(config: AIProvider, timeoutMs = 8_000): Promise<boolean> {
  if (!config || config.type !== 'ollama') return false
  const base = stripSlash(config.baseUrl || OLLAMA_DEFAULT_URL)
  // 只认本机地址：远程机器上的 Ollama 不归我们管（也可能是别人在用的服务）
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(base)) return false
  const model = (config.model ?? '').trim()
  if (!model) return false
  try {
    const res = await fetchWithTimeout(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: 0 }),
    }, timeoutMs)
    return res.ok
  } catch {
    return false
  }
}

// ---- 流式 SSE 解析 ----
//
// OpenAI 兼容接口：每行 `data: {json}\n`，结束发 `data: [DONE]`。
// Ollama /api/chat：每行是裸 JSON 对象（无 data: 前缀），结束对象 done:true。
// 这里写一套统一的行解析器，两种格式都吃：遇到 `data:` 前缀则剥掉；其余按裸 JSON 解析。
/**
 * SSE 增量行的形状。两家格式不同（Ollama 是 `message.content`、OpenAI 兼容是
 * `choices[0].delta.content`），故字段全可选；取到 content 后仍按 `typeof === 'string'` 把守。
 */
export type SseChunk = {
  message?: { content?: unknown }
  choices?: Array<{ delta?: { content?: unknown } }>
  done?: boolean
}

export async function readSSE(res: Response, onJson: (obj: unknown) => void, onFirstByte?: () => void): Promise<void> {
  if (!res.body) throw new Error('当前环境不支持流式读取响应体。')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let firedFirst = false
  const flushLine = (raw: string) => {
    const line = raw.trim()
    if (!line) return
    let payload = line
    if (line.startsWith('data:')) payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    try {
      onJson(JSON.parse(payload))
      if (!firedFirst) { firedFirst = true; onFirstByte?.() }
    } catch { /* 跳过无法解析的增量行，不致命 */ }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      flushLine(buf.slice(0, idx))
      buf = buf.slice(idx + 1)
    }
  }
  if (buf.trim()) flushLine(buf)
}

/**
 * 把云端 API 的失败响应翻译成「一句话原因 + 该怎么办」（2.4.0 · A1 错误映射）。
 *
 * 为什么要连服务商原话一起给：同样是 401，「密钥过期」与「少粘了一段」的处置完全不同，
 * 而各家返回体格式并不统一（`error.message` / `message` / `msg` / 纯文本都有）。
 * 所以两样都给 —— 按状态码能推出建议时给建议，抠得出原话时一并附上，作者才好定位。
 *
 * ⚠️ 这里解析的是 **HTTP 响应体**（传输层），不是「模型正文 → 结构化数据」，故不走 aiParse。
 */
export function describeApiError(status: number, raw: string): string {
  let detail = ''
  try {
    const j = JSON.parse(raw) as { error?: { message?: string }; message?: string; msg?: string }
    detail = String(j?.error?.message ?? j?.message ?? j?.msg ?? '').trim()
  } catch {
    detail = raw.trim()
  }
  const tail = detail ? `\n服务商原话：${detail.slice(0, 160)}` : ''
  switch (status) {
    case 400:
      return `请求被平台拒绝（HTTP 400）：最常见的原因是模型名不在该账户已开通的清单里，也可能是参数不被接受。${tail}`
    case 401:
      return `API 密钥无效或缺失（HTTP 401）：检查密钥是否复制完整、有没有夹带空格、是否已过期或被重置。${tail}`
    case 402:
      return `账户余额不足（HTTP 402）：请前往平台充值后重试。${tail}`
    case 403:
      return `密钥无权访问（HTTP 403）：确认这个 Key 已开通对应模型，或平台是否要求先实名 / 绑定。${tail}`
    case 404:
      return `接口地址或模型名不对（HTTP 404）：确认 baseUrl 指到 …/v1 这类 chat/completions 前缀（中转站请按其文档给的接口前缀填），并核对模型名拼写。${tail}`
    case 429:
      return `请求过于频繁或已达配额上限（HTTP 429）：稍后重试，或检查账户额度是否已用尽。${tail}`
    case 500:
    case 502:
    case 503:
    case 504:
      return `服务商端异常（HTTP ${status}）：这不是你本地配置的问题，稍后重试即可；持续报错可以换个平台。${tail}`
    default:
      return `API 调用失败（HTTP ${status}）：${detail.slice(0, 200) || '平台未返回可读原因。'}`
  }
}
