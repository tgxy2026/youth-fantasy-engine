// ============ 社区备份/恢复的协作式停写锁（3.5.2 · P0-R3） ============
//
// 🔴 这是**协作锁**，不是操作系统级互斥，也不是热备：
//   · 只有使用本仓库 store/API 的进程会检查它；
//   · 外部进程直接写 JSON 文件不会被阻止（只能靠读取前后 stat 检测）；
//   · 备份/恢复仍要求停服务窗口；锁用于阻止服务启动与经 API 的写入，
//     并让锁冲突显式失败，而不是把「人工确认 + stat 比较」说成可靠锁。
//
// 锁文件：`<community>.backup.lock`（与社区目录同级，避免恢复 rename 时被带走）。
// 崩溃残留锁不自动删除；需要 `community-backup unlock --confirm-stale` 人工核对。

import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'

export function communityLockPath(root) {
  return `${root}.backup.lock`
}

export function readCommunityLock(root) {
  const file = communityLockPath(root)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf8')
    const value = JSON.parse(raw)
    return {
      pid: Number(value?.pid) || 0,
      at: Number(value?.at) || 0,
      tool: String(value?.tool || ''),
      raw,
    }
  } catch {
    return { pid: 0, at: 0, tool: '', raw: '', malformed: true }
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = 进程存在但无权限发信号；ESRCH = 不存在
    return e && e.code === 'EPERM'
  }
}

/**
 * 获取独占锁。成功返回 ok:true；已有锁时绝不自动删除。
 * @returns {{ok:true, lock:object}|{ok:false, code:string, lock?:object, error?:string}}
 */
export function acquireCommunityLock(root, { now = Date.now(), pid = process.pid, tool = 'backup' } = {}) {
  if (!root) return { ok: false, code: 'NO_ROOT', error: '缺少 root' }
  const file = communityLockPath(root)
  try {
    if (existsSync(file) && statSync(file).isDirectory()) {
      return { ok: false, code: 'LOCK_FAILED', error: '锁路径被目录占用，拒绝把锁状态当成可用' }
    }
  } catch { /* 继续尝试独占创建，失败会走下面的错误分支 */ }
  try {
    const fd = openSync(file, 'wx')
    try { writeSync(fd, JSON.stringify({ pid, at: now, tool })) } finally { closeSync(fd) }
    return { ok: true, lock: { pid, at: now, tool } }
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      const lock = readCommunityLock(root)
      if (lock && lock.malformed) return { ok: false, code: 'LOCK_EXISTS_UNREADABLE', lock }
      if (lock && processAlive(lock.pid)) return { ok: false, code: 'LOCKED', lock }
      return { ok: false, code: 'STALE_LOCK', lock }
    }
    return { ok: false, code: 'LOCK_FAILED', error: e instanceof Error ? e.message : String(e) }
  }
}

/** 只释放自己持有的锁，避免误删其他进程的锁 */
export function releaseCommunityLock(root, { pid = process.pid } = {}) {
  const lock = readCommunityLock(root)
  if (!lock) return { ok: true, released: false }
  if (lock.pid !== pid) return { ok: false, code: 'LOCK_OWNED_BY_OTHER', lock }
  try { unlinkSync(communityLockPath(root)); return { ok: true, released: true } }
  catch (e) { return { ok: false, code: 'UNLOCK_FAILED', error: e instanceof Error ? e.message : String(e) } }
}

export function isCommunityLocked(root) {
  return existsSync(communityLockPath(root))
}

/** 服务启动前检查：任何锁（包括疑似残留）都阻止启动，等待人工核对 */
export function assertServiceStartable(root) {
  if (!isCommunityLocked(root)) return
  const lock = readCommunityLock(root)
  const e = new Error(
    lock?.malformed
      ? '社区备份锁不可读，拒绝启动；请核对锁文件后使用 `node server/community-backup.mjs unlock --confirm-stale`'
      : `社区备份/恢复锁存在（pid ${lock?.pid || '?'}，工具 ${lock?.tool || '?'}），拒绝启动；确认无进程后使用 unlock 命令`,
  )
  e.code = 'COMMUNITY_BACKUP_LOCKED'
  throw e
}

/** 人工清理残留锁：必须显式确认，且持有进程已不存在 */
export function unlockStaleCommunityLock(root, { confirm = false } = {}) {
  if (!confirm) return { ok: false, code: 'CONFIRM_REQUIRED', error: '必须确认残留锁对应的进程已不存在，才能清理' }
  const lock = readCommunityLock(root)
  if (!lock) return { ok: true, released: false }
  if (lock.malformed) return { ok: false, code: 'LOCK_UNREADABLE', error: '锁文件不可读，请人工核对后删除' }
  if (processAlive(lock.pid)) return { ok: false, code: 'LOCK_OWNER_ALIVE', lock, error: '锁仍由存活进程持有，拒绝清理' }
  try { unlinkSync(communityLockPath(root)); return { ok: true, released: true, lock } }
  catch (e) { return { ok: false, code: 'UNLOCK_FAILED', error: e instanceof Error ? e.message : String(e) } }
}