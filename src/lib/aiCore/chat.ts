/**
 * AI 接入层 · 对话层（2.8.0 从 `lib/ai.ts` 拆出，见 `lib/ai.ts` 顶部说明）。
 *
 * 职责：统一对话入口 `chat()`、输出协议解析、请求预算、用量上报与连通性测试。
 * 3.4.2 起，真正的「怎么发请求、怎么读流」交给 `aiCore/protocols/` 的线协议 driver：
 *   · `ollama` —— Ollama 原生 `/api/chat`
 *   · `openai-chat` —— OpenAI 兼容 `/chat/completions`
 *   · `anthropic` / `gemini` / `openai-responses` —— 见各 driver 文件
 * 新增协议只加 driver + 注册，本文件不再按协议写分支。
 */

import { reportUsage, type ChatUsage } from '@/lib/aiCore/usage'
import {
  CHAT_TIMEOUT_MS, TEST_TIMEOUT_MS, DEFAULT_TEMPERATURE, precheck,
  injectUserSystemPrompt, protocolOf,
  type AIProvider, type ChatMessage,
} from '@/lib/aiCore/core'
import { driverFor } from '@/lib/aiCore/protocols'
import { type DriverCallOpts, type DriverResult } from '@/lib/aiCore/protocols/contract'
import { samplingOptionsOf } from '@/lib/ai/modelSampling'
import { AICancelled, AIRefusalError } from '@/lib/aiCore/transport'
// 3.2.0 · WQ6：请求生命周期（本轮只做**旁路记录**，不接管超时语义）
import { createLifecycle, transitionLifecycle } from '@/lib/ai/streaming'
// 3.2.0 · WQ5：输出结构与推理需求分开解析（唯一口径）
import { resolveOutputProtocol, type OutputKind, type ReasoningNeed } from '@/lib/ai/outputProtocol'
import { capabilitiesOf } from '@/lib/ai/modelCapabilities'
import { capabilityConfigFingerprint } from '@/lib/ai/capabilityProfile'
import type { CallRequestContext } from '@/lib/ai/callTracking'
import { uid } from '@/lib/app/id'
// 3.2.0 · WQ4：请求预算（按**实际模型窗口**核对完整请求，放不下就明确申报）
import { planRequestBudget, AIContextOverflowError } from '@/lib/ai/requestBudget'
import { effectiveWindowOf, lookupWindow, MIN_SANE_WINDOW } from '@/lib/ai/modelCapacity'

// 3.4.2：旧的公共符号仍从本文件再导出，保持既有 import 契约不变
export { OPENAI_SAFE_SAMPLING, MAX_REQUESTS_PER_CALL, shouldDegradeOn400 } from '@/lib/aiCore/protocols/shared'

export interface ChatOptions {
  /** 禁用兼容性降级重发，适用于不能自动重复调用的任务。 */
  disableCompatibilityRetry?: boolean
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
   * 输出结构声明（3.2.0 · WQ5）：`text` / `json-object` / `json-schema`。
   * 🔴 与 `reasoning` **分开**声明 —— 「要 JSON」不等于「不许思考」。
   *    不传则按旧口径（`json:true` ⇒ JSON 对象 + 关推理），行为与 3.1.x 逐字一致。
   */
  output?: OutputKind
  /**
   * 推理需求（3.2.0 · WQ5）：`default`（按模型默认）/ `off` / `required`。
   * 声明为 `required` 但端点未确认能「推理＋结构」共存时会**降级为 off 并记一条限制**，
   * 不会静默地既开推理又输出坏 JSON。
   */
  reasoning?: ReasoningNeed
  /**
   * `output: 'json-schema'` 时要下发的 schema（3.2.0 · WQ5）。
   * 🔴 只有端点已确认支持、且本次确实传了 schema 才会真正下发；
   *    缺 schema 时协议层降级为 JSON 对象并留下限制说明，不假装下发了细约束。
   */
  schema?: Record<string, unknown>
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
   *    思考链既把延迟从 1~3s 拖到十几秒（ghost 体验直接崩），又可能经 ollama 通道的
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
  /**
   * 任务意图（3.2.0 · WQ4）：只用于预算/诊断归因，不影响发送内容。
   * 例：`chapter-continue` / `chapter-review` / `setting-extract`。
   */
  intent?: string
  /** 任务声明的输出上限（token）；缺省用全局 `REPLY_RESERVE_TOKENS` */
  outputTokens?: number
  /**
   * 允许超预算发送（**逃生口，默认关闭**）。
   *
   * 🔴 为什么默认要拦：本地 Ollama / 多数兼容端点超窗口时是**静默截断**——
   *    作者以为"资料全给了"，模型其实只看到前半段，输出看着挺像样。
   *    明确报错比这种假完整好。仅在"确认截断可接受"的兼容路径上显式打开，
   *    每一处打开都该在注释里写清为什么。
   */
  allowOverflow?: boolean
  /**
   * 流式空闲超时（毫秒，3.2.0 · WQ6）。缺省 `STREAM_IDLE_TIMEOUT_MS`（120 秒）。
   * 🔴 这是「多久没有**新内容**就判停滞」，不是总时长 —— 长篇连续输出不该被一刀切。
   */
  idleTimeoutMs?: number
  /**
   * 请求上下文（3.2.0 · WQ7）：显式说明「这次调用属于哪个项目 / 哪个任务 / 哪一步」。
   *
   * 🔴 账本按 `request.taskId` 精确归属。不传也能跑，但含义是「调用方没声明归属」：
   *    只有一个任务在跑时走兼容归属；多任务并行时会被如实判为**未归属**，
   *    绝不会塞给最近创建的那个任务（那正是旧全局单归属的错法）。
   *    独立调用（编辑器伴写 / 酒馆）应显式传 `scope: 'independent'`。
   */
  request?: CallRequestContext
}

/** 内部调用参数：统一成对象，避免位置参数越加越乱 */
type CallOpts = DriverCallOpts
type ChatRaw = DriverResult

/** 内部统一分发：按线协议取 driver；未接入的协议明确报错，绝不静默退回 OpenAI 兼容 */
async function chatRaw(config: AIProvider, messages: ChatMessage[], o: CallOpts): Promise<ChatRaw> {
  const protocol = protocolOf(config)
  const driver = driverFor(protocol)
  if (!driver) {
    throw new Error(`暂不支持该线协议（${protocol}）：请到「模型设置 → 模型配置」改选已支持的协议，或升级到包含该协议的新版本。`)
  }
  return driver.chat(config, messages, o)
}

/** 统一对话入口：按 provider 的线协议分发 */
export async function chat(config: AIProvider, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  // 输出结构与推理需求在这里**一次**解析（唯一口径在 `ai/outputProtocol.ts`）。
  //
  // 历史备案（3.1.x，仍然有效的一部分）：本地思考型模型思考开 ⇒ 实测 50.5 秒 / 思考链 12687 字 /
  //   **content 只剩 271 字且被截断** ⇒ 结构输出必残。所以 **旧口径 `json: true` 依旧关推理**，
  //   与 3.1.x 逐字一致（不能借迁移悄悄改老调用点的行为）。
  //
  // 3.2.0 · WQ5 改的是另一半：想保留构思能力的任务（大纲 / 设定 / 创意）现在可以显式声明
  //   `output: 'json-object'` + `reasoning: 'default' | 'required'`，不必再被「要 JSON」绑架。
  //   🔴 但 `required` + 结构输出只在端点**确认**支持共存时才生效，否则降级为 off 并记一条限制
  //   （见 outputProtocol 的能力闸）—— 宁可按老路走，也不赌「既推理又吐完整 JSON」。
  const protocol = resolveOutputProtocol({
    ...(opts.output ? { output: opts.output } : {}),
    ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
    ...(opts.schema ? { schema: opts.schema } : {}),
    ...(opts.json ? { json: true } : {}),
    ...(opts.think !== undefined ? { think: opts.think } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(config.temperature !== undefined ? { providerTemperature: config.temperature } : {}),
    caps: capabilitiesOf(config.model, config, config.baseUrl, capabilityConfigFingerprint(config)),
  })
  const think = protocol.think
  // 🔴 旧口径 `json:true` 即便端点已确认支持结构格式也**不下发** ——
  //    「给新链路加格式」与「保持老调用点逐字节不变」是两件事，不能顺手改前者。
  const wireFormat = protocol.legacyJson ? 'none' : protocol.wireFormat
  // 温度在此处统一解析（唯一真源）：显式 temperature 优先；否则按是否 JSON 任务取默认值。
  // 下游 driver 只管用 o.temperature，不再各自做缺省判断。
  const temperature = protocol.temperature
  // 🔴 兜底注入「作者自定义系统提示词」（2026-10-06）：这里是全项目**唯一**能让「所有 AI 功能
  //    都接上」这句话成立的位置。已显式调过 `composeSystemPrompt` 的链路内容里带标记，
  //    这里会跳过 —— 不会拼两遍，也不会改变既有行为。
  const msgs = opts.skipUserSystem ? messages : injectUserSystemPrompt(messages, config)
  // 3.0 · W1-4：上报本次调用用量（无订阅者时零开销）。
  // 🔴 失败 / 被拒**也记一笔** —— §14 说「拒答也记一笔，便于复盘哪段内容老被拒」；
  //    统计是旁路，绝不打断调用（reportUsage 内部已吞异常）。
  // 3.2.0 · WQ4：**发送前核对完整请求**（方案 §16.5 的固定顺序最后一步）。
  // 窗口取"实际 provider"的值（手填 > 模型识别 > 保守兜底），不用全局最近一次结果。
  const budget = planRequestBudget({
    window: effectiveWindowOf(config),
    windowSource: config.contextWindow != null && config.contextWindow >= MIN_SANE_WINDOW
      ? 'user'
      : (lookupWindow(config.model) ? 'preset' : 'fallback'),
    systemPrompt: msgs.filter(m => m.role === 'system').map(m => m.content).join('\n'),
    body: msgs.filter(m => m.role !== 'system').map(m => m.content).join('\n'),
    ...(opts.outputTokens != null ? { outputTokens: opts.outputTokens } : {}),
  })
  // 🔴 硬上限 = 输入 + 输出预留 + 安全余量 ≤ 窗口。超过它是一定会被截断的，
  //    连"资料额度 0.5"都算不上 —— 此时**必须**报错，不能发出去赌端点仁慈。
  const hardLimit = budget.windowTokens - budget.outputReserveTokens - budget.safetyMarginTokens
  if (!opts.allowOverflow && budget.estimates.input.tokens > hardLimit) {
    throw new AIContextOverflowError(budget)
  }

  const t0 = Date.now()
  // 3.2.0 · WQ7：每次调用一个 callId（调用方没给就现生成）——
  // 🔴 有了它，账本里同一次调用在「用量 / 上下文 / 错误」三处能对上号；
  //    没有它，并行时只能靠时间戳猜，复盘等于没有。
  const request: CallRequestContext = { ...opts.request, callId: opts.request?.callId ?? uid() }
  // 3.2.0 · WQ6（旁路第一步）：建生命周期，只**记录**首字/结局与耗时，暂不参与超时判定。
  // 🔴 为什么先旁路：现有超时是 `fetchWithTimeout` + `readSSE` 的组合，语义经过多轮实测校准；
  //    一次性换成生命周期驱动，风险是把"慢模型被一刀切"这类老问题请回来。
  //    先记录一轮（拿到真实首字分布），下一轮再让它接管。
  let lifecycle = transitionLifecycle(createLifecycle(`${config.model}@${t0}`), 'connecting')
  const wrappedOnToken = opts.onToken
    ? (delta: string) => {
      if (lifecycle.firstByteAt === undefined) {
        lifecycle = transitionLifecycle(lifecycle, 'first-byte', { firstByteAt: Date.now() })
      }
      lifecycle = transitionLifecycle(lifecycle, 'streaming', { text: delta, tokens: 1 })
      opts.onToken!(delta)
    }
    : undefined
  const wireProtocol = protocolOf(config)
  // 🔴 未接入的协议在**发送前**就明确报错，绝不静默退回 OpenAI 兼容
  const driver = driverFor(wireProtocol)
  if (!driver) {
    throw new Error(`暂不支持该线协议（${wireProtocol}）：请到「模型设置 → 模型配置」改选已支持的协议，或升级到包含该协议的新版本。`)
  }
  // 3.4.2：按 driver 能力决定实际下发到哪一档（Anthropic 只支持 json-schema）
  const canWire = driver.structuredWire === true
    || (driver.structuredWire === 'json-schema' && wireFormat === 'json-schema')
  const effectiveWireFormat = canWire ? wireFormat : 'none'
  const limitations = effectiveWireFormat === wireFormat
    ? protocol.limitations
    : [...protocol.limitations, '该线协议本版未接入结构化输出字段：本次只靠提示词约束。']
  const usageSource: ChatUsage['source'] = wireProtocol === 'ollama'
    ? 'ollama'
    : wireProtocol === 'openai-chat' ? 'openai' : wireProtocol
  try {
    const raw = await chatRaw(config, msgs, {
      timeoutMs: opts.timeoutMs ?? CHAT_TIMEOUT_MS,
      think,
      signal: opts.signal,
      onToken: wrappedOnToken,
      temperature,
      // 2.9.2：显式传入优先；否则用「模型配置 → 文本生成微调」里填的那组参数。
      // 🔴 不填时 `samplingOptionsOf` 返回 undefined ⇒ 请求体与改动前逐字节一致。
      // 🔴 `json: true` 的结构化任务**不下发**这组参数 —— 温度已被强制成低温（见 ai.ts 的
      //    JSON_TASK_TEMPERATURE）以保解析稳定，惩罚项若照发，作者为「文风」调的参数就会
      //    作用到抽取 / 解析任务上，同样会劣化 JSON 稳定性。这与界面上「结构化任务不受影响」
      //    的承诺同口径（2026-10-09 审计修）。
      //    ⚠️ 只抑制**兜底来源**：显式传入的 `opts.extraOptions` 一律照发 ——
      //       酒馆走的就是显式那一路，它有自己的参数面板，不该被这里改动。
      extraOptions: opts.extraOptions ?? (protocol.output !== 'text' ? undefined : samplingOptionsOf(config)),
      ...(effectiveWireFormat !== 'none' ? { wireFormat: effectiveWireFormat } : {}),
      ...(effectiveWireFormat === 'json-schema' && opts.schema ? { jsonSchema: opts.schema } : {}),
      ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
      ...(opts.outputTokens !== undefined ? { outputTokens: opts.outputTokens } : {}),
      ...(opts.disableCompatibilityRetry ? { disableCompatibilityRetry: true } : {}),
    })
    lifecycle = transitionLifecycle(lifecycle, 'completed')
    const out = raw.content
    // 3.2.0 · WQ7：**真实用量优先**；只有拿不到时才退回估算，并打上 `tokensEstimated`
    // （统计页据此区分"厂商报的数"与"我们估的数"，避免把估算当成账单依据）。
    const real = raw.usage
    const hasRealPrompt = real?.promptTokens !== undefined
    reportUsage({
      model: config.model, ms: Date.now() - t0, source: usageSource, at: Date.now(),
      request,
      protocol: {
        output: protocol.output,
        reasoning: protocol.reasoning,
        ...(effectiveWireFormat !== 'none' ? { wireFormat: effectiveWireFormat } : {}),
        ...(limitations.length ? { limitations } : {}),
      },
      promptTokens: hasRealPrompt ? real!.promptTokens : budget.estimates.input.tokens,
      ...(real?.completionTokens !== undefined ? { completionTokens: real.completionTokens } : {}),
      ...(real?.finishReason ? { finishReason: real.finishReason } : {}),
      ...(real?.attempts !== undefined ? { attempts: real.attempts } : {}),
      ...(hasRealPrompt && real?.completionTokens !== undefined ? {} : { tokensEstimated: true }),
      // 流式才有首字；非流式整段一次到，首字耗时没有独立意义（不写 0 冒充）。
      ...(lifecycle.firstByteAt !== undefined ? { firstByteMs: lifecycle.firstByteAt - lifecycle.startedAt } : {}),
    })
    return out
  } catch (e) {
    lifecycle = transitionLifecycle(
      lifecycle,
      e instanceof AICancelled ? 'cancelled' : 'failed',
      { error: e instanceof Error ? e.message : String(e) },
    )
    // 3.0 · W1-4：被内容政策拒绝的调用也记一笔，并标 finishReason ——
    // 统计页据此显示「被拒 N 次」，方便复盘哪段内容老被拒（§14）
    reportUsage({
      model: config.model, ms: Date.now() - t0, source: usageSource, at: Date.now(),
      // 🔴 失败调用也带同一份 request：同一次逻辑调用的「失败」与「成功」用同一个 taskId
      //    串得起来 —— 只记成功那一次，会让「试了三次才通」看起来像一次就通。
      request,
      ...(e instanceof AIRefusalError ? { finishReason: 'content_filter' } : {}),
    })
    throw e
  }
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