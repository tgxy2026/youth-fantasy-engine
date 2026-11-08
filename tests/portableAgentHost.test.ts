// 便携版 Agent 宿主 · 隔离集成测试（3.4.3）
//
// 启动真实 `scripts/portable-server.mjs`（临时根目录，绝不读真实作品数据），验证：
//   ① 页面端点必须带同源页面头；
//   ② `/api/agent` 由便携服务转发给页面队列（页面领取 → 回传 → 调用方拿到结果）；
//   ③ Agent 桥走宿主独立端口 + Bearer token；
//   ④ 未开启连接时失败关闭；开启后可调用；requestId 幂等。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-portable-agent-'))
fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<!doctype html><html><head></head><body>ok</body></html>', 'utf8')

const child = spawn(process.execPath, ['scripts/portable-server.mjs', '--no-open', '--root', tmp], {
  cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
let output = ''
child.stdout.on('data', d => { output += String(d) })
child.stderr.on('data', d => { output += String(d) })

const pageHeader = { 'x-yfe-agent-page': '1', 'sec-fetch-site': 'same-origin' }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitPort(): Promise<string> {
  const lock = path.join(tmp, 'data', '.port')
  for (let i = 0; i < 100; i++) {
    try {
      const port = Number(fs.readFileSync(lock, 'utf8').trim())
      if (port) return `http://127.0.0.1:${port}`
    } catch { /* 还没写锁 */ }
    await sleep(100)
  }
  throw new Error('便携服务未在 10 秒内启动：' + output.slice(-2000))
}

async function waitHostFile(): Promise<{ port: number; token: number | string }> {
  const file = path.join(tmp, 'data', 'agent-host.json')
  for (let i = 0; i < 100; i++) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw && raw.port > 0 && typeof raw.token === 'string') return raw
    } catch { /* 还没写入 */ }
    await sleep(100)
  }
  throw new Error('便携 Agent 宿主未在 10 秒内写入配置：' + output.slice(-2000))
}

async function main() {
  const base = await waitPort()
  const hostConfig = await waitHostFile() as { port: number; token: string }

  const ping = await fetch(base + '/api/ping')
  ok('便携服务正常启动', ping.ok)

  const noHeader = await fetch(base + '/api/agent/status')
  ok('缺页面头的页面端点被拒（403）', noHeader.status === 403, String(noHeader.status))

  const status = await fetch(base + '/api/agent/status', { headers: pageHeader })
  const statusBody = await status.json() as { running?: boolean; enabled?: boolean }
  ok('同源页面可读宿主状态', status.ok && statusBody.running === true && statusBody.enabled === false, JSON.stringify(statusBody))

  const agentBase = `http://127.0.0.1:${hostConfig.port}`
  const call = (requestId: string) => fetch(agentBase + '/api/agent/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostConfig.token}` },
    body: JSON.stringify({ call: { sessionId: 'portable-test', requestId, tool: 'yfe_list_projects', args: {} } }),
  }).then(r => r.json()) as Promise<{ ok: boolean; code?: string; result?: { ok: boolean; value?: unknown } }>

  const disabled = await call('req-portable-01')
  ok('未开启连接 → HOST_DISABLED', disabled.ok === false && disabled.code === 'HOST_DISABLED', JSON.stringify(disabled))

  const configured = await fetch(base + '/api/agent/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...pageHeader },
    body: JSON.stringify({ enabled: true, scope: { projects: [] } }),
  }).then(r => r.json()) as { ok: boolean; status?: { enabled?: boolean } }
  ok('同源页面可开启连接', configured.ok === true && configured.status?.enabled === true, JSON.stringify(configured))

  // 页面领取 → 回传 → 调用方拿到结果（真实走一遍便携队列）
  const pending = call('req-portable-02')
  let claimed = null
  for (let i = 0; i < 50 && !claimed; i++) {
    const next = await fetch(base + '/api/agent/next?clientId=page-1', { headers: pageHeader }).then(r => r.json()) as { request?: { id: string; payload: unknown } | null }
    if (next.request) claimed = next.request
    else await sleep(50)
  }
  ok('页面可以领取宿主任务', !!claimed, JSON.stringify(claimed))
  assert.ok(claimed)
  const returned = await fetch(base + '/api/agent/result', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...pageHeader },
    body: JSON.stringify({ clientId: 'page-1', id: claimed.id, result: { ok: true, value: { projects: [{ id: 'synthetic' }] } } }),
  }).then(r => r.json()) as { ok: boolean }
  ok('页面回传结果被接收', returned.ok === true, JSON.stringify(returned))
  const final = await pending
  ok('调用方拿到页面执行结果', final.ok === true && final.result?.ok === true, JSON.stringify(final))

  // requestId 幂等（重放不再进队列）
  const replay = await call('req-portable-02')
  ok('相同 requestId 重放不重复执行', replay.ok === true, JSON.stringify(replay))

  console.log(`\nPORTABLE_AGENT_RESULTS {"planned":${pass + fail},"passed":${pass},"failed":${fail}}`)
  if (fail > 0) process.exitCode = 1
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  child.kill()
  try {
    const resolved = fs.realpathSync(tmp)
    if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith('yfe-portable-agent-')) {
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  } catch { /* 清理失败不影响结果 */ }
})