// ============ 码字排行榜 · 本机有符号账本（3.5.0）============
//
// 【为什么不能用 dailyStats】现有 `dailyStats` 有两个致命差异：
//   ① 口径是**不含标点**的 `wordCount` 差量，而排行榜要求含标点净增量；
//   ② `addDailyWords` 把每日累计截到 0，先删除后新增时会丢失应在当天抵扣的删减量。
// 所以本模块另建一本账：**保留正负**、**只记正文**、**按日期分键**。
//
// 【存在哪】`settingsKV` 的 `<pid>::communityRankLedger::<YYYY-MM-DD>`。
//   选它而不是新建 IDB 表，是因为它已被三端（桌面 / 便携 / 网页）统一搬运、
//   随项目备份与云同步一起走，**不需要新增迁移与键映射**（少一处必然漂移的地方）。
//   键前缀独立，与看板的 `dailyStats` 完全隔离。
//
// 🔴 只统计「用户自己的真实写作」：导入备份、恢复、云拉取、示范项目都走**直接 put**，
//    不经过 `afterChapterWrite`，因此天然不计入；`withRankSuppressed` 是给
//    将来可能新增的「批量写入也要走保存函数」的路径留的闸。
// 服务器按账号汇总当天各项目的增减，周/月榜只累计已结束日期的正净增量。

import { getSettingFor, getSettingsByPrefix, setSettingFor } from '@/lib/db/meta'
import { countWordsWithPunct } from '@/lib/community/limits'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'

export const RANK_LEDGER_PREFIX = 'communityRankLedger::'

export interface RankLedgerRow {
  date: string
  /** 有符号净增量（含标点），可负 */
  net: number
  /** 单调递增序号：服务端据此丢弃迟到/重放的旧值 */
  seq: number
  updatedAt: number
  /** Timestamped changes allow the first authorised day to exclude earlier work. */
  events?: Array<{ at: number; delta: number }>
  /** Earlier events are unknown before this boundary. */
  eventsFrom?: number
}

/** 北京时间自然日（排行榜固定口径；不受设备时区影响） */
export function cnDateKey(nowMs = Date.now()): string {
  const d = new Date(nowMs + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 一段正文改为另一段后的含标点净变化（新增与删除相抵） */
export function netDeltaOfTexts(before: string | undefined, after: string | undefined): number {
  return countWordsWithPunct(after || '') - countWordsWithPunct(before || '')
}

/** 纯函数：把一次增量合并进账本行（供单测直接验证，不经存储） */
export function applyLedgerDelta(prev: RankLedgerRow | null | undefined, delta: number, date: string, now = Date.now()): RankLedgerRow {
  const events = [...(prev?.events || []), { at: now, delta }].sort((a, b) => a.at - b.at)
  let eventsFrom = prev?.eventsFrom ?? (prev ? prev.updatedAt + 1 : Date.parse(`${date}T00:00:00+08:00`))
  if (events.length > 4096) {
    const removed = events.splice(0, events.length - 4096)
    eventsFrom = Math.max(eventsFrom, removed[removed.length - 1].at + 1)
  }
  return {
    date,
    net: (prev?.net || 0) + delta,
    seq: (prev?.seq || 0) + 1,
    updatedAt: Math.max(prev?.updatedAt || 0, now),
    events,
    eventsFrom,
  }
}

// ---------------- 抑制闸 ----------------

let suppressed = 0

/**
 * 在「不算作日常写作」的批量写入期间暂停记账。
 * 🔴 目前导入/恢复/云拉取都直接写表，本用不上；保留它是为了防止后来者
 *    把它们改成走 `saveChapter` 时**悄悄把整本书算成当日新增**。
 */
export function withRankSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  suppressed++
  return Promise.resolve().then(fn).finally(() => { suppressed-- })
}

export function rankSuppressed(): boolean {
  return suppressed > 0
}

// ---------------- 记账 ----------------

// 🔴 读-改-写必须串行：2s 自动保存、Ctrl+S、标题防抖落库可能同时触发，
//    各自读旧值再写回会互相覆盖（与 `addDailyWords` 同一类问题）。
let chain: Promise<unknown> = Promise.resolve()

/**
 * 写账本失败时的补偿队列（本机 localStorage）。
 *
 * 【为什么必须有】正文落盘与账本写入是两笔独立写：正文成功、账本失败时若只吞掉异常，
 * 那一段字数就**永久少计**，且用户与管理员都看不出来。这里把失败增量留队，
 * 下一次记账或每次排行上报前补记；补记仍失败就继续留队，不丢。
 * 🔴 队列只存 projectId + 增量，不含正文/标题；随本机数据走，不跨设备。
 */
function pendingKey(): string {
  const id = typeof window === 'undefined' ? '' : (window as unknown as { __YFE_USER__?: { id?: string } }).__YFE_USER__?.id || ''
  return `yfe.community.rankPending${id ? `:${encodeURIComponent(id)}` : ''}`
}

interface PendingDelta { projectId: string; delta: number; at: number }

function readPending(): PendingDelta[] {
  try {
    const raw = localStorage.getItem(pendingKey())
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is PendingDelta => !!x && typeof x.projectId === 'string' && typeof x.delta === 'number')
  } catch { return [] }
}

function writePending(list: PendingDelta[]): void {
  try {
    if (!list.length) localStorage.removeItem(pendingKey())
    else localStorage.setItem(pendingKey(), JSON.stringify(list.slice(-500)))
  } catch { /* 忽略：配额满时退化为内存丢失，下次仍会尽力补 */ }
}

function enqueuePending(projectId: string, delta: number, at: number): void {
  const list = readPending()
  // 同项目同日多次失败可合并，避免队列无限增长
  const last = list[list.length - 1]
  if (last && last.projectId === projectId && last.at === at) last.delta += delta
  else list.push({ projectId, delta, at })
  writePending(list)
}

/** 待补记的增量条数（设置页/诊断展示用） */
export function pendingRankDeltaCount(): number {
  return readPending().length
}

/** 补记失败留下的增量；返回成功补记的条数 */
export async function flushPendingRankDeltas(): Promise<number> {
  const run = chain.then(() => flushPendingNow())
  chain = run.then(() => undefined, () => undefined)
  return run
}

async function flushPendingNow(): Promise<number> {
  const list = readPending()
  if (!list.length) return 0
  const remain: PendingDelta[] = []
  let done = 0
  for (const item of list) {
    try {
      await writeDelta(item.projectId, item.delta, undefined, item.at)
      done++
    } catch {
      remain.push(item)
    }
  }
  writePending(remain)
  return done
}

export function recordRankDelta(projectId: string, delta: number, owner?: OwnedOperation): Promise<void> {
  if (!projectId || !delta) return Promise.resolve()
  if (rankSuppressed()) return Promise.resolve()
  const at = Date.now()
  const run = chain.then(async () => {
    try {
      await writeDelta(projectId, delta, owner, at)
      // Both normal writes and compensation share the same queue.
      await flushPendingNow()
    } catch (e) {
      enqueuePending(projectId, delta, at)
      throw e
    }
  })
  chain = run.then(() => undefined, () => undefined)
  return run
}

async function writeDelta(projectId: string, delta: number, owner?: OwnedOperation, at = Date.now()): Promise<void> {
  const date = cnDateKey(at)
  const key = RANK_LEDGER_PREFIX + date
  const prev = await getSettingFor<RankLedgerRow | null>(projectId, key, null, owner)
  const next = applyLedgerDelta(prev, delta, date, at)
  await setSettingFor(projectId, key, next, owner)
}

/** 删除章节/卷导致的正文净减少（按被删内容的含标点字数记负） */
export function recordChapterDeleted(projectId: string, content: string | undefined, owner?: OwnedOperation): Promise<void> {
  const words = countWordsWithPunct(content || '')
  if (!words) return Promise.resolve()
  return recordRankDelta(projectId, -words, owner)
}

/** 读某项目全部账本行（按日期升序） */
export async function readLedger(projectId: string): Promise<RankLedgerRow[]> {
  if (!projectId) return []
  const map = await getSettingsByPrefix<RankLedgerRow>(projectId, RANK_LEDGER_PREFIX)
  const out: RankLedgerRow[] = []
  for (const [date, row] of map) {
    if (!row || typeof row.net !== 'number') continue
    out.push({
      date: typeof row.date === 'string' ? row.date : date,
      net: Number(row.net) || 0,
      seq: Number(row.seq) || 0,
      updatedAt: Number(row.updatedAt) || 0,
      events: Array.isArray(row.events) ? row.events.filter((e) => Number.isFinite(e?.at) && Number.isFinite(e?.delta)) : undefined,
      eventsFrom: typeof row.eventsFrom === 'number' ? row.eventsFrom : undefined,
    })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/** 只取某天之后的账本行（开启排行那天起算，历史不自动上传） */
export function ledgerSince(rows: RankLedgerRow[], fromDate: string): RankLedgerRow[] {
  return rows.filter((r) => r.date >= fromDate)
}

/** 本地合计（设置页展示「本次已记录」用；展示值最低 0） */
export function summarizeLedger(rows: RankLedgerRow[], fromDate?: string): { total: number; days: number; negative: number } {
  const list = fromDate ? ledgerSince(rows, fromDate) : rows
  let total = 0
  let negative = 0
  for (const r of list) {
    total += r.net
    if (r.net < 0) negative += r.net
  }
  return { total: Math.max(0, total), days: list.length, negative }
}
