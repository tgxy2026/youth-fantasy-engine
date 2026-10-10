/**
 * 跑团互动 · 一轮（3.0 · W4-3e）
 *
 * 【一条回合的顺序】🔴 与「让模型自己说成败」相反 ——
 *   系统**先掷检定**（`rollCheck`）→ 把结果写进 system 的本轮提示 → KP **照它演** →
 *   解析裁决（正文 ＋ `〖裁决〗` 后的 JSON）→ 落线索 / 揭秘密 → 结算结局。
 *   这样「不同玩家 / 不同分支」才**可复现**：同一掷值下，模型的成败判定被钉住了，
 *   不会同一句话这次算成功、下次算失败。
 *
 * 【为什么不新造 AI 通道】走既有的 `chat()`（`aiCore`）、`resolveTavernProvider`、分层装配
 *   `buildSystemPrompt` 与预算 `trimHistory` —— 与剧情 / 自由两条线同一套底盘，
 *   协议 / 提示词覆盖 / 思考策略 / 超时全部自动继承，不产生「酒馆有三种行为」的分叉。
 */
import { chat, isCancelled, type ChatMessage, type AIProvider } from '../ai'
import { resolveTavernProvider, type ChatFn } from '../tavern/provider'
import { uid } from '../id'
import { buildSystemPrompt, toChatMessages } from '../tavern/prompt'
import { toOllamaOptions } from '../tavern/params'
import { historyBudget, trimHistory } from '../tavern/budget'
import { getTavernSettings, resolveParamsOf, timeoutMsOf, thinkOptOf } from '../tavern/settings'
import {
  buildKpLayer, buildKpVerdictSchema, splitKpReply, parseKpVerdict,
  kindOf, difficultyFor, rollCheck,
  type KpVerdict,
} from './kp'
import { acquireClue } from './clues'
import { checkSecretUnlock, unlockSecretById, applyEndings } from './endings'
import { resolveRunWorldText } from './worldContext'
import type { RunSession, RunAction, RunOutcome, RunActionKind } from './runTypes'

export interface KpTurnCallbacks {
  onPhase?: (phase: string) => void
  onToken?: (t: string) => void
  signal?: AbortSignal
}

export interface KpCheck {
  kind: RunActionKind
  difficulty: number
  roll: number
  outcome: RunOutcome
}

export interface KpTurnResult {
  session: RunSession
  /** KP 的正文（进消息历史；`〖裁决〗` 之后的内容已被切走） */
  reply: string
  verdict: KpVerdict | null
  /** 本轮检定（无难度时仍会掷 —— 默认按归类给难度） */
  check: KpCheck
  cancelled: boolean
  modelName: string
  fellBack: boolean
}

/** 预算兜底值与 `TAVERN_DEFAULTS` 一致（engine.ts 的同名私有函数，此处照抄一份避免反向依赖） */
function totalBudget(v: number | undefined): number {
  return v && Number.isFinite(v) && v > 0 ? v : 24000
}

/** 把这一场（地点 / 时间 / 在场 / 描述）渲染成一行行文本；空则整层不出现 */
function sceneText(s: RunSession): string {
  const sc = s.scene
  if (!sc) return ''
  const parts: string[] = []
  if (sc.place?.trim()) parts.push(`地点：${sc.place.trim()}`)
  if (sc.time?.trim()) parts.push(`时间：${sc.time.trim()}`)
  if (sc.present?.length) parts.push(`在场：${sc.present.filter(Boolean).join('、')}`)
  if (sc.description?.trim()) parts.push(sc.description.trim())
  return parts.join('\n')
}

function clampDifficulty(v: number): number {
  if (!Number.isFinite(v)) return 45
  return Math.max(1, Math.min(100, Math.round(v)))
}

/** 模型解析的接缝（测试注入假 provider；省略走真实 `resolveTavernProvider`） */
export type ProviderResolver = (
  ref?: { providerId?: string },
  fallbackProviderId?: string,
) => Promise<{ provider: AIProvider; fellBack: boolean }>

/**
 * 跑一轮跑团。**命令式副作用集中在末尾**：先组装 → 调模型 → 再一次性落库（线索 / 秘密 / 结局 / 流水）。
 *
 * @param userText 玩家这一轮的行动（如「我搜查抽屉」）
 * @param deps.difficulty 指定难度（省略 = 按 `kindOf` 归类取默认难度）
 * @param deps.chatFn 注入 AI 通道（测试用；省略走真实 `chat`）
 * @param deps.resolveProvider 注入模型解析（测试用；省略走真实 `resolveTavernProvider`）
 */
export async function runKpTurn(
  session: RunSession,
  userText: string,
  cb: KpTurnCallbacks = {},
  deps: { chatFn?: ChatFn; difficulty?: number; resolveProvider?: ProviderResolver } = {},
): Promise<KpTurnResult> {
  const st = await getTavernSettings()
  const resolveProvider = deps.resolveProvider ?? resolveTavernProvider
  const { provider, fellBack } = await resolveProvider(session.model, st.common.defaultProviderId)
  const runChat = deps.chatFn ?? chat

  // ① 系统先掷检定
  const kind = kindOf(userText)
  const difficulty = clampDifficulty(deps.difficulty ?? difficultyFor(kind))
  const { roll, outcome } = rollCheck(difficulty)
  const check: KpCheck = { kind, difficulty, roll, outcome }

  // ② 组装 system：KP 层（含同伴知晓边界 / 暗牌）→ 这一场 → 记忆 → 协议 → 本轮检定 + 输出契约
  const pendingSecrets = session.secrets.filter(x => !x.unlocked).map(x => x.text)
  const kpLayer = buildKpLayer({
    companions: session.companions,
    pendingSecrets,
    clueCount: session.clues.filter(c => c.acquired).length,
  })
  // 引用的冻结世界版本（D4=A）：读那份**封存版**渲染成文本；取不到就整层不出现（不报错）
  const worldText = await resolveRunWorldText(session.worldRef)
  const system = buildSystemPrompt({
    tone: 'narrative',
    setting: kpLayer,
    world: worldText,
    worldTitle: session.worldRef
      ? `引用的世界版本（${session.worldRef.worldName ?? '世界'} v${session.worldRef.version}）`
      : undefined,
    scene: sceneText(session),
    memory: session.memory,
    protocol: st.protocol,
    tail: [
      `〖本轮检定〗行动归类：${kind}；难度 ${difficulty}；掷值 ${roll}；结果「${outcome}」。`,
      '请**照此结果**演这一幕（失败别写成成功），并**推进**剧情 —— 失败也要让事情发生。',
      '',
      buildKpVerdictSchema(),
    ].join('\n'),
  })

  // ③ 历史 → 消息（按预算裁；与新回合的用户输入一起送）
  const p = resolveParamsOf('plot', st, session.params)
  const { temperature, ...extraOptions } = toOllamaOptions(p)
  const budget = historyBudget(totalBudget(p.contextBudget), system, st.common.fixedOverheadChars)
  const { kept } = trimHistory(toChatMessages(session.messages), budget)
  const messages: ChatMessage[] = [...kept, { role: 'user', content: userText }]

  cb.onPhase?.('KP 主持中')
  let raw = ''
  let cancelled = false
  try {
    raw = await runChat(provider, [{ role: 'system', content: system }, ...messages], {
      timeoutMs: timeoutMsOf(st),
      temperature,
      extraOptions,
      signal: cb.signal,
      onToken: cb.onToken,
      think: thinkOptOf(st),   // 与剧情/自由一致：角色扮演要「像人说话」，不要分析腔
    })
  } catch (e) {
    if (isCancelled(e)) cancelled = true
    else throw e
  }

  // ④ 切正文 / 裁决，并落一条行动流水
  const { prose, verdictRaw } = splitKpReply(raw)
  const verdict = verdictRaw ? parseKpVerdict(verdictRaw) : null

  const action: RunAction = {
    id: uid(), at: Date.now(), text: userText.trim(), kind,
    difficulty, roll, outcome,
    consequence: verdict?.consequence?.trim() || undefined,
  }

  let next: RunSession = {
    ...session,
    actions: [...session.actions, action],
    messages: prose
      ? [...session.messages, { id: uid(), role: 'user' as const, content: userText, at: Date.now() },
        { id: uid(), role: 'assistant' as const, content: prose, at: Date.now() }]
      : session.messages,
    updatedAt: Date.now(),
  }

  // ⑤ 线索 → 秘密 → 结局（一次性走完，界面只读最终状态）
  if (verdict?.clue?.text) {
    const r = acquireClue(next, { text: verdict.clue.text, source: verdict.clue.source })
    next = r.session
  }
  if (verdict?.revealsSecretId) next = unlockSecretById(next, verdict.revealsSecretId)
  next = checkSecretUnlock(next).session
  next = applyEndings(next)

  return { session: next, reply: prose, verdict, check, cancelled, modelName: provider.model, fellBack }
}
