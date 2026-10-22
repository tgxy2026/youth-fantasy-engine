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
