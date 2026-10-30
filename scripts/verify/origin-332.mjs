// P1-10 · 写请求同源校验（CSRF/Origin 防护）· 端到端自检
//
// 盯四件事：
//   ① 同源 Origin 的写请求照常通过；
//   ② 跨源 Origin / Referer 的写请求一律 403；
//   ③ 带 Authorization: Bearer 的请求不受 Origin 限制（桌面客户端，无 CSRF 面）；
//   ④ GET 不做同源校验（不改状态）。
//
// 用法：node scripts/verify/origin-332.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverEntry = path.resolve(here, '../../server/index.mjs')

const PORT = 18741
const root = mkdtempSync(path.join(os.tmpdir(), 'yfe-origin-'))
const dataDir = path.join(root, 'data')
const wwwDir = path.join(root, 'www')
mkdirSync(dataDir, { recursive: true })
mkdirSync(wwwDir, { recursive: true })
writeFileSync(path.join(wwwDir, 'index.html'), '<!doctype html><title>fixture</title>')

const base = `http://127.0.0.1:${PORT}`
let passed = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) { passed++; console.log('PASS ' + name) }
  else { fails.push({ name, extra }); console.log('FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')) }
}

const server = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT), YFE_DATA: dataDir, YFE_WWW: wwwDir,
    YFE_REGISTER: 'open', YFE_STATS: path.join(root, 'stats.log'),
    YFE_BOOTSTRAP_INVITE: 'ORIGIN-INVITE-332',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (d) => { log += d })
server.stderr.on('data', (d) => { log += d })
const cleanup = () => {
  try { server.kill('SIGKILL') } catch { /* ignore */ }
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
}
process.on('exit', cleanup)

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/ping')).ok) return true } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

try {
  if (!(await waitReady())) throw new Error('服务未启动：\n' + log)

  // 注册（无 Origin / Referer ⇒ 放行）
  const reg = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '来源用户', password: 'pass1234' }),
  })
  const cookie = (reg.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('yfe_sid=')) || ''
  ok('注册（无 Origin）照常通过', reg.status === 200 && !!cookie, reg.status)

  const write = (headers) => fetch(base + '/api/v2/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, ...headers },
    body: JSON.stringify({ name: '来源测试' }),
  })

  // ① 同源
  const same = await write({ origin: base })
  ok('同源 Origin 的写请求通过', same.status === 200, same.status)

  // ② 跨源
  const cross = await write({ origin: 'https://evil.example' })
  ok('跨源 Origin 的写请求 403', cross.status === 403, cross.status)

  const crossRef = await write({ referer: 'https://evil.example/page' })
  ok('跨源 Referer 的写请求 403', crossRef.status === 403, crossRef.status)

  const nullOrigin = await write({ origin: 'null' })
  ok('Origin: null 也被拒', nullOrigin.status === 403, nullOrigin.status)

  // ③ Bearer 不受限（无效令牌 → 401，而不是 403）
  const bearer = await fetch(base + '/api/v2/projects', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://evil.example',
      authorization: 'Bearer not-a-real-token',
    },
    body: JSON.stringify({ name: '桌面代发' }),
  })
  ok('Bearer 请求不受 Origin 限制（401 而非 403）', bearer.status === 401, bearer.status)

  // ④ GET 不做同源校验
  const getCross = await fetch(base + '/api/v2/projects', {
    headers: { cookie, origin: 'https://evil.example' },
  })
  ok('GET 跨源不做同源拦截', getCross.status === 200, getCross.status)
} catch (e) {
  fails.push({ name: '未预期异常', extra: e instanceof Error ? e.message : String(e) })
  console.log('FAIL 未预期异常 — ' + (e instanceof Error ? e.message : String(e)))
} finally {
  cleanup()
}

console.log('')
if (fails.length) {
  console.log(`FAILED ${fails.length} / ${passed + fails.length}`)
  console.log(JSON.stringify(fails, null, 2))
  if (log) console.log('--- server log ---\n' + log.slice(-2500))
  process.exit(1)
}
console.log(`OK ${passed}/${passed}（${new Date().toISOString()}，Node ${process.version}）`)
process.exit(0)