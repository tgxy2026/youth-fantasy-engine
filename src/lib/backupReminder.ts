/**
 * 「导出备份」提醒的节流状态（#031）
 *
 * 设计要点：
 * - 只记「上次导出备份的时间戳」，不记「上次关闭弹窗的时间」。
 *   因为本提醒的判据是「你有多久没把数据导出到外部文件了」，而不是「你有多久没被烦过」。
 *   若把「稍后再说」也记成已备份，用户点几次就不再提醒，提醒就失去意义了 ——
 *   所以两者分开记：真正的导出更新 LAST_BACKUP_KEY；「稍后再说」只更新 DISMISS_KEY（间隔更短）。
 * - 存 localStorage 而非数据库：这是纯 UI 偏好，且数据库本身可能损坏/被清空，
 *   把提醒状态存进数据库等于「提醒跟着数据一起消失」，恰恰是本提醒要防的场景。
 */
const LAST_BACKUP_KEY = 'yfe-last-export-at'
const DISMISS_KEY = 'yfe-backup-remind-dismiss-at'

/** 距上次导出超过该天数 → 提醒（判据：导出备份，而非开关软件） */
export const REMIND_AFTER_DAYS = 7
/**
 * 点了「稍后再说」后的静默天数。
 * 刻意与 REMIND_AFTER_DAYS 同为 7：保证「每周最多打扰一次」，不会因用户反复点「稍后」
 * 而变成三天一弹的骚扰（数据安全重要，但弹窗惹人烦会直接反噬口碑）。
 * 两者分开记是为了语义诚实：导出记录的是「真备份过」，稍后记录的是「只是这会儿不想看」。
 */
const DISMISS_DAYS = 7

const DAY = 24 * 60 * 60 * 1000

function read(key: string): number {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? v : 0
  } catch {
    // 隐私模式 / 存储被禁用时读不到：按「从未导出」处理，照常提醒，不静默吞掉
    return 0
  }
}

function write(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    /* 存储不可用时忽略：下次启动仍会提醒，不会误判为已备份 */
  }
}

/** 用户真正导出了一份备份文件时调用（App 侧栏导出、项目管理页导出、备份管理导出均调用） */
export function markExported(): void {
  write(LAST_BACKUP_KEY, Date.now())
}

/** 点了「稍后再说」时调用：只短期静默，不代表已备份 */
export function markDismissed(): void {
  write(DISMISS_KEY, Date.now())
}

/** 距上次导出是否已超过提醒间隔；从未导出过返回 true */
export function isExportOverdue(): boolean {
  const last = read(LAST_BACKUP_KEY)
  if (!last) return true
  return Date.now() - last > REMIND_AFTER_DAYS * DAY
}

/** 「稍后再说」的静默期是否已过 */
export function isDismissExpired(): boolean {
  const at = read(DISMISS_KEY)
  if (!at) return true
  return Date.now() - at > DISMISS_DAYS * DAY
}
