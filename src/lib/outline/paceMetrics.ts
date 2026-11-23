// ============ 逐章确定性节奏指标（3.7.0 · W5）============
//
// 立场（规划 §3 W5.2 ③）：**只呈现事实分布** —— 不合成总分、不标区间、不做名次；
// 观察句只说「哪几章没有登记爽点」这类可由数据直接核对的陈述。
//
// 全部本地计算、零 AI：复用 `styleFingerprint.countDialogueWords` / `manuscriptCheck`
// 的段落切分与变异系数 —— 不重写第二套统计（两套口径必然漂移）。
import { countWords } from '@/lib/editor/textStats'
import { countDialogueWords } from '@/lib/ai/styleFingerprint'
import { splitParagraphs, cv } from '@/lib/audit/manuscriptCheck'

export interface PaceChapterInput {
  id: string
  /** 叙事序号（0 = 不占号，跳过） */
  no: number
  title: string
  content: string
}

export interface PaceHookInput {
  /** 该爽点登记的章号 */
  chapterNo: number
  /** 强度档：小 / 中 / 大 / 名场面（未知按「小」计权，不猜成更高档） */
  strength: string
}

export interface PacePoint {
  chapterNo: number
  title: string
  words: number
  /** 对话字数占比（0–1） */
  dialogueRatio: number
  /** 平均段长（字） */
  avgParagraph: number
  /** 段长变异系数（离散程度；段落越均匀越小） */
  paragraphCv: number
  /** 本章登记的爽点条数 */
  hooks: number
  /** 强度档加权和（小1 / 中2 / 大3 / 名场面4） */
  hookWeight: number
  /** 距上一个登记爽点隔了几章（本章有爽点 = 0；首个爽点前为 null） */
  hookGap: number | null
}

export interface PaceSeries {
  points: PacePoint[]
  /** 连续无爽点登记的最长一段（含起止章号；没有则 null） */
  longestHookGap: { from: number; to: number; length: number } | null
  /** 事实型观察句（界面直接展示；每句都能由点数据核对） */
  observations: string[]
}

const WEIGHT: Record<string, number> = { 小: 1, 中: 2, 大: 3, 名场面: 4 }

function weightOf(strength: string | undefined): number {
  return WEIGHT[(strength ?? '').trim()] ?? 1
}

/** 逐章指标（纯函数）。空章 / 空书 / 无爽点都正常返回，不抛。 */
export function computePaceSeries(chapters: readonly PaceChapterInput[], hooks: readonly PaceHookInput[]): PaceSeries {
  const usable = chapters.filter(c => typeof c.no === 'number' && Number.isFinite(c.no) && c.no > 0)
    .sort((a, b) => a.no - b.no)
  const byChapter = new Map<number, PaceHookInput[]>()
  for (const h of hooks) {
    if (!(h.chapterNo > 0)) continue
    const list = byChapter.get(h.chapterNo) ?? []
    list.push(h)
    byChapter.set(h.chapterNo, list)
  }
  const points: PacePoint[] = usable.map(c => {
    const text = c.content ?? ''
    const words = countWords(text)
    const paragraphs = splitParagraphs(text).map(p => countWords(p)).filter(n => n > 0)
    const dialogue = countDialogueWords(text)
    const mine = byChapter.get(c.no) ?? []
    return {
      chapterNo: c.no,
      title: c.title ?? '',
      words,
      dialogueRatio: words > 0 ? Math.min(1, dialogue / words) : 0,
      avgParagraph: paragraphs.length ? Math.round(words / paragraphs.length) : 0,
      paragraphCv: paragraphs.length > 1 ? Number(cv(paragraphs).toFixed(3)) : 0,
      hooks: mine.length,
      hookWeight: mine.reduce((sum, h) => sum + weightOf(h.strength), 0),
      hookGap: null,
    }
  })

  // 距上个登记爽点隔了几章（只认「登记过」的章；本章有爽点 = 0）
  let lastHook = 0
  for (const p of points) {
    if (p.hooks > 0) { p.hookGap = 0; lastHook = p.chapterNo; continue }
    p.hookGap = lastHook > 0 ? p.chapterNo - lastHook : null
  }

  // 最长连续无爽点段（事实陈述，不做好坏判断）
  let longest: PaceSeries['longestHookGap'] = null
  let runStart = 0
  let runLen = 0
  for (const p of points) {
    if (p.hooks > 0) { runStart = 0; runLen = 0; continue }
    if (runStart === 0) runStart = p.chapterNo
    runLen++
    if (!longest || runLen > longest.length) longest = { from: runStart, to: p.chapterNo, length: runLen }
  }

  const observations: string[] = []
  if (longest && longest.length > 1) {
    observations.push(`第 ${longest.from}–${longest.to} 章连续 ${longest.length} 章没有登记爽点。`)
  }
  const empty = points.filter(p => p.words === 0)
  if (empty.length) observations.push(`有 ${empty.length} 章还没有正文（${empty.slice(0, 5).map(p => `第${p.chapterNo}章`).join('、')}${empty.length > 5 ? ' 等' : ''}）。`)
  if (!points.length) observations.push('这本书还没有可统计的章节。')
  else if (points.every(p => p.words === 0)) observations.push('全书还没有可统计的正文。')
  if (!longest && points.length && points.some(p => p.hooks > 0)) observations.push('已登记的爽点之间没有出现连续空缺。')

  return { points, longestHookGap: longest, observations }
}

/** 抽稀到 ≤ max 个点（千章级曲线不把 DOM 撑爆；首尾点必留） */
export function samplePoints(points: readonly PacePoint[], max = 500): PacePoint[] {
  if (points.length <= max || max < 3) return [...points]
  // 留一个名额给尾点，保证「点数 ≤ max」而不会因为补尾点超一
  const step = Math.ceil(points.length / Math.max(1, max - 1))
  const out: PacePoint[] = []
  for (let i = 0; i < points.length; i += step) out.push(points[i])
  const last = points[points.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}