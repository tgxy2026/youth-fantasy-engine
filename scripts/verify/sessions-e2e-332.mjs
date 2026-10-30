// P1 · 多会话端到端自检（起一个真实 HTTP 服务，数据目录在临时目录，不碰真实账号）
//
// 用法：node scripts/verify/sessions-e2e-332.mjs
// 退出码 0 = 全部通过。
//
// 为什么要起真服务而不是只测纯函数：
//   · 「两台设备同时在线」这件事只有在真实 Cookie 与真实 users.json 上才算数；
//   · 旧实现是单会话（新登录顶掉旧设备），这条自检正是把那个行为反转掉之后的第一份证据。
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverEntry = path.resolve(here, '../../server/index.mjs')

const PORT = 18732
const root = mkdtempSync(path.join(os.tmpdir(), 'yfe-sessions-e2e-'))
const dataDir = path.join(root, 'data')
const wwwDir = path.join(root, 'www')
mkdirSync(dataDir, { recursive: true })
mkdirSync(wwwDir, { recursive: true })
writeFileSync(path.join(wwwDir, 'index.html'), '<!doctype html><title>fixture</title>')

const base = `http://127.0.0.1:${PORT}`
let passed = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('PASS ' + name) }
  else { fails.push({ name, extra }); console.log('FAIL ' + name + (extra ? ' — ' + JSON.stringify(extra) : '')) }
}

/** 极简 cookie jar：每个「设备」一个 */
function device() {
  return {
    cookie: '',
    async req(method, url, body) {
      const headers = { 'content-type': 'application/json' }
      if (this.cookie) headers.cookie = this.cookie
      const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined })
      const set = r.headers.getSetCookie?.() || []
      for (const c of set) {
        const [pair] = c.split(';')
        const key = pair.split('=')[0]
        if (key !== 'yfe_sid') continue
        const val = pair.slice(pair.indexOf('=') + 1)
        this.cookie = val ? `yfe_sid=${val}` : ''
      }
      let json = null
      try { json = await r.json() } catch { /* 可能是 HTML */ }
      return { status: r.status, json }
    },
  }
}

const server = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    YFE_DATA: dataDir,
    YFE_WWW: wwwDir,
    YFE_REGISTER: 'invite',
    YFE_STATS: path.join(root, 'stats.log'),
    YFE_BOOTSTRAP_INVITE: 'TEST-INVITE-332',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', (d) => { serverLog += d })
server.stderr.on('data', (d) => { serverLog += d })

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base + '/api/ping')
      if (r.ok) return true
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

function cleanup() {
  try { server.kill('SIGKILL') } catch { /* ignore */ }
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
}
process.on('exit', cleanup)

try {
  if (!(await waitReady())) throw new Error('服务未能在 10s 内启动：\n' + serverLog)

  const A = device()
  const B = device()

  // 1. 注册（设备 A）
  const reg = await A.req('POST', '/api/auth/register', { name: 'e2e用户', password: 'pass1234', invite: 'TEST-INVITE-332' })
  ok('注册成功并拿到会话', reg.status === 200 && !!A.cookie, reg)

  // 2. 第二台设备登录 —— 关键：旧设备**不能**被顶掉
  const login2 = await B.req('POST', '/api/auth/login', { name: 'e2e用户', password: 'pass1234' })
  ok('第二台设备登录成功', login2.status === 200 && !!B.cookie, login2)
  const meA = await A.req('GET', '/api/auth/me')
  const meB = await B.req('GET', '/api/auth/me')
  ok('两台设备同时在线（旧实现会在此失败）', meA.status === 200 && meB.status === 200, { meA, meB })

  // 3. 会话列表
  const list1 = await A.req('GET', '/api/auth/sessions')
  ok('会话列表含两条且标出当前', list1.status === 200 && list1.json.sessions.length === 2
    && list1.json.sessions.filter((s) => s.current).length === 1, list1.json)
  ok('会话列表不含 tokenHash', !JSON.stringify(list1.json).includes('tokenHash'), list1.json)
  ok('上限随接口下发', list1.json.softLimit === 10 && list1.json.hardLimit === 20, list1.json)

  // 4. 撤销 B，A 不受影响
  const bSid = list1.json.sessions.find((s) => !s.current).sid
  const rev = await A.req('POST', '/api/auth/sessions/revoke', { sid: bSid })
  const meB2 = await B.req('GET', '/api/auth/me')
  const meA2 = await A.req('GET', '/api/auth/me')
  ok('撤销指定设备生效', rev.status === 200 && rev.json.changed === true, rev.json)
  ok('被撤销设备拿 401 且 code=SESSION_REPLACED', meB2.status === 401 && meB2.json.code === 'SESSION_REPLACED', meB2)
  ok('另一台设备不受影响', meA2.status === 200, meA2)

  // 5. 退出其他设备
  await B.req('POST', '/api/auth/login', { name: 'e2e用户', password: 'pass1234' })
  const others = await A.req('POST', '/api/auth/sessions/revoke-others')
  const meB3 = await B.req('GET', '/api/auth/me')
  const meA3 = await A.req('GET', '/api/auth/me')
  ok('退出其他设备只留当前', others.status === 200 && others.json.revoked >= 1 && meA3.status === 200 && meB3.status === 401,
    { others: others.json, meA3, meB3 })

  // 6. 旧格式令牌（uid.exp.sig）仍可用 + 迁移不丢会话
  const secretHex = readFileSync(path.join(dataDir, '.secret'), 'utf8').trim()
  const secret = Buffer.from(secretHex, 'hex')
  const uid = (await A.req('GET', '/api/auth/me')).json.user.id
  const exp = Date.now() + 86400000
  const sig = createHmac('sha256', secret).update(`${uid}.${exp}`).digest('base64url')
  const legacyToken = `${uid}.${exp}.${sig}`
  const legacy = device()
  legacy.cookie = `yfe_sid=${legacyToken}`
  // 旧令牌必须在会话表里有一行（否则必然 401）。这里直接补一行，模拟「升级前登录的设备」：
  const usersFile = path.join(dataDir, 'users.json')
  const db = JSON.parse(readFileSync(usersFile, 'utf8'))
  const hashTok = createHmac('sha256', secret).update(`session:${legacyToken}`).digest('base64url')
  db.users[uid].sessionList.push({
    sid: 'legacy_sid', tokenHash: hashTok, kind: 'web', label: '升级前的设备',
    createdAt: Date.now() - 86400000, lastSeenAt: Date.now() - 86400000, revokedAt: null,
  })
  writeFileSync(usersFile, JSON.stringify(db))
  await new Promise((r) => setTimeout(r, 30)) // 让 mtime 变化足以让 users.mjs 的缓存失效
  const meLegacy = await legacy.req('GET', '/api/auth/me')
  ok('旧格式 3 段令牌仍被接受（升级不掉线）', meLegacy.status === 200, meLegacy)

  // 7. 重置密码撤销全部
  const reset = await A.req('POST', '/api/auth/reset', { name: 'e2e用户', invite: 'TEST-INVITE-332', password: 'newpass123' })
  const meA4 = await A.req('GET', '/api/auth/me')
  ok('重置密码后全部会话失效', reset.status === 200 && meA4.status === 401, { reset: reset.status, meA4 })
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
  if (serverLog) console.log('--- server log ---\n' + serverLog.slice(-3000))
  process.exit(1)
}
console.log(`OK ${passed}/${passed}（${new Date().toISOString()}，Node ${process.version}）`)
process.exit(0)
