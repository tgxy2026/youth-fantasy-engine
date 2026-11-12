// 3.5.2 · 社区备份/恢复的最小类型声明（真源是 communityBackup.mjs）
// 声明保持宽松：返回结构在运行时会随校验结果变化，测试只需读取字段。

export const COMMUNITY_FILES: readonly string[]
export const BACKUP_MANIFEST: string
export const BACKUP_FORMAT: number
export const defaultIO: Record<string, any>

export function emptyCommunityData(): Record<string, any>
export function snapshotPostVisible(post: any): boolean
export function readCommunityData(root: string, io?: Record<string, any>): {
  data: Record<string, any>
  present: string[]
  problems: string[]
}
export function validateSnapshot(data: Record<string, any>): {
  ok: boolean
  problems: string[]
  warnings: string[]
  repairs: any[]
  counts: Record<string, number>
  data: Record<string, any>
  normalized: Record<string, any>
}
export function inspectCommunity(root: string, io?: Record<string, any>): any
export function createBackup(opts: {
  root: string
  dest: string
  now?: number
  keep?: number
  io?: Record<string, any>
}): any
export function pruneOldBackups(dest: string, keep: number, io?: Record<string, any>): string[]
export function verifyBackup(dir: string, opts?: { io?: Record<string, any> }): any
export function diffVisibility(currentData: any, backupData: any): Array<{
  type: string
  postId: string
  currentStatus?: string
  backupStatus?: string
  backupVisible?: boolean
}>
export function restoreBackup(opts: {
  backupDir: string
  root: string
  now?: number
  stopConfirmed?: boolean
  acceptVisibilityChanges?: boolean
  io?: Record<string, any>
}): any