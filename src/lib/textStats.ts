/**
 * 中英混合字数统计（全局统一口径）。
 * - CJK 字符（含扩展 A 区）逐字计数
 * - 拉丁字母 / 数字按「词」计数（连续 [a-zA-Z0-9]+ 算一个词）
 *
 * 编辑器实时统计、全文搜索替换重算字数、种子数据估算、章节快照判定
 * 均复用此函数，避免各处口径漂移导致字数对不上。
 */
export function countWords(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const words = (text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ').match(/[a-zA-Z0-9]+/g) || []).length
  return cjk + words
}
