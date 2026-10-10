/**
 * 3.0 · W1-2 上下文分层与规模门（纯函数，好测）
 *
 * §10.3 #2：**远 / 中 / 近分层召回 ＋ 规模门（10 万 / 30 万 / 100 万字符）**。
 *
 * 🔴 为什么需要它（长篇的命门）：`buildProjectContext` 原先预算是**写死的 12000 字符**。
 *    写到 100 万字（约 400 章）时，这点预算只够塞进开头十来章 —— 模型看到的「前文」永远
 *    是第 1 章，越往后越不准。与其平铺截断，不如**按项目规模放大预算与召回数**。
 *
 * 三层的口径（与既有实现一一对应，不另造一套）：
 *   · **远**（全书脉络）—— 章节清单/摘要（`buildChapterDigest`）
 *   · **中**（相关证据）—— 相关章节召回（`findRelatedChapters`）、语义召回（`recallRelevant`）、
 *     参考资料（`buildKbBlock`）
 *   · **近**（当前上下文）—— 最近章节正文（`getRecentChapterTexts`）、相邻章末尾
 *
 * 🔴 小项目（< 10 万字）的档位**与旧行为逐字一致** —— 改这个文件不该动到中短篇的手感。
 */

export type ContextScale = 'short' | 'medium' | 'long' | 'epic'

/** 规模门阈值（项目总字数）—— 对应 §10.3 #2 的「10 万 / 30 万 / 100 万字符」 */
export const SCALE_GATES = { medium: 100_000, long: 300_000, epic: 1_000_000 } as const

/** 按项目总字数判规模档（阈值取「≥」） */
export function scaleOf(totalWords: number): ContextScale {
  const w = Number.isFinite(totalWords) && totalWords > 0 ? totalWords : 0
  if (w >= SCALE_GATES.epic) return 'epic'
  if (w >= SCALE_GATES.long) return 'long'
  if (w >= SCALE_GATES.medium) return 'medium'
  return 'short'
}

/** 某一规模档下的上下文配额 */
export interface LayerPlan {
  /** 设定/资料装配的总预算（字符） */
  budget: number
  /** 相关章节召回数上限 */
  relatedChapters: number
  /** 语义召回片段数上限 */
  semantic: number
  /** 远层：章节摘要带多少章（`buildChapterDigest` 的上限） */
  digestChapters: number
}

/**
 * 四档配额。
 * 🔴 `short` 档与改造前的写死值**逐项相等**（budget 12000 / related 8）—— 这是"小项目零变化"的保证。
 */
export const LAYER_PLANS: Record<ContextScale, LayerPlan> = {
  short: { budget: 12_000, relatedChapters: 8, semantic: 6, digestChapters: 200 },
  medium: { budget: 20_000, relatedChapters: 12, semantic: 8, digestChapters: 300 },
  long: { budget: 32_000, relatedChapters: 16, semantic: 10, digestChapters: 500 },
  epic: { budget: 48_000, relatedChapters: 20, semantic: 12, digestChapters: 800 },
}

/** 取某项目体量对应的配额 */
export function planFor(totalWords: number): LayerPlan {
  return LAYER_PLANS[scaleOf(totalWords)]
}
