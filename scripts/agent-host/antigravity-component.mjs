import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'

const version = '1.5.0'
const archiveURL = 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.5.0-windows-x86_64.zip'
const archiveSHA256 = '6163f6b59b381bae419652dbae167bc8cda0ef29d665c0ba8af3d8c7fddd8867'
const files = {
  'agy_acp_server.exe': '209a30dee3f67fbb62710263d38323dc0d66b71b5121eb37ea80b63383dd178a',
  'localharness_external.exe': '4e3644c05a601fd8da1cc9e72639e857d3a7c78f3d2cdf48ea7805ce4a3263ab',
}

export function createAntigravityComponent(root) {
  const destination = path.join(root, version)
  async function verify(directory) {
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Antigravity 组件目录不能是链接。')
    for (const [name, expected] of Object.entries(files)) {
      const file = path.join(directory, name)
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 200 * 1024 * 1024) throw new Error('Antigravity 组件文件无效。')
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(file)) hash.update(chunk)
      if (hash.digest('hex') !== expected) throw new Error('Antigravity 组件摘要不匹配。')
    }
    return path.join(directory, 'agy_acp_server.exe')
  }

  return {
    version,
    async resolve(binary) {
      if (typeof binary !== 'string' || !path.isAbsolute(binary) || path.basename(binary).toLowerCase() !== 'agy_acp_server.exe') {
        throw new Error('请先安装并校验 Antigravity 官方组件。')
      }
      return verify(path.dirname(binary))
    },
    async status() {
      try { return { version, installed: !!await verify(destination) } }
      catch { return { version, installed: false } }
    },
    async install(signal) {
      signal.throwIfAborted()
      const installed = await verify(destination).catch(error => {
        if (error?.code !== 'ENOENT') throw error
        return null
      })
      if (installed) return installed
      await fs.mkdir(root, { recursive: true })
      if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Antigravity 安装目录不能是链接。')
      const staging = await fs.mkdtemp(path.join(root, 'install-'))
      try {
        const archive = path.join(staging, 'component.zip')
        const extracted = path.join(staging, 'verified')
        const response = await fetch(archiveURL, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) })
        if (!response.ok || !response.body) throw new Error('无法下载 Google 官方 Antigravity 组件。')
        const hash = createHash('sha256')
        let bytes = 0
        const count = new Transform({
          transform(chunk, _encoding, callback) {
            bytes += chunk.length
            if (bytes > 230 * 1024 * 1024) { callback(new Error('Antigravity 下载超过大小限制。')); return }
            hash.update(chunk)
            callback(null, chunk)
          },
        })
        await pipeline(response.body, count, createWriteStream(archive, { flags: 'wx' }), { signal })
        if (hash.digest('hex') !== archiveSHA256) throw new Error('Antigravity 官方安装包摘要不匹配。')
        signal.throwIfAborted()
        const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        const script = fileURLToPath(new URL('./antigravity-extract.ps1', import.meta.url))
        await new Promise((resolve, reject) => {
          const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, archive, extracted], {
            windowsHide: true, stdio: 'ignore', signal, timeout: 60_000,
          })
          let failure
          child.on('error', error => { failure = error })
          child.once('close', code => {
            if (failure || code !== 0) reject(new Error('Antigravity 组件解压失败或已取消。'))
            else resolve()
          })
        })
        await verify(extracted)
        signal.throwIfAborted()
        // Windows may temporarily hold newly extracted executables open for inspection.
        for (let attempt = 0; ; attempt++) {
          try { await fs.rename(extracted, destination); break }
          catch (error) {
            if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error
            await delay(200 * (attempt + 1), undefined, { signal })
          }
        }
        return path.join(destination, 'agy_acp_server.exe')
      } finally {
        await fs.rm(staging, { recursive: true, force: true })
      }
    },
  }
}
