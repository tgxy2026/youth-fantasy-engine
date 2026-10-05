/**
 * 字数额度：把「设定能注入多少」从写死的常量改成**跟着模型上下文窗口走**。
 *
 * 【为什么要有这个模块】（2026-10-05 主人定案）
 *
 * 改造前世界书之前，`WORLD_MAX_CHARS = 2400` 管的是「**整份**设定」—— 那时每轮全量注入，
 * 2400 是"压缩目标"，合理。改世界书之后语义变了：2400 管的应该是「**每次命中的量**」，
 * 可界面仍拿它去卡「整份」，于是出现「界面报警说超了、实际只注入了三分之一」的假警报。
 *
 * 更根本的是：2400 是 2026-09-15 按**本地 5090 + 27B + 32K 窗口**算出来的。
 * 接上云端 128K / 256K 窗口时明明有 4~8 倍空间，却还被 2400 卡着 —— 界面上看不出来。
 *
 * 【ST 酒馆对照】
 * ST 不设固定字数，它设**比例**（默认 `world_info_budget = 25`，即上下文预算的 25%），
 * 随 API 的上下文上限自动伸缩；超预算时按优先级**逐条**取舍（constant 最先 → order 大者先 →
 * 直接命中优先于递归命中），而不是把拼接好的字符串一刀切断。
 * 本模块取的就是这套形态，只是把比例改小（ST 的 25% 是按云端大窗口调的，本地小窗口会挤爆对话历史）。
 *
 * 【两层额度】
 *  ① **固定层**（`fixedQuotaOf`）——「一句话总纲」(背景设定) 与「世界设定」(故事剧本)。
 *     这两块是**每轮全量注入**的定调内容，不参与关键词筛选 ⇒ 单独给一份额度。
 *     默认 = 窗口 × 8%，下限 2400（保住小窗口可用）、上限 12000（别写成百科全书）。
 *  ② **动态层**（`dynamicQuotaOf`）——世界书里**按关键词筛出来的分节 / 词条**。
 *     默认 = 窗口 × 15%，可在控制面板调到 5%~35%。
 *
 * 【单位口径】
 * 全项目按「**字符 ≈ 词元**」算（`types.ts` 与 `budget.ts` 都是这个口径），
 * 汉字大致一字一词元。所以这里算出来的数直接当字数用，作者心算方便。
 *
 * 本模块**纯逻辑、零运行时依赖**（只 import 常量），便于单测。
 */

/** 固定层额度占窗口的比例 */
export const FIXED_QUOTA_RATIO = 0.08
/** 固定层下限（字）：小窗口模型也不至于写两段就超 */
export const FIXED_QUOTA_MIN = 2400
/** 固定层上限（字）：写到这里已经很长了，再多是本末倒置 */
export const FIXED_QUOTA_MAX = 12000

/** 动态层额度占窗口的**默认**比例 */
export const DYNAMIC_QUOTA_RATIO = 0.15
/** 动态层比例的可调范围与步长（控制面板用） */
export const DYNAMIC_QUOTA_PCT = { min: 5, max: 35, step: 1, default: 15 } as const

/** 窗口缺失时的保守兜底（与 `modelCapacity.FALLBACK_WINDOW` 同量级） */
export const FALLBACK_WINDOW_TOKENS = 32768

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/**
 * 取「当前该按多大窗口算额度」。
 *
 * 🔴 真源是**模型配置里手填的「上下文窗口」**（2.8.0 起必填，见 `modelCapacity.checkContextWindow`）。
 *    这里只做「拿不到就保守兜底」：`null` / 非数 / 小于可信下限（说明多半是把 K 当词元数填了）
 *    一律退回 `FALLBACK_WINDOW_TOKENS` —— 宁可额度小，也不放大到作者没预期的规模。
 */
export function effectiveWindowTokens(windowTokens: number | null | undefined): number {
  if (typeof windowTokens !== 'number' || !Number.isFinite(windowTokens)) return FALLBACK_WINDOW_TOKENS
  // 2000 与 modelCapacity.MIN_SANE_WINDOW 同源，但这里刻意不 import（保持零依赖），
  // 一致性由 tests/tavernQuota.test.ts 比对守住。
  if (windowTokens < 2000) return FALLBACK_WINDOW_TOKENS
  return Math.floor(windowTokens)
}

/** 固定层额度（字）：总纲 + 世界设定，**每轮全量注入**的那部分 */
export function fixedQuotaOf(windowTokens: number | null | undefined): number {
  const w = effectiveWindowTokens(windowTokens)
  return Math.round(clamp(w * FIXED_QUOTA_RATIO, FIXED_QUOTA_MIN, FIXED_QUOTA_MAX))
}

/**
 * 动态层额度（字）：世界书按关键词筛出来的分节 / 词条。
 *
 * @param pct 控制面板里的百分比（5~35）。不传或非法 ⇒ 用默认 15%。
 */
export function dynamicQuotaOf(windowTokens: number | null | undefined, pct?: number | null): number {
  const w = effectiveWindowTokens(windowTokens)
  const raw = typeof pct === 'number' && Number.isFinite(pct) ? pct : DYNAMIC_QUOTA_PCT.default
  const p = clamp(raw, DYNAMIC_QUOTA_PCT.min, DYNAMIC_QUOTA_PCT.max)
  return Math.round(w * (p / 100))
}

/** 一份完整的额度档案（界面要同时显示两层，还要能解释"这个数是怎么来的"） */
export interface QuotaProfile {
  /** 参与计算的窗口（已是兜底后的值） */
  windowTokens: number
  /** 窗口是不是兜底值（界面据此提示「模型没填窗口」） */
  windowFallback: boolean
  /** 固定层额度（字） */
  fixed: number
  /** 动态层额度（字） */
  dynamic: number
  /** 动态层用的百分比 */
  dynamicPct: number
}

export function quotaProfileOf(windowTokens: number | null | undefined, dynamicPct?: number | null): QuotaProfile {
  const ok = typeof windowTokens === 'number' && Number.isFinite(windowTokens) && windowTokens >= 2000
  const raw = typeof dynamicPct === 'number' && Number.isFinite(dynamicPct) ? dynamicPct : DYNAMIC_QUOTA_PCT.default
  return {
    windowTokens: effectiveWindowTokens(windowTokens),
    windowFallback: !ok,
    fixed: fixedQuotaOf(windowTokens),
    dynamic: dynamicQuotaOf(windowTokens, raw),
    dynamicPct: clamp(raw, DYNAMIC_QUOTA_PCT.min, DYNAMIC_QUOTA_PCT.max),
  }
}

/** 人类可读的窗口一串（如 32768 → 「32K」）—— 界面提示用，避免各处各写一份换算 */
export function fmtWindow(tokens: number): string {
  const k = tokens / 1024
  if (k >= 100) return `${Math.round(tokens / 1024)}K`
  return `${Number(k.toFixed(1))}K`
}
