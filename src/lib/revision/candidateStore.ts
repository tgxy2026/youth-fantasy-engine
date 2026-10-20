/**
 * 3.2.0 · W3 候选存储（候选正文 ↔ 载荷）
 *
 * 方案 §9.2 把「工作产物」分成两层：
 *   · **元数据**（任务）走主库、随项目走；
 *   · **载荷**（候选正文这类大块文本）本地专属，不进云同步。
 *
 * 候选（`RevisionCandidate`）横跨两层：`text/beforeText` 是载荷，`status/intent/receipt` 是元数据。
 * 本模块把两者**装在同一份载荷**里（元数据放 `report`），理由：
 *   ① 候选的元数据与正文总要一起读（列表也要看状态），拆两个 store 只会多一次往返；
 *   ② 载荷本来就是"每次重生成用新 ID"的不可变块，状态变化只影响 `report` 里的字段，不破坏语义。
 *
 * 🔴 三条硬约束：
 *   ① **单份 ≤ 256 KiB**（`MAX_PAYLOAD_BYTES`）：超了直接拒绝，**不截断**（截断的候选等于废稿）；
 *   ② **严格写盘**：写完必须回读比对正文摘要，不一致就报错（§9.2「写入成功并回读一致后才发布引用」）；
 *   ③ **配额**：单项目 200 份 / 32 MiB，超了明确拒绝并说清是哪一条。
 */
import {
  MAX_PAYLOAD_BYTES, MAX_PAYLOADS_PER_PROJECT, MAX_PAYLOAD_TOTAL_BYTES,
  type RevisionPayload,
} from './jobTypes'
import type { RevisionCandidate, RevisionCandidateStatus } from './revisionCandidate'
import {
  getRevisionPayload, saveRevisionPayload, deleteRevisionPayload,
  listJobRevisionPayloads, listProjectRevisionPayloads,
} from '@/lib/db/revisionJobs'
import { hashOf } from '@/lib/semantic/chunk'

/** 载荷 `report` 里承载的候选元数据（与正文分开放，便于以后单独迁移） */
interface CandidateMeta {
  status: RevisionCandidateStatus
  generation: number
  updatedAt: number
  appliedAt?: number
  discardedAt?: number
  discardedReason?: string
  staleReasons?: string[]
  intent?: RevisionCandidate['intent']
  receipt?: RevisionCandidate['receipt']
  checkPayloadIds?: string[]
}

const isMeta = (v: unknown): v is CandidateMeta =>
  Boolean(v && typeof v === 'object' && typeof (v as CandidateMeta).status === 'string')

/** 字节数按 UTF-8 计（中文 3 字节，别用 `length` 之外的估算） */
const bytesOf = (s: string): number => new TextEncoder().encode(s).length

export function candidateToPayload(c: RevisionCandidate): RevisionPayload {
  const meta: CandidateMeta = {
    status: c.status,
    generation: c.generation,
    updatedAt: c.updatedAt,
    ...(c.appliedAt !== undefined ? { appliedAt: c.appliedAt } : {}),
    ...(c.discardedAt !== undefined ? { discardedAt: c.discardedAt } : {}),
    ...(c.discardedReason ? { discardedReason: c.discardedReason } : {}),
    ...(c.staleReasons?.length ? { staleReasons: c.staleReasons } : {}),
    ...(c.intent ? { intent: c.intent } : {}),
    ...(c.receipt ? { receipt: c.receipt } : {}),
    ...(c.checkPayloadIds?.length ? { checkPayloadIds: c.checkPayloadIds } : {}),
  }
  const bytes = bytesOf(c.text) + bytesOf(c.beforeText)
  return {
    id: c.id,
    projectId: c.projectId,
    kind: 'candidate',
    jobId: c.jobId,
    beforeText: c.beforeText,
    candidateText: c.text,
    summary: c.summary,
    bytes,
    createdAt: c.createdAt,
    report: meta,
  }
}

/**
 * 载荷 → 候选。
 * 🔴 严格校验：`kind` 不是 `candidate`、或 `report` 里没有状态 ⇒ 返回 null（**不猜**）。
 *    把"报告载荷"误当候选读出来，会让界面显示一条并不存在的候选。
 */
export function payloadToCandidate(p: RevisionPayload): RevisionCandidate | null {
  if (p.kind !== 'candidate') return null
  if (typeof p.candidateText !== 'string' || typeof p.beforeText !== 'string') return null
  const meta = p.report
  if (!isMeta(meta)) return null
  return {
    id: p.id,
    jobId: p.jobId,
    projectId: p.projectId,
    status: meta.status,
    text: p.candidateText,
    beforeText: p.beforeText,
    summary: p.summary,
    bytes: p.bytes,
    createdAt: p.createdAt,
    updatedAt: meta.updatedAt ?? p.createdAt,
    generation: meta.generation ?? 0,
    ...(meta.appliedAt !== undefined ? { appliedAt: meta.appliedAt } : {}),
    ...(meta.discardedAt !== undefined ? { discardedAt: meta.discardedAt } : {}),
    ...(meta.discardedReason ? { discardedReason: meta.discardedReason } : {}),
    ...(meta.staleReasons?.length ? { staleReasons: meta.staleReasons } : {}),
    ...(meta.intent ? { intent: meta.intent } : {}),
    ...(meta.receipt ? { receipt: meta.receipt } : {}),
    ...(meta.checkPayloadIds?.length ? { checkPayloadIds: meta.checkPayloadIds } : {}),
  }
}

export type SaveCandidateResult =
  | { ok: true; bytes: number }
  | { ok: false; code: 'too-large' | 'quota-count' | 'quota-bytes' | 'readback-mismatch'; detail: string }

/**
 * 存候选（含配额与回读校验）。
 *
 * 🔴 顺序：**先查配额 → 再写 → 再回读**。反过来先写再查配额，超限时就只能删掉刚写的那份，
 *    多一次失败路径；而"先查后写"最多是并发下略微超一点点，代价小得多。
 */
export async function saveCandidate(c: RevisionCandidate): Promise<SaveCandidateResult> {
  const payload = candidateToPayload(c)

  if (payload.bytes > MAX_PAYLOAD_BYTES) {
    return {
      ok: false, code: 'too-large',
      detail: `候选 ${payload.bytes} 字节，超过单份上限 ${MAX_PAYLOAD_BYTES}（256 KiB）—— 请缩小范围后重试`,
    }
  }

  const existing = await listProjectRevisionPayloads(c.projectId)
  const others = existing.filter(p => p.id !== c.id)
  if (others.length >= MAX_PAYLOADS_PER_PROJECT) {
    return {
      ok: false, code: 'quota-count',
      detail: `本项目已有 ${others.length} 份工作产物（上限 ${MAX_PAYLOADS_PER_PROJECT}），请先清理旧候选再生成`,
    }
  }
  const totalBytes = others.reduce((n, p) => n + (p.bytes || 0), 0) + payload.bytes
  if (totalBytes > MAX_PAYLOAD_TOTAL_BYTES) {
    return {
      ok: false, code: 'quota-bytes',
      detail: `本项目工作产物总量将达 ${Math.round(totalBytes / 1024 / 1024)} MB，超过上限 ${MAX_PAYLOAD_TOTAL_BYTES / 1024 / 1024} MB`,
    }
  }

  await saveRevisionPayload(payload)

  // 严格写盘：回读比对正文摘要（只比正文，元数据是本地生成的小对象）
  const back = await getRevisionPayload(c.id)
  if (!back || typeof back.candidateText !== 'string' || hashOf(back.candidateText) !== hashOf(c.text)) {
    return { ok: false, code: 'readback-mismatch', detail: '候选写入后回读与写入内容不一致（可能磁盘写满）' }
  }
  return { ok: true, bytes: payload.bytes }
}

export async function loadCandidate(id: string): Promise<RevisionCandidate | null> {
  const p = await getRevisionPayload(id)
  return p ? payloadToCandidate(p) : null
}

/** 某任务的全部候选（按创建时间升序，界面按"第几稿"排列即天然有序） */
export async function listJobCandidates(jobId: string): Promise<RevisionCandidate[]> {
  const list = await listJobRevisionPayloads(jobId)
  return list.map(payloadToCandidate).filter((c): c is RevisionCandidate => c !== null)
}

export async function deleteCandidate(id: string): Promise<void> {
  await deleteRevisionPayload(id)
}

/**
 * 该任务里**还能应用**的候选（`pending` / `applying`）。
 * 🔴 `applying` 也要算进来：它可能上次写一半崩了，`applyCandidate` 会走崩溃恢复分支。
 */
export async function listApplicableCandidates(jobId: string): Promise<RevisionCandidate[]> {
  const all = await listJobCandidates(jobId)
  return all.filter(c => c.status === 'pending' || c.status === 'applying')
}
