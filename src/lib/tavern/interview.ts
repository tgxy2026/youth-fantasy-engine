/**
 * 对话引导（访谈式创建）
 *
 * 【它解决什么】
 * 「一句话起草」适合**作者已经想清楚**的情况（甚至是照着一个已有作品填）。但原创角色/剧本常常是
 * 「有点感觉，说不清」—— 这时需要的不是让他憋出一句完整描述，而是**按模板提纲被问着走**：
 * 先定名字与身份，再问外在，再问在乎什么……一边聊一边成形。
 *
 * 【两条硬规则（老大明确要求）】
 *   ① **一次只问 1–3 个相关联的问题** —— 一次抛一整张问卷等于把人劝退；
 *   ② **按模板提纲为纲领推进**，一个话题聊透了再进下一个，别跳着问。
 *
 * 【怎么保证「聊着聊着能变成一张卡」】
 * 每轮都让模型顺带输出一句 \`filled\`：**到目前为止从对话里提炼出的字段**（增量合并）。
 * 这样「生成草稿」不是重新总结一遍对话（很容易丢细节），而是把一路攒下来的东西交出去。
 *
 * 【为什么每轮都过一次模型】
 * 本地做「下一个问什么」的编排看起来能省调用，但那样提问会变成死板的问卷顺序，接不住作者的回答。
 * 一次调用换一轮有上下文的追问，值得。
 */
import { chat, CHAT_TIMEOUT_MS, isCancelled, type ChatMessage } from '../ai'
import { parsePlainObject, asText } from '../aiParse'
import { newAuthorFence, authorBlock } from '../promptGuard'
import { resolveTavernProvider, type ChatFn } from './engine'
import { EMPTY_CARD_DRAFT, type CardDraft } from './draft'
import { EMPTY_SCRIPT_FIELDS, type ScriptDraftFields } from './script'

export type InterviewKind = 'card' | 'script'

/** 提纲的一个话题：对应模板里的一组栏 */
export type InterviewTopic = {
  key: string
  /** 话题名（界面显示进度用） */
  label: string
  /** 这一话题要问出什么（写给模型看的） */
  ask: string
  /** 对应模板里的哪些栏（用于进度统计） */
  fields: string[]
}

/** 角色卡提纲：按「先定人、再定形、后定边界」的顺序 —— 前一个话题的答案自然引出后一个 */
export const CARD_TOPICS: InterviewTopic[] = [
  { key: 'basic', label: '名字与世界', ask: 'Ta 叫什么、处在什么样的世界（时代 / 地点 / 有没有超自然与科技底色）', fields: ['name', 'world'] },
  { key: 'look', label: '外在', ask: '长什么样、多大、穿什么、身上常带着什么 —— 能让读者一眼认出 Ta 的细节', fields: ['externals'] },
  { key: 'core', label: '内核', ask: '什么性子、在乎什么、怕什么、眼下想要什么', fields: ['core'] },
  { key: 'speech', label: '说话方式', ask: '怎么说话（句子长短、口头禅、怎么称呼别人）', fields: ['speech'] },
  { key: 'relations', label: '关系', ask: '跟谁有牵扯、什么关系（有具体名字更好）', fields: ['relations'] },
  { key: 'limits', label: '底线与边界', ask: 'Ta 绝不会做什么、做不到什么；以及 Ta 知道什么、不知道什么', fields: ['cannot', 'knowledge'] },
  { key: 'conduct', label: '扮演规范', ask: '用第几人称演、关系推进的节奏该怎么把握、适合什么尺度', fields: ['perspective', 'bottomLine', 'paceLock', 'rating'] },
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

export function topicsOf(kind: InterviewKind): InterviewTopic[] {
  return kind === 'card' ? CARD_TOPICS : SCRIPT_TOPICS
}

export function fieldKeysOf(kind: InterviewKind): string[] {
  return kind === 'card' ? Object.keys(EMPTY_CARD_DRAFT) : Object.keys(EMPTY_SCRIPT_FIELDS)
}

export type InterviewTurn = { role: 'user' | 'ai'; text: string }

export type InterviewState = {
  kind: InterviewKind
  /** 对话历史（含 AI 的提问） */
  turns: InterviewTurn[]
  /** 到目前为止从对话里提炼出的字段（增量合并） */
  filled: Record<string, string>
  /** 模型认为可以收尾了 */
  done: boolean
}

export function emptyInterview(kind: InterviewKind): InterviewState {
  return { kind, turns: [], filled: {}, done: false }
}

/** 已收集 / 总共 的栏数（界面进度条用） */
export function interviewProgress(s: InterviewState): { got: number; total: number } {
  const keys = fieldKeysOf(s.kind)
  const got = keys.filter(k => String(s.filled[k] ?? '').trim()).length
  return { got, total: keys.length }
}

const KIND_NAME: Record<InterviewKind, string> = { card: '角色卡', script: '剧本' }

export function buildInterviewSystem(kind: InterviewKind): string {
  const topics = topicsOf(kind)
  const outline = topics.map((t, i) => `${i + 1}. 【${t.label}】要问到的是：${t.ask}（对应栏：${t.fields.join('、')}）`)
  const fieldList = fieldKeysOf(kind).join('、')
  return [
    `你在帮一位小说作者**从零塑形**一张${KIND_NAME[kind]}。你不是问卷，是会追问的编辑：`,
    '作者往往只说了个感觉，你要顺着他的话把模糊的地方问清楚。',
    '',
    '〖提纲（按这个顺序推进，一个话题聊得差不多再进下一个）〗',
    ...outline,
    '',
    '〖提问的硬规则〗',
    '- 一次只问 1–3 个**互相关联**的问题 —— 绝不能一口气把提纲全问完（那会把人劝退）；',
    '- **先接住作者上一句**：他提到的细节值得展开就追问细节，别机械地念下一个话题；',
    '- 别重复已经答过的内容；作者说「随便你」「你定」时，你自己给一个具体的建议让他确认；',
    '- 语气自然、简短，别写小作文，也别滥用感叹号。',
    '',
    `〖每轮必须顺带输出「已提炼的字段」〗`,
    `可用的栏名只有这些：${fieldList}。把你从**目前为止的全部对话**里能确定的栏累积写出来`,
    '（一句话即可，别扩写成长段；还不清楚的栏就别写、不要瞎填）。',
    '',
    '〖输出格式〗只输出一个 JSON 对象，不要代码块、不要围栏：',
    '{"filled":{"栏名":"内容"},"question":"你要问作者的下一句（1–3 个问题）","done":false}',
    '- 当提纲里的栏基本都有着落时，把 done 设为 true，question 换成一句收尾话',
    '（例如「信息差不多齐了，可以生成草稿了 —— 生成后你还能逐栏改」）。',
  ].join('\n')
}

/** 把当前状态摊成给模型的输入（含提纲进度、已收集字段、对话历史） */
export function buildInterviewUser(s: InterviewState, existing?: string): string {
  const fence = newAuthorFence()
  const topics = topicsOf(s.kind)
  const progress = topics.map(t => {
    const missing = t.fields.filter(f => !String(s.filled[f] ?? '').trim())
    return `- ${t.label}：${missing.length === 0 ? '已有信息' : '还缺 ' + missing.join('、')}`
  })
  const filledRows = Object.entries(s.filled)
    .filter(([, v]) => String(v ?? '').trim())
    .map(([k, v]) => `${k}：${v}`)
  const history = s.turns.map(t => `${t.role === 'ai' ? '你' : '作者'}：${t.text}`).join('\n')

  return [
    existing?.trim() ? `〖作者已有的内容（这是补完，不是从零开始）〗\n${authorBlock(fence, existing.trim())}\n` : '',
    '〖提纲进度〗',
    ...progress,
    '',
    filledRows.length ? `〖目前已提炼的字段〗\n${filledRows.join('\n')}\n` : '',
    '〖对话到这儿〗',
    history || '（还没开始，这是第一轮：请先问最开头的话题，1–3 个问题）',
    '',
    '请按格式输出 JSON。',
  ].filter(Boolean).join('\n')
}

export type InterviewReply = {
  /** 这一轮结束后累积的字段（已与进来的合并） */
  filled: Record<string, string>
  /** 要问作者的下一句 */
  question: string
  done: boolean
}

/** 解析一轮访谈的输出（导出便于单测） */
export function parseInterviewReply(raw: string, prev: Record<string, string> = {}): InterviewReply | null {
  const o = parsePlainObject(raw)
  if (!o) return null
  const allowed = new Set(Object.keys(EMPTY_CARD_DRAFT))
  const scriptKeys = new Set(Object.keys(EMPTY_SCRIPT_FIELDS))
  const filled: Record<string, string> = { ...prev }
  const rawFilled = o.filled
  if (rawFilled && typeof rawFilled === 'object') {
    for (const [k, v] of Object.entries(rawFilled as Record<string, unknown>)) {
      if (!allowed.has(k) && !scriptKeys.has(k)) continue
      const text = asText(v).trim()
      if (text) filled[k] = text
    }
  }
  const question = asText(o.question).trim()
  const done = o.done === true || o.done === 'true'
  if (!question && !done) return null
  return { filled, question, done }
}

/** 跑一轮访谈。`answer` 为空 = 开场（让 AI 先问） */
export async function runInterviewTurn(
  s: InterviewState,
  answer: string | null,
  deps: { providerId?: string; chatFn?: ChatFn; signal?: AbortSignal; existing?: string } = {},
): Promise<{ state: InterviewState; reply: InterviewReply }> {
  const { provider } = await resolveTavernProvider(deps.providerId ? { providerId: deps.providerId } : undefined)
  const runChat = deps.chatFn ?? chat

  const withAnswer: InterviewState = answer?.trim()
    ? { ...s, turns: [...s.turns, { role: 'user' as const, text: answer.trim() }] }
    : s

  const msgs: ChatMessage[] = [
    { role: 'system', content: buildInterviewSystem(withAnswer.kind) },
    { role: 'user', content: buildInterviewUser(withAnswer, deps.existing) },
  ]
  const raw = await runChat(provider, msgs, {
    timeoutMs: CHAT_TIMEOUT_MS,
    signal: deps.signal,
    json: true,
    think: false,
  })
  const reply = parseInterviewReply(raw, withAnswer.filled)
  if (!reply) throw new Error('引导模型没有按格式回应（没输出 JSON）—— 再发一次试试')
  const next: InterviewState = {
    ...withAnswer,
    filled: reply.filled,
    done: reply.done,
    turns: reply.question
      ? [...withAnswer.turns, { role: 'ai' as const, text: reply.question }]
      : withAnswer.turns,
  }
  return { state: next, reply }
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

/** 把已收集的字段摊平成文本（给「补完已有」模式当起点用） */
export function filledToText(filled: Record<string, string>, kind: InterviewKind): string {
  const labels: Record<string, string> = kind === 'card'
    ? { name: '名字', world: '世界', externals: '外在', core: '内核', speech: '语言特征', relations: '关系', cannot: '做不到的事', knowledge: '知识边界', perspective: '视角与人称', bottomLine: '底线清单', paceLock: '进度锁', rating: '尺度', examples: '示例对话' }
    : { name: '名称', situation: '情境', opening: '开场白', playerRole: '你的位置', goal: '这一场的目标', taboo: '不要发生' }
  return Object.entries(filled)
    .filter(([, v]) => String(v ?? '').trim())
    .map(([k, v]) => `【${labels[k] ?? k}】${v}`)
    .join('\n')
}

export { isCancelled }
