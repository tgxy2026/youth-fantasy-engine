// ============ 投稿体检 · 预检 / 探针结果快照（3.7.0 · W6 复核补 ②）============
//
// 与 `openingSnapshot` 同一个思路：只把**那次结论的摘要**存进项目 settingsKV，
// 让「投稿体检」能引用「当时到底看到了什么」，而不是永远「未跑」。
//
// 🔴 只存观察句 / 收尾句 / 条数，不复制整章正文、不存敏感词明细全文；
//    读不到或结构损坏一律 null（体检页如实写「未跑」，不编造）。
import * as db from '@/lib/db'
import type { PlatformCheckReport } from '@/lib/audit/platformCheck'
import type { ReaderProbeResult } from '@/lib/audit/readerProbe'

export const PLATFORM_SNAPSHOT_KEY = 'platformPrecheck'
export const READER_PROBE_SNAPSHOT_KEY = 'readerProbeSummary'
/** 观察句上限：够体检页引用即可，不做第二份完整报告 */
const MAX_OBSERVATIONS = 12

export interface PlatformSnapshot {
  platform: string
  observations: string[]
  at: number
}

export interface ReaderProbeSnapshot {
  lens: string
  summary: string
  notes: number
  at: number
}

/** 存平台预检摘要（旁路：失败静默，预检结果本身不受影响） */
export async function savePlatformSnapshot(projectId: string, report: PlatformCheckReport): Promise<boolean> {
  if (!projectId) return false
  const observations = report.observations.map(s => s.trim()).filter(Boolean).slice(0, MAX_OBSERVATIONS)
  const snap: PlatformSnapshot = {
    platform: report.platformName,
    observations,
    at: Date.now(),
  }
  try {
    await db.setSettingFor(projectId, PLATFORM_SNAPSHOT_KEY, snap)
    return true
  } catch {
    return false
  }
}

export async function readPlatformSnapshot(projectId: string): Promise<PlatformSnapshot | null> {
  try {
    const raw = await db.getSettingFor<unknown>(projectId, PLATFORM_SNAPSHOT_KEY, null)
    if (!raw || typeof raw !== 'object') return null
    const v = raw as Partial<PlatformSnapshot>
    if (typeof v.platform !== 'string' || !v.platform) return null
    const observations = Array.isArray(v.observations) ? v.observations.filter((x): x is string => typeof x === 'string') : []
    return { platform: v.platform, observations, at: typeof v.at === 'number' ? v.at : 0 }
  } catch {
    return null
  }
}

/** 存读者探针摘要（只有收尾一句 + 条数 + 身份；不复制逐条引文） */
export async function saveReaderProbeSnapshot(
  projectId: string, lensName: string, result: ReaderProbeResult,
): Promise<boolean> {
  const summary = (result.summary ?? '').trim()
  if (!projectId || !summary) return false
  const snap: ReaderProbeSnapshot = {
    lens: lensName,
    summary,
    notes: result.notes.length,
    at: Date.now(),
  }
  try {
    await db.setSettingFor(projectId, READER_PROBE_SNAPSHOT_KEY, snap)
    return true
  } catch {
    return false
  }
}

export async function readReaderProbeSnapshot(projectId: string): Promise<ReaderProbeSnapshot | null> {
  try {
    const raw = await db.getSettingFor<unknown>(projectId, READER_PROBE_SNAPSHOT_KEY, null)
    if (!raw || typeof raw !== 'object') return null
    const v = raw as Partial<ReaderProbeSnapshot>
    if (typeof v.summary !== 'string' || !v.summary.trim()) return null
    return {
      lens: typeof v.lens === 'string' ? v.lens : '读者',
      summary: v.summary,
      notes: typeof v.notes === 'number' ? v.notes : 0,
      at: typeof v.at === 'number' ? v.at : 0,
    }
  } catch {
    return null
  }
}