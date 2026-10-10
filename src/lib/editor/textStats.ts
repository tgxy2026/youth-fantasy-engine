/**
 * 中英混合字数统计（全局统一口径）。
 * - CJK 字符（含扩展 A 区）逐字计数
 * - 拉丁字母 / 数字按「词」计数（连续 [a-zA-Z0-9]+ 算一个词）
 *
 * 编辑器实时统计、全文搜索替换重算字数、种子数据估算、章节快照判定
 * 均复用此函数，避免各处口径漂移导致字数对不上。
 *
 * 🔴 两种口径（#004，2026-09-21 起）：
 *   `'cjk'`       —— 汉字 ＋ 英文词，**不含标点**。默认值，也是**所有逻辑判断必须用的口径**。
 *   `'cjk-punct'` —— 汉字 ＋ 中文标点 ＋ 英文词。**网文平台的计费口径**，仅供「展示」用。
 * ⚠️ 逻辑层（`enforceWordRange` 的 ±300 汉字判定、AI 输出异常阈值、拆书字数等）
 *    一律走默认口径，**绝不随用户的显示偏好变** —— 否则「写够 3000 字」这类硬约束
 *    会随着开关漂移，属于行为退化。
 */
export type WordCountMode = 'cjk' | 'cjk-punct'

/** CJK 统一表意文字（含扩展 A 区） */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g

/**
 * 中文标点（网文平台计入字数的那些）。
 * 覆盖：CJK 符号与标点(U+3000–303F)、全角标点子集（**排除**全角字母数字 U+FF10–FF19/FF21–FF3A/FF41–FF5A）、
 *      以及中文里常用的西文标点（— … · “ ” ‘ ’）。
 */
const PUNCT_RE =
  /[\u3000-\u303f\u2014\u2018-\u201d\u2026\u00b7]|[\uff01-\uff0f]|[\uff1a-\uff20]|[\uff3b-\uff40]|[\uff5b-\uff65]/g

export function countWords(text: string, mode: WordCountMode = 'cjk'): number {
  const cjk = (text.match(CJK_RE) || []).length
  const words = (text.replace(CJK_RE, ' ').match(/[a-zA-Z0-9]+/g) || []).length
  if (mode === 'cjk') return cjk + words
  const punct = (text.match(PUNCT_RE) || []).length
  return cjk + punct + words
}
