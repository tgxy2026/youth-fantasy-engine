import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const script = fileURLToPath(new URL('./acp-sandbox.ps1', import.meta.url))
const windows = process.env.SystemRoot ?? 'C:\\Windows'
const shell = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

export function createAcpSandbox(root) {
  const vault = path.join(root, 'windows-isolation')
  const credentialFile = path.join(vault, 'identity.json')
  const run = (action, args = [], options = {}) => exec(shell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Action', action, '-Vault', vault, ...args,
  ], { windowsHide: true, maxBuffer: 16_384, ...options })

  async function configured() {
    try {
      const directory = await fs.lstat(vault)
      if (!directory.isDirectory() || directory.isSymbolicLink()) return false
      const stat = await fs.lstat(credentialFile)
      return stat.isFile() && !stat.isSymbolicLink()
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }

  return {
    configured,
    async setup(signal) {
      signal.throwIfAborted()
      await fs.mkdir(vault, { recursive: true })
      const realRoot = await fs.realpath(root)
      if ((await fs.realpath(vault)).toLowerCase() !== path.join(realRoot, 'windows-isolation').toLowerCase()) {
        throw new Error('Windows ACP 凭据目录不能使用链接。')
      }
      try {
        // Keep the operation leased until the UAC broker returns, even if the UI cancels.
        await run('Setup')
      } catch {
        throw new Error('Windows 隔离账户开通失败。请在 UAC 中使用当前 Windows 管理员账户批准后重试。')
      }
      signal.throwIfAborted()
      if (!(await configured())) throw new Error('无法确认 Windows ACP 隔离账户已开通。')
    },
    async prepare({ profile, cwd, temp, component, signal }) {
      if (!(await configured())) throw new Error('请先在「ACP 连接」开通 Windows 隔离，再连接 Agent。')
      try {
        const { stdout } = await run('Prepare', [
          '-Profile', profile, '-Work', cwd, '-Temp', temp, '-Component', component,
        ], { signal, timeout: 15_000 })
        const { user, sid } = JSON.parse(stdout)
        if (!/^YFEACP-[a-f0-9]{10}$/.test(user) || !/^S-1-5-21-(?:\d+-){3}\d+$/.test(sid)) throw new Error()
        return { user, sid, identityFile: credentialFile }
      } catch {
        signal.throwIfAborted()
        throw new Error('无法核对 Windows ACP 隔离账户或目录权限，请检查账户状态与组件位置。')
      }
    },
  }
}
