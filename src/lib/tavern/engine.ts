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
  chat, loadProviders, requireActiveProvider, isCancelled, CHAT_TIMEOUT_MS,
  type AIProvider, type ChatMessage,
} from '../ai'
import { uid } from '../id'
import { buildProjectContext } from '../aiContext'
import { buildSystemPrompt, buildMultiCharRule, toChatMessages } from './prompt'
import { trimHistory, historyBudget } from './budget'
import { resolveParams } from './params'
import type { TavernSession, TavernMessage, TavernCast } from './types'

/** 剧情模式的档位固定为叙事向（方案 §5.3：剧情默认叙事向、自由默认聊天向） */
const PLOT_TONE = 'narrative' as const

/**
 * 解析本轮要用的模型。
 * 酒馆模式**单独指定模型**（方案 §7.8），只存 providerId 引用，不复制模型配置；
 * 没配或配的那个已被删除时，回退到全局活动模型（并在 UI 上提示）。
 */
export async function resolveTavernProvider(ref?: { providerId?: string }): Promise<{ provider: AIProvider; fellBack: boolean }> {
  if (ref?.providerId) {
    const list = await loadProviders()
    const hit = list.find(p => p.id === ref.providerId)
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
export async function buildPlotSystem(session: TavernSession): Promise<PlotSystemResult> {
  const p = resolveParams('plot', session.params)
  const total = p.contextBudget
  const casts = splitCast(session.cast)
  const aiNames = casts.ai.map(c => c.name)
  const userNames = casts.user.map(c => c.name)

  // ② 设定层：给上下文留出约 60% 的额度，其余留给对话历史与记忆
  const ctx = await buildProjectContext({
    budget: Math.round(total * 0.6),
    viewMode: session.mode === 'immersive' ? 'character-view' : 'director-view',
    anchorChapterId: session.anchorChapterId,
    // 知情者过滤：多个 AI 角色时传入全部名字（aiContext 侧按「任一命中」匹配）
    knowerName: aiNames.join('、') || undefined,
    // 用锚点章做焦点召回：优先级高于通用章节清单
    focusChapterId: session.anchorChapterId,
  })

  const setting = aiNames.length > 1
    ? `${ctx.text}\n\n${buildMultiCharRule(aiNames)}`
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

  const system = buildSystemPrompt({
    tone: PLOT_TONE,
    setting,
    memory: session.memory,
    self: selfLines.join('\n'),
    dropped: ctx.dropped,
  })

  return { system, settingChars: ctx.chars, dropped: ctx.dropped }
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
  deps: { chatFn?: ChatFn } = {},
): Promise<PlotTurnResult> {
  const runChat = deps.chatFn ?? chat
  const { provider, fellBack } = await resolveTavernProvider(session.model)
  const p = resolveParams('plot', session.params)

  cb.onPhase?.('组装上下文')
  const { system } = await buildPlotSystem(session)

  // 用户这条先并进历史，保证模型看到的是「含本轮输入」的完整对话
  const withUser: TavernMessage[] = [
    ...session.messages,
    { id: uid(), role: 'user', content: userText, at: Date.now() },
  ]

  const historyBudgetChars = historyBudget(totalBudget(p.contextBudget), system, session.memory ?? '')
  const { messages } = buildPlotMessages({ ...session, messages: withUser }, historyBudgetChars)

  cb.onPhase?.('生成中')
  let reply = ''
  let cancelled = false
  try {
    reply = await runChat(
      provider,
      [{ role: 'system', content: system }, ...messages],
      {
        timeoutMs: CHAT_TIMEOUT_MS,
        signal: cb.signal,
        onToken: cb.onToken,
        // 见文件头：角色扮演全程关闭思考（对 ai.ts 全局政策的有意例外）
        think: false,
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

function totalBudget(v: number | undefined): number {
  return v && Number.isFinite(v) && v > 0 ? v : 8000
}
