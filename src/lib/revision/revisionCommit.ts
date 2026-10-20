// ============ 3.2.0 · W3 候选生成与应用 · 条件提交与提交标记 ============
// 2026-10-20 · 方案 §9.1 / §9.3
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI。
//    它负责：
//    ① 条件提交（正文摘要校验）
//    ② 同记录提交标记（intent + receipt）
//    ③ 取消边界（同章互斥）
//    ④ 幂等派生回执与崩溃核对
//    ⑤ 提交各阶段故障可恢复

import type { RevisionJob, RevisionPayload, RevisionSubmitIntent, RevisionSubmitReceipt } from './jobTypes'
import type { RevisionCandidate, RevisionCandidateStatus } from './revisionCandidate'
import { canTransition, transitionCandidate, buildCandidateFromJob } from './revisionCandidate'
import { uid } from '@/lib/app/id'

// ============ 提交结果 ============
export interface RevisionCommitResult {
  ok: boolean
  /** 提交后的候选（ok=true 时） */
  candidate?: RevisionCandidate
  /** 提交意图（应用前写入，ok=true 时） */
  intent?: RevisionSubmitIntent
  /** 提交回执（应用后写入，ok=true 时） */
  receipt?: RevisionSubmitReceipt
  /** 错误原因（ok=false 时） */
  error?: string
  /** 是否需要核对（崩溃恢复时） */
  needsReconcile?: boolean
}

// ============ 条件提交 ============
// 提交前校验正文摘要是否与任务创建时一致。
// 不一致 → 不提交，返回 needsReconcile=true，由作者决定。
export function validateCommitPrecondition(
  job: RevisionJob,
  currentBodyDigest: string,
  currentOutlineDigest?: string,
): { ok: boolean; error?: string } {
  if (job.baseline.bodyDigest !== currentBodyDigest) {
    return {
      ok: false,
      error: `正文已变化（创建时 ${job.baseline.bodyDigest.slice(0, 8)}…，当前 ${currentBodyDigest.slice(0, 8)}…），需重新核对`,
    }
  }
  if (job.baseline.outlineDigest !== undefined && currentOutlineDigest !== undefined) {
    if (job.baseline.outlineDigest !== currentOutlineDigest) {
      return {
        ok: false,
        error: `细纲已变化，需重新核对`,
      }
    }
  }
  return { ok: true }
}

// ============ 创建提交意图 ============
// 应用前写入：记录「我要把正文改成什么样」。
// 崩溃恢复时，用它核对「这个提交到底有没有做完」。
export function createSubmitIntent(
  job: RevisionJob,
  candidateId: string,
  currentBodyDigest: string,
  currentOutlineDigest?: string,
): RevisionSubmitIntent {
  return {
    operationId: uid(),
    // 🔴 必须记下 jobId：崩溃恢复时靠它把意图对回任务（否则候选清理后无从追溯）
    jobId: job.id,
    submittedAt: Date.now(),
    beforeBodyDigest: currentBodyDigest,
    beforeOutlineDigest: currentOutlineDigest,
    candidateId,
  }
}

// ============ 创建提交回执 ============
// 应用后写入：记录「提交已完成，正文现在是这个摘要」。
// 崩溃恢复时，用它判断「提交是否成功」。
export function createSubmitReceipt(
  intent: RevisionSubmitIntent,
  afterBodyDigest: string,
  afterOutlineDigest?: string,
  ok: boolean = true,
  error?: string,
): RevisionSubmitReceipt {
  return {
    operationId: intent.operationId,
    receivedAt: Date.now(),
    afterBodyDigest,
    afterOutlineDigest,
    ok,
    error,
  }
}

// ============ 崩溃核对 ============
// 启动后将遗留 running 标为 interrupted；applying 按 B2 的提交意图核对。
// 核对规则：
//   ① 有 intent 但无 receipt → 提交中断，需核对
//   ② 有 intent 且有 receipt → 看 receipt.ok
//   ③ 无 intent → 正常状态，无需核对
export interface RevisionCrashReconcileResult {
  /** 是否需要作者核对 */
  needsReconcile: boolean
  /** 核对原因 */
  reason?: string
  /** 建议状态 */
  suggestedStatus: RevisionCandidateStatus
  /** 提交意图（如有） */
  intent?: RevisionSubmitIntent
  /** 提交回执（如有） */
  receipt?: RevisionSubmitReceipt
}

export function reconcileCrash(
  job: RevisionJob,
  candidate: RevisionCandidate,
  currentBodyDigest: string,
  currentOutlineDigest?: string,
): RevisionCrashReconcileResult {
  // 🔴 候选与任务对不上：不猜，直接判"需人工核对"
  if (candidate.jobId !== job.id) {
    return {
      needsReconcile: true,
      reason: `候选属于任务 ${candidate.jobId}，与当前任务 ${job.id} 不一致，需人工核对`,
      suggestedStatus: 'needs-reconcile',
      ...(candidate.intent ? { intent: candidate.intent } : {}),
      ...(candidate.receipt ? { receipt: candidate.receipt } : {}),
    }
  }

  // 无 intent → 正常状态
  if (!candidate.intent) {
    return {
      needsReconcile: false,
      suggestedStatus: candidate.status,
    }
  }

  // 有 intent 但无 receipt → 提交中断
  if (!candidate.receipt) {
    // 检查正文是否已被修改
    if (candidate.intent.beforeBodyDigest !== currentBodyDigest) {
      return {
        needsReconcile: true,
        reason: `提交中断且正文已变化（意图前摘要 ${candidate.intent.beforeBodyDigest.slice(0, 8)}…，当前 ${currentBodyDigest.slice(0, 8)}…），需核对是否保留候选`,
        suggestedStatus: 'needs-reconcile',
        intent: candidate.intent,
      }
    }
    // 正文未变 → 提交未生效，候选仍可应用
    return {
      needsReconcile: true,
      reason: `提交中断（有意图无回执），正文未变，候选仍可应用`,
      suggestedStatus: 'pending',
      intent: candidate.intent,
    }
  }

  // 有 intent 且有 receipt
  if (!candidate.receipt.ok) {
    return {
      needsReconcile: true,
      reason: `提交失败：${candidate.receipt.error ?? '未知错误'}`,
      suggestedStatus: 'discarded',
      intent: candidate.intent,
      receipt: candidate.receipt,
    }
  }

  // 细纲也变了：正文没动不代表上下文没动（细纲改过 → 候选依据已过期）
  const outlineChanged = Boolean(
    currentOutlineDigest
    && candidate.intent.beforeOutlineDigest
    && candidate.intent.beforeOutlineDigest !== currentOutlineDigest,
  )

  // 提交成功，但正文可能已被后续操作修改
  if (candidate.receipt.afterBodyDigest !== currentBodyDigest) {
    return {
      needsReconcile: true,
      reason: `提交已成功但正文已变化（回执后摘要 ${candidate.receipt.afterBodyDigest.slice(0, 8)}…，当前 ${currentBodyDigest.slice(0, 8)}…）`
        + (outlineChanged ? '；细纲也变了，候选依据已过期' : ''),
      suggestedStatus: 'applied',
      intent: candidate.intent,
      receipt: candidate.receipt,
    }
  }

  return {
    needsReconcile: false,
    suggestedStatus: candidate.status,
    intent: candidate.intent,
    receipt: candidate.receipt,
  }
}

// ============ 应用候选（条件提交 + 提交标记） ============
// 流程：
//   ① 校验正文摘要（条件提交）
//   ② 创建 intent（应用前写入）
//   ③ 应用正文（由调用方执行）
//   ④ 创建 receipt（应用后写入）
//   ⑤ 更新候选状态
//
// 本函数只做 ①②⑤，③④ 由调用方在「写盘成功并回读摘要一致后」执行。
// 这是方案 §9.2 的严格写盘路径：写入成功并回读摘要一致后才发布元数据引用。
export function prepareApplyCandidate(
  job: RevisionJob,
  candidate: RevisionCandidate,
  currentBodyDigest: string,
  currentOutlineDigest?: string,
): RevisionCommitResult {
  // ① 状态校验
  if (!canTransition(candidate.status, 'applying')) {
    return {
      ok: false,
      error: `候选状态不可应用：${candidate.status}`,
    }
  }

  // ② 条件提交：校验正文摘要
  const pre = validateCommitPrecondition(job, currentBodyDigest, currentOutlineDigest)
  if (!pre.ok) {
    return {
      ok: false,
      error: pre.error,
    }
  }

  // ③ 创建 intent
  const intent = createSubmitIntent(job, candidate.id, currentBodyDigest, currentOutlineDigest)

  // ④ 更新候选状态为 applying（带 intent）
  const t = transitionCandidate(candidate, 'applying')
  if (!t.ok || !t.candidate) {
    return { ok: false, error: t.error }
  }
  const applying: RevisionCandidate = {
    ...t.candidate,
    intent,
  }

  return {
    ok: true,
    candidate: applying,
    intent,
  }
}

// ============ 完成应用（写回执） ============
// 调用方在「写盘成功并回读摘要一致后」调用本函数。
export function completeApplyCandidate(
  candidate: RevisionCandidate,
  afterBodyDigest: string,
  afterOutlineDigest?: string,
): RevisionCommitResult {
  // 校验 candidate 正在 applying
  if (candidate.status !== 'applying') {
    return {
      ok: false,
      error: `候选不在 applying 状态：${candidate.status}`,
    }
  }
  if (!candidate.intent) {
    return {
      ok: false,
      error: `候选缺少提交意图，无法完成应用`,
    }
  }

  // 创建 receipt
  const receipt = createSubmitReceipt(candidate.intent, afterBodyDigest, afterOutlineDigest, true)

  // 更新候选状态为 applied（带 receipt）
  const t = transitionCandidate(candidate, 'applied')
  if (!t.ok || !t.candidate) {
    return { ok: false, error: t.error }
  }
  const applied: RevisionCandidate = {
    ...t.candidate,
    receipt,
  }

  return {
    ok: true,
    candidate: applied,
    receipt,
  }
}

// ============ 放弃候选 ============
export function discardCandidate(
  candidate: RevisionCandidate,
  reason?: string,
): RevisionCommitResult {
  const t = transitionCandidate(candidate, 'discarded')
  if (!t.ok || !t.candidate) {
    return { ok: false, error: t.error }
  }
  // 🔴 原先 `reason` 收了不用：作者放弃后完全看不出为什么，回看只剩一条"已放弃"。
  return {
    ok: true,
    candidate: {
      ...t.candidate,
      discardedAt: t.candidate.discardedAt ?? Date.now(),
      ...(reason ? { discardedReason: reason } : {}),
    },
  }
}

// ============ 标记候选过期 ============
export function staleCandidate(candidate: RevisionCandidate): RevisionCommitResult {
  const t = transitionCandidate(candidate, 'stale')
  if (!t.ok || !t.candidate) {
    return { ok: false, error: t.error }
  }
  return { ok: true, candidate: t.candidate }
}

// ============ 从任务 + 载荷构建候选（带代次） ============
export function buildCandidate(
  job: RevisionJob,
  payload: RevisionPayload,
  generation: number = 1,
): RevisionCandidate | undefined {
  return buildCandidateFromJob(job, payload, generation)
}
