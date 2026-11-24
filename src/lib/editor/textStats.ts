/**
 * 多语言字数统计（全局统一口径）。
 * - 「文字」= 所有语言文字的字母与数字字符（Unicode \p{L}\p{N}），逐码点计 1：
 *   汉字逐字、英文字母逐字（hello=5）、假名/谚文/西里尔/带音标拉丁等一律逐字。
 * - 「文字＋标点」= 文字 + 所有标点符号（Unicode \p{P}，含中英文标点），仅供展示。
 * - 空白与符号（emoji、+、= 等 \p{S}/\p{Z}）两口径都不计。
 *
 * 编辑器实时统计、全文搜索替换重算字数、种子数据估算、章节快照判定、导入预览、
 * 修订字数差、排行含标点净增量均复用此函数，避免各处口径漂移导致字数对不上。
 *
 * 🔴 两种口径（3.6.4 起由「汉字/汉字+标点」改为「文字/文字+标点」）：
 *   `'text'`       —— 文字，**不含标点**。默认值，也是**所有逻辑判断必须用的口径**。
 *   `'text-punct'` —— 文字＋标点。**含所有标点符号**，仅供「展示」用。
 * ⚠️ 逻辑层（`enforceWordRange` 的 ±300 判定、AI 输出异常阈值、拆书字数等）
 *    一律走默认口径，**绝不随用户的显示偏好变** —— 否则「写够 3000 字」这类硬约束
 *    会随着开关漂移，属于行为退化。
 * 🔴 3.6.4 前的老口径只数汉字＋ASCII 英文词，假名/谚文/西里尔/带音标字母完全不计、
 *    英文按词计；历史落库 `wordCount` 与排行账本保留老口径数值，不回填重算。
 */
export type WordCountMode = 'text' | 'text-punct'

/** 所有语言的字母与数字（逐码点；u 标志保证代理对按 1 个码点计） */
const LETTER_RE = /[\p{L}\p{N}]/gu

/** 所有语言的标点（中文 。、！…… 与西文 . , ! ? 引号等；不含空白与符号） */
const PUNCT_RE = /\p{P}/gu

export function countWords(text: string, mode: WordCountMode = 'text'): number {
  const letters = (text.match(LETTER_RE) || []).length
  if (mode === 'text') return letters
  return letters + (text.match(PUNCT_RE) || []).length
}