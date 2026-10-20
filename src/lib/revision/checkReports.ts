// ============ W4 检查报告留存策略（2026-10-20 · 方案 §9.2 / §16.11）============
//
// 作者 2026-10-20 拍板 **A 策略：有问题才存 + 双闸淘汰**。
//
// 🔴 为什么不能「每次检查都存」：一章连写会跑 3 项审校，逐章累加；`revisionPayloads`
//    单项目上限 200 份 / 32 MiB —— 全量落库会在几十章内把更早的报告全挤掉，
//    等于「存了但存不住」，还白占磁盘。
// 🔴 为什么不能「不存」：作者回看「当时到底报了哪三条」是 W4 的验收要求
//    （检查 → 证据 → 候选 → 审阅应用）；只留计数等于链条缺一环。
//
// 因此口径是：
//   ① **只在有实质发现时落库**（严重 / 中等）；全绿不落，账本里只留计数（自检状态已有）；
//   ② **同一批发现只存一份**（指纹去重）—— 重跑同一章不会被当成新报告；
//   ③ **双闸淘汰**：每任务最近 5 份、每项目 200 份 / 32 MiB（超了删最旧，且删的是整份载荷）。
//
// ⚠️ 不存「未完成 / 失败」的检查：那不是发现，是故障；故障由运行账本与日志如实承担
//    （否则一份失败报告会在 UI 上看起来像"检查过了"）。

import type { RevisionPayload } from './jobTypes'
import type { TicketEvidence } from './findingAdapters'
import { persistCheckResult } from './checkPersistence'
import { listProjectRevisionPayloads, deleteRevisionPayload } from '@/lib/db/revisionJobs'
import { hashOf } from '@/lib/semantic/chunk'

/** 会被当"实质发现"的级别（与审计侧词表一致：严重 / 中等 / 提示） */
export const SERIOUS_LEVELS = ['严重', '中等'] as const

export const CHECK_REPORT_LIMITS = {
  /** 每个任务最多留几份（一个任务里同一章多次审校、或连写多章） */
  perJob: 5,
  /** 每个项目最多留几份（与 `revisionPayloads` 的 W2 总配额一致） */
  perProject: 200,
  /** 每个项目最多多少字节（32 MiB，与 W2 总配额一致） */
  perProjectBytes: 32 * 1024 * 1024,
} as const

/** 一项检查的结论形状（只取本模块需要的字段，避免与 audit 的类型强耦合） */
export interface CheckFindingLike {
  level?: string
  title?: string
  detail?: string
}

/** 一次检查的结果形状（`*WithStatus` 内核的返回） */
export interface CheckRunLike {
  state?: string
  result?: { data?: readonly CheckFindingLike[] } | null
}

/** 某级别是否算实质发现 */
export function isSeriousLevel(level: unknown): boolean {
  return typeof level === 'string' && (SERIOUS_LEVELS as readonly string[]).includes(level.trim())
}

/**
 * 这次检查值不值得落库。
 *
 * 🔴 `state` 必须是 `completed`：失败/取消/未完成的检查**不是**"没发现问题"，
 *    落成一份空报告会让作者以为「查过了、没事」—— 这正是 WQ1 登记的老毛病。
 */
export function isWorthPersisting(run: CheckRunLike | null | undefined): boolean {
  if (!run || run.state !== 'completed') return false
  const findings = run.result?.data ?? []
  return findings.some(f => isSeriousLevel(f.level))
}

/** 计数（严重 / 中等 / 提示），用于摘要与人话 */
export function countFindings(findings: readonly CheckFindingLike[]): {
  serious: number
  minor: number
  info: number
} {
  let serious = 0, minor = 0, info = 0
  for (const f of findings) {
    const lv = typeof f.level === 'string' ? f.level.trim() : ''
    if (lv === '严重') serious++
    else if (lv === '中等') minor++
    else info++
  }
  return { serious, minor, info }
}

/** 一批发现的指纹：同内容不重复落库（检查重跑不算新报告） */
export function findingsFingerprint(findings: readonly CheckFindingLike[]): string {
  const lines = findings
    // where 不在 CheckFindingLike 里（审计侧才有），取不到就空串——指纹只需稳定，不需完整
    .map(f => `${f.level ?? ''}|${f.title ?? ''}|${(f as { where?: string }).where ?? ''}|${f.detail ?? ''}`)
    .sort()
  return hashOf(lines.join('\n'))
}

export interface PrunableReport {
  id: string
  jobId: string
  createdAt: number
  bytes: number
}

/**
 * 算出该删哪些（纯函数，便于单测）。
 *
 * 顺序：先按「每任务最近 N 份」删，再按「每项目总数」「每项目字节」删最旧。
 * 🔴 同一份不会算两次（`drop` 集合去重）。
 */
export function planCheckReportPrune(
  entries: readonly PrunableReport[],
  limits: { perJob?: number; perProject?: number; perProjectBytes?: number } = {},
): string[] {
  const perJob = Math.max(1, limits.perJob ?? CHECK_REPORT_LIMITS.perJob)
  const perProject = Math.max(1, limits.perProject ?? CHECK_REPORT_LIMITS.perProject)
  const perProjectBytes = Math.max(1, limits.perProjectBytes ?? CHECK_REPORT_LIMITS.perProjectBytes)
  const drop = new Set<string>()
  // 🔴 同一毫秒内写多份是常态（三项审校连着落库），只按 `createdAt` 排序会把「新的」判成「旧的」。
  //    这里用**入参顺序**当次级键：数组是插入顺序，越靠后越新。
  const order = new Map(entries.map((e, i) => [e.id, i]))
  const newer = (a: PrunableReport, b: PrunableReport): number =>
    b.createdAt - a.createdAt || (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0)

  // ① 每任务：新的留下，旧的删
  const byJob = new Map<string, PrunableReport[]>()
  for (const e of entries) {
    const arr = byJob.get(e.jobId) ?? []
    arr.push(e)
    byJob.set(e.jobId, arr)
  }
  for (const arr of byJob.values()) {
    arr.sort(newer)
    for (const e of arr.slice(perJob)) drop.add(e.id)
  }

  // ② 每项目：总数（最旧先删）
  const alive = entries.filter(e => !drop.has(e.id)).sort(newer)
  for (const e of alive.slice(perProject)) drop.add(e.id)

  // ③ 每项目：字节（最旧先删，直到进额度）
  const stillAlive = alive.filter(e => !drop.has(e.id))
  let bytes = stillAlive.reduce((n, e) => n + e.bytes, 0)
  for (let i = stillAlive.length - 1; i >= 0 && bytes > perProjectBytes; i--) {
    const e = stillAlive[i]
    if (drop.has(e.id)) continue
    drop.add(e.id)
    bytes -= e.bytes
  }

  return [...drop]
}

export interface PersistCheckReportsInput {
  projectId: string
  jobId: string
  /** 本次跑过的检查（顺序无关） */
  reports: readonly { checkId: string; source: string; run: CheckRunLike | null | undefined; evidence?: TicketEvidence[] }[]
}

export interface PersistCheckReportsResult {
  /** 落库份数 */
  saved: number
  /** 因"没实质发现 / 未完成 / 已存在同一份"而跳过 */
  skipped: number
  /** 淘汰份数 */
  pruned: number
  /** 失败原因（不影响创作主流程） */
  error?: string
}

/** 从载荷里取回「指纹」，用于去重（老数据没有指纹就按内容现算） */
function fingerprintOfPayload(p: RevisionPayload): string | null {
  const r = (p.report ?? {}) as Record<string, unknown>
  const result = r.result
  if (!Array.isArray(result)) return null
  return findingsFingerprint(result as CheckFindingLike[])
}

/**
 * 落库 + 淘汰。
 *
 * 🔴 全程不抛：检查报告是**旁路**，写不进去只记 error 字符串，绝不能让连写中断
 *    （正文已经生成好了，报告没存上是遗憾，不是失败）。
 */
export async function persistCheckReports(
  input: PersistCheckReportsInput,
): Promise<PersistCheckReportsResult> {
  const out: PersistCheckReportsResult = { saved: 0, skipped: 0, pruned: 0 }
  const worth = input.reports.filter(r => isWorthPersisting(r.run))
  out.skipped += input.reports.length - worth.length
  if (worth.length === 0) return out

  try {
    const existing = (await listProjectRevisionPayloads(input.projectId))
      .filter(p => p.kind === 'report' && p.jobId === input.jobId)
    const seen = new Set(existing.map(fingerprintOfPayload).filter((x): x is string => !!x))

    for (const r of worth) {
      const findings = (r.run?.result?.data ?? []) as readonly CheckFindingLike[]
      const fp = findingsFingerprint(findings)
      // 同一批发现只存一份（检查重跑 / 换模型后结论相同，不该占两份额度）
      if (seen.has(fp)) { out.skipped++; continue }
      const { serious, minor } = countFindings(findings)
      const res = await persistCheckResult(
        input.jobId,
        input.projectId,
        r.checkId,
        r.source,
        findings,
        r.evidence,
        `检查 ${r.checkId}：严重 ${serious} / 中等 ${minor}`,
      )
      if (res.ok) { out.saved++; seen.add(fp) }
      else out.skipped++
    }

    // 淘汰：拿全项目报告（含刚写的）算一遍
    const all = (await listProjectRevisionPayloads(input.projectId))
      .filter(p => p.kind === 'report')
      .map(p => ({ id: p.id, jobId: p.jobId, createdAt: p.createdAt, bytes: p.bytes }))
    const drop = planCheckReportPrune(all)
    for (const id of drop) {
      await deleteRevisionPayload(id)
      out.pruned++
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e)
  }
  return out
}
