/**
 * 拆书 · AI 章节切分的本地核对与重建（2.6.1 · R2，纯函数，零 AI 依赖，可单测）。
 *
 * 🔴 防幻觉铁律：AI 报回来的「章节起始行」必须在原文里**逐字命中**才采信 ——
 *   先按整行严格匹配，不足 2 处再退一步用「前缀包含」（行以 AI 文本开头且 AI 文本 ≥4 字），
 *   仍不足 2 处就整体弃用（返回 null），调用方回退本地正则 / 字数兜底的结果。
 *   任何一步都不允许「AI 说什么就是什么」。
 */
import { scanLinesOf, buildChaptersFromMarks, type RawChapter, type SplitResult } from './split'

/** 单段采样上限（字符）——中文 1 字 ≈ 1 token，四段合计 ≤7500 字（≈7500 token），压在常见 num_ctx 内 */
const HEAD_CHARS = 3000
const MID_CHARS = 1500
const MID_TAKES = 2
const TAIL_CHARS = 1500
/** AI 报的行原文定位时，两章起点之间的最小间距（字符）——防相邻行重复计数 */
const MIN_GAP = 200

/** 从整篇原文里采样给 AI：头部 + 中部切片 + 尾部，节选处用「……」占位（保持行结构不破坏） */
export function sampleTextForSplit(raw: string): string {
  const text = raw ?? ''
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return text
  const head = text.slice(0, HEAD_CHARS)
  const tail = text.slice(-TAIL_CHARS)
  const gap = text.length - HEAD_CHARS - TAIL_CHARS
  const step = Math.floor(gap / (MID_TAKES + 1))
  const mids: string[] = []
  for (let i = 1; i <= MID_TAKES; i++) {
    const at = HEAD_CHARS + step * i
    mids.push(text.slice(at, at + MID_CHARS))
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
      const found = lines.find(l => match(l.text.trim(), key))
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
