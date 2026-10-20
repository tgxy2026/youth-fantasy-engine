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

import { OLLAMA_DEFAULT_URL } from '@/lib/aiCore/core'
import { mergeHeaders } from '@/lib/aiCore/headers'
import type { AIProvider } from '@/lib/aiCore/core'

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
 * 流式输出**停滞**（3.2.0 · WQ6）。
 *
 * 🔴 为什么必须有这个错误：首 token 到达后，`chat()` 会把外层总超时清掉
 *    （否则长篇输出会被一刀切）—— 于是「服务端收了请求、发了响应头、然后不再发数据」
 *    过去会**永久挂住**，作者只能看到界面一直转圈。方案 §16.7 的验收项
 *    「首输出后停滞能结束等待」说的就是这件事。
 */
export class AIStreamStalledError extends Error {
  constructor(
    /** 判定的空闲时长（毫秒） */
    readonly idleMs: number,
    /** 停滞前已收到的增量行数（0 ＝ 连第一段内容都没来） */
    readonly chunksBeforeStall: number,
  ) {
    super(
      chunksBeforeStall > 0
        ? `模型输出停滞：已收到 ${chunksBeforeStall} 段内容后，${Math.round(idleMs / 1000)} 秒没有新数据，已停止等待。`
        : `模型 ${Math.round(idleMs / 1000)} 秒没有返回任何内容，已停止等待（可稍后重试或换模型）。`,
    )
    this.name = 'AIStreamStalledError'
  }
}
export function isStreamStalled(e: unknown): boolean {
  return e instanceof Error && e.name === 'AIStreamStalledError'
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
export async function listOpenAIModels(config: Pick<AIProvider, 'baseUrl' | 'apiKey' | 'headers'>): Promise<string[]> {
  const base = openaiBaseOf(config.baseUrl)
  if (!base) throw new Error('未填写 API 接口地址（baseUrl）：先填地址再获取模型列表。')
  let res: Response
  try {
    res = await fetchWithTimeout(`${base}/models`, {
      // 自定义请求头同样要带上 —— 否则「获取可用模型」这条通路会先 400（见 lib/aiCore/headers.ts）
      headers: mergeHeaders({ ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) }, config.headers),
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
  /** finish_reason 也在 choices[0] 上 —— 3.0 · W1-3 用它识别 `content_filter` 截断 */
  choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>
  done?: boolean
}

export interface ReadSseOptions {
  /**
   * 空闲超时（毫秒，3.2.0 · WQ6）：**有进展**才重置。
   * 省略或 0 ⇒ 不设（与旧行为一致）；生产路径传 `STREAM_IDLE_TIMEOUT_MS`。
   */
  idleTimeoutMs?: number
}

/**
 * 流式空闲超时的默认值。
 *
 * 🔴 取 120 秒而不是 30 秒（方案 §16.7「流式空闲初始建议 120 秒」）：
 *    本机 27B 在思考阶段可能几十秒不吐增量，30 秒会把**正常慢模型**判成停滞 ——
 *    那是比"偶尔多等一会儿"更糟的错误（作者会以为模型坏了）。
 *    真正断流的端点不会因为放宽到 120 秒而变得更难发现：它一秒数据都不会再来。
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000

export async function readSSE(
  res: Response,
  onJson: (obj: unknown) => void,
  onFirstByte?: () => void,
  opts: ReadSseOptions = {},
): Promise<void> {
  if (!res.body) throw new Error('当前环境不支持流式读取响应体。')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let firedFirst = false
  /** 解析成功（＝真实进展）的增量行数 */
  let parsedChunks = 0
  const idle = opts.idleTimeoutMs ?? 0
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 停滞时用来把 `reader.read()` 的等待打断 */
  let rejectIdle: ((e: Error) => void) | null = null

  const disarm = () => { if (timer) { clearTimeout(timer); timer = null } }
  /**
   * 重新计时。
   * 🔴 只在**解析出增量**时调用 —— 心跳/注释行（`: ping`）不算进展，
   *    否则一个每隔 10 秒发心跳的端点能让任务无限挂着（方案 §16.7 明确禁止）。
   */
  const arm = () => {
    if (idle <= 0) return
    disarm()
    timer = setTimeout(() => {
      timer = null
      rejectIdle?.(new AIStreamStalledError(idle, parsedChunks))
    }, idle)
  }

  const flushLine = (raw: string) => {
    const line = raw.trim()
    if (!line) return
    let payload = line
    if (line.startsWith('data:')) payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    try {
      onJson(JSON.parse(payload))
      parsedChunks += 1
      arm()
      if (!firedFirst) { firedFirst = true; onFirstByte?.() }
    } catch { /* 跳过无法解析的增量行，不致命（也不当作进展） */ }
  }

  arm()
  try {
    for (;;) {
      const { done, value } = idle > 0
        ? await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          rejectIdle = reject
          reader.read().then(resolve, reject)
        })
        : await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        flushLine(buf.slice(0, idx))
        buf = buf.slice(idx + 1)
      }
    }
    if (buf.trim()) flushLine(buf)
  } catch (e) {
    // 停滞 / 取消：把读取器放掉，别让底层连接悬着
    if (idle > 0) { try { await reader.cancel() } catch { /* 忽略 */ } }
    throw e
  } finally {
    disarm()
    rejectIdle = null
  }
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
// ============ 3.0 · W1-3 模型「拒答」感知（§14）============
//
// 🔴 背景（2026-10-10 源码自查）：全仓**零读取** `finish_reason`；平台把「内容政策拒绝」也走
//    400 / 403，而 `describeApiError` 只按状态码给建议 ⇒ 作者被引向「查模型名 / 密钥」，
//    其实内容是敏感的。本段提供**判据 + 结构化信号**，上层据此给「被拒」而非「配置错」的提示。
//
// 🔴 边界（§14.3）：只做「**如实反馈 + 让作者自己决定**」，不做任何「绕过 / 反检测 / 洗提示词」。

/** 常见平台的安全类关键词（出现在**错误响应体**里即判「内容被平台拒绝」） */
const SAFETY_MESSAGE_PATTERNS: RegExp[] = [
  /content[_ -]?policy/i, /data[_ ]?inspection[_ ]?failed/i, /sensitive/i,
  /prohibited/i, /moderation/i, /flagged/i, /unsafe/i, /risk[_ ]?control/i,
  /内容(安全|审核|政策|违规|不合规)/, /违规内容/, /敏感(内容|词|信息)/, /安全策略/, /风控/,
]

/** 拒答模板文本（HTTP 200 却给一段「我无法…」时用它兜底） */
const REFUSAL_TEXT_PATTERNS: RegExp[] = [
  /^抱歉[，,]?\s*(我|作为)/, /作为(一个)?(AI|人工智能|语言模型)/,
  /我(无法|不能|不便|不适合)(提供|生成|协助|回答|完成|继续)/,
  /^(I'?m sorry|I am sorry|I can'?t|I cannot|I'?m unable)/i, /as an AI/i, /I (must|have to) (decline|refuse)/i,
]

/** 这些 HTTP 状态**可能**承载「内容被拒」（需再看响应体关键词才能定） */
export function isRefusalStatus(status: number): boolean {
  return status === 400 || status === 403 || status === 422 || status === 451
}

/** 错误响应体是否含安全类关键词（配合 {@link isRefusalStatus} 用） */
export function looksLikeSafetyMessage(raw: string): boolean {
  return SAFETY_MESSAGE_PATTERNS.some(re => re.test(raw ?? ''))
}

/**
 * 一段文本是否像「拒答模板」。
 * 🔴 只取开头 200 字判 + **只提示不自动丢弃** —— 启发式必然有误报 / 漏报（§14.3 ③）。
 */
export function looksLikeRefusalText(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  return REFUSAL_TEXT_PATTERNS.some(re => re.test(t.slice(0, 200)))
}

/** 从响应体里抠出「平台原话」（有则给作者，无则退化为纯文本截断） */
export function extractPlatformMessage(raw: string): string {
  try {
    const j = JSON.parse(raw) as { error?: { message?: string }; message?: string; msg?: string }
    const m = String(j?.error?.message ?? j?.message ?? j?.msg ?? '').trim()
    if (m) return m
  } catch { /* 非 JSON，按纯文本处理 */ }
  return (raw ?? '').trim().slice(0, 300)
}

export type RefusalKind = 'content-filter' | 'safety-http' | 'refusal-text'

/** 结构化「拒答信号」—— 让上层能分辨「被拒」与「配置错」，而不是一律当通用错误 */
export class AIRefusalError extends Error {
  readonly kind: RefusalKind
  readonly platformMessage: string
  constructor(kind: RefusalKind, platformMessage: string) {
    super(describeRefusal(kind, platformMessage))
    this.name = 'AIRefusalError'
    this.kind = kind
    this.platformMessage = platformMessage
  }
}

export function isRefusal(e: unknown): e is AIRefusalError {
  return e instanceof AIRefusalError
}

/** 给作者看的「被拒」文案（三件事：不是配置错 / 平台原话 / 可行动作） */
export function describeRefusal(kind: RefusalKind, platformMessage: string): string {
  const where = kind === 'content-filter'
    ? '模型在生成过程中被内容过滤截断（finish_reason = content_filter）'
    : kind === 'safety-http'
      ? '平台直接拒绝了这次请求（状态码属拒绝类，且响应含安全政策关键词）'
      : '模型返回的是一段拒答文字，而不是正文'
  const tail = platformMessage ? `\n平台原话：${platformMessage.slice(0, 200)}` : ''
  return '⚠️ 这次请求被平台以「内容政策」为由拒绝 —— **不是你的密钥 / 模型名 / 参数配置出错**。\n'
    + `判定依据：${where}。${tail}\n`
    + '可试试：① 改掉可能触发的内容点后重试；② 换本地模型（本地 Ollama 不受平台内容政策限制）；③ 换一个平台。'
}

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
      // 3.0 · W1-3：内容政策拒绝也走 400 —— 先分流，别把作者引向「模型名 / 参数」的错误方向
      if (looksLikeSafetyMessage(raw)) {
        return `请求被平台拒绝（HTTP 400）：**这是内容被平台拒绝**，不是模型名 / 参数配置出错。${tail}\n可试试：改掉触发的敏感点后重试 / 换本地模型（不受平台内容政策限制）/ 换一个平台。`
      }
      return `请求被平台拒绝（HTTP 400）：最常见的原因是模型名不在该账户已开通的清单里，也可能是参数不被接受。${tail}`
    case 401:
      return `API 密钥无效或缺失（HTTP 401）：检查密钥是否复制完整、有没有夹带空格、是否已过期或被重置。${tail}`
    case 402:
      return `账户余额不足（HTTP 402）：请前往平台充值后重试。${tail}`
    case 403:
      // 3.0 · W1-3：部分平台用 403 表达「内容被拒」—— 先分流，别一律归因密钥
      if (looksLikeSafetyMessage(raw)) {
        return `请求被平台拒绝（HTTP 403）：**这是内容被平台拒绝**（部分平台用 403 表达），不是密钥权限问题。${tail}\n可试试：改掉触发的敏感点后重试 / 换本地模型 / 换一个平台。`
      }
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
