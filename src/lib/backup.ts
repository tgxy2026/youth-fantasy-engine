/**
 * 自动备份引擎（v1.3 备份策略加固）
 * - 打开并使用项目时，每 5 分钟滚动保存一次全量数据（最多 30 份，#012）。
 * - 每天首次打开项目，自动生成一份「每日备份」（最多 30 份，超出后最早的一份会被自动淘汰）。
 * 由 App 在打开项目时调用 startAutoBackup / ensureDailyBackup，退出时 stop。
 */
import * as db from './db'
import { todayKey } from './date'

const FIVE_MIN = 5 * 60 * 1000

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
  } catch (e) {
    // 备份失败不应阻断用户写作
    console.warn('[backup] 每日备份失败', e)
  }
}

/** 启动自动备份：立即不打扰，仅按 5 分钟间隔滚动；返回 stop 函数 */
export function startAutoBackup(projectId: string): () => void {
  const tick = async () => {
    try {
      await db.createAutoBackup(projectId, 'auto5min')
    } catch (e) {
      console.warn('[backup] 自动备份失败', e)
    }
  }
  const timer = setInterval(tick, FIVE_MIN)
  return () => clearInterval(timer)
}
