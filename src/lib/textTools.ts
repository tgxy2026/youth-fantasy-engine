/**
 * 一键排版（参考橙瓜码字「快捷排版」：段落首行缩进、空行规范）
 */

/** 规范排版：去行尾空白、合并连续空行为一个、每段首行加两个全角空格缩进 */
export function formatNovelText(text: string): string {
  const lines = text.split(/\r?\n/).map(l => l.replace(/[\s　]+$/, ''))
  const out: string[] = []
  let blankRun = 0
  for (const line of lines) {
    const trimmed = line.replace(/^[\s　]+/, '')
    if (trimmed === '') {
      blankRun++
      if (blankRun <= 1 && out.length > 0) out.push('')
      continue
    }
    blankRun = 0
    out.push('　　' + trimmed)
  }
  // 去掉首尾空行
  while (out.length > 0 && out[0] === '') out.shift()
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}
