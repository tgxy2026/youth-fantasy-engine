// ============ 3.2.0 · W3 候选生成与应用 · 候选类型与状态机 ============
// 2026-10-20 · 方案 §9.1 / §9.3
//
// 🔴 本文件是纯类型 + 纯函数，不 import 任何 UI 或业务域。
//    状态机只管「合法转移」与「取消边界」，不碰 IDB、不碰 AI。

import type { RevisionJob, RevisionPayload, RevisionSubmitIntent, RevisionSubmitReceipt } from './jobTypes'

// ============ 候选状态 ============
export type RevisionCandidateStatus =
  | 'pending'        // 待审阅
  | 'stale'          // 过期（基准变化）
  | 'applying'       // 正在应用
  | 'applied'        // 已应用
  | 'discarded'      // 已放弃
  | 'needs-reconcile' // 需核对（崩溃恢复）

// ============ 候选记录 ============
export interface RevisionCandidate {
  /** 候选 ID（与 payload.id 对应） */
  id: string
  /** 关联任务 ID */
  jobId: string
  /** 项目 ID */
  projectId: string
  /** 候选状态 */
  status: RevisionCandidateStatus
  /** 候选全文（来自 payload.candidateText） */
  text: string
  /** 改前文本（来自 payload.beforeText） */
  beforeText: string
  /** 摘要（列表展示用） */
  summary: string
  /** 字节数 */
  bytes: number
  /** 创建时间 */
  createdAt: number
  /** 状态更新时间 */
  updatedAt: number
  /** 应用时间（applied 时） */
  appliedAt?: number
  /** 放弃时间（discarded 时） */
  discardedAt?: number
  /** 放弃理由（作者可见，便于日后回看为什么丢掉） */
  discardedReason?: string
  /** 过期理由（基准变化时逐条记录） */
  staleReasons?: string[]
  /** 代次（同批次单一执行租约） */
  generation: number
  /** 提交意图（应用前写入） */
  intent?: RevisionSubmitIntent
  /** 提交回执（应用后写入） */
  receipt?: RevisionSubmitReceipt
  /**
   * 关联的检查载荷 ID（W4：检查 → 候选）。
   * 只增可选字段：老候选没有它照常工作。
   */
  checkPayloadIds?: string[]
}

// ============ 状态转移结果 ============
export interface RevisionTransitionResult {
  ok: boolean
  /** 转移后的候选（ok=true 时） */
  candidate?: RevisionCandidate
  /** 错误原因（ok=false 时） */
  error?: string
}

// ============ 状态机：合法转移表 ============
// 从 → 到：true 表示合法
const TRANSITIONS: Record<RevisionCandidateStatus, RevisionCandidateStatus[]> = {
  pending: ['stale', 'applying', 'discarded'],
  stale: ['applying', 'discarded'],
  applying: ['applied', 'needs-reconcile', 'discarded'],
  applied: [], // 终态
  discarded: [], // 终态
  'needs-reconcile': ['applied', 'discarded', 'applying'],
}

/** 检查状态转移是否合法 */
export function canTransition(from: RevisionCandidateStatus, to: RevisionCandidateStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

/** 执行状态转移（纯函数，不写盘） */
export function transitionCandidate(
  candidate: RevisionCandidate,
  to: RevisionCandidateStatus,
  generation?: number,
): RevisionTransitionResult {
  if (candidate.status === to) {
    return { ok: true, candidate }
  }
  if (!canTransition(candidate.status, to)) {
    return {
      ok: false,
      error: `非法状态转移：${candidate.status} → ${to}`,
    }
  }
  // 代次校验：如果指定了 generation，必须匹配
  if (generation !== undefined && generation !== candidate.generation) {
    return {
      ok: false,
      error: `代次不匹配：当前 ${candidate.generation}，请求 ${generation}`,
    }
  }
  const now = Date.now()
  const next: RevisionCandidate = { ...candidate, status: to, updatedAt: now }
  if (to === 'applied') next.appliedAt = now
  if (to === 'discarded') next.discardedAt = now
  if (to === 'needs-reconcile') {
    // 崩溃恢复：保留 applying 状态信息，标记需核对
  }
  return { ok: true, candidate: next }
}

// ============ 取消边界 ============
// 同章有另一份候选时，应用一份后另一份应失效（§9.1）
export function invalidateSiblings(
  candidates: RevisionCandidate[],
  appliedId: string,
): RevisionCandidate[] {
  return candidates.map(c => {
    if (c.id === appliedId) return c
    if (c.status === 'pending' || c.status === 'stale' || c.status === 'applying') {
      return { ...c, status: 'discarded' as const, discardedAt: Date.now(), updatedAt: Date.now() }
    }
    return c
  })
}

// ============ 从任务 + 载荷构建候选 ============
export function buildCandidateFromJob(
  job: RevisionJob,
  payload: RevisionPayload,
  generation: number = 1,
): RevisionCandidate | undefined {
  if (payload.kind !== 'candidate') return undefined
  if (payload.jobId !== job.id) return undefined
  if (!payload.candidateText) return undefined
  return {
    id: payload.id,
    jobId: job.id,
    projectId: job.projectId,
    status: 'pending',
    text: payload.candidateText,
    beforeText: payload.beforeText ?? '',
    summary: payload.summary,
    bytes: payload.bytes,
    createdAt: payload.createdAt,
    updatedAt: payload.createdAt,
    generation,
  }
}

// ============ 基准校验 ============
// 恢复时校验记录与实际依赖字段/映射：
//   布局、无关字段变化可继续；
//   相关结构/用途/权限变化时保留产物可读，列出需要重跑的涉及步骤。
export interface RevisionBaselineCheck {
  ok: boolean
  /** 正文是否变化 */
  bodyChanged: boolean
  /** 细纲是否变化 */
  outlineChanged: boolean
  /** 依赖设定是否变化 */
  settingsChanged: boolean
  /** 章序是否变化 */
  chapterOrderChanged: boolean
  /** 是否需要重跑 */
  needsRerun: boolean
  /** 需要重跑的步骤（相关结构/用途/权限变化时） */
  stepsToRerun: string[]
}

export function checkBaseline(
  job: RevisionJob,
  currentBodyDigest: string,
  currentOutlineDigest?: string,
  currentSettingsDigest?: string,
  currentChapterOrder?: number,
): RevisionBaselineCheck {
  const bodyChanged = job.baseline.bodyDigest !== currentBodyDigest
  const outlineChanged = job.baseline.outlineDigest !== undefined
    && currentOutlineDigest !== undefined
    && job.baseline.outlineDigest !== currentOutlineDigest
  const settingsChanged = job.baseline.settingsDigest !== undefined
    && currentSettingsDigest !== undefined
    && job.baseline.settingsDigest !== currentSettingsDigest
  const chapterOrderChanged = job.baseline.chapterOrder !== undefined
    && currentChapterOrder !== undefined
    && job.baseline.chapterOrder !== currentChapterOrder

  // 相关结构/用途/权限变化 → 需要重跑
  // 仅改主题（bodyChanged 但 outline/settings 未变）→ 不失效
  const needsRerun = settingsChanged || chapterOrderChanged
  const stepsToRerun: string[] = []
  if (settingsChanged) stepsToRerun.push('设定审计')
  if (chapterOrderChanged) stepsToRerun.push('章序重排')
  if (bodyChanged && !needsRerun) stepsToRerun.push('正文已变（可继续，但建议审阅）')

  return {
    ok: !needsRerun,
    bodyChanged,
    outlineChanged,
    settingsChanged,
    chapterOrderChanged,
    needsRerun,
    stepsToRerun,
  }
}
