// ============ 码字排行榜 · 上报（3.5.0）============
//
// 【设计取舍】本地账本本身就是「待同步队列」：服务端按 (账号, 设备, 项目, 日期)
// 保存最新一条，所以不需要再维护一份可丢失的队列 —— 网络失败时账本还在，
// 下次成功后自然覆盖。这样少一处状态机，也少一处「队列与账本不一致」的 bug。
//
// 🔴 批次与积压：服务端单次最多 400 条，原先只取「最近 400 条」⇒ 积压时**旧日期永远传不上去**。
//    现在按日期升序分批、每轮最多 5 批，并把「已同步到哪一天」记在本机（按账号），
//    下一轮从该日往前回退 2 天接着传（重叠部分由服务端 seq 幂等覆盖）。
// 🔴 撤回授权后**不得**再上传：每次上报前先查服务端档案（唯一真相），
//    本地不缓存「已开启」状态，避免另一台设备撤回后本机继续硬传。
// 🔴 只上传日期与数量：不含正文、标题、项目名。projectId 是不透明本地 id。
// 🔴 设备标识存本机 localStorage，随机生成；换设备 = 换标识，服务端据此做尽力去重。

import { getAllProjects } from '@/lib/db/projects'
import { fetchProfile, reportRank, type RankReportEntry } from '@/lib/community/api'
import { cnDateKey, flushPendingRankDeltas, ledgerSince, readLedger } from '@/lib/community/rankLedger'

const DEVICE_KEY = 'yfe.community.deviceId'
const SYNC_KEY = 'yfe.community.rankSync'
const THROTTLE_MS = 60_000
/** 与服务器单次上限一致：超过会被服务端截断，且难以判断「哪些没发」 */
const BATCH_SIZE = 400
/** 单轮最多发的批次数：保证一次上报不会拖住界面太久，下一轮会接着往下传 */
const MAX_BATCHES = 5
/** 「已同步日」回退天数：让最近几天的新增减量仍然会被重新上报覆盖 */
const OVERLAP_DAYS = 2

let lastRunAt = 0
let running: Promise<RankUploadResult> | null = null

export interface RankUploadResult {
  skipped?: 'opt-out' | 'throttled' | 'offline' | 'no-entries'
  sent: number
  accepted: number
  rejected: Array<{ projectId: string; date: string; code: string }>
  /** 本轮之后仍未上传的条目数（>0 表示还有积压，下次继续） */
  remaining: number
  /** 本机记录的「已同步到哪天」 */
  syncedThrough: string
  error?: string
}

interface SyncState {
  accountKey: string
  syncedThrough: string
  fullSyncAt: number
}

function deviceId(): string {
  try {
    const prev = localStorage.getItem(DEVICE_KEY)
    if (prev && /^[a-zA-Z0-9_-]{6,64}$/.test(prev)) return prev
  } catch { /* 忽略 */ }
  const rnd = new Uint8Array(9)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(rnd)
  else for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256)
  const id = 'dev_' + Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('')
  try { localStorage.setItem(DEVICE_KEY, id) } catch { /* 忽略 */ }
  return id
}

function readSyncState(): SyncState | null {
  try {
    const raw = localStorage.getItem(SYNC_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SyncState>
    if (!parsed || typeof parsed.accountKey !== 'string') return null
    return {
      accountKey: parsed.accountKey,
      syncedThrough: typeof parsed.syncedThrough === 'string' ? parsed.syncedThrough : '',
      fullSyncAt: Number(parsed.fullSyncAt) || 0,
    }
  } catch { return null }
}

function writeSyncState(state: SyncState): void {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(state)) } catch { /* 忽略 */ }
}

function clearSyncState(): void {
  try { localStorage.removeItem(SYNC_KEY) } catch { /* 忽略 */ }
}

/** 把日期往后/往前挪 n 天（只做字符串 → Date.UTC 运算，避免时区漂移） */
export function shiftDateKey(dateKey: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (!m) return dateKey
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86400000
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 按日期升序组装待上传条目（纯函数，便于单测核对「开启前不传」「积压不漏旧日期」）*/
export async function buildRankEntries(input: {
  projects: string[]
  ledgerOf: (projectId: string) => Promise<Array<{ date: string; net: number; seq: number; updatedAt: number }>>
  fromDate: string
}): Promise<RankReportEntry[]> {
  const out: RankReportEntry[] = []
  for (const pid of input.projects) {
    const rows = ledgerSince(await input.ledgerOf(pid), input.fromDate)
    for (const row of rows) {
      out.push({ projectId: pid, date: row.date, netDelta: row.net, seq: row.seq, issuedAt: row.updatedAt })
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/**
 * 上报一次。可以安全地重复调用：内部有 60 秒节流与并发去重。
 * @param opts.force 设置页「立即同步」用（跳过节流）
 * @param opts.accountKey 当前账号（用于区分本机同步游标；缺省时只用本次结果）
 */
export function uploadRank(opts: { force?: boolean; accountKey?: string } = {}): Promise<RankUploadResult> {
  const empty: RankUploadResult = { sent: 0, accepted: 0, rejected: [], remaining: 0, syncedThrough: '' }
  if (running) return running
  const now = Date.now()
  if (!opts.force && now - lastRunAt < THROTTLE_MS) return Promise.resolve({ ...empty, skipped: 'throttled' })
  lastRunAt = now
  running = (async () => {
    // 账本写入失败留下的增量先补记；失败不影响后面（会再次留队）
    await flushPendingRankDeltas()

    let profile
    try {
      profile = (await fetchProfile()).profile
    } catch (e) {
      return { ...empty, skipped: 'offline' as const, error: e instanceof Error ? e.message : String(e) }
    }
    if (!profile.rankOptIn) {
      clearSyncState()
      return { ...empty, skipped: 'opt-out' as const }
    }

    const optInDate = cnDateKey(Number(profile.rankOptInAt) || Date.now())
    const accountKey = opts.accountKey || 'default'
    const previous = readSyncState()
    const sameAccount = previous?.accountKey === accountKey
    const staleFullSync = !sameAccount || now - (previous?.fullSyncAt || 0) > 12 * 3600 * 1000
    // 同账号且 12 小时内同步过：从「已同步日 − 2 天」接着传；否则从授权开启日全量补齐
    const resumeFrom = sameAccount && previous?.syncedThrough && !staleFullSync
      ? shiftDateKey(previous.syncedThrough, -OVERLAP_DAYS)
      : optInDate
    const from = [optInDate, resumeFrom].sort()[1] // 取较晚者，但不早于授权日

    let projects: string[] = []
    try {
      projects = (await getAllProjects()).map((p) => p.id)
    } catch {
      return { ...empty, error: '读取项目列表失败' }
    }
    const entries = await buildRankEntries({ projects, ledgerOf: readLedger, fromDate: from })
    if (!entries.length) {
      writeSyncState({ accountKey, syncedThrough: previous?.syncedThrough || optInDate, fullSyncAt: now })
      return { ...empty, skipped: 'no-entries' as const, syncedThrough: previous?.syncedThrough || optInDate }
    }

    const device = deviceId()
    let sent = 0
    let accepted = 0
    const rejected: RankUploadResult['rejected'] = []
    let offset = 0
    let batches = 0
    let syncedThrough = previous && sameAccount ? previous.syncedThrough : ''

    while (offset < entries.length && batches < MAX_BATCHES) {
      const chunk = entries.slice(offset, offset + BATCH_SIZE)
      batches++
      try {
        const r = await reportRank({ deviceId: device, entries: chunk })
        sent += chunk.length
        accepted += r.accepted.length
        rejected.push(...r.rejected)
        offset += chunk.length
        const lastDate = chunk[chunk.length - 1]?.date || ''
        if (lastDate && lastDate > syncedThrough) syncedThrough = lastDate
        writeSyncState({ accountKey, syncedThrough, fullSyncAt: now })
      } catch (e) {
        return {
          sent, accepted, rejected,
          remaining: entries.length - offset,
          syncedThrough,
          skipped: 'offline' as const,
          error: e instanceof Error ? e.message : String(e),
        }
      }
    }

    return {
      sent, accepted, rejected,
      remaining: Math.max(0, entries.length - offset),
      syncedThrough,
    }
  })().finally(() => { running = null })
  return running
}

/** 设置页展示用：本机记录的上次同步进度（不含内容） */
export function readRankSyncState(): SyncState | null {
  return readSyncState()
}