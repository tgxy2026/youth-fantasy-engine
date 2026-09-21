/**
 * 自动备份引擎（v1.3 备份策略加固）
 * - 打开并使用项目时，每 5 分钟滚动保存一次全量数据（最多 30 份，#012）。
 * - 每天首次打开项目，自动生成一份「每日备份」（最多 30 份，超出后最早的一份会被自动淘汰）。
 * 由 App 在打开项目时调用 startAutoBackup / ensureDailyBackup，退出时 stop。
 */
import * as db from './db'
import { DESKTOP, flushDesktop, getDesktopState } from './desktop'
import { todayKey } from './date'

const FIVE_MIN = 5 * 60 * 1000

/**
 * 最近一次备份失败的记录。
 *
 * 🔴 为什么要有它：备份失败原本只 `console.warn`，用户毫不知情 ——
 *   他会以为「每 5 分钟一份、留 30 份」还在保护他，而实际上可能一份都没存成功
 *   （磁盘满、数据文件被设为只读、桌面版写盘失败…）。等到真要恢复数据时才发现没有。
 *   这与本项目的总原则一致：**绝不静默失败**。
 *
 * 🔴 为什么 lib 不直接弹 toast：`showToast` 住在 `components/dialogs`，
 *   从 lib 反向依赖 components 会撞 importCycles 闸。故此处只记录，由 UI 层取走展示。
 */
export interface BackupFailure {
  at: number
  kind: 'daily' | 'auto5min'
  message: string
}

let lastFailure: BackupFailure | null = null

function recordFailure(kind: BackupFailure['kind'], e: unknown): void {
  const message = e instanceof Error ? e.message : String(e)
  lastFailure = { at: Date.now(), kind, message }
  console.warn(`[backup] ${kind === 'daily' ? '每日备份' : '自动备份'}失败`, e)
}

/**
 * 取走最近一次备份失败（**取走即清空**，保证同一条只提示一次）；没有则返回 null。
 * 由 App 定时轮询调用。
 */
export function takeBackupFailure(): BackupFailure | null {
  const f = lastFailure
  lastFailure = null
  return f
}

/** 上一次已经报过的写盘错误 —— 同一个错误只提示一次，避免备份提醒反复弹 */
let lastSeenWriteError = ''

/**
 * 确认这次备份**真的落盘了**。
 *
 * 🔴 为什么不能只看 `createAutoBackup` 抛不抛（2026-09-19 六维审计 P2-1）：
 *    它内部只做 `ops.put('backups', rec)` —— 那是**内存写**，真正的磁盘写在随后的防抖 flush 里。
 *    于是「磁盘满 / 数据文件只读 / 写盘失败」**全都不会让它抛**，失败只体现在 desktop 的
 *    lastError 上 → `takeBackupFailure()` 永远返回 null：用户以为「每 5 分钟一份、留 30 份」
 *    还在保护他，实际上可能一份都没写进磁盘。
 */
async function checkBackupLanded(kind: BackupFailure['kind']): Promise<void> {
  if (!DESKTOP) return // 浏览器 / 便携版没有独立数据文件，写盘由存储层自己负责
  try {
    await flushDesktop()
  } catch (e) {
    recordFailure(kind, e)
    return
  }
  const st = getDesktopState()
  const err = st.writeLocked
    ? (st.writeLockReason || '数据文件当前不可读，写盘已锁定')
    : (st.lastError || '')
  if (err && err !== lastSeenWriteError) {
    lastSeenWriteError = err
    recordFailure(kind, new Error(err))
  }
}

/** 今天是否已存在「每日备份」 */
async function hasDailyBackupToday(projectId: string): Promise<boolean> {
  const all = await db.listBackups(projectId)
  return all.some(b => b.kind === 'daily' && todayKey(new Date(b.createdAt)) === todayKey())
}

/** 每天首次打开：生成一份每日备份（已存在则跳过） */
export async function ensureDailyBackup(projectId: string): Promise<void> {
  try {
    if (await hasDailyBackupToday(projectId)) return
    await db.createAutoBackup(projectId, 'daily', `每日自动备份 ${todayKey()}`)
    await checkBackupLanded('daily')
  } catch (e) {
    // 备份失败不应阻断用户写作 —— 但也不许「闷声失败」：记录下来由 App 提示作者
    recordFailure('daily', e)
  }
}

/** 启动自动备份：立即不打扰，仅按 5 分钟间隔滚动；返回 stop 函数 */
export function startAutoBackup(projectId: string): () => void {
  const tick = async () => {
    try {
      await db.createAutoBackup(projectId, 'auto5min')
      // 内存写成功不等于落盘成功 —— 见 checkBackupLanded 的说明
      await checkBackupLanded('auto5min')
    } catch (e) {
      // 同上：不阻断写作，但必须留痕给界面
      recordFailure('auto5min', e)
    }
  }
  const timer = setInterval(tick, FIVE_MIN)
  return () => clearInterval(timer)
}
