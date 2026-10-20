// ============ 存储层 · 修订任务元数据 ============
// 2026-10-20 · W2 工作产物存储（方案 §9.2）
//
// 🔴 任务元数据是**项目级**数据：随项目走，导出项目时一并带走，删项目时一并清理。
//    但载荷（revisionPayloads）是**本地专属**，不参与云盘同步。
import type { RevisionJob, RevisionPayload, RevisionJobStatus } from '@/lib/revision/jobTypes'
import { ops } from '@/lib/db/core'

// ============ 修订任务元数据（revisionJobs store） ============
// 小元数据留主库，按项目索引。

export async function getRevisionJob(id: string): Promise<RevisionJob | undefined> {
  return ops.get<RevisionJob>('revisionJobs', id)
}

/** 某项目的全部任务（走 projectId 索引，避免全表扫） */
export async function listProjectRevisionJobs(projectId: string): Promise<RevisionJob[]> {
  return ops.getAllByIndex<RevisionJob>('revisionJobs', 'projectId', projectId)
}

/** 某项目下未结束的任务（awaiting-review / paused / running / interrupted） */
export async function listActiveRevisionJobs(projectId: string): Promise<RevisionJob[]> {
  const all = await listProjectRevisionJobs(projectId)
  const activeStatuses: RevisionJobStatus[] = ['running', 'awaiting-review', 'paused', 'interrupted']
  return all.filter(j => activeStatuses.includes(j.status))
}

export async function saveRevisionJob(job: RevisionJob): Promise<void> {
  await ops.put('revisionJobs', job)
}

export async function deleteRevisionJob(id: string): Promise<void> {
  await ops.del('revisionJobs', id)
}

/** 级联删除：删任务同时清理其载荷引用（载荷本身由 cleanupOrphanPayloads 回收） */
export async function deleteRevisionJobWithCleanup(id: string, payloadId?: string): Promise<void> {
  await deleteRevisionJob(id)
  if (payloadId) {
    // 不立即删载荷：可能还有其他任务引用，由 cleanupOrphanPayloads 统一回收
  }
}

// ============ 修订载荷（revisionPayloads store） ============
// 不可变报告、改前文本、候选全文、Q1 暂停草稿及摘要；每次重生成用新载荷 ID。
// 桌面/便携按 ID 外置，IDB 独立 store；按需读取。
// 🔴 载荷是**本地专属**：不参与云盘同步（见 syncCore.LOCAL_ONLY_STORES）。

export async function getRevisionPayload(id: string): Promise<RevisionPayload | undefined> {
  return ops.get<RevisionPayload>('revisionPayloads', id)
}

export async function saveRevisionPayload(payload: RevisionPayload): Promise<void> {
  // 🔴 严格写盘：写入成功并回读摘要一致后才发布元数据引用
  // 调用方应先写载荷、再写元数据；本函数不负责回读校验（由调用方按 §9.2 执行）
  await ops.put('revisionPayloads', payload)
}

/**
 * 某任务的载荷列表（3.2.0 · W3）。
 *
 * 🔴 为什么要全表扫再过滤：载荷 store **没有 jobId 索引**（方案只要求按项目限额 200 条），
 *    为一个很少用到的读取路径加索引不值当。单项目上限 200 条，扫一遍是毫秒级。
 */
export async function listJobRevisionPayloads(jobId: string): Promise<RevisionPayload[]> {
  const all = await ops.getAll<RevisionPayload>('revisionPayloads')
  return all.filter(p => p.jobId === jobId).sort((a, b) => a.createdAt - b.createdAt)
}

/** 某项目的载荷列表（配额校验用：条数 200 / 总量 32 MiB） */
export async function listProjectRevisionPayloads(projectId: string): Promise<RevisionPayload[]> {
  const all = await ops.getAll<RevisionPayload>('revisionPayloads')
  return all.filter(p => p.projectId === projectId)
}

export async function deleteRevisionPayload(id: string): Promise<void> {
  await ops.del('revisionPayloads', id)
}

/** 清理孤儿载荷：无任务引用的载荷（保留 30 天宽限期，本版先做立即清理） */
export async function cleanupOrphanPayloads(keepIds: Set<string>): Promise<number> {
  // 全表扫：载荷量级有限（每项目 200 个），首屏不预读全部候选
  const all = await ops.getAll<RevisionPayload>('revisionPayloads')
  let cleaned = 0
  for (const p of all) {
    if (!keepIds.has(p.id)) {
      await deleteRevisionPayload(p.id)
      cleaned++
    }
  }
  return cleaned
}
