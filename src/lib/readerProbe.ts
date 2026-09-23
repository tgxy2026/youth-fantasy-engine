/**
 * 读者视角审问（C5 · 2.4.2）
 *
 * ## 它和「AI 审稿」不是一件事
 * 审稿型的提示词会把模型推向「挑语法、挑结构、挑设定矛盾」——那些已经由**本章体检（C3）**
 * 与**颉文姬校对**覆盖了。这里要的是**一个具体的人在读**：他会走神、会看不懂、会想知道
 * 后面的事。所以提示词走「**扮演**」而不是「评估」——复用酒馆模式那套以人设驱动对话的写法
 * （`lib/tavern/prompt.ts` 的经验：先立住"你是谁、你在意什么"，再谈任务）。
 *
 * ## 三条设计约束
 * 1. 🔴 **位置由本地算**：AI 只出「逐字引文 + 读者感受」，段号由 `paceAnalysis.locateQuote`
 *    在正文里换算（那里已验过三种匹配策略）。引文定位失败显式标「未定位」——
 *    宁可标不出来，也不指到错的地方。
 * 2. 🔴 **立场**：读者反馈天然主观，所以 UI 与提示词都**不做通过与否的判定，也不打分、不分档**。
 *    只呈现「有人读到这里会怎样」，改不改、怎么改是作者的事。
 * 3. 🔴 **模型没按结构回也不丢内容**：解析失败时把原文整段兜住（`raw`），界面降级展示，
 *    而不是显示一个空白结果。
 */
import { asText, parseLooseObject, parseObjectArray } from './aiParse'
import { locateQuote } from './paceAnalysis'

/** 读者是谁 —— 决定 AI 站在谁的位置读（不是"读者画像分析"，是"你就是这个人"） */
export interface ReaderLens {
  key: string
  name: string
  /** 一句话人设，写进提示词的「你是谁」 */
  brief: string
  /** 这个读者最容易被什么惹到（写在界面上，让作者知道自己在问谁） */
  care: string
}

export const READER_LENSES: ReaderLens[] = [
  {
    key: 'chaser',
    name: '追更读者',
    brief: '你是每天追更的网文读者，通勤路上用手机看。一章读完觉得没劲，下一章就不会点了——你从不"体谅作者"，也不关心文笔。',
    care: '最在意：这章有没有让我爽到 / 有没有留一个非点不可的理由。',
  },
  {
    key: 'rookie',
    name: '第一次点开的新读者',
    brief: '你从推荐位点进来，没看过这本书的任何前文，也不认识里面任何一个人。这一章就是你了解这个世界的全部信息。',
    care: '最在意：谁是谁、在干什么、为什么这么干 —— 全靠这一章讲清楚。',
  },
  {
    key: 'veteran',
    name: '同类型老书虫',
    brief: '你读过几百本同类型的书，套路基本都见过。你不反感套路，但一眼能看穿的走向、重复的桥段会让你失去耐心。',
    care: '最在意：有没有我没见过的处理 / 是不是又走了那条老路。',
  },
]

export function readerLensOf(key: string): ReaderLens {
  return READER_LENSES.find(l => l.key === key) ?? READER_LENSES[0]
}

/** 三个固定问题（规划原文口径：「哪里看不下去 / 哪里没看懂 / 最想知道什么」） */
export interface ReaderQuestion {
  key: string
  label: string
  /** 给模型的问法（第二人称、口语，避免滑回"审稿"腔） */
  ask: string
}

export const READER_QUESTIONS: ReaderQuestion[] = [
  {
    key: 'bored',
    label: '哪里看不下去',
    ask: '读到哪一段你开始走神、想跳过去、甚至不想往下看了？为什么这一段留不住你？',
  },
  {
    key: 'lost',
    label: '哪里没看懂',
    ask: '哪一处让你停下来想「等等，这是什么意思」「这人是谁」？是哪个信息没交代清楚？',
  },
  {
    key: 'want',
    label: '最想知道什么',
    ask: '读完这一章，你最想知道接下来的哪件事？是哪一句勾住了你（如果一句都没有，就直说）？',
  },
]

export function readerQuestionLabel(key: string): string {
  return READER_QUESTIONS.find(q => q.key === key)?.label ?? '其他'
}

/** 一条反馈：读者在说什么 + 他说的是正文哪一处 */
export interface ReaderNote {
  /** 问题 key（bored / lost / want） */
  q: string
  /** 模型给的逐字引文（原样展示，让作者能核对） */
  quote: string
  /** 引文在正文里的字符下标；-1 = 未定位 */
  at: number
  /** 段号（1 起）；0 = 未定位 */
  paragraph: number
  /** 读者感受（一句话） */
  comment: string
}

export interface ReaderProbeResult {
  notes: ReaderNote[]
  /** 读者视角的收尾一句（想不想接着看） */
  summary: string
  /** 模型没按结构回时的原始文本（降级展示，不丢内容）；正常解析时为空串 */
  raw: string
}

/** 字符串 → 段号（1 起，按换行分段）；下标无效时返回 0（表示未定位） */
export function paragraphAt(text: string, at: number): number {
  if (at < 0 || at > text.length) return 0
  let n = 1
  for (let i = 0; i < at; i++) if (text[i] === '\n') n++
  return n
}

/** 归一化问题 key：模型可能写「看不下去」「bored」等，认不出来就落到 bored（界面标原文，不静默丢） */
function normalizeQuestion(v: unknown): string {
  const s = asText(v).trim()
  if (READER_QUESTIONS.some(q => q.key === s)) return s
  // ⚠️ lost 要排在 bored 之前：「没看懂」不含「看不懂」，但也不该落到 bored（单测抓到过）
  if (/看不懂|没看懂|看不懂|没懂|不懂|困惑|confus|lost/i.test(s)) return 'lost'
  if (/看不下去|没劲|弃|无聊|bored|skip/i.test(s)) return 'bored'
  if (/想知道|期待|好奇|curious|want/i.test(s)) return 'want'
  return 'bored'
}

function normalizeNotes(v: unknown): Array<{ q: string; quote: string; comment: string }> {
  if (!Array.isArray(v)) return []
  const out: Array<{ q: string; quote: string; comment: string }> = []
  for (const item of v) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    out.push({
      q: normalizeQuestion(o.q ?? o.question ?? o.type),
      quote: asText(o.quote ?? o.evidence ?? o.text),
      comment: asText(o.comment ?? o.note ?? o.why ?? o.reason),
    })
  }
  return out
}

/**
 * 解析模型回复 → `ReaderProbeResult`（**纯函数**，单测直接喂字符串）。
 *
 * 容错顺序与 B5 一致：先按单个对象解析（提示词要求的就是对象），
 * 再兼容模型把 notes 直接摊成数组的情况；都失败才降级把原文兜住。
 */
export function parseReaderProbe(raw: string, chapterText: string): ReaderProbeResult {
  const obj = parseLooseObject(raw) ?? {}

  let items = normalizeNotes(obj.notes ?? obj.items ?? obj.list)
  if (items.length === 0) {
    // 兼容：模型直接回了一个数组（无外层对象）
    items = normalizeNotes(parseObjectArray(raw))
  }

  const notes: ReaderNote[] = items.map(it => {
    const at = it.quote ? locateQuote(chapterText, it.quote) : -1
    return { q: it.q, quote: it.quote, at, paragraph: paragraphAt(chapterText, at), comment: it.comment }
  // 有引文的一律排在前面（更好用）；同一问题内按正文顺序排
  }).sort((a, b) => (a.q === b.q ? a.at - b.at : 0))

  const summary = asText(obj.summary ?? obj.verdict ?? obj.overall)

  // 一条都没解析出来 ⇒ 原文兜住（不静默丢）
  const empty = notes.length === 0 && !summary
  return { notes, summary, raw: empty ? raw.trim() : '' }
}

/** 按三个问题分组（保持 READER_QUESTIONS 的顺序；空组也保留，让作者看到"这一项读者没意见"） */
export function groupNotes(notes: ReaderNote[]): Array<{ q: ReaderQuestion; items: ReaderNote[] }> {
  return READER_QUESTIONS.map(q => ({ q, items: notes.filter(n => n.q === q.key) }))
}

/** 汇总成可复制的纯文本（给作者贴到笔记 / 反馈里） */
export function readerProbeToText(result: ReaderProbeResult, chapterTitle: string, lensName: string): string {
  const lines: string[] = [`【读者视角审问】${chapterTitle} · 以「${lensName}」的身份读`]
  for (const { q, items } of groupNotes(result.notes)) {
    lines.push('', `■ ${q.label}`)
    if (items.length === 0) { lines.push('（读者没提这一项）'); continue }
    for (const it of items) {
      const loc = it.paragraph > 0 ? `第 ${it.paragraph} 段` : '未定位'
      lines.push(`· 〔${loc}〕「${it.quote}」`)
      lines.push(`  ${it.comment}`)
    }
  }
  if (result.summary) lines.push('', `■ 读完这一章的感受`, result.summary)
  if (result.raw) lines.push('', '■ 原始回复', result.raw)
  return lines.join('\n')
}
