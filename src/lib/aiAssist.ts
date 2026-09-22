/**
 * AI 辅助占比统计（2.4.1 · B3）
 *
 * 用途：如实记录「哪些环节用了 AI、用了多少」，供两处消费：
 *   ① 「创作轨迹」页签展示；② 一键生成投稿平台的《AI 使用情况申报说明》草稿。
 *
 * 🔴 **立场（产品红线，一个字都不能含糊）**：这是**如实申报**工具，**不是**「反检测 / 降低 AI 命中率」工具。
 *    所有对外文案只描述"用了什么、用在哪里"，绝不做任何掩盖性加工，也不给"怎么改才不被认出来"的建议。
 *
 * 【口径：为什么记「累计产出字数」而不是「当前正文里有多少 AI 字」】
 * AI 产出之后作者往往会再改，改完就**无法反推**哪些字是 AI 的。
 * 所以口径定为**过程量**：每次 AI 产出时把字数累加进来 —— 可核验、不猜测。
 * 代价是它可能大于当前字数（AI 写 3000 字、作者删到 1000 字）—— 故 `aiRatio()` 会**封顶 100%**
 * 并在文案里讲清这一点，而不是假装精确。
 *
 * 【为什么要「纯函数 + 单一入口」而不是在每个调用点手写】
 * `saveChapter` 全项目有 15 个调用点，其中若干是 AI 路径 —— 逐个手写必然漏（"删了会复活是家族"的教训）。
 * 因此：① 记账做成**纯函数** `withAiAssist()`，返回新对象不产生副作用；
 *       ② 测试里用**守门断言**盯着那几条 AI 主路径必须出现该调用，漏一处就红。
 */
import type { Chapter, AiAssistStat } from './types'
// ⚠️ 用的是 `textStats` 里那个 countWords（与 chapterRewrite / autoContinue 同一实现）——
//    别图省事换成别处的同名函数，否则占比数字会和其它地方的口径对不上。
import { countWords } from './textStats'

/** 类型本体定义在 `types.ts`（避免循环依赖）—— 这里转发一次，调用方少 import 一处 */
export type { AiAssistStat }

/** 四类来源（与 2.4.0-版本规划 B3 的口径一致） */
export const AI_SOURCE_KINDS = ['generated', 'rewritten', 'continued', 'polished'] as const
export type AiSourceKind = (typeof AI_SOURCE_KINDS)[number]

/** 给作者看的来源名 —— 也是申报草稿里用的措辞 */
export const AI_SOURCE_LABELS: Record<AiSourceKind, string> = {
  generated: '生成',
  rewritten: '改写',
  continued: '续写',
  polished: '润色',
}

/** 每类来源「用在什么环节」的白话说明（申报草稿直接用） */
export const AI_SOURCE_WHERE: Record<AiSourceKind, string> = {
  generated: '创意写作 / 从无到有产出正文草稿',
  rewritten: '对已有正文做整章改写',
  continued: '在已有正文后自动续写',
  polished: '对选中段落做润色、改写等局部处理',
}

export function emptyAiAssist(): AiAssistStat {
  const zeros = () => ({ generated: 0, rewritten: 0, continued: 0, polished: 0 })
  return { chars: zeros(), times: zeros(), updatedAt: 0 }
}

/** 容错读取：旧数据 / 半截数据 / 脏数据都归一成合法结构（缺失的类按 0 计） */
export function normalizeAiAssist(raw: unknown): AiAssistStat {
  const base = emptyAiAssist()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Partial<AiAssistStat>
  for (const k of AI_SOURCE_KINDS) {
    const c = Number(r.chars?.[k])
    const t = Number(r.times?.[k])
    base.chars[k] = Number.isFinite(c) && c > 0 ? Math.floor(c) : 0
    base.times[k] = Number.isFinite(t) && t > 0 ? Math.floor(t) : 0
  }
  const u = Number(r.updatedAt)
  base.updatedAt = Number.isFinite(u) && u > 0 ? u : 0
  return base
}

/**
 * 记一次 AI 产出 —— **返回新对象，不改原对象**（纯函数，便于单测与并发安全）。
 *
 * 🔴 所有 AI 产出落库的路径都应经它，别在别处手搓 `aiAssist` 字段。
 *
 * @param ch    目标章节
 * @param kind  来源类别
 * @param chars 本次产出的字数（非正数视为无效，原样返回，不留下空记录）
 */
export function withAiAssist(ch: Chapter, kind: AiSourceKind, chars: number): Chapter {
  const n = Math.floor(Number(chars) || 0)
  if (n <= 0) return ch
  const cur = normalizeAiAssist(ch.aiAssist)
  const next: AiAssistStat = {
    chars: { ...cur.chars, [kind]: cur.chars[kind] + n },
    times: { ...cur.times, [kind]: cur.times[kind] + 1 },
    updatedAt: Date.now(),
  }
  return { ...ch, aiAssist: next }
}

/** 编辑器挂起的一笔 AI 产出记账（带章节 id —— 只有保存"同一章"时才消费它） */
export interface PendingAiNote {
  chapterId: string
  kind: AiSourceKind
  chars: number
}

/**
 * 把挂起记账里属于这一章的部分合并进章节对象（B3 补做 · 2.4.1）。
 * 返回合并后的章节 + **未消费的剩余记账**（别的章的账要继续留着）。
 *
 * 🔴 为什么抽成纯函数：编辑器里「采纳那一刻挂账、保存时合并」是两条路径（伴写采纳 / 选区改稿）
 *    共用的逻辑，写在 hook 里就没法单测；抽出来之后 hook 只做编排，tests 直接验合并与消费语义。
 */
export function foldPendingAi(
  notes: PendingAiNote[], ch: Chapter,
): { chapter: Chapter; rest: PendingAiNote[] } {
  const mine = notes.filter(n => n.chapterId === ch.id)
  const rest = notes.filter(n => n.chapterId !== ch.id)
  if (!mine.length) return { chapter: ch, rest }
  let out = ch
  for (const m of mine) out = withAiAssist(out, m.kind, m.chars)
  return { chapter: out, rest }
}

export interface AiRatio {
  /** AI 累计产出字数 */
  aiChars: number
  /** 分母：本章当前字数 */
  totalChars: number
  /** 占比（0~100，一位小数）—— 见下方"封顶"说明 */
  ratioPct: number
  /** 是否发生了"AI 产出多于现存正文"（说明经过人工删改，占比会显得偏高） */
  cappedByEdits: boolean
  /** 按类拆开的占比（便于 UI 画条） */
  byKind: Record<AiSourceKind, number>
}

/**
 * 单章 AI 占比。
 *
 * ⚠️ 分母用**当前字数**（不是"AI + 人工"的和）：这是作者投稿时平台能看到的口径。
 * 当 AI 累计产出 > 当前字数（作者事后删改过）时，占比**封顶 100%** 并置 `cappedByEdits` ——
 * 宁可显示"偏高且已说明"，也不去猜一个"更漂亮"的数字。
 */
export function aiRatio(ch: Pick<Chapter, 'content' | 'wordCount' | 'aiAssist'>): AiRatio {
  const st = normalizeAiAssist(ch.aiAssist)
  const aiChars = AI_SOURCE_KINDS.reduce((s, k) => s + st.chars[k], 0)
  const totalChars = countWords(ch.content ?? '') || ch.wordCount || 0
  if (aiChars <= 0 || totalChars <= 0) {
    return {
      aiChars, totalChars,
      ratioPct: 0,
      cappedByEdits: false,
      byKind: { generated: 0, rewritten: 0, continued: 0, polished: 0 },
    }
  }
  const raw = (aiChars / totalChars) * 100
  const byKind = {} as Record<AiSourceKind, number>
  for (const k of AI_SOURCE_KINDS) byKind[k] = Math.round((st.chars[k] / totalChars) * 1000) / 10
  return {
    aiChars,
    totalChars,
    ratioPct: Math.round(Math.min(100, raw) * 10) / 10,
    cappedByEdits: aiChars > totalChars,
    byKind,
  }
}

export interface AiAssistSummary {
  /** 参与统计的章节数（有内容的章） */
  chapters: number
  /** 有 AI 记录的章节数 */
  aiChapters: number
  aiChars: number
  totalChars: number
  ratioPct: number
  /** 按类汇总（全书） */
  chars: Record<AiSourceKind, number>
  times: Record<AiSourceKind, number>
  /** 被人工删改到"AI 产出多于现存正文"的章节数 */
  cappedChapters: number
}

/** 全书汇总（按章节列表一次算完） */
export function summarizeAiAssist(chapters: Array<Pick<Chapter, 'content' | 'wordCount' | 'aiAssist'>>): AiAssistSummary {
  const zeros = () => ({ generated: 0, rewritten: 0, continued: 0, polished: 0 })
  const out: AiAssistSummary = {
    chapters: 0, aiChapters: 0, aiChars: 0, totalChars: 0, ratioPct: 0,
    chars: zeros(), times: zeros(), cappedChapters: 0,
  }
  for (const ch of chapters) {
    const total = countWords(ch.content ?? '') || ch.wordCount || 0
    if (total <= 0) continue
    out.chapters++
    out.totalChars += total
    const r = aiRatio(ch)
    if (r.aiChars > 0) {
      out.aiChapters++
      out.aiChars += r.aiChars
      if (r.cappedByEdits) out.cappedChapters++
    }
    const st = normalizeAiAssist(ch.aiAssist)
    for (const k of AI_SOURCE_KINDS) {
      out.chars[k] += st.chars[k]
      out.times[k] += st.times[k]
    }
  }
  if (out.totalChars > 0) {
    out.ratioPct = Math.round(Math.min(100, (out.aiChars / out.totalChars) * 100) * 10) / 10
  }
  return out
}

/**
 * 生成《AI 使用情况申报说明》草稿（纯文本，作者可直接粘贴到平台申报入口）。
 *
 * 🔴 只陈述事实：用了哪几类、各多少字、占比多少、以及**已知的口径局限**。
 *    不给"怎么说明更容易通过"之类的话术建议 —— 那是越界。
 */
export function buildAiDisclosureDraft(
  s: AiAssistSummary,
  opts: { bookName?: string; generatedAt?: number } = {},
): string {
  const book = (opts.bookName || '').trim() || '本书'
  const used = AI_SOURCE_KINDS.filter(k => s.chars[k] > 0)
  const lines: string[] = []
  lines.push(`《${book}》AI 使用情况说明`)
  if (opts.generatedAt) lines.push(`生成时间：${new Date(opts.generatedAt).toLocaleString('zh-CN')}`)
  lines.push('')
  lines.push(`一、总体情况`)
  lines.push(`全书正文字数约 ${s.totalChars.toLocaleString('zh-CN')} 字，共 ${s.chapters} 章；`)
  lines.push(`其中 ${s.aiChapters} 章在写作过程中使用过 AI 辅助。`)
  lines.push(`AI 辅助产出的累计字数约 ${s.aiChars.toLocaleString('zh-CN')} 字，占当前正文的 ${s.ratioPct}%。`)
  lines.push('')
  if (used.length === 0) {
    lines.push(`二、具体环节`)
    lines.push(`本书未记录到 AI 辅助产出。`)
  } else {
    lines.push(`二、具体环节`)
    used.forEach((k, i) => {
      const pct = s.totalChars > 0 ? Math.round((s.chars[k] / s.totalChars) * 1000) / 10 : 0
      lines.push(`${i + 1}. ${AI_SOURCE_LABELS[k]}（${AI_SOURCE_WHERE[k]}）：累计约 ${s.chars[k].toLocaleString('zh-CN')} 字、${s.times[k]} 次，占当前正文 ${pct}%。`)
    })
    lines.push('')
    lines.push(`三、说明`)
    lines.push(`上述"AI 辅助产出字数"为**写作过程中的累计产出量**。作者对 AI 产出内容均做了人工取舍与修改，`)
    lines.push(`故它与"最终成稿中由 AI 直接形成的比例"并不等同 —— 最终成稿由作者本人定稿并负责。`)
    if (s.cappedChapters > 0) {
      lines.push(`（有 ${s.cappedChapters} 章出现"AI 累计产出多于现存正文"，即作者做了大幅删改，其实际留存比例低于上表数字。）`)
    }
  }
  lines.push('')
  lines.push(`四、工具说明`)
  lines.push(`本说明由写作软件依据**写作过程中自动记录的操作日志**生成，非手工填写。`)
  return lines.join('\n')
}
