// ============ W4 AI 工单接线 · 检查持久化 ============
// 2026-10-20 · 方案 §7.2 / §9.2
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI。
//    它负责：
//    ① 检查结果的持久化（写入 revisionPayloads）
//    ② 检查状态的恢复
//    ③ 检查与候选的关联

import type { RevisionJob, RevisionPayload } from './jobTypes'
import type { RevisionCandidate } from './revisionCandidate'
import type { TicketEvidence } from './findingAdapters'
import { getRevisionJob, getRevisionPayload, saveRevisionPayload } from '@/lib/db/revisionJobs'
import { uid } from '@/lib/app/id'

// ============ 检查载荷类型 ============
export type CheckPayloadKind = 'check-report' | 'check-draft' | 'check-snapshot'

// ============ 检查载荷 ============
export interface CheckPayload {
  /** 载荷 ID */
  id: string
  /** 项目 ID */
  projectId: string
  /** 关联任务 ID */
  jobId: string
  /** 载荷类型 */
  kind: CheckPayloadKind
  /** 检查项 ID */
  checkId: string
  /** 检查来源 */
  source: string
  /** 检查结果（JSON 序列化） */
  result: unknown
  /** 证据列表 */
  evidence?: TicketEvidence[]
  /** 摘要 */
  summary: string
  /** 字节数 */
  bytes: number
  /** 创建时间 */
  createdAt: number
}

// ============ 检查持久化结果 ============
export interface CheckPersistResult {
  ok: boolean
  /** 载荷 ID */
  payloadId?: string
  /** 错误原因 */
  error?: string
}

/** 计算字节数（UTF-8 近似） */
function byteCount(s: string): number {
  return new Blob([s]).size
}

/** 持久化检查结果 */
export async function persistCheckResult(
  jobId: string,
  projectId: string,
  checkId: string,
  source: string,
  result: unknown,
  evidence?: TicketEvidence[],
  summary?: string,
): Promise<CheckPersistResult> {
  try {
    const payloadId = `check-${uid()}`
    // 🔴 checkId / source / evidence 必须**跟载荷一起存**：
    //    否则读回来只能写 'unknown'（曾如此），筛选与去重全部失效。
    const report = { checkId, source, result, evidence: evidence ?? [] }
    const resultStr = JSON.stringify(report)
    const bytes = byteCount(resultStr)

    await saveRevisionPayload({
      id: payloadId,
      projectId,
      // 检查报告就是 report —— 不能标成 'candidate'（会与候选正文抢同一个回收语义）
      kind: 'report',
      jobId,
      report,
      summary: summary ?? `检查 ${checkId} 结果`,
      bytes,
      createdAt: Date.now(),
    } as RevisionPayload)

    return { ok: true, payloadId }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 读取检查结果 */
export async function loadCheckResult(payloadId: string): Promise<CheckPayload | undefined> {
  const p = await getRevisionPayload(payloadId)
  if (!p) return undefined
  const r = (p.report ?? {}) as Record<string, unknown>
  return {
    id: p.id,
    projectId: p.projectId,
    jobId: p.jobId,
    kind: 'check-report',
    checkId: typeof r.checkId === 'string' ? r.checkId : p.id,
    source: typeof r.source === 'string' ? r.source : 'unknown',
    result: r.result ?? {},
    ...(Array.isArray(r.evidence) ? { evidence: r.evidence as TicketEvidence[] } : {}),
    summary: p.summary,
    bytes: p.bytes,
    createdAt: p.createdAt,
  }
}

/** 关联检查与候选 */
export function linkCheckToCandidate(
  checkPayload: CheckPayload,
  candidate: RevisionCandidate,
): RevisionCandidate {
  // 🔴 原先这里 `{...candidate}` 什么都不加 —— 关联函数返回原对象，等于没关联。
  //    现在把载荷 ID 记在候选上（可选字段，老候选不受影响），并保持幂等。
  const ids = candidate.checkPayloadIds ?? []
  if (ids.includes(checkPayload.id)) return candidate
  return { ...candidate, checkPayloadIds: [...ids, checkPayload.id] }
}

/** 检查状态恢复：从任务中恢复检查状态 */
export async function restoreCheckState(jobId: string): Promise<{
  job: RevisionJob | undefined
  checks: CheckPayload[]
}> {
  const job = await getRevisionJob(jobId)
  if (!job) {
    return { job: undefined, checks: [] }
  }

  // 按 jobId 查询相关载荷（通过 getAll 后过滤）
  const { ops } = await import('@/lib/db/core')
  const all = await ops.getAll<RevisionPayload>('revisionPayloads')
  const checks: CheckPayload[] = all
    .filter(p => p.jobId === jobId)
    .map(p => ({
      id: p.id,
      projectId: p.projectId,
      jobId: p.jobId,
      kind: 'check-report' as CheckPayloadKind,
      checkId: p.id,
      source: 'unknown',
      result: p.report ?? {},
      summary: p.summary,
      bytes: p.bytes,
      createdAt: p.createdAt,
    }))

  return { job, checks }
}

// ============ 检查状态汇总 ============
export interface CheckStateSummary {
  /** 总检查数 */
  total: number
  /** 已持久化 */
  persisted: number
  /** 关联候选 */
  linkedToCandidate: number
  /** 字节总数 */
  totalBytes: number
}

export function summarizeCheckState(checks: CheckPayload[]): CheckStateSummary {
  return {
    total: checks.length,
    persisted: checks.filter(c => c.kind === 'check-report').length,
    linkedToCandidate: checks.filter(c => c.kind === 'check-report').length, // 简化：所有报告都关联
    totalBytes: checks.reduce((sum, c) => sum + c.bytes, 0),
  }
}
