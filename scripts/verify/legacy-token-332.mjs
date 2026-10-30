// P1 · 旧令牌升级路径端到端自检
// 用法：node scripts/verify/legacy-token-332.mjs
//
// 守的是一条承诺：「3.3.1 的旧登录态在新版服务端上仍然有效，不会被踢下线」。
// 这条曾经是**坏的**：迁移函数用 djb2 造了个占位摘要，而认证算的是 HMAC ⇒ 永远对不上。
// 当时的端到端是手工塞了一条用真 HMAC 的行，所以没露。本文件用**真实旧数据形态**验一遍。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const serverEntry = path.join(repo, 'server/index.mjs')

const PORT = 18736
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-legacy-token-'))
const dataDir = path.join(root, 'data')
const wwwDir = path.join(root, 'www')
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(wwwDir, { recursive: true })
fs.writeFileSync(path.join(wwwDir, 'index.html'), '<!doctype html><title>fixture</title>')
process.env.YFE_DATA = dataDir

const { createUser } = await import('../../server/lib/users.mjs')

let passed = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) { passed++; console.log('PASS ' + name) }
  else { fails.push({ name, extra }); console.log('FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')) }
}

// 1. 自己写一份密钥（服务端会直接沿用），这样我们能签出「3.3.1 形态」的令牌
const secret = randomBytes(32)
fs.writeFileSync(path.join(dataDir, '.secret'), secret.toString('hex'))

// 2. 造一个 3.3.1 形态的账号：只有单个 `session` 字段，没有 sessionList
const user = createUser({ id: 'u_legacy', name: '老用户', passwordHash: 'x' })
const loginAt = Date.now() - 10 * 24 * 3600 * 1000
const exp = Date.now() + 20 * 24 * 3600 * 1000
const legacyToken = `${user.id}.${exp}.` + createHmac('sha256', secret).update(`${user.id}.${exp}`).digest('base64url')
const usersFile = path.join(dataDir, 'users.json')
const db = JSON.parse(fs.readFileSync(usersFile, 'utf8'))
db.users[user.id].session = { token: legacyToken, at: loginAt }
fs.writeFileSync(usersFile, JSON.stringify(db))
const legacyTokenHash = createHmac('sha256', secret).update(`session:${legacyToken}`).digest('base64url')

const base = `http://127.0.0.1:${PORT}`
const server = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), YFE_DATA: dataDir, YFE_WWW: wwwDir, YFE_REGISTER: 'open', YFE_STATS: path.join(root, 'stats.log') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (d) => { log += d })
server.stderr.on('data', (d) => { log += d })
const cleanup = () => {
  try { server.kill('SIGKILL') } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
}
process.on('exit', cleanup)

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/ping')).ok) return true } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const me = (token) => fetch(base + '/api/auth/me', { headers: { cookie: `yfe_sid=${token}` } })
const listSessions = (token) => fetch(base + '/api/auth/sessions', { headers: { cookie: `yfe_sid=${token}` } })

try {
  if (!(await waitReady())) throw new Error('服务未启动：\n' + log)

  // 3. 旧令牌第一次到来：必须被接受，并就地转正
  const r1 = await me(legacyToken)
  ok('3.3.1 旧令牌仍然有效（升级不掉线）', r1.status === 200, r1.status)

  const after = JSON.parse(fs.readFileSync(usersFile, 'utf8')).users[user.id]
  ok('旧 session 字段已转正并清除', after.session === undefined, JSON.stringify(after.session))
  ok('会话表里出现一条「升级前的设备」', Array.isArray(after.sessionList) && after.sessionList.length === 1
    && after.sessionList[0].label === '升级前的设备', JSON.stringify(after.sessionList))
  ok('转正时用的是真实 HMAC 摘要（不是占位哈希）', after.sessionList[0].tokenHash === legacyTokenHash,
    { got: after.sessionList[0].tokenHash, want: legacyTokenHash })
  ok('转正不刷新登录时间（不自偷偷续期）', after.sessionList[0].createdAt === loginAt,
    { got: after.sessionList[0].createdAt, want: loginAt })

  // 4. 第二次请求走会话表命中
  const r2 = await me(legacyToken)
  ok('第二次请求按会话表命中', r2.status === 200, r2.status)

  // 5. 设备列表里能看到它
  const ls = await listSessions(legacyToken)
  const rows = ls.status === 200 ? (await ls.json()).sessions : []
  ok('设备列表里能看到这台旧设备', rows.length === 1 && rows[0].current === true, rows)

  // 6. 撤销后旧令牌立刻失效
  const revoke = await fetch(base + '/api/auth/sessions/revoke', {
    method: 'POST',
    headers: { cookie: `yfe_sid=${legacyToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sid: rows[0]?.sid }),
  })
  const r3 = await me(legacyToken)
  ok('撤销后旧令牌失效', revoke.status === 200 && r3.status === 401, { revoke: revoke.status, me: r3.status })

  // 7. 伪造令牌（同 uid、错签名）仍然被拒
  const forged = `${user.id}.${exp}.` + createHmac('sha256', randomBytes(32)).update(`${user.id}.${exp}`).digest('base64url')
  ok('伪造签名的令牌被拒', (await me(forged)).status === 401)
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
  if (log) console.log('--- server log ---\n' + log.slice(-2000))
  process.exit(1)
}
console.log(`OK ${passed}/${passed}（${new Date().toISOString()}，Node ${process.version}）`)
process.exit(0)
