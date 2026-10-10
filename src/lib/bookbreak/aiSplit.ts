/**
 * 拆书 · AI 章节切分的本地核对与重建（2.6.1 · R2，纯函数，零 AI 依赖，可单测）。
 *
 * 🔴 防幻觉铁律：AI 报回来的「章节起始行」必须在原文里**逐字命中**才采信 ——
 *   先按整行严格匹配，不足 2 处再退一步用「前缀包含」（行以 AI 文本开头且 AI 文本 ≥4 字），
 *   仍不足 2 处就整体弃用（返回 null），调用方回退本地正则 / 字数兜底的结果。
 *   任何一步都不允许「AI 说什么就是什么」。
 */
import { scanLinesOf, buildChaptersFromMarks, type RawChapter, type SplitResult } from '@/lib/bookbreak/split'
import { stripEmphasis } from '@/lib/storage/mdLite'

/**
 * 单段采样上限（字符）——中文 1 字 ≈ 1 token，四段合计 = `SAMPLE_BUDGET_FALLBACK`（7500）
 * ⇒ ≈7500 token，压在常见 num_ctx 内。
 *
 * 🔴 2026-10-10 六维审计 P2：这四个数是「采样口径」的唯一定义处，但**实际调用点**要用
 *    `writerBudgetFor('bookbreak-split')`（`aiWriterBudget`）派生的额度 —— 否则「登记在
 *    预算表里的系数」与「真正喂给模型的字数」会各走一路、静默漂移（拆书链路没有别的调用点读它）。
 *    下面 `sampleTextForSplit(raw, budget?)` 的 `budget` 就是那个额度；不传时退回出厂 7500 字。
 */
const HEAD_CHARS = 3000
const MID_CHARS = 1500
const MID_TAKES = 2
const TAIL_CHARS = 1500
/** 四段合计（= 7500）—— 不传 budget 时的出厂采样上限，与 `aiWriterBudget` 的出厂换算结果一致 */
export const SAMPLE_BUDGET_FALLBACK = HEAD_CHARS + MID_TAKES * MID_CHARS + TAIL_CHARS
/** AI 报的行原文定位时，两章起点之间的最小间距（字符）——防相邻行重复计数 */
const MIN_GAP = 200

/**
 * 从整篇原文里采样给 AI：头部 + 中部切片 + 尾部，节选处用「……」占位（保持行结构不破坏）。
 *
 * @param budget 采样总字数上限（由 `writerBudgetFor('bookbreak-split')` 派生）。
 *   省略时用出厂 `SAMPLE_BUDGET_FALLBACK`（7500），行为与改造前完全一致。
 *   传入时会按 4:2:2:1 的固定比例重新分配四段（头 40% / 中×2 各 20% / 尾 20%），下限保护 400 字。
 */
export function sampleTextForSplit(raw: string, budget?: number): string {
  const text = raw ?? ''
  const total = budget === undefined ? SAMPLE_BUDGET_FALLBACK : Math.max(400, Math.round(budget))
  // 按出厂比例切分：头 40%、中部每段 20%（×2）、尾 20%
  const ratio = total / SAMPLE_BUDGET_FALLBACK
  const headChars = Math.round(HEAD_CHARS * ratio)
  const midChars = Math.round(MID_CHARS * ratio)
  const tailChars = Math.round(TAIL_CHARS * ratio)
  if (text.length <= headChars + tailChars) return text
  const head = text.slice(0, headChars)
  const tail = text.slice(-tailChars)
  const gap = text.length - headChars - tailChars
  const step = Math.floor(gap / (MID_TAKES + 1))
  const mids: string[] = []
  for (let i = 1; i <= MID_TAKES; i++) {
    const at = headChars + step * i
    mids.push(text.slice(at, at + midChars))
  }
  return [head, ...mids, tail].join('\n……\n')
}

/**
 * 把 AI 报的行回定位到原文，重建「章节模式」切分结果。
 * 返回 null = 采信不足（<2 处命中），调用方回退本地结果。
 */
export function applyAiSplit(raw: string, aiLines: string[], maxChunks = 60): SplitResult | null {
  const text = raw ?? ''
  if (!aiLines.length) return null
  const lines = scanLinesOf(text)
  const hits: { start: number; title: string }[] = []

  const locate = (match: (lineText: string, aiLine: string) => boolean) => {
    hits.length = 0
    for (const aiLine of aiLines) {
      const key = aiLine.trim()
      if (key.length < 2) continue
      let found = lines.find(l => match(l.text.trim(), key))
      // 🔴 模型有时给行加了 markdown 强调（`**第三章 血月夜**`）—— 逐字比对会全落空、
      //    命中 <2 就整体弃用（静默降级回本地兜底）。剥一次强调再试，仍要求逐字命中。
      if (!found) {
        const clean = stripEmphasis(key).trim()
        if (clean !== key && clean.length >= 2) found = lines.find(l => match(l.text.trim(), clean))
      }
      if (!found) continue
      // 同一行多次被报（模型重复）只收一次；与上一章起点太近的丢弃（MIN_GAP 防密集误判）
      if (hits.some(h => h.title === found.text.trim())) continue
      const prev = hits[hits.length - 1]
      if (prev && found.start - prev.start < MIN_GAP) continue
      hits.push({ start: found.start, title: found.text.trim() })
    }
    hits.sort((a, b) => a.start - b.start)
    return hits.length
  }

  // 第一轮：整行逐字相等；第二轮：行以 AI 文本为前缀（AI 可能漏抄行尾变化）
  if (locate((line, key) => line === key) < 2) {
    if (locate((line, key) => key.length >= 4 && line.startsWith(key)) < 2) return null
  }
  return buildChaptersFromMarks(text, hits, maxChunks)
}

/** 类型再导出（调用方免 import 两处） */
export type { RawChapter, SplitResult }
