/**
 * 一键排版（参考橙瓜码字「快捷排版」：段落首行缩进、空行规范）
 *
 * 【2.4.0 · A5 起的两处变化】
 * ① 🔴 **默认不再抹平缩进**：旧实现给每行强制加两个全角空格，把作者手写的多级缩进
 *    （缩进一级的对白、缩进两级的补充说明）一律压平成段首 —— 那正是「自由缩进排版」要解决的痛点。
 *    现在默认**保留每行既有缩进深度**，只做它本来该做的事：去行尾空白、折叠连续空行、去首尾空行。
 * ② **旧的「强制统一」没有删**：作为 `mode: 'uniform'` 保留，供确实想让整篇版面严格对齐的作者使用；
 *    缩进单位跟随编辑器设置项（`lib/indent.ts` 的 `IndentUnit`）。
 */
import { type IndentUnit, DEFAULT_INDENT_UNIT, indentTextOf, splitIndent } from '@/lib/editor/indent'

export type FormatMode = 'preserve' | 'uniform'

export interface FormatOptions {
  /** `preserve`（默认）＝保留既有缩进深度；`uniform` ＝全篇统一成段首一个缩进单位 */
  mode?: FormatMode
  /** 缩进单位：`uniform` 模式的段首前缀用它；两档下的"整行只有空白"判定共用 */
  unit?: IndentUnit
}

/**
 * 规范排版：去行尾空白 → 连续空行折叠成一个 → 去首尾空行；
 * 缩进按 `mode` 决定「保留深度」还是「统一成段首一个单位」。
 */
export function formatNovelText(text: string, opts: FormatOptions = {}): string {
  const mode: FormatMode = opts.mode ?? 'preserve'
  const unit = indentTextOf(opts.unit ?? DEFAULT_INDENT_UNIT)
  const lines = text.split(/\r?\n/).map(l => l.replace(/[\s　]+$/, ''))
  const out: string[] = []
  let blankRun = 0
  for (const line of lines) {
    // ⚠️ 用 splitIndent 判空行：它把「整行只有空白」也视作空行（缩进归零），
    //    否则一串只有全角空格的行会被当成正文行保留下来，导出后是一堆看不见的空白。
    const { indent, rest } = splitIndent(line)
    if (rest === '') {
      blankRun++
      if (blankRun <= 1 && out.length > 0) out.push('')
      continue
    }
    blankRun = 0
    out.push(mode === 'uniform' ? unit + rest : indent + rest)
  }
  // 去掉首尾空行
  while (out.length > 0 && out[0] === '') out.shift()
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}
