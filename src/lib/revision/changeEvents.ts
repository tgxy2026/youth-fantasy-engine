// ============ A3 有证据的后续影响提示 · 变化事件与影响证据 ============
// 2026-10-20 · 方案 §6.1 / A3
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI。
//    它负责：
//    ① 变化事件记录（提交前后引用与内容摘要）
//    ② 事件在项目内按记录合并
//    ③ 影响证据生成
//    ④ 直接依据与相关性复核

// ============ 变化事件类型 ============
export type ChangeEventType =
  | 'body-change'      // 正文变化
  | 'outline-change'   // 细纲变化
  | 'setting-change'   // 设定变化
  | 'field-rename'     // 字段改名
  | 'field-meaning'    // 字段含义变化
  | 'permission-change' // 权限变化
  | 'record-delete'    // 记录删除
  | 'chapter-reorder'  // 章序重排

// ============ 变化事件 ============
export interface ChangeEvent {
  /** 事件 ID */
  id: string
  /** 事件类型 */
  type: ChangeEventType
  /** 来源引用 */
  sourceRef: string
  /** 变化前摘要 */
  beforeSummary: string
  /** 变化后摘要 */
  afterSummary: string
  /** 原因 */
  reason: string
  /** 时间 */
  timestamp: number
  /** 是否可合并 */
  mergeable: boolean
}

// ============ 变化事件记录 ============
// ============ 创建变化事件 ============
export function createChangeEvent(
  type: ChangeEventType,
  sourceRef: string,
  beforeSummary: string,
  afterSummary: string,
  reason: string,
): ChangeEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    sourceRef,
    beforeSummary,
    afterSummary,
    reason,
    timestamp: Date.now(),
    mergeable: true,
  }
}

// ============ 事件合并（按记录合并） ============
export function mergeEvents(events: ChangeEvent[]): ChangeEvent[] {
  const merged: ChangeEvent[] = []
  const seen = new Set<string>()

  for (const e of events) {
    // 按 sourceRef + type 去重
    const key = `${e.sourceRef}|${e.type}`
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(e)
    }
  }

  return merged
}

// ============ 影响证据 ============
export interface ImpactEvidence {
  /** 证据 ID */
  id: string
  /** 来源事件 ID */
  sourceEventId: string
  /** 目标细纲 ID */
  targetOutlineId: string
  /** 匹配字段 ID */
  matchedFieldId: string
  /** 标签快照 */
  labelSnapshot: string
  /** 引文 */
  quote: string
  /** 目标摘要 */
  targetSummary: string
  /** 关联等级 */
  relevance: 'direct' | 'indirect' | 'unknown'
  /** 处置状态 */
  disposition: 'pending' | 'checked' | 'no-change' | 'needs-modify'
}

// ============ 直接依据（P1） ============
export interface DirectImpact {
  /** 是否命中 */
  hit: boolean
  /** 显式资料关联 */
  explicitLinks: string[]
  /** 通过用途读取的旧名/新名及别称 */
  nameChanges: { old: string; new: string }[]
  /** 伏笔编号 */
  foreshadowIds: string[]
  /** 问题列表 */
  issues: string[]
}

/** 计算直接依据 */
export function computeDirectImpact(
  event: ChangeEvent,
  outlineLinks: string[],
  nameChanges: { old: string; new: string }[],
  foreshadowIds: string[],
): DirectImpact {
  const explicitLinks = outlineLinks.filter(l =>
    event.beforeSummary.includes(l) || event.afterSummary.includes(l),
  )

  return {
    hit: explicitLinks.length > 0 || nameChanges.length > 0 || foreshadowIds.length > 0,
    explicitLinks,
    nameChanges,
    foreshadowIds,
    issues: explicitLinks.length === 0 ? ['无显式关联'] : [],
  }
}

// ============ 相关性复核（3.2.x） ============
export interface RelevanceReview {
  /** 是否可能冲突 */
  mayConflict: boolean
  /** 是否可能无关 */
  mayBeIrrelevant: boolean
  /** 是否无法判断 */
  cannotDetermine: boolean
  /** 理由 */
  reason: string
}

/** 相关性复核 */
export function reviewRelevance(
  event: ChangeEvent,
  targetOutline: string,
  providedContext: string[],
): RelevanceReview {
  const hasDirectMatch = providedContext.some(c =>
    targetOutline.includes(c) || event.afterSummary.includes(c),
  )

  if (hasDirectMatch) {
    return {
      mayConflict: true,
      mayBeIrrelevant: false,
      cannotDetermine: false,
      reason: '存在直接匹配，可能冲突',
    }
  }

  // 无直接命中时，继续显示已有粗粒度"后续计划建议复核"
  return {
    mayConflict: false,
    mayBeIrrelevant: true,
    cannotDetermine: false,
    reason: '尚未定位直接关联，建议人工复核',
  }
}

// ============ 变化事件去重 ============
export function deduplicateEvents(events: ChangeEvent[]): ChangeEvent[] {
  const seen = new Set<string>()
  const result: ChangeEvent[] = []

  for (const e of events) {
    // 使用 sourceRef + type + beforeSummary 前 20 字符作为去重键
    const key = `${e.sourceRef}|${e.type}|${e.beforeSummary.slice(0, 20)}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(e)
    }
  }

  return result
}

// ============ 变化事件上限 ============
export const MAX_EVENTS_PER_PROJECT = 100
export const MAX_TARGET_REMINDS = 500
export const MAX_QUOTE_LENGTH = 300

/** 检查是否触顶 */
export function checkEventLimit(eventCount: number, remindCount: number): {
  atLimit: boolean
  message: string
} {
  if (eventCount >= MAX_EVENTS_PER_PROJECT) {
    return {
      atLimit: true,
      message: `已达变化事件上限 ${MAX_EVENTS_PER_PROJECT}，请清理已处理历史`,
    }
  }
  if (remindCount >= MAX_TARGET_REMINDS) {
    return {
      atLimit: true,
      message: `已达目标提醒上限 ${MAX_TARGET_REMINDS}，显示汇总与"其余待复查数量"`,
    }
  }
  return { atLimit: false, message: '' }
}

// ============ 处置状态 ============
export type Disposition = 'pending' | 'checked' | 'no-change' | 'needs-modify'

/** 更新处置状态 */
export function updateDisposition(
  evidence: ImpactEvidence,
  disposition: Disposition,
): ImpactEvidence {
  return { ...evidence, disposition }
}

/** 新变化必须产生新的处置状态 */
export function isNewDisposition(
  oldDisposition: Disposition | undefined,
  newDisposition: Disposition,
): boolean {
  return oldDisposition !== newDisposition
}

// ============ 影响依据（3.6.1 · 只接「证据层」）============
//
// 3.6.0 记账时本模块是 `gap`；3.6.1 先只接证据层。**3.7.0 · W2 起两类事件真正被构造**：
//   `revision/changeWatch` 用 `buildChangeEvidence`（内部 `createChangeEvent`）为总纲 / 卷纲 /
//   细纲 / 设定变更生成证据，并据此把候选标为过期；处置状态机仍未接（沿用 3.6.1 定案）。
// 当时的取舍：产品已上线的 `outline/futureImpact` 负责
//   「哪几章的计划要重看一眼」，作者真正缺的是「凭什么说这几章受影响」——
//   即变化处的**前后引用**；而 `pending/checked/no-change/needs-modify` 是一套新的用户流程，
//   属于另开条目的事。
//
// 🔴 引文一律 ≤ `MAX_QUOTE_LENGTH`（300 字）：依据是提示，不是第二份正文档；
//    存全文会让每条标记变成几百 KB，且作者核对时也读不完。

/** 一眼能核对的依据：改前那一小段 → 改后那一小段 */
export interface ChangeEvidence {
  /** 事件 id（来自 `createChangeEvent`，便于将来追溯） */
  eventId: string
  /** 改前片段（≤300 字，超长带省略号） */
  beforeSummary: string
  /** 改后片段（≤300 字） */
  afterSummary: string
  /** 变化发生的章 / 记录定位（如 `chapter:<id>`） */
  sourceRef: string
}

/** 按上限截断并标注省略（不留半截字感） */
function clip(text: string, limit: number): string {
  const body = text ?? ''
  if (body.length <= limit) return body
  return `${body.slice(0, limit)}…（已截断，共 ${body.length} 字）`
}

/**
 * 找出「真正变了的那一段」：剥掉公共前缀与公共后缀，剩下的就是差异区间。
 *
 * 🔴 为什么要这样做，而不是直接给改后正文开头 300 字：
 *    整章改写动的是几百上千字，开头往往是**没变**的部分（章节标题、开场白），
 *    作者点开「依据」看到一段跟自己改动无关的文字，比不给依据更糟。
 * 🔴 纯位置比较，不做语义分析（沿用本项目「只做确定性判定」的取向）。
 */
export function changedSpan(before: string, after: string, limit = MAX_QUOTE_LENGTH): { beforeSpan: string; afterSpan: string } {
  const a = before ?? ''
  const b = after ?? ''
  const max = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix < max && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  const beforeSpan = a.slice(prefix, a.length - suffix)
  const afterSpan = b.slice(prefix, b.length - suffix)
  return { beforeSpan: clip(beforeSpan, limit), afterSpan: clip(afterSpan, limit) }
}

/**
 * 造一条变化依据（供 `futureImpact` 打标时一并存下）。
 * 事件本身走 `createChangeEvent`，存的是**截断后**的摘要 —— 事件表不是正文副本。
 */
export function buildChangeEvidence(input: {
  type: ChangeEventType
  sourceRef: string
  before: string
  after: string
  reason: string
}): ChangeEvidence {
  const span = changedSpan(input.before, input.after)
  const event = createChangeEvent(input.type, input.sourceRef, span.beforeSpan, span.afterSpan, input.reason)
  return {
    eventId: event.id,
    sourceRef: input.sourceRef,
    beforeSummary: span.beforeSpan,
    afterSummary: span.afterSpan,
  }
}
