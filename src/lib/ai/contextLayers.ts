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
 *
 * 🔴 `short` 档 3.1.3 由 12000 抬到 **16000**（主人 2026-10-18 拍板）。
 *    原注释写的是"与改造前写死值逐项相等"，那条保证**已主动作废**：实测一个 22 章的小项目，
 *    12000 字符在装完世界设定 / 力量体系 / 四制度 / 势力之后就用光了，
 *    ⇒ 章节清单、种族生物、物品资源、地理风物、伏笔追踪 共 19 段被整段丢弃，
 *    模型完全不知道剧情写到哪。抬到 16000 是为「章节清单 + 一两个设定表」留出实际空间。
 *    ⚠️ 代价：每次请求多约 1.3K token（云端计费、本地只慢一点）。
 */
export const LAYER_PLANS: Record<ContextScale, LayerPlan> = {
  short: { budget: 16_000, relatedChapters: 8, semantic: 6, digestChapters: 200 },
  medium: { budget: 20_000, relatedChapters: 12, semantic: 8, digestChapters: 300 },
  long: { budget: 32_000, relatedChapters: 16, semantic: 10, digestChapters: 500 },
  epic: { budget: 48_000, relatedChapters: 20, semantic: 12, digestChapters: 800 },
}

/**
 * 给「章节清单」预留的字符上限（3.1.3 · R3）。
 *
 * 🔴 为什么需要单独预留：章节清单在装配序列里排得很后，而装载是**贪心**的 ——
 *    前面的设定段只要还有空间就会一直吃，清单永远轮不到。实测把预算抬到 32000 时
 *    `章节清单` 依然是「未带入」（每次都只剩不到 200 字符）。
 *    没有它的后果很具体：AI 不知道「现在是第几章、上一章发生了什么」，续写容易接错线。
 *
 * 取 1800 的理由：一个 200 章的项目清单约 1500~2500 字符，1800 能覆盖大半；
 * 再大就会从设定段里扣得太狠。**只在清单真的有内容时才预留**（见 aiContext 里的动态计算）。
 */
export const CHAPTER_RESERVE_CHARS = 1800

/**
 * 上下文预算的上下限（字符）。
 *
 * 上限 200000 ≈ 13 万汉字设定 —— 再长的项目也不会用到这么多"资料段"，
 * 给更大只是让预算数字好看，实际装不满就停（装配器按数据量走）。
 * 下限 8000：小窗口模型（8K）也要能装下章节清单 + 一两张表。
 */
export const BUDGET_MIN = 8_000
export const BUDGET_MAX = 200_000

/**
 * **按模型上下文窗口算资料预算（字符）**。
 *
 * 公式就一句：`窗口 × 0.5`。
 *   · 1 token ≈ 1 个中文字符（保守取值），窗口的一半给"资料"，另一半留给
 *     系统提示词、召回文本、模型回复与误差；
 *   · 32K → 16384；64K → 32768；128K → 65536；200K → 100000（封顶 200000）。
 *
 * 🔴 不要在这里再乘项目规模系数：项目小的时候数据本来就少，装配器**装不满就停**，
 *    不需要提前把预算压低 —— 压低了只会在"项目变长"时突然不够用。
 */
export function budgetFromWindow(windowTokens: number): number {
  const w = Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : 0
  if (w <= 0) return LAYER_PLANS.short.budget
  return Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, Math.round(w * 0.5)))
}

/** 取某项目体量对应的配额 */
export function planFor(totalWords: number): LayerPlan {
  return LAYER_PLANS[scaleOf(totalWords)]
}
