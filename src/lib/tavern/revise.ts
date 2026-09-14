/**
 * 酒馆模式 · 角色设定更新（2026-09-14，老大要求）
 *
 * 【与「整理记忆」的分工 —— 这是本模块存在的全部理由】
 *   · 整理记忆 = 记录**发生过什么**（六栏档案）。自动会跑，手动也能跑。
 *   · 更新设定 = 判断**人物档案本身要不要改**（关系、内核、进度锁…）。**只手动跑**。
 *
 * 为什么必须分开：记忆是「Ta 记得什么」，设定是「Ta 是谁」。一次分手当然会同时改变两者，
 * 但改设定的后果重得多 —— 改错了，之后**每一轮**对话都从错的人设出发，而且很难察觉
 * （模型会一直照着错的卡演，看上去只是"最近有点怪"）。所以设定只能**列出来让作者逐条裁决**，
 * 绝不自动写卡。
 *
 * 用户举的例子正是这条：楚楠提分手 → 龙汐与楚楠的记忆里都多一条「分手」事件（整理记忆干这个），
 * 而两张角色卡的「2.4 关系」要从「男女朋友」改成「前男女朋友」（更新设定干这个，
 * 且因为关系是双向的，**两张卡都要列**）。
 *
 * 🔴 本模块**不落库、不改卡**：只产出建议。采纳由调用方执行（`store.applyCardRevision`）。
 */
import { chat, CHAT_TIMEOUT_MS, isCancelled, type ChatMessage } from '../ai'
import { parseObjectArray, asText } from '../aiParse'
import { newAuthorFence, authorBlock } from '../promptGuard'
import { resolveTavernProvider, type ChatFn } from './engine'
import { uid } from '../id'
import { CARD_FIELDS, isCardField, readCardField, fieldLabel } from './types'
import type { CardFieldPath, FreeCharacter, TavernMessage } from './types'

// 字段表与读写工具在 ./types（纯数据 + 纯函数，store 也要用；放这里会让 store→revise→engine→store 成环）
export {
  CARD_FIELDS, fieldLabel, isCardField, readCardField, writeCardField,
} from './types'
export type { CardFieldPath } from './types'
/** 一条待裁决的设定变更 */
export type CardRevision = {
  id: string
  /** 归属角色（关系是双向的：一次分手要同时出现在两张卡上） */
  charId: string
  charName: string
  field: CardFieldPath
  fieldLabel: string
  /** 现有值（采纳前的样子，供对照） */
  before: string
  /** 建议的新值（**完整文本**，采纳即整段替换） */
  after: string
  reason: string
  /** 来自对话里的哪一句（尽量原文） */
  quote: string
}

export function buildReviseSystem(charName: string): string {
  return `你是小说角色设定的**审查员**。现在要读一段〖对话记录〗，对照〖现有设定〗，找出**因这段对话而必须修改**的设定项。

角色：${charName}

〖判断标准 —— 宁少勿多〗
- 只报**对话里已经明确发生**的事所导致的改动。没有发生的走向、可能的发展、作者的客套话，一律不提。
- 现有设定与对话并不冲突的，**不要报**（比如对话里聊到天气，不该去改「1 世界」）。
- 一次审查通常只有 0~2 条，**返回空数组是完全正常的结果**。为了显得勤快而列一堆小改动，
  会让作者每次都要逐条否掉，这是最坏的体验。
- **不要改名字**（名字不在可改字段里）。

〖可改字段（field 只能填左侧的英文路径）〗
${CARD_FIELDS.map(f => `- ${f.path} —— ${f.label}：${f.when}`).join('\n')}

〖每条要写清〗
- field：上面清单里的路径，一字不差。
- after：**改完之后的完整文本**（不是"在原文后面加一句"）—— 采纳时是整段替换，所以你必须把整段重写一遍。
- reason：为什么必须改（一句话，说清是什么事件造成的）。
- quote：对话里的原句，尽量照抄。

〖输出格式〗只输出一个 JSON 对象，不要代码块、不要解释、不要前后缀：
{"changes":[{"field":"profile.relations","after":"（改完后的完整文本）","reason":"（为什么）","quote":"（对话原句）"}]}
不需要修改时输出：{"changes":[]}`
}

/**
 * 只取最近的一部分对话做审查：设定变更多半出在近期，而且全文可能超出上下文。
 *
 * `speakerName` 用来把 AI 侧的发言标成**具体是谁说的** —— 多角色同场时这一点很关键：
 * 「谁对谁说了分手」和「谁对谁说了谢谢」是完全不同的两件事，只写「角色」模型分不出来。
 */
export function recentTranscript(
  messages: TavernMessage[],
  maxChars = 6000,
  speakerName?: (m: TavernMessage) => string,
): string {
  const lines = messages
    .filter(m => m.role !== 'system' && !m.hidden && m.content.trim())
    .map(m => `〖${m.role === 'user' ? '对方' : (speakerName?.(m) || '角色')}〗${m.content.trim()}`)
  const out: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (used + l.length > maxChars) break
    out.unshift(l)
    used += l.length
  }
  // 被截断时给一句说明，免得模型以为对话就这么短
  const head = out.length < lines.length ? `（下面是最近 ${out.length} 条，更早的已省略）\n` : ''
  return head + out.join('\n')
}

export type ReviseArgs = {
  char: FreeCharacter
  messages: TavernMessage[]
  providerId?: string
  chatFn?: ChatFn
  signal?: AbortSignal
  /** 送进提示词的对话字符上限 */
  maxChars?: number
  /** 把 AI 侧发言标成「谁说的」（多角色同场必需） */
  speakerName?: (m: TavernMessage) => string
}

/**
 * 跑一次设定审查，产出**建议列表**（不落库）。
 * 没有任何建议（或模型乱答）时返回空数组 —— 调用方据此显示「这一段没有需要改的设定」。
 */
export async function proposeCardRevisions(args: ReviseArgs): Promise<CardRevision[]> {
  const { char, messages, providerId, chatFn, signal, maxChars, speakerName } = args
  const transcript = recentTranscript(messages, maxChars, speakerName)
  if (!transcript.trim()) return []

  const { provider } = await resolveTavernProvider(providerId ? { providerId } : undefined)
  const runChat = chatFn ?? chat

  // 现有设定：**空字段也要列**（对话里新长出来的信息正是要补进去的）
  const current = CARD_FIELDS
    .map(f => `- ${f.path}（${f.label}）：${readCardField(char, f.path).trim() || '（现为空）'}`)
    .join('\n')

  const fence = newAuthorFence()
  const msgs: ChatMessage[] = [
    { role: 'system', content: buildReviseSystem(char.name) },
    {
      role: 'user',
      content: [
        '〖现有设定〗',
        current,
        '',
        '〖对话记录〗',
        authorBlock(fence, transcript),
        '',
        '请按要求输出 JSON（不需要修改就输出 {"changes":[]}）。',
      ].join('\n'),
    },
  ]

  const reply = await runChat(provider, msgs, {
    timeoutMs: CHAT_TIMEOUT_MS,
    signal,
    // 结构化任务：由 chat() 统一解析 json 开关 → 低温
    json: true,
    think: false,
  })

  return parseRevisions(reply, char)
}

/**
 * 解析 + **二次把关**。模型返回的字段名必须落在白名单里，否则丢掉
 * （不做这一步的话，一个拼错的字段名会让整条采纳动作写到一个不存在的键上）。
 * 同一字段出现多条时只留最后一条：采纳是整段替换，前几条必然被覆盖。
 */
export function parseRevisions(raw: string, char: FreeCharacter): CardRevision[] {
  const rows = parseObjectArray(raw)
  const byField = new Map<CardFieldPath, CardRevision>()
  for (const r of rows) {
    const field = asText(r.field).trim() as CardFieldPath
    if (!isCardField(field)) continue
    const after = asText(r.after).trim()
    if (!after) continue
    const before = readCardField(char, field).trim()
    // 与现状一模一样 → 不是改动，别浪费作者的一次裁决
    if (after === before) continue
    byField.set(field, {
      id: uid(),
      charId: char.id,
      charName: char.name,
      field,
      fieldLabel: fieldLabel(field),
      before,
      after,
      reason: asText(r.reason).trim() || '（模型未给出理由）',
      quote: asText(r.quote).trim(),
    })
  }
  return [...byField.values()]
}

export { isCancelled }
