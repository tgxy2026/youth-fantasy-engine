// ============ WT2 AI 与存量联动 · 候选按代次失效 ============
// 2026-10-20 · 方案 §9.1 / §11
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI。
//    它负责：
//    ① 同批次单一执行租约/代次
//    ② 候选按代次失效
//    ③ 多窗口不能同时「继续」并重复发送请求
//    ④ 租约丢失后的迟到回调处理

import type { RevisionCandidate } from './revisionCandidate'
import type { RevisionJob } from './jobTypes'
import { transitionCandidate } from './revisionCandidate'

// ============ 代次管理 ============
/** 同批次使用单一执行租约/代次 */
export interface GenerationLease {
  /** 代次号 */
  generation: number
  /** 租约持有者（窗口 ID / 会话 ID） */
  leaseHolder: string
  /** 租约获取时间 */
  leasedAt: number
  /** 租约过期时间 */
  expiresAt: number
  /** 关联任务 ID */
  jobId: string
}

/** 创建新代次 */
export function createGeneration(leaseHolder: string, jobId: string, ttlMs: number = 30 * 60 * 1000): GenerationLease {
  const now = Date.now()
  return {
    generation: 1,
    leaseHolder,
    leasedAt: now,
    expiresAt: now + ttlMs,
    jobId,
  }
}

/** 升级代次（当需要重新生成时） */
export function bumpGeneration(lease: GenerationLease, leaseHolder: string): GenerationLease | {
  error: string
} {
  if (lease.leaseHolder !== leaseHolder) {
    return { error: `租约被 ${lease.leaseHolder} 持有，当前 ${leaseHolder} 无法升级` }
  }
  const now = Date.now()
  return {
    ...lease,
    generation: lease.generation + 1,
    leasedAt: now,
    expiresAt: now + (lease.expiresAt - lease.leasedAt),
  }
}

/** 检查租约是否有效 */
export function isLeaseValid(lease: GenerationLease, leaseHolder: string): boolean {
  return lease.leaseHolder === leaseHolder && Date.now() < lease.expiresAt
}

/** 检查租约是否过期 */
export function isLeaseExpired(lease: GenerationLease): boolean {
  return Date.now() >= lease.expiresAt
}

// ============ 候选按代次失效 ============
/** 同章有另一份候选时，应用一份后另一份应失效（§9.1） */
export function invalidateByGeneration(
  candidates: RevisionCandidate[],
  appliedId: string,
  currentGeneration: number,
): RevisionCandidate[] {
  return candidates.map(c => {
    if (c.id === appliedId) return c
    // 同代次的候选：应用一份后另一份失效
    if (c.generation === currentGeneration) {
      if (c.status === 'pending' || c.status === 'stale' || c.status === 'applying') {
        return {
          ...c,
          status: 'discarded' as const,
          discardedAt: Date.now(),
          updatedAt: Date.now(),
        }
      }
    }
    // 不同代次的候选：保留（可能是旧版本的候选）
    return c
  })
}

/** 多窗口不能同时「继续」并重复发送请求 */
export function canContinue(
  lease: GenerationLease | undefined,
  leaseHolder: string,
  candidates: RevisionCandidate[],
): { ok: boolean; error?: string } {
  // 无租约：可以继续
  if (!lease) return { ok: true }

  // 租约过期：可以继续（但需要先获取新租约）
  if (isLeaseExpired(lease)) {
    return { ok: true }
  }

  // 租约被其他窗口持有：不能继续
  if (lease.leaseHolder !== leaseHolder) {
    return {
      ok: false,
      error: `租约被 ${lease.leaseHolder} 持有（到期 ${new Date(lease.expiresAt).toLocaleTimeString()}），当前 ${leaseHolder} 无法继续`,
    }
  }

  // 同代次已有 applying 状态的候选：不能继续
  const hasApplying = candidates.some(c => c.generation === lease.generation && c.status === 'applying')
  if (hasApplying) {
    return { ok: false, error: `同代次 ${lease.generation} 已有正在应用的候选` }
  }

  return { ok: true }
}

// ============ 租约丢失后的迟到回调处理 ============
/** 租约丢失或项目删除后的迟到回调不得重新创建任务、载荷或资料 */
export interface LateCallbackResult {
  /** 是否应丢弃 */
  discard: boolean
  /** 原因 */
  reason?: string
  /** 建议操作 */
  action?: 'discard' | 'mark-stale' | 'keep'
}

export function handleLateCallback(
  lease: GenerationLease | undefined,
  leaseHolder: string,
  projectDeleted: boolean,
  jobExists: boolean,
): LateCallbackResult {
  // 项目已删除：必须丢弃
  if (projectDeleted) {
    return { discard: true, reason: '项目已删除', action: 'discard' }
  }

  // 任务不存在：必须丢弃
  if (!jobExists) {
    return { discard: true, reason: '任务不存在', action: 'discard' }
  }

  // 无租约：标记为过期
  if (!lease) {
    return { discard: false, reason: '无租约记录', action: 'mark-stale' }
  }

  // 租约过期：标记为过期
  if (isLeaseExpired(lease)) {
    return { discard: false, reason: '租约已过期', action: 'mark-stale' }
  }

  // 租约被其他窗口持有：丢弃
  if (lease.leaseHolder !== leaseHolder) {
    return { discard: true, reason: `租约被 ${lease.leaseHolder} 持有`, action: 'discard' }
  }

  // 正常情况：保留
  return { discard: false, action: 'keep' }
}

// ============ 切项目后的回调处理 ============
/** 切项目后的回调只更新原项目结果，不向当前编辑器注入文本 */
export function handleProjectSwitch(
  callbackProjectId: string,
  currentProjectId: string,
): { shouldInject: boolean; reason?: string } {
  if (callbackProjectId !== currentProjectId) {
    return {
      shouldInject: false,
      reason: `回调来自项目 ${callbackProjectId}，当前项目 ${currentProjectId}，不注入文本`,
    }
  }
  return { shouldInject: true }
}

// ============ 基准过期判断 ============
/** 基准过期：正文、细纲、依赖设定、章序改变 */
export function isBaselineStale(
  job: RevisionJob,
  currentBodyDigest: string,
  currentOutlineDigest?: string,
  currentSettingsDigest?: string,
  currentChapterOrder?: number,
): { stale: boolean; reasons: string[] } {
  const reasons: string[] = []

  if (job.baseline.bodyDigest !== currentBodyDigest) {
    reasons.push('正文已变化')
  }
  if (job.baseline.outlineDigest !== undefined && currentOutlineDigest !== undefined) {
    if (job.baseline.outlineDigest !== currentOutlineDigest) {
      reasons.push('细纲已变化')
    }
  }
  if (job.baseline.settingsDigest !== undefined && currentSettingsDigest !== undefined) {
    if (job.baseline.settingsDigest !== currentSettingsDigest) {
      reasons.push('依赖设定已变化')
    }
  }
  if (job.baseline.chapterOrder !== undefined && currentChapterOrder !== undefined) {
    if (job.baseline.chapterOrder !== currentChapterOrder) {
      reasons.push('章序已变化')
    }
  }

  return {
    stale: reasons.length > 0,
    reasons,
  }
}

// ============ 候选过期处理 ============
/** 标记候选为过期（基准变化） */
export function expireCandidate(
  candidate: RevisionCandidate,
  reasons: string[],
): { ok: boolean; candidate?: RevisionCandidate; error?: string } {
  // 只有 pending / stale / applying 可以过期
  if (candidate.status === 'applied' || candidate.status === 'discarded') {
    return { ok: false, error: `候选状态 ${candidate.status} 不可过期` }
  }

  const t = transitionCandidate(candidate, 'stale')
  if (!t.ok || !t.candidate) {
    return { ok: false, error: t.error }
  }

  // 🔴 原先 `reasons` 收了不用 —— 过期了但不知道为什么，作者无从判断要不要重新生成。
  return {
    ok: true,
    candidate: {
      ...t.candidate,
      ...(reasons.length > 0 ? { staleReasons: [...(t.candidate.staleReasons ?? []), ...reasons] } : {}),
    },
  }
}

// ============ 批量候选过期 ============
export function expireCandidatesByBaseline(
  candidates: RevisionCandidate[],
  job: RevisionJob,
  currentBodyDigest: string,
  currentOutlineDigest?: string,
  currentSettingsDigest?: string,
  currentChapterOrder?: number,
): { updated: RevisionCandidate[]; expiredCount: number } {
  const stale = isBaselineStale(job, currentBodyDigest, currentOutlineDigest, currentSettingsDigest, currentChapterOrder)
  if (!stale.stale) {
    return { updated: candidates, expiredCount: 0 }
  }

  const updated: RevisionCandidate[] = []
  let expiredCount = 0

  for (const c of candidates) {
    const result = expireCandidate(c, stale.reasons)
    if (result.ok && result.candidate) {
      updated.push(result.candidate)
      expiredCount++
    } else {
      updated.push(c)
    }
  }

  return { updated, expiredCount }
}
