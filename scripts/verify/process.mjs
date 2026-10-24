// Shared asynchronous process boundary. Only an explicit exit 0 is success.
import { spawn } from 'node:child_process'

export function processVerdict({ exitCode, signal = null, timedOut = false, error = null, aborted = false, outputLimit = false }) {
  const ok = exitCode === 0 && !signal && !timedOut && !error && !aborted && !outputLimit
  return { ok, code: ok ? 0 : timedOut ? -2 : aborted ? -3 : outputLimit ? -4 : Number.isInteger(exitCode) && exitCode !== 0 ? exitCode : -1 }
}

// Kill only the process tree created by this invocation, never processes by name.
function stopOwnedTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => { try { child.kill() } catch { /* already closed */ } })
    killer.unref()
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* already closed */ } }
  }
}

export async function runProcess(command, args = [], options = {}) {
  const { cwd, env = process.env, timeoutMs = 120000, signal: cancel, maxOutputChars = 16 * 1024 * 1024 } = options
  if (!(timeoutMs > 0) || !(maxOutputChars > 0)) throw new Error('timeoutMs and maxOutputChars must be positive')
  const start = Date.now()
  return new Promise(resolve => {
    let child, timer, grace, settled = false
    let stdout = '', stderr = '', error = null, timedOut = false, aborted = false, outputLimit = false
    const finish = (exitCode = null, signal = null, cleanupComplete = true) => {
      if (settled) return
      settled = true
      clearTimeout(timer); clearTimeout(grace)
      cancel?.removeEventListener('abort', abort)
      const verdict = processVerdict({ exitCode, signal, timedOut, error, aborted, outputLimit })
      resolve({ ...verdict, exitCode, signal, timedOut, aborted, outputLimit, error, stdout, stderr,
        out: stdout + stderr, pid: child?.pid ?? null, durationMs: Date.now() - start, cleanupComplete })
    }
    const stop = () => {
      stopOwnedTree(child)
      grace ??= setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref()
        finish(null, null, false)
      }, 3000)
    }
    const abort = () => { aborted = true; if (child) stop(); else finish() }
    if (cancel?.aborted) { aborted = true; finish(); return }
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { error = String(e); finish(); return }
    const collect = (key, data) => {
      const text = String(data)
      if (key === 'stdout') stdout += text; else stderr += text
      if (stdout.length + stderr.length > maxOutputChars) {
        stdout = stdout.slice(-Math.floor(maxOutputChars / 2))
        stderr = stderr.slice(-Math.floor(maxOutputChars / 2))
        outputLimit = true; stop()
      }
    }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', data => collect('stdout', data))
    child.stderr.on('data', data => collect('stderr', data))
    child.on('error', e => { error = String(e); finish() })
    child.on('close', (code, signal) => finish(code, signal))
    cancel?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    if (cancel?.aborted) abort()
  })
}
