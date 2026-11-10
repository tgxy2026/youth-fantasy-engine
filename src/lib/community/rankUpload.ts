// ============ 码字排行榜 · 上报（3.5.0）============
//
// 【设计取舍】本地账本本身就是「待同步队列」：服务端按 (账号, 设备, 项目, 日期)
// 保存最新一条，所以不需要再维护一份可丢失的队列 —— 网络失败时账本还在，
// 下次成功后自然覆盖。这样少一处状态机，也少一处「队列与账本不一致」的 bug。
//
// 🔴 撤回授权后**不得**再上传：每次上报前先查服务端档案（唯一真相），
//    本地不缓存「已开启」状态，避免另一台设备撤回后本机继续硬传。
// 🔴 只上传日期与数量：不含正文、标题、项目名。projectId 是不透明本地 id。
// 🔴 设备标识存本机 localStorage，随机生成；换设备 = 换标识，服务端据此做尽力去重。

import { getAllProjects } from '@/lib/db/projects'
import { fetchProfile, reportRank, type RankReportEntry } from '@/lib/community/api'
import { cnDateKey, ledgerSince, readLedger } from '@/lib/community/rankLedger'

const DEVICE_KEY = 'yfe.community.deviceId'
const THROTTLE_MS = 60_000
let lastRunAt = 0
let running: Promise<RankUploadResult> | null = null

export interface RankUploadResult {
  skipped?: 'opt-out' | 'throttled' | 'offline'
  sent: number
  accepted: number
  rejected: Array<{ projectId: string; date: string; code: string }>
  error?: string
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

/** 组装待上传条目（纯函数，便于单测核对「开启前不传」）*/
export function buildRankEntries(input: {
  projects: string[]
  ledgerOf: (projectId: string) => Promise<Array<{ date: string; net: number; seq: number; updatedAt: number }>>
  fromDate: string
}): Promise<RankReportEntry[]> {
  return (async () => {
    const out: RankReportEntry[] = []
    for (const pid of input.projects) {
      const rows = ledgerSince(await input.ledgerOf(pid), input.fromDate)
      for (const row of rows) {
        out.push({ projectId: pid, date: row.date, netDelta: row.net, seq: row.seq, issuedAt: row.updatedAt })
      }
    }
    // 服务端单次上限 400 条；优先最近的日期
    return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 400)
  })()
}

/**
 * 上报一次。可以安全地重复调用：内部有 60 秒节流与并发去重。
 * @param opts.force 设置页「立即同步」用（跳过节流）
 */
export function uploadRank(opts: { force?: boolean } = {}): Promise<RankUploadResult> {
  const empty: RankUploadResult = { sent: 0, accepted: 0, rejected: [] }
  if (running) return running
  const now = Date.now()
  if (!opts.force && now - lastRunAt < THROTTLE_MS) return Promise.resolve({ ...empty, skipped: 'throttled' })
  lastRunAt = now
  running = (async () => {
    let profile
    try {
      profile = (await fetchProfile()).profile
    } catch (e) {
      return { ...empty, skipped: 'offline' as const, error: e instanceof Error ? e.message : String(e) }
    }
    if (!profile.rankOptIn) return { ...empty, skipped: 'opt-out' as const }

    const from = cnDateKey(Number((profile as unknown as { rankOptInAt?: number }).rankOptInAt) || Date.now())
    let projects: string[] = []
    try {
      projects = (await getAllProjects()).map((p) => p.id)
    } catch {
      return { ...empty, error: '读取项目列表失败' }
    }
    const entries = await buildRankEntries({ projects, ledgerOf: readLedger, fromDate: from })
    if (!entries.length) return { ...empty }

    try {
      const r = await reportRank({ deviceId: deviceId(), entries })
      return {
        sent: entries.length,
        accepted: r.accepted.length,
        rejected: r.rejected,
      }
    } catch (e) {
      return { ...empty, skipped: 'offline' as const, error: e instanceof Error ? e.message : String(e) }
    }
  })().finally(() => { running = null })
  return running
}