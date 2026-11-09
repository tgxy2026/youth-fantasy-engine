// 排他宿主锁：异常退出可能留下锁文件；不能根据 PID 猜测锁已过期并自动删除。
// 需要其他进程无权替换锁文件的本机数据目录，调用方负责限制目录权限。
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/** 读取锁文件的归属信息；不存在返回 null。损坏时 pid 为 null，调用方必须失败关闭。 */
export async function readModeOwnerLock(file) {
  if (!path.isAbsolute(file)) throw new Error('模式锁文件必须使用绝对路径')
  let text
  try { text = await fs.readFile(file, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return { pid: null, token: null, corrupt: true }
    const pid = Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null
    return { pid, token: typeof parsed.token === 'string' ? parsed.token : null, corrupt: pid === null }
  } catch {
    return { pid: null, token: null, corrupt: true }
  }
}

/** 进程是否仍存活：ESRCH = 不存在；EPERM = 存在但无权查询，按存活处理。 */
export function isModeOwnerProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

/**
 * 把遗留锁移到证据文件而不是删除。仅允许在调用方已取得用户明确确认、
 * 且锁记录中的 pid 与用户看到的一致时使用；存活进程的锁一律拒绝。
 */
export async function quarantineModeOwnerLock(file, { confirmPid = null } = {}) {
  const current = await readModeOwnerLock(file)
  if (!current) return null
  if (current.pid === null) {
    if (confirmPid !== null) throw new Error('锁记录损坏且归属未知，请确认信息已核对')
  } else if (confirmPid !== current.pid) {
    throw new Error('锁归属已变化，拒绝重置连接锁')
  }
  if (current.pid !== null && isModeOwnerProcessAlive(current.pid)) {
    throw new Error(`另一个引擎进程（PID ${current.pid}）仍在运行，请先关闭它再恢复。`)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.stale-${stamp}`
  await fs.rename(file, target)
  return target
}

export async function acquireModeOwnerLock(file) {
  if (!path.isAbsolute(file)) throw new Error('模式锁文件必须使用绝对路径')
  const target = path.resolve(file)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const token = randomBytes(32).toString('hex')
  let handle
  try {
    handle = await fs.open(target, 'wx', 0o600)
    await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, token }) + '\n', 'utf8')
    await handle.sync()
  } catch (error) {
    // 创建或写入失败不尝试删除锁；不能判断其他进程或残留记录的归属。
    if (handle) await handle.close().catch(() => {})
    throw error
  }
  let released = false
  return {
    async release() {
      if (released) return
      const current = JSON.parse(await fs.readFile(target, 'utf8'))
      if (current?.version !== 1 || current?.token !== token) throw new Error('模式锁归属已变化，拒绝删除')
      // 应仅在宿主拒绝新任务并确认全部任务结束后调用。
      await fs.unlink(target)
      await handle.close()
      released = true
    },
  }
}
