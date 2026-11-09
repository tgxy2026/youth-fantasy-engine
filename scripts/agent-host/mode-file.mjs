// 互斥模式记录的本机持久化适配器；调用方必须保证只有一个宿主管理此文件。
// 本模块不提供跨进程锁，也不执行初始化、迁移或模式切换。
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export function createModeFilePersistence(file) {
  if (!path.isAbsolute(file)) throw new Error('模式状态文件必须使用绝对路径')
  const target = path.resolve(file)
  return {
    async read() {
      // ENOENT 与 JSON 损坏均向上抛出，不伪装成默认 API 模式。
      const text = await fs.readFile(target, 'utf8')
      return JSON.parse(text)
    },
    /** 仅在文件从未存在时初始化；绝不覆盖损坏或中断的记录。 */
    async initialize(mode) {
      if (mode !== 'api' && mode !== 'agent') throw new Error('初始模式无效')
      await fs.mkdir(path.dirname(target), { recursive: true })
      const handle = await fs.open(target, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ version: 1, phase: 'stable', mode }) + '\n', 'utf8')
        await handle.sync()
      } finally { await handle.close() }
    },
    /** 兼容旧调用点：显式初始化为 API 模式。 */
    async initializeApi() { return this.initialize('api') },
    async write(value) {
      const serialized = JSON.stringify(value)
      if (typeof serialized !== 'string') throw new Error('模式状态无法序列化')
      await fs.mkdir(path.dirname(target), { recursive: true })
      const temporary = `${target}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`
      let handle
      let created = false
      try {
        handle = await fs.open(temporary, 'wx', 0o600)
        created = true
        await handle.writeFile(serialized + '\n', 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await fs.rename(temporary, target)
      } catch (error) {
        if (handle) await handle.close().catch(() => {})
        // 仅清理本次新建的唯一临时文件，不触碰旧模式记录或其他运行证据。
        if (created) await fs.unlink(temporary).catch(() => {})
        throw error
      }
    },
  }
}
