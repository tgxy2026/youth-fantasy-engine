// ============ W4 「加入工单」联动（2026-10-20 · 方案 §7.2 / §9.1）============
//
// 一条链：**自检/审校发现问题 → 检查报告落库 → 加入工单 → 作者手动处置**。
//
// 🔴 为什么必须落在工单上（而不是只留在检查报告里）：
//    工单是作者唯一「按章待办」的视图；报告躺在载荷里没人会去翻。
//    但也不能把 AI 结论变成**可自动执行**的条目 —— 检查结论是「可疑」，不是「确定要改」，
//    所以 `action` 恒为 `manual`（界面禁掉「执行」，只提示作者自己判断）。
//
// 🔴 章号 vs 章 id：连写时自检发生在 `createChapterAfter` 之前，新章还没有 id，
//    报告只能记「计划章号」。所以这里做**两级匹配**：先按 id，再按章号；两级都对不上就如实
//    记为 `unmapped`（不硬塞到某一章头上 —— 塞错章比不塞更糟）。

import type { TicketItem, TicketSource } from '@/lib/app/optimizeTicket'
import type { ContinuityFinding } from '@/lib/aiTasks/audit'
import {
  fromContinuityFinding, ticketDedupKey, type ExtendedTicketItem,
} from './findingAdapters'
import { listProjectRevisionPayloads } from '@/lib/db/revisionJobs'

/** 检查项 → 工单来源（词表映射的**唯一**去处） */
export function ticketSourceOfCheck(checkId: string): TicketSource {
  const id = checkId.trim().toLowerCase()
  if (id === 'foreshadow') return 'foreshadow'
  if (id === 'ooc') return 'ai-ooc'
  if (id === 'continuity') return 'continuity'
  return 'ai-review'
}

/** 工单里按章分组需要的章节信息（由调用方给，模块自己不读库） */
export interface ChapterRef {
  id: string
  title: string
  /** 叙事序号（0 = 序章 / 番外） */
  no: number
  body: string
}

/** 一条已落库的检查报告（只取本模块需要的字段） */
export interface PersistedCheckReport {
  id: string
  jobId: string
  checkId: string
  source: string
  chapterId?: string
  chapterNo?: number
  findings: ContinuityFinding[]
}

/** 从载荷形状里安全取出检查结论（模型/老数据都可能不成形） */
export function findingsOfReport(report: unknown): ContinuityFinding[] {
  if (!report || typeof report !== 'object') return []
  const result = (report as { result?: unknown }).result
  if (!Array.isArray(result)) return []
  const out: ContinuityFinding[] = []
  for (const raw of result) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const title = typeof r.title === 'string' ? r.title.trim() : ''
    const level = typeof r.level === 'string' ? r.level.trim() : ''
    // 没有标题的条目无法成为工单（作者看不出要改什么）
    if (!title) continue
    out.push({
      level: level || '中等',
      title,
      detail: typeof r.detail === 'string' ? r.detail : '',
      where: typeof r.where === 'string' ? r.where : '',
    })
  }
  return out
}

/** 一份报告 → 工单条目（按章定位证据，`action` 恒为 manual） */
export function intakeReport(
  report: PersistedCheckReport,
  chapter: ChapterRef,
): ExtendedTicketItem[] {
  return report.findings.map(f => {
    const item = fromContinuityFinding(
      f, chapter.id, chapter.title, chapter.no, chapter.body,
      ticketSourceOfCheck(report.checkId),
    )
    return {
      ...item,
      // 保留报告来源，便于作者回看「这条是哪次检查报的」
      originReportId: report.id,
      disposition: 'pending' as const,
    }
  })
}

export interface IntakeResult {
  /** 新条目 */
  items: ExtendedTicketItem[]
  /** 用掉的报告数 */
  reportsUsed: number
  /** 匹配不到章节的报告（章号/id 都对不上）—— 如实计数，不硬塞 */
  unmapped: number
}

/**
 * 从**已落库**的检查报告里取出条目并挂到章上。
 *
 * 匹配顺序：`chapterId` 精确 → `chapterNo` 精确 → 放弃（计入 unmapped）。
 */
export function intakeFromReports(
  reports: readonly PersistedCheckReport[],
  chapters: readonly ChapterRef[],
): IntakeResult {
  const byId = new Map(chapters.map(c => [c.id, c]))
  const byNo = new Map<number, ChapterRef>()
  for (const c of chapters) if (!byNo.has(c.no)) byNo.set(c.no, c)

  const items: ExtendedTicketItem[] = []
  let reportsUsed = 0
  let unmapped = 0
  for (const r of reports) {
    if (r.findings.length === 0) continue
    const ch = (r.chapterId ? byId.get(r.chapterId) : undefined)
      ?? (r.chapterNo !== undefined ? byNo.get(r.chapterNo) : undefined)
    if (!ch) { unmapped++; continue }
    items.push(...intakeReport(r, ch))
    reportsUsed++
  }
  return { items, reportsUsed, unmapped }
}

/**
 * 合并：已有工单 + 新条目。
 *
 * 🔴 已有条目**状态优先**：作者可能已经把它标成 skipped/done，重新加入工单不该把它拉回 pending。
 *    去重键与 `ticketDedupKey` 同源，避免"同一问题两种写法各算一条"。
 */
export function mergeIntake(
  existing: readonly TicketItem[],
  incoming: readonly ExtendedTicketItem[],
): { items: TicketItem[]; added: number; skipped: number } {
  const seen = new Set(existing.map(i => ticketDedupKey(i as ExtendedTicketItem)))
  const items = [...existing]
  let added = 0
  let skipped = 0
  for (const it of incoming) {
    const key = ticketDedupKey(it)
    if (seen.has(key)) { skipped++; continue }
    seen.add(key)
    items.push(it)
    added++
  }
  return { items, added, skipped }
}

/** 读全项目的检查报告（按章可挂的那部分） */
export async function loadCheckReports(projectId: string): Promise<PersistedCheckReport[]> {
  const rows = await listProjectRevisionPayloads(projectId)
  const out: PersistedCheckReport[] = []
  for (const p of rows) {
    if (p.kind !== 'report') continue
    const r = (p.report ?? {}) as Record<string, unknown>
    const findings = findingsOfReport(r)
    if (findings.length === 0) continue
    out.push({
      id: p.id,
      jobId: p.jobId,
      checkId: typeof r.checkId === 'string' ? r.checkId : 'unknown',
      source: typeof r.source === 'string' ? r.source : '',
      ...(typeof r.chapterId === 'string' ? { chapterId: r.chapterId } : {}),
      ...(typeof r.chapterNo === 'number' ? { chapterNo: r.chapterNo } : {}),
      findings,
    })
  }
  return out
}

/**
 * 「加入工单」的总入口：读报告 → 挂章 → 去重合并。
 *
 * 🔴 全程不抛（读库失败就当没有报告）：工单页是只读诊断入口，
 *    不该因为一份旧报告坏了而整页空掉。
 */
export async function joinCheckReportsToTicket(
  projectId: string,
  chapters: readonly ChapterRef[],
  existing: readonly TicketItem[],
): Promise<{ items: TicketItem[]; added: number; skipped: number; reportsUsed: number; unmapped: number }> {
  try {
    const reports = await loadCheckReports(projectId)
    const intake = intakeFromReports(reports, chapters)
    const merged = mergeIntake(existing, intake.items)
    return { ...merged, reportsUsed: intake.reportsUsed, unmapped: intake.unmapped }
  } catch {
    return { items: [...existing], added: 0, skipped: 0, reportsUsed: 0, unmapped: 0 }
  }
}
