// AI 模型接入抽象层
//
// 设计目标（v1）：
// - 本地 Ollama：免密钥，调用 /api/chat，适合离线、隐私优先的辅助创作。
// - 联网 OpenAI 兼容接口：Bearer 密钥，调用 /chat/completions；
//   国内主流平台（DeepSeek / 通义千问 / 智谱 GLM / 豆包 / Kimi / MiniMax 等）
//   均提供 OpenAI 兼容端点，用「预设」一键填好 baseUrl 即可。
// - 配置走现有 db.settingsKV（web/便携/桌面三端通用），不另起存储。
//
// 注意：浏览器 / Electron 渲染进程直接 fetch 外部地址可能受 CORS 限制，
// 这是平台侧策略，本层只负责把错误翻译成可读中文提示。

import * as db from './db'
import { parsePlainObject } from './aiParse'

export type AIProviderType = 'ollama' | 'openai'

export interface AIProvider {
  id: string
  /** 用户自定义显示名 */
  name: string
  type: AIProviderType
  /** Ollama 默认 http://localhost:11434；OpenAI 兼容填到 …/v1 之类前缀 */
  baseUrl: string
  apiKey: string
  /** Ollama 用 /api/tags 拉到的本地模型名；OpenAI 兼容自由填写（如 deepseek-chat） */
  model: string
  /**
   * 是否为本机 / 局域网 OpenAI 兼容服务（LM Studio / LocalAI / GPT4All / Jan 等）。
   * true 时 precheck 不强制要求 apiKey（本地服务大多免密钥）；并与 ollama 一并标记为「本地」。
   */
  local?: boolean
  /** 用户自定义系统提示词：追加到各功能自带系统提示词之后，不覆盖、不影响原指令与格式约束 */
  systemPrompt?: string
  /**
   * 该模型的上下文窗口（tokens）。**选填**，只在「云端 OpenAI 兼容端点」时才有意义：
   * 本地 Ollama 的 num_ctx 由显存决定（见 lib/modelCapacity.ts），云端则由服务商决定，
   * 且没有统一的查询接口 —— 所以允许手填。留空时按 model 名去预设表里认，认不出走保守兜底。
   */
  contextWindow?: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export const OLLAMA_DEFAULT_URL = 'http://localhost:11434'

/** 正文生成默认超时：本地大参数模型首字延迟可能很久，给足时间 */
export const CHAT_TIMEOUT_MS = 180_000
/** 连通性测试超时：只让模型回两个字，但本地模型可能要先加载进显存 */
export const TEST_TIMEOUT_MS = 90_000

/** 创意类生成（续写 / 取名 / 灵感）默认温度 */
export const DEFAULT_TEMPERATURE = 0.85
/** 结构化 JSON 任务（校对 / 审读 / 改稿 / 抽取）专用：低温换取格式稳定 */
export const JSON_TASK_TEMPERATURE = 0.3

/** 国内 / 国际 OpenAI 兼容平台预设（baseUrl 为 chat/completions 的前缀） */
export interface PlatformPreset {
  label: string
  baseUrl: string
  /** 是否为本机 / 局域网服务（免密钥） */
  local?: boolean
  /** 该预设对应的 provider 类型：'ollama' 走原生 /api/chat；'openai'（默认）走 OpenAI 兼容 */
  type?: AIProviderType
}

/** Ollama 本地预设：原生 API，单独用 type:'ollama' 走 /api/chat 路径 */
export const OLLAMA_PRESET: PlatformPreset = { label: 'Ollama（本地）', baseUrl: OLLAMA_DEFAULT_URL, local: true, type: 'ollama' }

/** 本地 OpenAI 兼容服务预设（baseUrl 为本机端口，一般无需密钥，type 默认 openai）。
 *  这些服务都暴露 OpenAI 兼容的 /v1 接口，走与「联网模型」完全相同的调用路径，
 *  仅用 local 标记免除密钥要求并归类为「本地」。 */
export const LOCAL_OPENAI_PRESETS: PlatformPreset[] = [
  { label: 'LM Studio（本地）', baseUrl: 'http://localhost:1234/v1', local: true },
  { label: 'LocalAI（本地）', baseUrl: 'http://localhost:8080/v1', local: true },
  { label: 'GPT4All（本地）', baseUrl: 'http://localhost:4891/v1', local: true },
  { label: 'Jan（本地）', baseUrl: 'http://localhost:1337/v1', local: true },
  { label: 'TextGen WebUI（本地）', baseUrl: 'http://localhost:5000/v1', local: true },
]

/** 全部本地平台预设（Ollama + 本地 OpenAI 兼容），用于绿色「添加本地模型」按钮 */
export const LOCAL_PRESETS: PlatformPreset[] = [OLLAMA_PRESET, ...LOCAL_OPENAI_PRESETS]

/** 联网 OpenAI 兼容平台预设（需 API 密钥，baseUrl 为 chat/completions 前缀） */
export const ONLINE_PRESETS: PlatformPreset[] = [
  { label: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { label: '通义千问 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { label: '豆包 Doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { label: 'Kimi 月之暗面', baseUrl: 'https://api.moonshot.cn/v1' },
  { label: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1' },
  { label: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1' },
  { label: '百川智能', baseUrl: 'https://api.baichuan-ai.com/v1' },
  { label: '零一万物', baseUrl: 'https://api.lingyiwanwu.com/v1' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { label: '自定义', baseUrl: '' },
]

/** 由平台预设生成一条未保存的 provider 草稿（类型 / 本地标记自动带好） */
export function providerFromPreset(p: PlatformPreset): AIProvider {
  const id = 'p_' + Math.random().toString(36).slice(2, 9)
  const isOllama = p.type === 'ollama'
  const name = (p.label.replace(/（本地）|（联网）|\(local\)/gi, '').trim()) || (isOllama ? '本地 Ollama' : '联网模型')
  return {
    id,
    name,
    type: isOllama ? 'ollama' : 'openai',
    baseUrl: p.baseUrl,
    apiKey: '',
    model: '',
    local: p.local ?? isOllama,
  }
}

/**
 * 组合系统提示词：把「用户自定义系统提示词」追加到「功能自带的系统提示词」之后。
 * 设计要点（用户要求）：
 * - 用户没填 → 仅用功能预设，行为与原先完全一致；
 * - 用户填了 → 附加在原本指令之后，作为「总体补充」，不覆盖、不破坏各功能的格式约束与铁律；
 * - 因此无论用户写什么，校对 / 补全 / 整理 / 对话等原有功能都不会受影响。
 */
export function composeSystemPrompt(featureSys: string, provider?: AIProvider | null): string {
  const base = featureSys || ''
  const custom = provider?.systemPrompt?.trim()
  if (!custom) return base
  return `${base}\n\n【作者自定义系统提示词（请在遵循以上全部规则的前提下一并考虑）】\n${custom}`
}

function stripSlash(u: string) {
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

function isAbortError(e: unknown): boolean {
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
 * 带超时的 fetch：
 * - 超时 → 内部 ctrl.abort()，调用方把 AbortError 翻译成友好超时提示；
 * - 外部 signal 触发 → 视为用户主动取消（抛 AICancelled）；
 * - 流式场景（onResponse 提供）把「清总超时定时器」交出去，由 readSSE 在收到首个 token 时调用，
 *   这样慢模型边出边显时不会被总超时一刀切中断（首字出来即代表模型活着）。
 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, external?: AbortSignal, onResponse?: (clearTimer: () => void) => void): Promise<Response> {
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

function secs(ms: number) {
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

export interface ChatOptions {
  /** 超时毫秒，默认 CHAT_TIMEOUT_MS */
  timeoutMs?: number
  /**
   * 【推荐用于结构化任务，而非直接调 temperature】标记本次调用是结构化 JSON 任务。
   *
   * 置 true 时，未显式指定 temperature 的调用会自动采用 JSON_TASK_TEMPERATURE（0.3 低温）。
   *
   * 之所以做成语义开关而不是让调用方直接填温度：温度是"可选参数"，靠每个任务函数自觉
   * 传值，一旦有人漏传就会静默退回 0.85 创意温度——2026-09-14 审计即发现 aiTasks.ts 内
   * 20 处 chat 调用只有 1 处传了低温，其余 14 个 JSON 任务全跑在创意温度上，而本文件
   * 注释早已写明"必须显式传低值"。把判断收进 chat 内部、任务层只声明"我是 JSON 任务"，
   * 才能从机制上堵住漏传（新增任务也不例外）。
   */
  json?: boolean
  /**
   * 采样温度，默认按 DEFAULT_TEMPERATURE（0.85，偏创意）；
   * 若同时传了 json:true 且未显式给 temperature，则默认改用 JSON_TASK_TEMPERATURE（0.3）。
   * 结构化任务建议只传 json:true，不要各自硬填温度。
   */
  temperature?: number
  /**
   * 额外采样参数（键名用**目标接口的原生名字**，值必须是数字）。
   *
   * 为什么留这个口子：top_k / repeat_penalty / num_ctx 只有 Ollama 认，
   * 而 OpenAI 兼容端点认的是 top_p / presence_penalty / frequency_penalty，
   * 两边字段名不一致，故不做改名、由调用方按目标接口给键 ——
   * openaiChat 只转发白名单内的键，其余丢弃，免得把 Ollama 专有字段发过去被端点拒掉。
   *
   * ⚠️ 在此之前，酒馆模式的 top_p / top_k / 重复惩罚 / presence_penalty / num_ctx
   * **一个都没真正下发过**（只有 temperature 能过 chat）—— params.ts 的 toOllamaOptions
   * 此前是死代码。这是本次补上的。
   */
  extraOptions?: Record<string, number>
  /**
   * 是否关闭思考型模型的思维链输出：
   * - false：关闭（仅用于连通性测试等需要极速反馈的场景）
   * - true / undefined：不传该字段，交给模型/平台默认
   * 关键约定：think:false 只允许在 testProvider 等明确场景使用；正文生成、设定补全
   * 等需要推理深度的地方必须保持默认（undefined），切勿全局关闭——否则 deepseek-r1 /
   * gemma4 / qwen3.5 等会失去思考过程，补全质量直线下降。
   * ⚠️ 例外：酒馆模式（扮演对话）是**有意**全局关闭的（见 TavernSettings.common.disableThink，默认 true）
   *    —— 那边要的是稳定人物口吻而非推理链，别照本条去「修正」掉它。
   * ⚠️ 例外二：AI 伴写（aiTasks.aiInlineSuggest）同样**有意**关闭 —— 它只续写一句话、要求「停笔即出」，
   *    思考链既把延迟从 1~3s 拖到十几秒（ghost 体验直接崩），又可能经 ollamaChatRaw 的
   *    「content 为空则退用 thinking」兜底被当成续写内容透出来。它要的是顺手接一句，不是推理。
   * ⚠️ 例外三：**云端 OpenAI 兼容通道 + 混合思考模型（Qwen3 系）由 `openaiChat` 自动关思考**
   *    —— 同上，不是偏好而是可用性：那边思考不进 `content` 且吃光输出预算，
   *    开着等于让所有 AI 功能静默失败。实测数据见 `HYBRID_THINKING_RE` 上方注释。
   *    这条**别按上面那句「切勿全局关闭」去改回来** —— 它只作用于云端 Qwen3，不碰本地。
   */
  think?: boolean
  /** 外部取消信号（对话面板的「停止」按钮） */
  signal?: AbortSignal
  /** 流式输出回调：提供时开启 SSE 流式，逐块收到模型输出（已剥离思考块）。不提供则走普通一次性返回。 */
  onToken?: (delta: string) => void
}

interface ChatRaw {
  content: string
  /** Ollama 把模型加载进显存的耗时（毫秒）；联网接口无此概念，恒为 0 */
  loadMs: number
}

/** 内部调用参数：统一成对象，避免位置参数越加越乱 */
interface CallOpts {
  timeoutMs: number
  think?: boolean
  signal?: AbortSignal
  /** 流式回调：提供时开启 SSE 流式 */
  onToken?: (delta: string) => void
  /** 采样温度。**必填**：由 chat() 统一解析后传入，是唯一真源；下游不再各自做缺省判断。 */
  temperature: number
  /** 额外采样参数（见 ChatOptions.extraOptions）：原样并入 Ollama 的 options，OpenAI 侧只转发白名单 */
  extraOptions?: Record<string, number>
}

/** 内部统一分发：带元信息，供测试面板展示「其中加载耗时」 */
async function chatRaw(config: AIProvider, messages: ChatMessage[], o: CallOpts): Promise<ChatRaw> {
  if (config.type === 'ollama') return ollamaChatRaw(config, messages, o)
  return { content: await openaiChat(config, messages, o), loadMs: 0 }
}

// ---- 流式 SSE 解析 ----
//
// OpenAI 兼容接口：每行 `data: {json}\n`，结束发 `data: [DONE]`。
// Ollama /api/chat：每行是裸 JSON 对象（无 data: 前缀），结束对象 done:true。
// 这里写一套统一的行解析器，两种格式都吃：遇到 `data:` 前缀则剥掉；其余按裸 JSON 解析。
async function readSSE(res: Response, onJson: (obj: unknown) => void, onFirstByte?: () => void): Promise<void> {
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

/** 统一对话入口：按 provider.type 分发 */
export async function chat(config: AIProvider, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  // 注意：opts.think 默认 undefined → ollamaChatRaw 不传 think 字段，思考型模型保持思考。
  // 温度在此处统一解析（唯一真源）：显式 temperature 优先；否则按是否 JSON 任务取默认值。
  // 下游 ollamaChatRaw / openaiChat 只管用 o.temperature，不再各自做缺省判断。
  const temperature = opts.temperature ?? (opts.json ? JSON_TASK_TEMPERATURE : DEFAULT_TEMPERATURE)
  return (await chatRaw(config, messages, {
    timeoutMs: opts.timeoutMs ?? CHAT_TIMEOUT_MS,
    think: opts.think,
    signal: opts.signal,
    onToken: opts.onToken,
    temperature,
    extraOptions: opts.extraOptions,
  })).content
}

async function ollamaChatRaw(config: AIProvider, messages: ChatMessage[], o: CallOpts): Promise<ChatRaw> {
  const { timeoutMs, think } = o
  const base = stripSlash(config.baseUrl || OLLAMA_DEFAULT_URL)
  if (!config.model) throw new Error('未选择 Ollama 模型，请先到「灵感启发 → 模型配置」拉取并选择本地模型。')
  // 构建请求体：仅在显式要求关闭思考时传 think:false（连通性测试等极速反馈场景）。
  // 正常创作生成不传该字段，由模型/平台默认——思考型模型（deepseek-r1 / gemma4 / qwen3.5）保持思考，利于深度设定补全。
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: !!o.onToken,
    options: { temperature: o.temperature, ...(o.extraOptions ?? {}) },
  }
  if (think === false) body.think = false
  let res: Response
  let clearTimer: (() => void) | null = null
  try {
    res = await fetchWithTimeout(
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
  } catch (e) {
    if (isCancelled(e)) throw e
    if (isAbortError(e)) {
      throw new Error(
        `Ollama 响应超时（超过 ${secs(timeoutMs)} 秒）。大参数模型首次调用需加载进显存，可稍后重试；` +
        '若长期超时，建议换用更小的模型或确认显存是否足够。',
      )
    }
    throw new Error('无法连接 Ollama：请确认本机已启动 Ollama（ollama serve）且地址正确（默认 http://localhost:11434）。')
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    if (res.status === 404) throw new Error(`模型「${config.model}」不存在（HTTP 404），请确认已执行 ollama pull ${config.model}。`)
    throw new Error(`Ollama 调用失败（HTTP ${res.status}）：${txt.slice(0, 200)}`)
  }
  // 流式：边读边回调，本地大参数模型首字出来就不转圈
  if (o.onToken) {
    let content = ''
    try {
      await readSSE(res, (obj: any) => {
        const delta = obj?.message?.content
        if (typeof delta === 'string' && delta) { content += delta; o.onToken!(delta) }
      }, () => clearTimer?.())
    } catch (e) {
      if (o.signal?.aborted) throw new AICancelled()
      if (isAbortError(e)) throw new Error(`Ollama 响应超时（超过 ${secs(timeoutMs)} 秒）。大参数模型首次调用需加载进显存，可稍后重试；若长期超时建议换用更小的模型。`)
      throw e
    }
    if (!content.trim()) throw new Error('Ollama 未返回内容，请确认模型名称正确且已拉取（ollama pull <模型名>）。')
    return { content: stripThink(content), loadMs: 0 }
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
  return { content: stripThink(content), loadMs: Number.isFinite(loadMs) ? loadMs : 0 }
}

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
const HYBRID_THINKING_RE = /(^|[/_\-. ])(qwen3|qwen-3|qwq)/i

function openaiSampling(o: CallOpts): Record<string, number> {
  const src = o.extraOptions
  if (!src) return {}
  const out: Record<string, number> = {}
  for (const k of OPENAI_SAFE_SAMPLING) {
    if (typeof src[k] === 'number' && Number.isFinite(src[k])) out[k] = src[k]
  }
  return out
}

async function openaiChat(config: AIProvider, messages: ChatMessage[], o: CallOpts): Promise<string> {
  const { timeoutMs } = o
  const rawBase = stripSlash(config.baseUrl || '')
  if (!rawBase) throw new Error('未填写 API 接口地址（baseUrl）。')
  const base = rawBase
  if (!config.model) throw new Error('未填写模型名称。')
  let res: Response
  let clearTimer: (() => void) | null = null
  // 云端 Qwen3 系：思考开着就拿不到 content，等于静默废掉所有 AI 功能 —— 默认关掉（`think:true` 可显式保留）
  const thinkToggle = !config.local && o.think !== true && HYBRID_THINKING_RE.test(config.model)
  const doFetch = (withToggle: boolean) => fetchWithTimeout(
    `${base}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model, messages, temperature: o.temperature,
        ...openaiSampling(o),
        stream: !!o.onToken,
        ...(withToggle ? { enable_thinking: false } : {}),
      }),
    },
    timeoutMs,
    o.signal,
    o.onToken ? (ct) => { clearTimer = ct } : undefined,
  )
  try {
    res = await doFetch(thinkToggle)
    // 该端点不认 enable_thinking（返回 400）→ 丢掉这个字段重试一次。
    // 宁可少一个优化，也绝不因为多发一个字段把功能弄坏。
    if (res.status === 400 && thinkToggle) {
      await res.text().catch(() => '')
      res = await doFetch(false)
    }
  } catch (e) {
    if (isCancelled(e)) throw e
    if (isAbortError(e)) throw new Error(`接口响应超时（超过 ${secs(timeoutMs)} 秒），请检查网络或稍后重试。`)
    throw new Error('无法连接该 API 地址，请检查网络与接口地址（浏览器/桌面端可能因 CORS 拦截跨域请求）。')
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    if (res.status === 401) throw new Error('API 密钥无效或缺失（HTTP 401）。')
    if (res.status === 402) throw new Error('账户余额不足（HTTP 402），请前往平台充值后重试。')
    if (res.status === 404) throw new Error('接口地址或路径不正确（HTTP 404），请确认 baseUrl 指向 …/v1 之类的 chat/completions 前缀。')
    if (res.status === 429) throw new Error('请求过于频繁或已达配额上限（HTTP 429），请稍后重试。')
    throw new Error(`API 调用失败（HTTP ${res.status}）：${txt.slice(0, 200)}`)
  }
  // 流式：边收边回调（联网模型首字出来即可见，本地慢模型不再整轮转圈）
  if (o.onToken) {
    let content = ''
    try {
      await readSSE(res, (obj: any) => {
        const delta = obj?.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta) { content += delta; o.onToken!(delta) }
      }, () => clearTimer?.())
    } catch (e) {
      if (o.signal?.aborted) throw new AICancelled()
      if (isAbortError(e)) throw new Error(`接口响应超时（超过 ${secs(timeoutMs)} 秒），请检查网络或稍后重试。`)
      throw e
    }
    if (!content.trim()) throw new Error('API 未返回内容，请确认模型名称正确且账户有额度。')
    return stripThink(content)
  }
  const data = await res.json().catch(() => ({}))
  const content = data?.choices?.[0]?.message?.content
  if (!content) throw new Error('API 未返回内容，请确认模型名称正确且账户有额度。')
  return stripThink(content)
}

// ---- 连通性测试 ----

export interface AITestResult {
  ok: boolean
  /** 往返总耗时（毫秒） */
  latencyMs: number
  /** 其中「模型加载进显存」的耗时（毫秒，仅本地 Ollama 有值） */
  loadMs: number
  /** 成功时模型的实际回文（已剥离思考块） */
  reply: string
  /** 失败时的中文可读原因 */
  error: string
}

/** 测试前的本地校验：缺字段就别浪费一次网络往返 */
function precheck(config: AIProvider): string {
  if (config.type === 'ollama') {
    if (!config.model.trim()) return '未选择模型：请先「获取本地模型」并选择一个，或手动填写模型名。'
    return ''
  }
  if (!config.baseUrl.trim()) return '未填写 API 接口地址（baseUrl）。'
  if (!config.model.trim()) return '未填写模型名称。'
  // 本地 OpenAI 兼容服务（LM Studio / LocalAI 等）大多免密钥，故仅联网模型强制要求密钥
  if (!config.local && !config.apiKey.trim()) return '未填写 API 密钥（本地兼容服务可留空）。'
  return ''
}

/**
 * 真实发一次最小对话，验证「配置能否正常拉起该模型并交互」。
 * 不抛异常——统一返回结构化结果，便于 UI 直接渲染成功 / 失败反馈。
 */
export async function testProvider(config: AIProvider): Promise<AITestResult> {
  const pre = precheck(config)
  if (pre) return { ok: false, latencyMs: 0, loadMs: 0, reply: '', error: pre }
  const t0 = Date.now()
  try {
    // 连通性测试：只要两个字，用创意温度无妨（此处不涉及结构化解析）
    const raw = await chatRaw(config, [{ role: 'user', content: '请只回复两个字：ok' }], { timeoutMs: TEST_TIMEOUT_MS, think: false, temperature: DEFAULT_TEMPERATURE })
    const text = raw.content.trim()
    const latencyMs = Date.now() - t0
    if (!text) return { ok: false, latencyMs, loadMs: raw.loadMs, reply: '', error: '模型返回了空内容，可能未正确加载，建议重试或更换模型。' }
    return { ok: true, latencyMs, loadMs: raw.loadMs, reply: text, error: '' }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, loadMs: 0, reply: '', error: e instanceof Error ? e.message : String(e) }
  }
}

// ---- 设定模板 AI 补全 ----

export interface TemplateField {
  /** 内部字段 key（卡片/表单型为 `模块名::字段名`，表格型为列名） */
  key: string
  /** 展示名（中文） */
  label: string
  desc?: string
  example?: string
  /** 锁定字段：不发给模型、不随补全写入（如自动编号），仅在预览中展示 */
  locked?: boolean
}

export interface TemplateFillResult {
  /** key -> 模型补全的值（仅非锁定、且模型实际产出的字段） */
  values: Record<string, string>
  /** 由 AI 补全的字段 key 列表（前端高亮「AI补全」徽标用） */
  aiFilled: string[]
}

/**
 * 构建世界观上下文摘要，供补全时保证一致性。
 * v1：抽取表单型「世界设定 / 力量体系 / 作品定位」的关键字段，作为模型补全的约束。
 */
export async function buildWorldContext(): Promise<string> {
  const pick = (data: Record<string, string> | undefined, names: string[]): string[] => {
    if (!data) return []
    const out: string[] = []
    for (const n of names) {
      const v = Object.entries(data)
        .map(([k, val]) => (k.endsWith(`::${n}`) || k === n ? val : ''))
        .find(Boolean)
      if (v && v.trim()) out.push(`${n}：${v.trim()}`)
    }
    return out
  }
  const [world, power, pos] = await Promise.all([
    db.getFormData('worldbase').catch(() => undefined),
    db.getFormData('power').catch(() => undefined),
    db.getFormData('positioning').catch(() => undefined),
  ])
  const lines: string[] = []
  lines.push(...pick(world, ['世界名称', '一句话世界观', '文明程度', '当前时代背景', '世界核心规则']))
  lines.push(...pick(power, ['体系名称', '体系类型', '力量来源与路线', '力量的限制规则']))
  lines.push(...pick(pos, ['书名', '类型赛道', '核心卖点', '一句话简介']))
  return lines.join('\n')
}

/**
 * 设定模板补全：把字段清单 + 草图（+ 可选的世界观上下文与外部素材）发给当前 AI 模型，
 * 返回结构化结果。内部自取当前模型配置（loadProviders + loadActiveId），调用方无需关心 provider。
 *
 * 外部素材＝联网检索结果或作者粘贴的参考（见 `draftMaterial.ts`）。它单独成块而不是并进
 * 「世界观上下文」：一个是**本项目已有的设定**，一个是**外面查来的资料**，冲突时该听谁不一样。
 */
export async function aiCompleteTemplate(
  fields: TemplateField[],
  sketch: string,
  opts: {
    worldContext?: string
    /** 外部素材（联网检索结果 / 作者粘贴的参考，已拼好的块）—— 有就优先依据它 */
    material?: string
    onToken?: (delta: string) => void
  } = {},
): Promise<TemplateFillResult> {
  const cfg = await requireActiveProvider()
  const send = fields.filter(f => !f.locked)

  const fieldList = send
    .map((f, i) => {
      const bits = [`${i + 1}. [${f.label}]`]
      if (f.desc) bits.push(`说明：${f.desc}`)
      if (f.example) bits.push(`示例：${f.example}`)
      return bits.join(' ')
    })
    .join('\n')

  const sys = `你是「青春幻想引擎」的小说设定辅助助手。作者会给你一份设定模板的字段清单和一段粗略草图，请把草图整理成一份完整、合理的设定，逐项填入模板字段。规则：
1. 严格按字段清单返回，使用给定的编号作为 JSON key（如 {"1":"...","2":"..."}）。
2. 只补全"设定/世界观/人物/道具"等元信息，绝不写剧情正文、不写章节内容。
3. 草图中作者已明确说出的信息（名字、身份、定位等），保留原意，不要篡改或擅加矛盾设定。
4. 草图未提及的字段，基于【世界观上下文】与【外部素材】（若有）以及网文设定常识合理补全，确保与上下文及字段间内部一致。
5. 【外部素材】优先于你的记忆 —— 它是作者提供的、或刚从网上查到的资料。冲突时以素材为准；素材里没有的具体事实（数字、日期、专有名词）不要编，宁可写得笼统。
6. 对需要作者特别注意/确认的地方，可在该字段值末尾用「（建议确认：…）」提示，但不要滥用。
7. 只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码块标记、不要多余文字。
8. 若某字段确实无从补全，给一个合理的占位或留空字符串 ""，不要编造明显荒谬的内容。`

  const user = `【字段清单】
${fieldList}

【世界观上下文】
${opts.worldContext && opts.worldContext.trim() ? opts.worldContext.trim() : '（无）'}

【外部素材】
${opts.material && opts.material.trim() ? opts.material.trim() : '（无）'}

【作者草图】
${sketch && sketch.trim() ? sketch.trim() : '（作者未提供草图，请基于世界观上下文合理补全一份）'}

请返回补全后的 JSON（只输出这一个对象，不要解释、不要 Markdown 代码块标记）。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    { timeoutMs: CHAT_TIMEOUT_MS, onToken: opts.onToken },
  )

  const parsed = parseTemplateJSON(text, send)
  const values: Record<string, string> = {}
  const aiFilled: string[] = []
  parsed.forEach((val, i) => {
    const key = send[i].key
    const v = (val ?? '').trim()
    if (v) { values[key] = v; aiFilled.push(key) }
  })
  return { values, aiFilled }
}

/**
 * 用**当前活动模型**发一轮「结构化输出」请求（JSON 模式 + 低温度 + 不要思考过程）。
 *
 * 供「对话引导」这类**交互式**补全用：一轮一轮地聊，每轮都要解析 JSON。
 * 有它，界面就不必自己解析模型配置（那件事只有这里该做），也不会各自漏掉 `think:false`
 * —— 漏了的话思考型模型每轮都把推理过程吐出来，JSON 解析直接失败。
 */
export async function aiChatJson(
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const cfg = await requireActiveProvider()
  return chat(cfg, messages, {
    timeoutMs: opts.timeoutMs ?? CHAT_TIMEOUT_MS,
    signal: opts.signal,
    json: true,
    think: false,
  })
}

/** 从模型回复中解析出按编号索引的值数组（剥代码块 / 切最外层统一走 aiParse） */
function parseTemplateJSON(raw: string, fields: TemplateField[]): string[] {
  const obj = parsePlainObject(raw) ?? {}
  const out: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const v = obj[String(i + 1)] ?? obj[i + 1] ?? ''
    out.push(typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
  }
  return out
}

// ---- 设置持久化（走 db.meta，全局共享）----
//
// 1.5.0 起模型配置改为「全局」：模型是这台机器的能力，不该随小说项目切换而丢失。
// 旧版本曾写在项目级 settingsKV 里，首次读取时按项目自动迁移到全局，作者无感。

const K_PROVIDERS = 'aiProviders'
const K_ACTIVE = 'aiActiveProviderId'
const K_MIGRATED = 'aiConfigMigratedToGlobal'

/** 已完成旧配置迁移的项目 id（进程内缓存，避免每次读配置都多打两次库） */
let migratedFor: string | null = null

async function ensureMigrated(): Promise<void> {
  const pid = db.getCurrentProjectId()
  if (migratedFor === pid) return
  migratedFor = pid
  try {
    if (await db.getSetting<boolean>(K_MIGRATED, false)) return
    const legacy = await db.getSetting<AIProvider[]>(K_PROVIDERS, [])
    if (legacy.length > 0) {
      const cur = await db.getMeta<AIProvider[]>(K_PROVIDERS, [])
      const merged = [...cur]
      for (const p of legacy) if (!merged.some(x => x.id === p.id)) merged.push(p)
      await db.setMeta(K_PROVIDERS, merged)
      if (!(await db.getMeta<string | null>(K_ACTIVE, null))) {
        const la = await db.getSetting<string | null>(K_ACTIVE, null)
        if (la) await db.setMeta(K_ACTIVE, la)
      }
    }
    await db.setSetting(K_MIGRATED, true)
  } catch {
    // 迁移失败不影响主流程：最坏情况就是作者重新添加一次模型
    migratedFor = null
  }
}

export async function loadProviders(): Promise<AIProvider[]> {
  await ensureMigrated()
  return (await db.getMeta<AIProvider[]>(K_PROVIDERS, [])) ?? []
}
export async function saveProviders(list: AIProvider[]): Promise<void> {
  await db.setMeta(K_PROVIDERS, list)
  await refreshAIReady()
}
export async function loadActiveId(): Promise<string | null> {
  await ensureMigrated()
  return (await db.getMeta<string | null>(K_ACTIVE, null)) ?? null
}
export async function saveActiveId(id: string | null): Promise<void> {
  await db.setMeta(K_ACTIVE, id)
  await refreshAIReady()
}

export function typeLabel(p: AIProvider): string {
  return p.type === 'ollama' || p.local ? '本地' : '联网'
}

// ---- AI 就绪状态（全局订阅）----
//
// 存在意义：所有 AI 入口按钮都要能在「未配置模型」时自动禁用并给出说明。
// 各组件若各自去 loadProviders() 判断，既重复又容易漏掉「刚配好模型但按钮还是灰的」。
// 这里做一个极小的发布订阅：配置变更 → 广播 → 所有按钮同步刷新。

export interface AIReadyInfo {
  /** 是否存在「配置完整、可直接调用」的模型 */
  ready: boolean
  /** 当前模型的简短标识，如「本地 Ollama · qwen3:8b」；未就绪为空串 */
  label: string
}

const AI_NOT_READY: AIReadyInfo = { ready: false, label: '' }
let readyInfo: AIReadyInfo = AI_NOT_READY
let readyLoaded = false
const readyListeners = new Set<() => void>()

/** 配置是否填全（能真正发起调用），复用测试前的本地校验 */
export function isProviderUsable(p: AIProvider): boolean {
  return precheck(p) === ''
}

function resolveActive(list: AIProvider[], activeId: string | null): AIProvider | null {
  const byId = activeId ? list.find(p => p.id === activeId) : undefined
  const cand = byId ?? list[0]
  if (cand && isProviderUsable(cand)) return cand
  // 当前选中的那个没填全时，退而取第一个填全的，
  // 免得作者明明配好了另一个模型，按钮却告诉他「未配置」。
  return list.find(isProviderUsable) ?? null
}

/** 取当前生效的模型配置；未配置或配置不全时返回 null（调用方自行决定是否降级） */
export async function getActiveProvider(): Promise<AIProvider | null> {
  const [list, activeId] = await Promise.all([loadProviders(), loadActiveId()])
  return resolveActive(list, activeId)
}

/** 取当前模型；没有就抛出统一的中文提示（供必须依赖 AI 的功能使用） */
export async function requireActiveProvider(): Promise<AIProvider> {
  const cfg = await getActiveProvider()
  if (!cfg) throw new Error('尚未配置可用的 AI 模型，请先到「灵感启发 → 模型配置」添加并设为当前。')
  return cfg
}

/** 同步读取当前快照（useSyncExternalStore 用，返回引用稳定的对象） */
export function aiReadySnapshot(): AIReadyInfo {
  return readyInfo
}

/** 重新计算就绪状态，有变化才广播 */
async function refreshAIReady(): Promise<AIReadyInfo> {
  readyLoaded = true
  let next: AIReadyInfo = AI_NOT_READY
  try {
    const cfg = await getActiveProvider()
    if (cfg) next = { ready: true, label: `${cfg.name || typeLabel(cfg)} · ${cfg.model}` }
  } catch {
    next = AI_NOT_READY
  }
  if (next.ready !== readyInfo.ready || next.label !== readyInfo.label) {
    readyInfo = next
    readyListeners.forEach(fn => {
      try { fn() } catch { /* 单个监听者出错不影响其他 */ }
    })
  }
  return readyInfo
}

/** 订阅就绪状态变化；首次订阅时惰性加载一次配置 */
export function subscribeAIReady(fn: () => void): () => void {
  readyListeners.add(fn)
  if (!readyLoaded) void refreshAIReady()
  return () => { readyListeners.delete(fn) }
}
