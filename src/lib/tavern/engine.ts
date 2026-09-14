/**
 * 酒馆模式 · 剧情模式引擎（纯逻辑，无 React）
 *
 * 一条完整的推演回合：
 *   组装上下文（按信息边界档位裁剪）→ 五层 system → 历史消息（按预算裁剪）→ 调模型 → 落库
 *
 * 🔴 本模块全程 `think: false`（显式传，见 §9.1 的说明）：
 *    角色扮演要的是「像人说话」，不是「想得深」。思考链会让正文带上分析腔，轮次越多越明显。
 *    这是对 ai.ts 全局政策（正文生成保持默认思考）的**有意例外**，不影响其他功能。
 *
 * 设计铁律（沿用项目既有约定）：
 *   · 上下文必须走 buildProjectContext，不自拼 prompt 抓数据
 *   · 加锁 isCancelled 处理，取消要能中断
 */
import {
  chat, loadProviders, requireActiveProvider, isCancelled,
  type AIProvider, type ChatMessage,
} from '../ai'
import { uid } from '../id'
import { buildProjectContext } from '../aiContext'
import {
  buildSystemPrompt, buildMultiCharRule, toChatMessages, renderCastSetting,
  buildSameNameNote, buildSceneDescriptionRule,
} from './prompt'
import * as store from './store'
import { trimHistory, historyBudget } from './budget'
import { resolveParams, toOllamaOptions } from './params'
import {
  getTavernSettings, commonParamsLayer, modeParamsLayer, timeoutMsOf, thinkOptOf,
  type TavernSettings,
} from './settings'
import { memoryToText, isMemoryEmpty } from './memory'
import {
  hasCastSetting, charTag,
  type TavernSession, type TavernMessage, type TavernCast,
  type FreeSession, type FreeCharacter, type FreeMemory,
} from './types'

/** 剧情模式的档位固定为叙事向（方案 §5.3：剧情默认叙事向、自由默认聊天向） */
const PLOT_TONE = 'narrative' as const

/**
 * 解析本轮要用的模型。
 * 酒馆模式**单独指定模型**（方案 §7.8），只存 providerId 引用，不复制模型配置；
 * 没配或配的那个已被删除时，回退到全局活动模型（并在 UI 上提示）。
 */
export async function resolveTavernProvider(
  ref?: { providerId?: string },
  fallbackProviderId?: string,
): Promise<{ provider: AIProvider; fellBack: boolean }> {
  // 优先会话自己指定的；会话没指定则用**控制面板的默认模型**；都没有才回退全局活动模型
  const want = ref?.providerId || fallbackProviderId || ''
  if (want) {
    const list = await loadProviders()
    const hit = list.find(p => p.id === want)
    if (hit) return { provider: hit, fellBack: false }
  }
  return { provider: await requireActiveProvider(), fellBack: true }
}

/** 把角色分配表拆成三类 */
export function splitCast(cast: TavernCast[]) {
  return {
    user: cast.filter(c => c.role === 'user'),
    ai: cast.filter(c => c.role === 'ai'),
    silent: cast.filter(c => c.role === 'silent'),
  }
}

export type PlotSystemResult = {
  system: string
  /** 上下文（②层设定）实际占用的字符数，供 UI 显示 */
  settingChars: number
  /** 被预算丢弃的段落名 */
  dropped: string[]
}

/**
 * 组装剧情模式的 system 消息（五层）。
 * 关键在 viewMode：沉浸档 → character-view（排除作者侧资料，防剧透）；
 * 导演档 → director-view（作者侧照带，但锚点仍然生效）。
 */
export async function buildPlotSystem(session: TavernSession, settings?: TavernSettings): Promise<PlotSystemResult> {
  const st = settings ?? await getTavernSettings()
  // 参数优先级：会话参数 → 控制面板（通用层 + 模式层）→ TAVERN_DEFAULTS 兜底
  const p = resolveParams('plot', commonParamsLayer(st.common), modeParamsLayer('plot', st), session.params)
  const total = p.contextBudget
  const casts = splitCast(session.cast)
  const aiNames = casts.ai.map(c => c.name)
  const userNames = casts.user.map(c => c.name)

  // ② 设定层：给上下文留出约 60% 的额度，其余留给对话历史与记忆
  const ctx = await buildProjectContext({
    budget: Math.round(total * st.plot.settingRatio),
    viewMode: session.mode === 'immersive' ? 'character-view' : 'director-view',
    anchorChapterId: session.anchorChapterId,
    // 知情者过滤：多个 AI 角色时传入全部名字（aiContext 侧按「任一命中」匹配）
    knowerName: aiNames.join('、') || undefined,
    // 用锚点章做焦点召回：优先级高于通用章节清单
    focusChapterId: session.anchorChapterId,
  })

  // 多角色时才追加发言规则；没有「你演」角色时（整场 AI）不再写「用户扮演用户自己的角色」
  const setting = aiNames.length > 1
    ? `${ctx.text}\n\n${buildMultiCharRule(aiNames, { hasUser: userNames.length > 0 })}`
    : ctx.text

  // ④ 身份与知识边界
  const selfLines = [
    `你扮演：${aiNames.length ? aiNames.join('、') : '（未指定，按设定中最主要的角色演）'}`,
    userNames.length ? `用户扮演：${userNames.join('、')}（其言行归用户自己掌控，你不要代写）` : '',
    casts.silent.length ? `在场但这一场不出声：${casts.silent.map(c => c.name).join('、')}` : '',
  ].filter(Boolean)
  if (casts.ai.length > 1) {
    selfLines.push('⚠️ 你负责多个角色：一次只让其中一个说话，轮到谁由语境决定，不要替没开口的角色发言。')
  }

  // 扮演设定（方案 §6.4）：按 cardId 逐个读。AI 角色的是「你要怎么演」，
  // 作者角色的仅供 AI 理解对方口吻 —— 都填过才成块，全空则整层不出现。
  const castBlock = await buildCastBlock(casts)

  const system = buildSystemPrompt({
    tone: PLOT_TONE,
    setting,
    memory: session.memory,
    self: selfLines.join('\n'),
    cast: castBlock,
    dropped: ctx.dropped,
    styleHint: st.plot.styleHint,
    commonExtra: st.common.extraPrompt,
    modeExtra: st.plot.extraPrompt,
    protocol: st.protocol,
  })

  return { system, settingChars: ctx.chars, dropped: ctx.dropped }
}

/** 逐个读取扮演设定并渲染（无任何填写时返回空串 → 整层跳过） */
async function buildCastBlock(casts: ReturnType<typeof splitCast>): Promise<string> {
  const load = async (list: typeof casts.ai, kind: 'ai' | 'user') => {
    const rows = await Promise.all(list.map(async c => ({
      name: c.name,
      cs: await store.getCastSetting(c.cardId).catch(() => null),
    })))
    return rows.filter(r => r.cs && hasCastSetting(r.cs))
      .map(r => renderCastSetting(r.name, r.cs!, kind))
      .filter(Boolean)
  }
  const [aiBlocks, userBlocks] = await Promise.all([
    load(casts.ai, 'ai'),
    load(casts.user, 'user'),
  ])
  return [...aiBlocks, ...userBlocks].join('\n\n')
}

/**
 * 组装发给模型的历史消息。
 * 首轮的开场（user 的第一条）由调用方在创建会话时写入 messages，这里只做转换与预算裁剪。
 */
export function buildPlotMessages(session: TavernSession, budgetChars: number): { messages: ChatMessage[]; dropped: number } {
  const casts = splitCast(session.cast)
  const nameById = new Map(casts.ai.map(c => [c.cardId, c.name]))
  const all = toChatMessages(session.messages, {
    // 多角色同场：输入侧标注这句是谁说的（协议禁止的是**输出**写名字前缀，输入标注不冲突）
    withSpeaker: casts.ai.length > 1
      ? (id?: string) => (id && nameById.get(id) ? `（${nameById.get(id)}）` : '')
      : undefined,
  })
  const trimmed = trimHistory(all, budgetChars)
  return { messages: trimmed.kept.map(m => ({ role: m.role, content: m.content })), dropped: trimmed.dropped }
}

/**
 * 模型调用注入点：默认用 ai.ts 的 chat。
 * 以参数注入，是为了让「组装上下文 → 调模型 → 落库」这条链路能在**不起真实模型**的前提下
 * 端到端跑通（tests/tavernFlow.test.ts 用示范项目的真实数据验证防剧透与报告定位）。
 */
export type ChatFn = typeof chat

export type PlotTurnCallbacks = {
  onToken?: (delta: string) => void
  onPhase?: (phase: string) => void
  signal?: AbortSignal
}

export type PlotTurnResult = {
  /** 追加了两条消息（user + assistant）后的会话（调用方负责落库） */
  session: TavernSession
  reply: string
  cancelled: boolean
  /** 本轮实际使用的模型名（UI 可显示） */
  modelName: string
  /** 是否因没配酒馆模型而回退到了全局活动模型 */
  fellBack: boolean
}

/**
 * 跑一轮：把用户输入送进模型，把回复追进会话。
 * **不落库**（调用方决定何时保存，便于「先预览再采纳」的交互）。
 */
export async function runPlotTurn(
  session: TavernSession,
  userText: string,
  cb: PlotTurnCallbacks = {},
  deps: { chatFn?: ChatFn; settings?: TavernSettings } = {},
): Promise<PlotTurnResult> {
  const runChat = deps.chatFn ?? chat
  const st = deps.settings ?? await getTavernSettings()
  const { provider, fellBack } = await resolveTavernProvider(session.model, st.common.defaultProviderId)
  const p = resolveParams('plot', commonParamsLayer(st.common), modeParamsLayer('plot', st), session.params)
  /** temperature 单独拎出来（chat 的唯一真源），其余整体透传 */
  const { temperature, ...extraOptions } = toOllamaOptions(p)

  cb.onPhase?.('组装上下文')
  const { system } = await buildPlotSystem(session, st)

  // 用户这条先并进历史，保证模型看到的是「含本轮输入」的完整对话
  const withUser: TavernMessage[] = [
    ...session.messages,
    { id: uid(), role: 'user', content: userText, at: Date.now() },
  ]

  const historyBudgetChars = historyBudget(
    totalBudget(p.contextBudget), system, session.memory ?? '', st.common.fixedOverheadChars)
  const { messages } = buildPlotMessages({ ...session, messages: withUser }, historyBudgetChars)

  cb.onPhase?.('生成中')
  let reply = ''
  let cancelled = false
  try {
    reply = await runChat(
      provider,
      [{ role: 'system', content: system }, ...messages],
      {
        timeoutMs: timeoutMsOf(st),
        // 采样参数：temperature 走 chat 的唯一真源，其余（top_p / top_k /
        // repeat_penalty / presence_penalty / num_ctx）走 extraOptions 透传。
        // 此前这些参数压根没下发过，控制面板上的旋钮会是死的。
        temperature,
        extraOptions,
        signal: cb.signal,
        onToken: cb.onToken,
        // 见文件头：角色扮演默认关闭思考（对 ai.ts 全局政策的有意例外）—— 控制面板可开回来
        think: thinkOptOf(st),
      },
    )
  } catch (e) {
    if (isCancelled(e)) cancelled = true
    else throw e
  }

  const next: TavernSession = {
    ...session,
    messages: [
      ...withUser,
      // 取消 / 空回复时**不追加**占位消息：原先写成 `|| cancelled` 会插入一条 content 为空的
      // assistant 消息 —— 界面上留下一个空气泡，让「取消」看起来像真的发生了一轮对话。
      ...(reply.trim()
        ? [{ id: uid(), role: 'assistant' as const, content: reply.trim(), at: Date.now() }]
        : []),
    ],
    updatedAt: Date.now(),
  }

  return { session: next, reply: reply.trim(), cancelled, modelName: provider.model, fellBack }
}


// ==================== 自由模式（方案 §7） ====================
//
// 与剧情模式的三处根本差异：
//   ① 设定层不是「项目资料」，而是**作者手写的角色卡四章**
//   ② 记忆是**角色级**的（tavern.free.mem.<charId>）—— 记忆是「她记得什么」，
//      不是「这场戏的公共档案」；多角色同场时各自更新各自的那份
//   ③ 档位是**聊天向**（剧情默认叙事向），且没有锚点/信息边界这些概念

/** 自由模式的档位固定为聊天向（方案 §5.3） */
const FREE_TONE = 'chat' as const

/**
 * 把角色卡四章渲染成设定块（空章跳过，不留「（未填）」噪音）。
 * 第 4 章「示例对话」杠杆最高 —— 模型会直接吸收示例里的应对话术与格式（手册实测），
 * 所以标题里明确写出「请模仿」，别让它当成普通资料读过就忘。
 *
 * 【2026-09-14 改动：块首加角色名】
 * 从前只输出四章、不带名字 —— 单角色时靠身份层「你扮演：X」还能对上，
 * 多角色时就是**两段无主的设定拼在一起**，模型只能靠顺序猜谁是谁。
 * 现在每块自带 `【角色卡 · 名】`；同场有同名卡时再挂 `#短码`（见 `charTag`）。
 */
export function renderFreeCharacter(c: FreeCharacter, opts: { tag?: string } = {}): string {
  const secs: string[] = []
  if (c.world?.trim()) secs.push(`【第 1 章 · 世界】\n${c.world.trim()}`)

  const profile: [string, string][] = [
    ['2.1 外在', c.profile?.externals ?? ''],
    ['2.2 内核', c.profile?.core ?? ''],
    ['2.3 语言特征', c.profile?.speech ?? ''],
    ['2.4 关系', c.profile?.relations ?? ''],
    ['2.5 做不到的事', c.profile?.cannot ?? ''],
    ['2.6 知识边界', c.profile?.knowledge ?? ''],
  ]
  const pl = profile.filter(([, v]) => v.trim()).map(([k, v]) => `${k}：${v.trim()}`)
  if (pl.length) secs.push(`【第 2 章 · 人物档案】\n${pl.join('\n')}`)

  const conduct: [string, string][] = [
    ['视角与人称', c.conduct?.perspective ?? ''],
    ['底线清单', c.conduct?.bottomLine ?? ''],
    ['进度锁', c.conduct?.paceLock ?? ''],
    ['尺度', c.conduct?.rating ?? ''],
  ]
  const cl = conduct.filter(([, v]) => v.trim()).map(([k, v]) => `${k}：${v.trim()}`)
  if (cl.length) secs.push(`【第 3 章 · 行为规范】\n${cl.join('\n')}`)

  if (c.examples?.trim()) {
    secs.push(`【第 4 章 · 示例对话（请模仿其应对话术与格式）】\n${c.examples.trim()}`)
  }
  // 空卡仍然渲染成空串（不产生一个只有标题的空壳块）
  if (secs.length === 0) return ''
  const tag = opts.tag ? ` #${opts.tag}` : ''
  return `【角色卡 · ${c.name.trim() || '（未命名）'}${tag}】\n\n${secs.join('\n\n')}`
}

export type FreeSystemResult = {
  system: string
  settingChars: number
  memoryChars: number
  /** 会话里引用了、但角色卡已被删的 id（UI 据此提示） */
  missing: string[]
}

/**
 * 组装自由模式的 system。
 * 设定层**不做预算裁剪** —— 角色卡是作者手写的核心，悄悄砍掉会让角色「设定性失忆」
 * （字段名与字数都摊在 UI 里，超预算由界面提示作者自己精简）。
 */
export async function buildFreeSystem(session: FreeSession, chars: FreeCharacter[], settings?: TavernSettings): Promise<FreeSystemResult> {
  const st = settings ?? await getTavernSettings()
  const found: FreeCharacter[] = []
  const missing: string[] = []
  for (const id of session.charIds) {
    const c = chars.find(x => x.id === id)
    if (c) found.push(c)
    else missing.push(id)
  }

  /**
   * 把参演角色拆成两拨：AI 演的和**用户演的**。
   * `session.userCharId` 未设 = 用户演他自己（旧行为），此时 aiChars === found。
   */
  const userChar = found.find(c => c.id === session.userCharId) ?? null
  const aiChars = found.filter(c => c.id !== userChar?.id)

  /**
   * 同名消歧（2026-09-14）。
   *
   * 数据层本来就以 **id** 为准（记忆 `tavern.free.mem.<charId>`、消息 `speakerId`），
   * 所以「新建一张同名但内容不同的卡」**不会**抢走原来那张卡的记忆 —— 这点不用怀疑。
   * 会出问题的只有提示词：两张卡都叫「洛汐」时，模型读到的是两段同名的设定与记忆，
   * 无从判断谁是谁。所以同名字段命中时给每张卡挂一个稳定短码，并附一张对照表。
   */
  const nameCount = new Map<string, number>()
  for (const c of found) {
    const k = c.name.trim()
    nameCount.set(k, (nameCount.get(k) ?? 0) + 1)
  }
  const dupNames = new Set([...nameCount].filter(([, n]) => n > 1).map(([k]) => k))
  const tagOf = (c: FreeCharacter) => (dupNames.has(c.name.trim()) ? charTag(c.id) : '')

  const setting = (() => {
    // 用户扮演的角色（可选）：他由用户自己掌控，**不是 AI 的位子** ——
    // 从 AI 的名单、发言轮转、记忆块里都要摘出去（否则模型会替他说话、抢他的台词）。
    const parts: string[] = []
    // 对照表放最前：它解释的是「下面为什么有两张同名的卡」，先读规则再读卡
    if (dupNames.size) {
      parts.push(buildSameNameNote(
        found.filter(c => dupNames.has(c.name.trim())).map(c => ({ name: c.name.trim(), tag: charTag(c.id) })),
      ))
    }
    if (aiChars.length) parts.push(aiChars.map(c => renderFreeCharacter(c, { tag: tagOf(c) })).join('\n\n'))
    if (userChar) {
      // 用户扮演的那张卡也带给模型，但**只用来说明「对面是谁」**：口吻、立场、底线
      parts.push(
        `【用户扮演的角色 · ${userChar.name}${tagOf(userChar) ? ` #${tagOf(userChar)}` : ''}】（仅供你理解对方是谁、说话什么调子；\n` +
        `他的言行归用户自己掌控 —— **不要代写、不要替他决定、也不要替他回答**）\n` +
        renderFreeCharacter(userChar, { tag: tagOf(userChar) }),
      )
    }
    if (aiChars.length > 1) {
      parts.push(buildMultiCharRule(aiChars.map(c => c.name), { userName: userChar?.name }))
    }
    return parts.join('\n\n')
  })()

  // 记忆层：**每个角色各自的记忆**分别成块（多角色时模型要能分清「谁知道什么」）。
  // ⚠️ 用户扮演的那个角色**不给**：那是他自己的底牌，给 AI 看等于让对手读你的日记，
  //   还容易演成「替你说出你私下想的事」。他的处境光靠角色卡说明就够了。
  const blocks = await Promise.all(aiChars.map(async c => {
    let m: FreeMemory | null = null
    try { m = await store.getMemory(c.id) } catch { m = null }
    // 空档案不输出：六栏全写「（暂无）」既占上下文又干扰模型，不如整块不出现
    const text = m && !isMemoryEmpty(m) ? memoryToText(m).trim() : ''
    // 挂短码的规则与角色卡一致：同名才挂，免得平时多出无意义的标记
    const tag = tagOf(c)
    return text ? `【长期记忆 · ${c.name}${tag ? ` #${tag}` : ''}】\n${text}` : ''
  }))
  const memory = blocks.filter(Boolean).join('\n\n')

  const aiNames = aiChars.map(c => c.name)
  const self = userChar
    ? `你扮演：${aiNames.length ? aiNames.join('、') : '（未指定角色）'}\n` +
      `用户扮演：${userChar.name}（其言行归用户自己掌控，你不要代写，也不要替他做决定）`
    : aiNames.length > 1
      ? `你同时扮演：${aiNames.join('、')}。用户扮演用户自己。`
      : `你扮演：${aiNames[0] ?? '（未指定角色）'}`

  const system = buildSystemPrompt({
    tone: FREE_TONE,
    setting,
    memory,
    self,
    dropped: [],
    styleHint: st.free.styleHint,
    commonExtra: st.common.extraPrompt,
    // 模式补充要求：内置的「客观描写」在前、作者自己写的在后 —— 作者的话离生成点更近，
    // 真冲突时以作者为准（与「协议钉末尾」同一个思路）。
    modeExtra: [buildSceneDescriptionRule(st.free.sceneDescription), st.free.extraPrompt]
      .filter(x => x?.trim())
      .join('\n\n'),
    protocol: st.protocol,
  })

  return { system, settingChars: setting.length, memoryChars: memory.length, missing }
}

export type FreeTurnCallbacks = PlotTurnCallbacks & {
  /** 下一句由谁接话（点了某个角色头像）；不传则按在场角色依次轮转 */
  speakerId?: string
}

export type FreeTurnResult = {
  session: FreeSession
  reply: string
  cancelled: boolean
  modelName: string
  fellBack: boolean
  /** 这句回复归属的角色（多角色同场时标记到消息上，供 UI 显示头像） */
  speakerId?: string
}

/**
 * 跑一轮自由对话（**不落库**，调用方决定保存与总结时机）。
 *
 * 发言调度（方案 §7.3）：默认由调用方指定（点头像）或**按在场角色轮转** ——
 * 轮转而非「让模型自己决定谁说话」，是因为协议禁止输出带名字前缀，我们无法从文本
 * 可靠地反推说话人，而消息气泡又必须挂对头像。轮转简单、可预测，且满足
 * 「一次只让一个角色说话」的规则。
 */
export async function runFreeTurn(
  session: FreeSession,
  chars: FreeCharacter[],
  userText: string,
  cb: FreeTurnCallbacks = {},
  deps: { chatFn?: ChatFn; settings?: TavernSettings } = {},
): Promise<FreeTurnResult> {
  const st = deps.settings ?? await getTavernSettings()
  const { provider, fellBack } = await resolveTavernProvider(session.model, st.common.defaultProviderId)
  const runChat = deps.chatFn ?? chat
  const { system } = await buildFreeSystem(session, chars, st)

  const withUser: TavernMessage[] = [
    ...session.messages,
    { id: uid(), role: 'user', content: userText, at: Date.now() },
  ]

  const p = resolveParams('free', commonParamsLayer(st.common), modeParamsLayer('free', st), session.params)
  const { temperature, ...extraOptions } = toOllamaOptions(p)
  const historyBudgetChars = historyBudget(totalBudget(p.contextBudget), system, '', st.common.fixedOverheadChars)
  const { messages } = buildFreeMessages(withUser, session, chars, historyBudgetChars, cb.speakerId)

  cb.onPhase?.('生成中')
  let reply = ''
  let cancelled = false
  try {
    reply = await runChat(
      provider,
      [{ role: 'system', content: system }, ...messages],
      {
        timeoutMs: timeoutMsOf(st),
        temperature,
        extraOptions,
        signal: cb.signal,
        onToken: cb.onToken,
        think: thinkOptOf(st), // 同剧情模式：陪伴要「像人说话」，不要分析腔（控制面板可开回来）
      },
    )
  } catch (e) {
    if (isCancelled(e)) cancelled = true
    else throw e
  }

  // 归属角色：指定优先，否则按历史里已有的 assistant 条数轮转。
  // ⚠️ 轮转名单要**排除用户扮演的角色** —— 他不是 AI 的位子，轮到他就会出现「AI 替你回答你」。
  const aiIds = session.charIds.filter(id => id !== session.userCharId)
  const said = session.messages.filter(m => m.role === 'assistant').length
  const autoSpeaker = aiIds.length > 0 ? aiIds[said % aiIds.length] : undefined
  const speakerId = aiIds.length > 1 ? (cb.speakerId ?? autoSpeaker) : aiIds[0]

  const next: FreeSession = {
    ...session,
    messages: [
      ...withUser,
      ...(reply.trim()
        ? [{ id: uid(), role: 'assistant' as const, content: reply.trim(), at: Date.now(), speakerId }]
        : []),
    ],
    lastActiveAt: Date.now(),
    updatedAt: Date.now(),
  }

  return { session: next, reply: reply.trim(), cancelled, modelName: provider.model, fellBack, speakerId }
}

/** 历史转换 + 预算裁剪（自由模式没有记忆层要预留，故传入 memory 为空串） */
export function buildFreeMessages(
  msgs: TavernMessage[],
  session: FreeSession,
  chars: FreeCharacter[],
  budgetChars: number,
  speakerId?: string,
): { messages: ChatMessage[]; dropped: number } {
  // 输入侧标注说话人只在**多个 AI 角色**时才需要；用户扮演的角色不算 AI 的位子
  const aiChars = chars.filter(c => c.id !== session.userCharId)
  const nameById = new Map(aiChars.map(c => [c.id, c.name]))
  const all = toChatMessages(msgs, {
    withSpeaker: aiChars.length > 1
      ? (id?: string) => (id && nameById.get(id) ? `（${nameById.get(id)}）` : '')
      : undefined,
  })
  // 手动指定下一位时，在输入侧提示一句（模型据此优先让该角色接话）
  if (speakerId && aiChars.length > 1 && nameById.get(speakerId)) {
    all.push({ role: 'user', content: `（下一位由 ${nameById.get(speakerId)} 接话）` })
  }
  const trimmed = trimHistory(all, budgetChars)
  return { messages: trimmed.kept.map(m => ({ role: m.role, content: m.content })), dropped: trimmed.dropped }
}

function totalBudget(v: number | undefined): number {
  return v && Number.isFinite(v) && v > 0 ? v : 8000
}
