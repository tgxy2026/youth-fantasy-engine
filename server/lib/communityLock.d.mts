// 3.5.2 · 协作式备份锁的最小类型声明（真源是 communityLock.mjs）
export function communityLockPath(root: string): string
export function readCommunityLock(root: string): {
  pid: number
  at: number
  tool: string
  raw: string
  malformed?: boolean
} | null
export function acquireCommunityLock(root: string, opts?: { now?: number; pid?: number; tool?: string }): {
  ok: boolean
  code?: string
  lock?: any
  error?: string
}
export function releaseCommunityLock(root: string, opts?: { pid?: number }): { ok: boolean; released?: boolean; code?: string; error?: string; lock?: any }
export function isCommunityLocked(root: string): boolean
export function assertServiceStartable(root: string): void
export function unlockStaleCommunityLock(root: string, opts?: { confirm?: boolean }): { ok: boolean; released?: boolean; code?: string; error?: string; lock?: any }