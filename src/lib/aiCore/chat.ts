/**
 * AI 接入层 · 对话层（2.8.0 从 `lib/ai.ts` 拆出，见 `lib/ai.ts` 顶部说明）。
 *
 * 职责：统一对话入口 `chat()`、Ollama / OpenAI 兼容两条实际通道、以及连通性测试。
 * 依赖 `aiCore/transport.ts` 的 HTTP 与 SSE 能力，不自己碰底层 fetch。
 */

import { fetchWithTimeout, readSSE, secs, stripSlash, stripThink, isAbortError, isCancelled, AICancelled, openaiBaseOf, describeApiError, AIRefusalError, isRefusalStatus, looksLikeSafetyMessage, looksLikeRefusalText, extractPlatformMessage, type SseChunk } from '@/lib/aiCore/transport'
import { reportUsage, type ChatUsage } from '@/lib/aiCore/usage'
import {
  OLLAMA_DEFAULT_URL, CHAT_TIMEOUT_MS, TEST_TIMEOUT_MS, DEFAULT_TEMPERATURE, JSON_TASK_TEMPERATURE, precheck,
  injectUserSystemPrompt,
  type AIProvider, type ChatMessage,
} from '@/lib/aiCore/core'
// 2.9.2：「模型配置 → 文本生成微调」的语义名 → 原生键名（详见 lib/modelSampling.ts）
import { samplingOptionsOf } from '@/lib/ai/modelSampling'

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
  /**
   * 跳过「作者自定义系统提示词」的兜底注入（默认 false = 注入）。
   *
   * 🔴 默认就该注入 —— 模型配置界面对作者的承诺是「对所有调用此模型的功能生效」，
   *    而 `chat()` 是唯一能保证这条承诺的地方（见 `core.injectUserSystemPrompt`）。
   *
   * 目前**没有生产调用点** —— 留着是给将来那种「确实不该带作者提示词」的新链路一个显式口子，
   * 免得有人为了跳过注入而去手工改 provider 对象（那会顺手把别的字段一起改掉）。
   * ⚠️ 酒馆**不走这个参数**：它的独立开关实现在 `resolveTavernProvider`（直接剥 `provider.systemPrompt`）
   *    —— 那样才能一处改动覆盖酒馆全部 15 个调用点，且在新增酒馆功能时自动跟随。
   */
  skipUserSystem?: boolean
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

/** 统一对话入口：按 provider.type 分发 */
export async function chat(config: AIProvider, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  // 注意：opts.think 默认 undefined → ollamaChatRaw 不传 think 字段，思考型模型保持思考。
  //
  // 🔴🔴 2026-10-03 统一口径：**JSON 任务默认关思考**（显式 `think: true` 仍是逃生口）。
  //   依据（本文件上方实测）：本地思考型模型思考开 ⇒ 50.5 秒 / 思考链 12687 字 /
  //   **content 只剩 271 字且被截断** ⇒ JSON 必残。而调用点里 32 处 `json: true` 只有十来处
  //   显式写了 `think: false`，其余在本地路径上一直开着思考 —— 「功能坏掉」的风险远大于
  //   「多想一会儿」的收益。要推理的长文任务（正文续写 / 整章改写 / 伴写 / 深度设定深化）
  //   不是 JSON 任务，保持 undefined、照旧让思考型模型思考。
  // ⚠️ 一次「想给它开思考」的取舍备案在此：创意生成（`aiTasks/creative.ts`）也走 `json: true`
  //   （要解析成结构化清单），因此同样落在「关」这一侧 —— 这是**有意为之**：思考型模型思考开
  //   会把 content 截到几百字，那不是「创意少一点」，而是**整份 JSON 直接坏掉**。
  //   想要更好的创意，走草图（作者自己多给几条线索）比赌截断靠谱。
  const think = opts.think ?? (opts.json ? false : undefined)
  // 温度在此处统一解析（唯一真源）：显式 temperature 优先；否则按是否 JSON 任务取默认值。
  // 下游 ollamaChatRaw / openaiChat 只管用 o.temperature，不再各自做缺省判断。
  // 2.4.0：创意生成的默认温度可由 provider 自带（见 AIProvider.temperature）——
  // 本地小模型与云端大模型合适值差别很大；JSON 任务仍固定低温，不受影响。
  const temperature = opts.temperature ?? (opts.json ? JSON_TASK_TEMPERATURE : (config.temperature ?? DEFAULT_TEMPERATURE))
  // 🔴 兜底注入「作者自定义系统提示词」（2026-10-06）：这里是全项目**唯一**能让「所有 AI 功能
  //    都接上」这句话成立的位置。已显式调过 `composeSystemPrompt` 的链路内容里带标记，
  //    这里会跳过 —— 不会拼两遍，也不会改变既有行为。
  const msgs = opts.skipUserSystem ? messages : injectUserSystemPrompt(messages, config)
  // 3.0 · W1-4：上报本次调用用量（无订阅者时零开销）。
  // 🔴 失败 / 被拒**也记一笔** —— §14 说「拒答也记一笔，便于复盘哪段内容老被拒」；
  //    统计是旁路，绝不打断调用（reportUsage 内部已吞异常）。
  const t0 = Date.now()
  const usageSource: ChatUsage['source'] = config.type === 'ollama' ? 'ollama' : 'openai'
  try {
    const out = (await chatRaw(config, msgs, {
      timeoutMs: opts.timeoutMs ?? CHAT_TIMEOUT_MS,
      think,
      signal: opts.signal,
      onToken: opts.onToken,
      temperature,
      // 2.9.2：显式传入优先；否则用「模型配置 → 文本生成微调」里填的那组参数。
      // 🔴 不填时 `samplingOptionsOf` 返回 undefined ⇒ 请求体与改动前逐字节一致。
      // 🔴 `json: true` 的结构化任务**不下发**这组参数 —— 温度已被强制成低温（见 ai.ts 的
      //    JSON_TASK_TEMPERATURE）以保解析稳定，惩罚项若照发，作者为「文风」调的参数就会
      //    作用到抽取 / 解析任务上，同样会劣化 JSON 稳定性。这与界面上「结构化任务不受影响」
      //    的承诺同口径（2026-10-09 审计修）。
      //    ⚠️ 只抑制**兜底来源**：显式传入的 `opts.extraOptions` 一律照发 ——
      //       酒馆走的就是显式那一路，它有自己的参数面板，不该被这里改动。
      extraOptions: opts.extraOptions ?? (opts.json ? undefined : samplingOptionsOf(config)),
    })).content
    reportUsage({ model: config.model, ms: Date.now() - t0, source: usageSource, at: Date.now() })
    return out
  } catch (e) {
    // 3.0 · W1-4：被内容政策拒绝的调用也记一笔，并标 finishReason ——
    // 统计页据此显示「被拒 N 次」，方便复盘哪段内容老被拒（§14）
    reportUsage({
      model: config.model, ms: Date.now() - t0, source: usageSource, at: Date.now(),
      ...(e instanceof AIRefusalError ? { finishReason: 'content_filter' } : {}),
    })
    throw e
  }
}

async function ollamaChatRaw(config: AIProvider, messages: ChatMessage[], o: CallOpts): Promise<ChatRaw> {
  const { timeoutMs, think } = o
  const base = stripSlash(config.baseUrl || OLLAMA_DEFAULT_URL)
  if (!config.model) throw new Error('未选择 Ollama 模型，请先到「模型设置 → 模型配置」拉取并选择本地模型。')
  // 构建请求体：**只有关思考时才传 think:false**。
  // · JSON 任务：由 `chat()` 统一归一（`opts.think ?? (opts.json ? false : undefined)`）⇒ 这里会收到 false；
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
      await readSSE(res, (obj) => {
        const chunk = obj as SseChunk
        const delta = chunk?.message?.content
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
  const base = openaiBaseOf(config.baseUrl || '')
  if (!base) throw new Error('未填写 API 接口地址（baseUrl）。')
  if (!config.model) throw new Error('未填写模型名称。')
  let res: Response
  let clearTimer: (() => void) | null = null
  // 云端 Qwen3 系：思考开着就拿不到 content，等于静默废掉所有 AI 功能 —— 默认关掉（`think:true` 可显式保留）
  const thinkToggle = !config.local && o.think !== true && HYBRID_THINKING_RE.test(config.model)
  // 三级请求体：full（含 enable_thinking + temperature + 采样）→ noToggle（去 enable_thinking）
  //   → bare（再去 temperature 与采样惩罚——推理系模型（o1 / deepseek-r1 等）对 temperature ≠ 1 会直接 400；
  //     部分中转站也会拒绝不认识的字段。每级只在上一级 400 时才降）
  const doFetch = (variant: 'full' | 'noToggle' | 'bare') => fetchWithTimeout(
    `${base}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model, messages,
        ...(variant !== 'bare' ? { temperature: o.temperature, ...openaiSampling(o) } : {}),
        stream: !!o.onToken,
        ...(variant === 'full' && thinkToggle ? { enable_thinking: false } : {}),
      }),
    },
    timeoutMs,
    o.signal,
    o.onToken ? (ct) => { clearTimer = ct } : undefined,
  )
  try {
    res = await doFetch(thinkToggle ? 'full' : 'noToggle')
    // 该端点不认 enable_thinking（返回 400）→ 丢掉这个字段重试一次。
    // 宁可少一个优化，也绝不因为多发一个字段把功能弄坏。
    if (res.status === 400 && thinkToggle) {
      await res.text().catch(() => '')
      res = await doFetch('noToggle')
    }
    // 🔴 中转站兼容：部分端点 / 推理系模型对 temperature、采样字段校验严格（HTTP 400）→ 再降一级重试
    if (res.status === 400) {
      await res.text().catch(() => '')
      res = await doFetch('bare')
    }
  } catch (e) {
    if (isCancelled(e)) throw e
    if (isAbortError(e)) throw new Error(`接口响应超时（超过 ${secs(timeoutMs)} 秒）：请检查网络；若连的是本机 / 局域网服务，确认它已经启动。`)
    throw new Error('无法连接该 API 地址：请检查网络与接口地址；若连的是本机 / 局域网服务，确认它已启动（浏览器 / 桌面端也可能因 CORS 拦下跨域请求）。')
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
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
    try {
      await readSSE(res, (obj) => {
        const chunk = obj as SseChunk
        const delta = chunk?.choices?.[0]?.delta?.content
        const fr = chunk?.choices?.[0]?.finish_reason
        if (typeof fr === 'string' && fr) finishReason = fr
        if (typeof delta === 'string' && delta) { content += delta; o.onToken!(delta) }
      }, () => clearTimer?.())
    } catch (e) {
      if (o.signal?.aborted) throw new AICancelled()
      if (isAbortError(e)) throw new Error(`接口响应超时（超过 ${secs(timeoutMs)} 秒）：请检查网络；若连的是本机 / 局域网服务，确认它已经启动。`)
      throw e
    }
    // 3.0 · W1-3 判据①（结构化，最强）：被内容过滤截断 ⇒ 如实报「被拒」，不当正常产出用
    if (finishReason === 'content_filter') {
      throw new AIRefusalError('content-filter', '')
    }
    if (!content.trim()) {
      // 🔴 2.5.2 中转站兼容：部分中转对流式返回**非标准体**（每行 JSON.parse 失败被 readSSE
      //    静默跳过）→ content 恒为空，用户看到的就是「跑不通」。自动降级**非流式**重试一次——
      //    宁可多等一整轮，也要把「跑不通」变成「慢一点但能跑」。
      const retry = await fetchWithTimeout(
        `${base}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.model, messages, temperature: o.temperature,
            ...openaiSampling(o), stream: false,
            ...(thinkToggle ? { enable_thinking: false } : {}),
          }),
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
          return out
        }
      }
      throw new Error('API 未返回内容（流式响应体无法解析，非流式重试也失败）：该接口地址可能不兼容 OpenAI 流式格式——请确认中转站文档给出的接口地址与模型名，或换官方接口测试。')
    }
    // 3.0 · W1-3 判据③（文本启发式，兜底）：200 却给一段拒答文字 ⇒ 提示作者（§14.3 ③）
    if (looksLikeRefusalText(content)) {
      throw new AIRefusalError('refusal-text', content.trim().slice(0, 200))
    }
    return stripThink(content)
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
