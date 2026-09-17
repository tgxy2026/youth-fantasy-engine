/**
 * 对话引导 —— 酒馆模式的「纲」
 *
 * 访谈**机制**（提问规则、字段白名单、增量合并、每轮 JSON）都在项目级的 `../interview.ts` 里，
 * 这边只做酒馆独有的事：
 *   ① 两份精心排过的提纲（角色卡按「先定人、再定形、后定边界」；剧本按「这是哪一场 → 你是谁 →
 *      要什么 → 不许什么 → 开场白」）—— 顺序本身是设计，比按字段清单切片好得多；
 *   ② 把提纲 + 栏名 + 中文名打包成一份 `InterviewSpec`；
 *   ③ 把攒到的字段翻译成角色卡 / 剧本草稿。
 *
 * 🔴 别把机制再抄一遍来这里：2026-09-15 起「对话引导」要在全局所有 AI 补全入口复用，
 *    两份实现必然漂移（一边改了白名单另一边没改，表现是「界面显示记下了、草稿里却没有」）。
 */
import { chat, CHAT_TIMEOUT_MS, isCancelled, type ChatMessage } from '../ai'
import { resolveTavernProvider, type ChatFn } from './engine'
import {
  emptyInterview as emptyInterviewCore,
  interviewProgress as interviewProgressCore,
  buildInterviewSystem as buildInterviewSystemCore,
  buildInterviewUser as buildInterviewUserCore,
  parseInterviewReply as parseInterviewReplyCore,
  runInterviewTurn as runInterviewTurnCore,
  filledToText as filledToTextCore,
  type InterviewSpec, type InterviewState as CoreState, type InterviewTopic,
  type InterviewTurn, type InterviewReply,
} from '../interview'
import { EMPTY_CARD_DRAFT, type CardDraft } from './draft'
import { EMPTY_SCRIPT_FIELDS, type ScriptDraftFields } from './script'
import { EMPTY_STORY_FIELDS, type StoryDraftFields } from './story'

export type { InterviewTopic, InterviewTurn, InterviewReply }

export type InterviewKind = 'card' | 'script' | 'story'

/** 角色卡提纲：按「先定人、再定形、后定边界」的顺序 —— 前一个话题的答案自然引出后一个 */
export const CARD_TOPICS: InterviewTopic[] = [
  // 🔴 只问「Ta 与这个世界的关系」（审计 P1-11）：世界本身写在「故事」层（起草提示词也明写「不写世界本身」），
  //    这里再问一遍世界，等于让作者把世界观抄进角色卡 —— 与故事层重复占额度。
  { key: 'basic', label: '名字与处境', ask: 'Ta 叫什么、在这个世界里处在什么位置（身份、常在什么地方、与「我」是什么关系）', fields: ['name', 'world'] },
  { key: 'look', label: '外在', ask: '长什么样、多大、穿什么、身上常带着什么 —— 能让读者一眼认出 Ta 的细节', fields: ['externals'] },
  { key: 'core', label: '内核', ask: '什么性子、在乎什么、怕什么、眼下想要什么', fields: ['core'] },
  { key: 'speech', label: '说话方式', ask: '怎么说话（句子长短、口头禅、怎么称呼别人）', fields: ['speech'] },
  { key: 'relations', label: '关系', ask: '跟谁有牵扯、什么关系（有具体名字更好）', fields: ['relations'] },
  { key: 'limits', label: '底线与边界', ask: 'Ta 绝不会做什么、做不到什么；以及 Ta 知道什么、不知道什么', fields: ['cannot', 'knowledge'] },
  { key: 'conduct', label: '扮演规范', ask: '以谁的视角看（描写人称固定第三人称）、关系推进的节奏该怎么把握、适合什么尺度', fields: ['perspective', 'bottomLine', 'paceLock', 'rating'] },
  { key: 'examples', label: '示例对话', ask: '写一段小小的示范对话（能定住 Ta 的语气）', fields: ['examples'] },
]

/** 剧本提纲：先「这是哪一场」，再「你在这场的什么人」，最后「要发生什么、不许发生什么」 */
export const SCRIPT_TOPICS: InterviewTopic[] = [
  { key: 'stage', label: '这一场在哪', ask: '先给这场戏起个短名（列表里认得出的那种），再说清此刻在哪、什么时候、两个人为什么在这儿、刚发生了什么', fields: ['name', 'situation'] },
  { key: 'who', label: '你是谁', ask: '作者在这一场里演谁、跟对面什么关系、此刻想做什么', fields: ['playerRole'] },
  { key: 'goal', label: '这一场要什么', ask: '这一场要推进到什么（一个主要目标就够，要可推进）', fields: ['goal'] },
  { key: 'taboo', label: '不要发生', ask: '这一场不该出现什么（2–4 条具体的禁区）', fields: ['taboo'] },
  { key: 'opening', label: '开场白', ask: '对面开口说的第一句（一两句即可，它是整场戏的语气锚点）', fields: ['opening'] },
]

/**
 * 故事提纲：先「叫什么」，再把这个世界的骨架问全。
 * 刻意**不问人物与情节** —— 那是角色卡与剧本的活儿，混进来就成了三处重复的设定源。
 */
export const STORY_TOPICS: InterviewTopic[] = [
  { key: 'name', label: '故事名', ask: '先给这个世界起个短名（列表里认得出的那种）', fields: ['name'] },
  {
    key: 'setting', label: '这个世界', fields: ['setting'],
    ask: '把这个世界的骨架说清：发生在什么时候、什么地方（现实还是架空、城市还是乡野）；' +
      '这里的规矩是什么 —— 有没有超自然或科技底色、有哪些势力、普通人怎么过日子。' +
      '一次问完，别挤牙膏；作者答不完就先把答到的写进设定，下一轮再补。',
  },
]

export function topicsOf(kind: InterviewKind): InterviewTopic[] {
  if (kind === 'card') return CARD_TOPICS
  if (kind === 'story') return STORY_TOPICS
  return SCRIPT_TOPICS
}

export function fieldKeysOf(kind: InterviewKind): string[] {
  if (kind === 'card') return Object.keys(EMPTY_CARD_DRAFT)
  if (kind === 'story') return Object.keys(EMPTY_STORY_FIELDS)
  return Object.keys(EMPTY_SCRIPT_FIELDS)
}

/** 栏名 → 中文名（界面摊平、提示词都靠它） */
export const CARD_LABELS: Record<string, string> = {
  name: '名字', world: '角色与设定的关系', externals: '外在', core: '内核', speech: '语言特征', relations: '关系',
  cannot: '做不到的事', knowledge: '知识边界', perspective: '视角与人称', bottomLine: '底线清单',
  paceLock: '进度锁', rating: '尺度', examples: '示例对话',
}
export const SCRIPT_LABELS: Record<string, string> = {
  name: '名称', situation: '情境', opening: '开场白', playerRole: '你的位置', goal: '这一场的目标', taboo: '不要发生',
}

export const STORY_LABELS: Record<string, string> = {
  name: '故事名', setting: '世界设定',
}

const KIND_NAME: Record<InterviewKind, string> = { card: '角色卡', script: '剧本', story: '故事' }

function labelsOf(kind: InterviewKind): Record<string, string> {
  if (kind === 'card') return CARD_LABELS
  if (kind === 'story') return STORY_LABELS
  return SCRIPT_LABELS
}

/** 打包成通用核心认识的「纲」 */
export function specOf(kind: InterviewKind): InterviewSpec {
  return { subject: KIND_NAME[kind], topics: topicsOf(kind), allowedKeys: fieldKeysOf(kind), labels: labelsOf(kind) }
}

/** 酒馆侧的访谈状态 = 通用状态 + 它是哪一类（界面据此选提纲与中文名） */
export type InterviewState = CoreState & { kind: InterviewKind }

export function emptyInterview(kind: InterviewKind): InterviewState {
  return { ...emptyInterviewCore(), kind }
}

/** 已收集 / 总共 的栏数（界面进度条用） */
export function interviewProgress(s: InterviewState): { got: number; total: number } {
  return interviewProgressCore(s, fieldKeysOf(s.kind))
}

export function buildInterviewSystem(kind: InterviewKind): string {
  return buildInterviewSystemCore(specOf(kind))
}

export function buildInterviewUser(s: InterviewState, existing?: string): string {
  return buildInterviewUserCore(s, specOf(s.kind), existing)
}

/** 解析一轮访谈的输出（导出便于单测）—— 角色卡与剧本的栏名都认（兼容旧调用） */
export function parseInterviewReply(raw: string, prev: Record<string, string> = {}): InterviewReply | null {
  return parseInterviewReplyCore(
    raw,
    [...new Set([...fieldKeysOf('card'), ...fieldKeysOf('script'), ...fieldKeysOf('story')])],
    prev,
  )
}

/** 跑一轮访谈。`answer` 为空 = 开场（让 AI 先问） */
export async function runInterviewTurn(
  s: InterviewState,
  answer: string | null,
  deps: { providerId?: string; chatFn?: ChatFn; signal?: AbortSignal; existing?: string; context?: string } = {},
): Promise<{ state: InterviewState; reply: InterviewReply }> {
  const res = await runInterviewTurnCore(specOf(s.kind), s, answer, {
    signal: deps.signal,
    existing: deps.existing,
    context: deps.context,
    callChat: tavernCallChat(deps.providerId, deps.chatFn),
  })
  return { state: { ...res.state, kind: s.kind }, reply: res.reply }
}

/**
 * 造一个「用酒馆这一侧的模型发一轮」的 callChat —— 界面共用件（`InterviewChat`）靠它拿到模型。
 * 模型解析只在这里做一次：会话指定的 provider 优先，其次控制面板默认，最后回退全局活动模型
 * （`resolveTavernProvider` 已在那边实现，别在这儿重写一遍优先级）。
 */
export function tavernCallChat(
  providerId?: string,
  chatFn?: ChatFn,
): (msgs: ChatMessage[], opts: { signal?: AbortSignal }) => Promise<string> {
  const runChat = chatFn ?? chat
  return async (msgs, opts) => {
    const { provider } = await resolveTavernProvider(providerId ? { providerId } : undefined)
    return runChat(provider, msgs, {
      timeoutMs: CHAT_TIMEOUT_MS,
      signal: opts.signal,
      json: true,
      think: false,
    })
  }
}

/** 把攒下来的字段变成真正的草稿（缺的栏留空，交给作者自己补或再聊一轮） */
export function interviewToCard(filled: Record<string, string>): CardDraft {
  const out: CardDraft = { ...EMPTY_CARD_DRAFT }
  for (const k of Object.keys(EMPTY_CARD_DRAFT) as (keyof CardDraft)[]) {
    out[k] = String(filled[k] ?? '').trim()
  }
  return out
}

export function interviewToScript(filled: Record<string, string>): ScriptDraftFields {
  const out: ScriptDraftFields = { ...EMPTY_SCRIPT_FIELDS }
  for (const k of Object.keys(EMPTY_SCRIPT_FIELDS) as (keyof ScriptDraftFields)[]) {
    out[k] = String(filled[k] ?? '').trim()
  }
  return out
}

export function interviewToStory(filled: Record<string, string>): StoryDraftFields {
  const out: StoryDraftFields = { ...EMPTY_STORY_FIELDS }
  for (const k of Object.keys(EMPTY_STORY_FIELDS) as (keyof StoryDraftFields)[]) {
    out[k] = String(filled[k] ?? '').trim()
  }
  return out
}

/** 把已收集的字段摊平成文本（给「补完已有」模式当起点用） */
export function filledToText(filled: Record<string, string>, kind: InterviewKind): string {
  return filledToTextCore(filled, labelsOf(kind))
}

export { isCancelled }
