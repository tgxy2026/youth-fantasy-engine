/**
 * 正文工作现场的**纯计算**部分（UX06 · 捕获/恢复）。
 *
 * 【为什么单独一层】
 *   捕获与恢复都在 React 之外跑（离页时同步捕获、恢复要等布局稳定），而「什么算内容变了」
 *   「布局变了该用绝对位置还是相对比例」这些判断是纯数学，抽出来才能单测、也才不会被 DOM 噪声带偏。
 *
 * 🔴 只处理**数字与摘要**，绝不接触正文原文：
 *   revision 是内容的单向摘要（长度 + 两路 FNV-1a），只用于「回来时内容还是不是那一份」的比对。
 *   记录里不存任何正文片段，也不存选区周围的上下文。
 */

/** 校验用：与 workspaceViewState 的 opaqueId 同字符集（字母数字 + `_ . : -`） */
export interface SelectionPlan { start: number; end: number; direction: 'forward' | 'backward' | 'none' }
export interface LayoutBox { width: number; height: number; fontSize: number; lineHeight: number }
export interface ScrollRecord { top: number; ratio: number; outerTop: number; outerRatio: number }

/**
 * 内容修订标识（单向摘要，不是哈希签名的安全用途）。
 * 两路 32 位混合 + 长度，碰撞概率对「同一章改没改」这一用途足够；
 * 输出只用 `[0-9a-z-]`，满足存储层的 opaqueId 校验。
 */
export function contentRevision(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = (Math.imul(b ^ (code + i), 0x85ebca6b) ^ (b >>> 13)) >>> 0
  }
  return `${text.length.toString(36)}-${a.toString(36)}${b.toString(36)}`
}

/** 把记录里的选区夹到当前正文长度内（防御：记录来自上一份内容或更短的稿） */
export function clampSelection(
  start: number,
  end: number,
  length: number,
  direction: SelectionPlan['direction'] = 'none',
): SelectionPlan {
  const safe = (value: number) => Math.max(0, Math.min(length, Number.isFinite(value) ? Math.trunc(value) : 0))
  const s = safe(start)
  return { start: s, end: Math.max(s, safe(end)), direction }
}

/** 捕获时的滚动比例：0 = 顶部，1 = 触底（`max` 为 scrollHeight − clientHeight） */
export function scrollRatio(top: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(top)) return 0
  return Math.max(0, Math.min(1, top / max))
}

/**
 * 恢复滚动的方案：
 * - 排版没变（宽度 / 字号 / 行高一致）⇒ 用**绝对位置**，与原样一模一样；
 * - 排版变了（换字号、换窗口、换密度）⇒ 用**相对比例**，宁可大致对位也不要跳到无关段落；
 * `max` 为当前 scrollHeight − clientHeight。
 */
export function scrollTopFor(
  record: ScrollRecord,
  saved: LayoutBox,
  current: LayoutBox,
  max: number,
): { top: number; mode: 'absolute' | 'ratio' } {
  const limit = Math.max(0, Math.trunc(max))
  const sameLayout = (['width', 'fontSize', 'lineHeight'] as const)
    .every(key => Math.abs((current[key] ?? 0) - (saved[key] ?? 0)) < 0.5)
  if (sameLayout && Number.isFinite(record.top)) {
    return { top: Math.max(0, Math.min(limit, Math.trunc(record.top))), mode: 'absolute' }
  }
  const ratio = Number.isFinite(record.ratio) ? Math.max(0, Math.min(1, record.ratio)) : 0
  return { top: Math.round(ratio * limit), mode: 'ratio' }
}
