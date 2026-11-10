// ============ 码字排行榜 · 本机有符号账本（3.5.0）============
//
// 【为什么不能用 dailyStats】现有 `dailyStats` 有两个致命差异：
//   ① 口径是**不含标点**的 `wordCount` 差量，而排行榜要求含标点净增量；
//   ② `addDailyWords` 把每日累计**截到 0**（`Math.max(0, …)`），负数凭空消失 ——
//      用它算周月排行会把「昨天删了 5000 字」当成没发生。
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
// 🔴 周、月排行先把每日有符号增减相加再比较，展示值最低为 0，但负数仍参与抵扣。

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
  return {
    date,
    net: (prev?.net || 0) + delta,
    seq: (prev?.seq || 0) + 1,
    updatedAt: now,
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

export function recordRankDelta(projectId: string, delta: number, owner?: OwnedOperation): Promise<void> {
  if (!projectId || !delta) return Promise.resolve()
  if (rankSuppressed()) return Promise.resolve()
  const run = chain.then(() => writeDelta(projectId, delta, owner))
  chain = run.then(() => undefined, () => undefined)
  return run
}

async function writeDelta(projectId: string, delta: number, owner?: OwnedOperation): Promise<void> {
  const date = cnDateKey()
  const key = RANK_LEDGER_PREFIX + date
  const prev = await getSettingFor<RankLedgerRow | null>(projectId, key, null, owner)
  const next = applyLedgerDelta(prev, delta, date)
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