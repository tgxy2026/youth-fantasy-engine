import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const script = fileURLToPath(new URL('./acp-job.ps1', import.meta.url))
const shell = () => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const args = name => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-JobName', name]
const parentStarted = Math.round(Date.now() - process.uptime() * 1000)

export function windowsJobName(runId) {
  if (!/^[a-f0-9]{32}$/.test(runId)) throw new Error('ACP Windows 运行标记损坏。')
  return `Global\\YFE-ACP-${runId}`
}

function exitOf(child) {
  let failure = null
  child.on('error', error => { failure = error })
  return new Promise(resolve => child.once('close', code => resolve({ code, failure })))
}

export async function verifyWindowsJobGone(runId) {
  const name = windowsJobName(runId)
  for (let attempt = 0; attempt < 3; attempt++) {
    const check = spawn(shell(), [...args(name), '-Check'], { windowsHide: true, stdio: 'ignore', timeout: 7000 })
    const { code, failure } = await exitOf(check)
    if (code === 0 && !failure) return
    if (code !== 3 || failure) break
    await delay(100)
  }
  throw new Error('无法确认 ACP Windows 进程树已退出。')
}

export function launchWindowsAcpJob({ runId, binary, cwd, env, childArguments = '', sandbox, onStderr }) {
  const name = windowsJobName(runId)
  const identity = sandbox ? [
    '-SandboxUser', sandbox.user, '-SandboxSid', sandbox.sid, '-SandboxCredentialFile', sandbox.credentialFile,
  ] : []
  const child = spawn(shell(), [...args(name), '-HostPid', String(process.pid), '-HostStarted', String(parentStarted),
    '-Binary', binary, '-WorkingDirectory', cwd, ...(childArguments ? ['-ChildArguments', childArguments] : []), ...identity], {
    cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.on('data', chunk => onStderr?.(chunk))
  const exited = exitOf(child)
  return {
    input: child.stdin, output: child.stdout, exited,
    async stop() {
      child.kill()
      let timer
      try {
        await Promise.race([exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('ACP Windows 启动器退出超时。')), 4000)
        })])
      } finally { clearTimeout(timer) }
      await verifyWindowsJobGone(runId)
    },
  }
}
