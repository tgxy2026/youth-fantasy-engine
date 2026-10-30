// P1-5 · 桌面授权交换端到端自检（真服务 + 临时数据目录，不碰真实账号）
// 用法：node scripts/verify/desktop-auth-332.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverEntry = path.resolve(here, '../../server/index.mjs')

const PORT = 18733
const LOOPBACK_PORT = 18740
const root = mkdtempSync(path.join(os.tmpdir(), 'yfe-desktop-e2e-'))
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

/** 完整 cookie jar（要同时保住 yfe_sid 与 yfe_dp） */
function client() {
  return {
    jar: new Map(),
    cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    absorb(res) {
      const list = res.headers.getSetCookie?.() || []
      for (const c of list) {
        const [pair] = c.split(';')
        const i = pair.indexOf('=')
        const k = pair.slice(0, i)
        const v = pair.slice(i + 1)
        if (!v) this.jar.delete(k)
        else this.jar.set(k, v)
      }
    },
    async req(method, url, body) {
      const headers = { 'content-type': 'application/json' }
      const ck = this.cookieHeader()
      if (ck) headers.cookie = ck
      const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' })
      this.absorb(res)
      let json = null
      if ((res.headers.get('content-type') || '').includes('application/json')) {
        try { json = await res.json() } catch { /* ignore */ }
      }
      return { status: res.status, location: res.headers.get('location'), json, headers: res.headers }
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
    YFE_BOOTSTRAP_INVITE: 'DP-INVITE-332',
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
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/ping')).ok) return true } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const verifierOf = () => randomBytes(32).toString('base64url')
const challengeOf = (v) => createHash('sha256').update(v).digest('base64url')
const stateOf = () => randomBytes(12).toString('base64url')
const desktopUrl = (challenge, state, port = LOOPBACK_PORT) =>
  `/auth/desktop?challenge=${encodeURIComponent(challenge)}&port=${port}&state=${encodeURIComponent(state)}`

try {
  if (!(await waitReady())) throw new Error('服务未启动：\n' + log)

  const web = client()
  const reg = await web.req('POST', '/api/auth/register', { name: '桌面用户', password: 'pass1234', invite: 'DP-INVITE-332' })
  ok('网页侧注册并登录', reg.status === 200 && web.jar.has('yfe_sid'), reg.status)

  // 1. 已登录 → 直接签发 code 并回跳回环地址
  const v1 = verifierOf(), s1 = stateOf()
  const start = await web.req('GET', desktopUrl(challengeOf(v1), s1))
  const loc = start.location || ''
  const parsed = new URL(loc || 'http://x/')
  ok('已登录时 302 到 127.0.0.1 回调', start.status === 302 && loc.startsWith(`http://127.0.0.1:${LOOPBACK_PORT}/callback?`), loc)
  ok('回调带回原样 state 与一次性 code', parsed.searchParams.get('state') === s1 && !!parsed.searchParams.get('code'), loc)
  const code1 = parsed.searchParams.get('code')

  // 2. code + verifier 换令牌
  const ex = await client().req('POST', '/api/auth/desktop/exchange', { code: code1, verifier: v1 })
  ok('授权码换到令牌', ex.status === 200 && typeof ex.json?.token === 'string' && ex.json.token.split('.').length === 4, ex.json)
  ok('换令牌不种网页 Cookie', !(ex.headers.getSetCookie?.() || []).some((c) => c.startsWith('yfe_sid=')), '不应写 Cookie')

  // 3. 令牌可直接当会话用
  const dt = client()
  dt.jar.set('yfe_sid', ex.json.token)
  const me = await dt.req('GET', '/api/auth/me')
  ok('桌面令牌可访问需登录接口', me.status === 200 && me.json?.user?.name === '桌面用户', me.json)

  // 3b. 也要能用 Bearer 头（桌面不是浏览器，没有 Cookie 罐）
  const bearer = await fetch(base + '/api/auth/me', { headers: { authorization: `Bearer ${ex.json.token}` } })
  ok('Authorization: Bearer 可用', bearer.status === 200, bearer.status)

  // 4. 同一 code 不能二次使用
  const replay = await client().req('POST', '/api/auth/desktop/exchange', { code: code1, verifier: v1 })
  ok('授权码单次使用（重放被拒）', replay.status === 400, replay.json)

  // 5. verifier 不匹配：拒绝，且该 code 也作废
  const v2 = verifierOf(), s2 = stateOf()
  const start2 = await web.req('GET', desktopUrl(challengeOf(v2), s2))
  const code2 = new URL(start2.location || 'http://x/').searchParams.get('code')
  const wrong = await client().req('POST', '/api/auth/desktop/exchange', { code: code2, verifier: verifierOf() })
  const retryRight = await client().req('POST', '/api/auth/desktop/exchange', { code: code2, verifier: v2 })
  ok('verifier 不匹配被拒', wrong.status === 400, wrong.json)
  ok('不匹配后该 code 也作废（先删后验）', retryRight.status === 400, retryRight.json)

  // 6. 参数校验
  const badPort = await web.req('GET', desktopUrl(challengeOf(verifierOf()), stateOf(), 80))
  const badState = await web.req('GET', desktopUrl(challengeOf(verifierOf()), 'short'))
  ok('非特权端口被拒', badPort.status === 400, badPort.status)
  ok('过短 state 被拒', badState.status === 400, badState.status)

  // 7. 未登录：先存待授权参数，登录后在 / 上自动续上
  const fresh = client()
  const v3 = verifierOf(), s3 = stateOf()
  const anon = await fresh.req('GET', desktopUrl(challengeOf(v3), s3))
  ok('未登录时重定向到首页并暂存参数', anon.status === 302 && anon.location === '/' && fresh.jar.has('yfe_dp'), anon.location)
  const login = await fresh.req('POST', '/api/auth/login', { name: '桌面用户', password: 'pass1234' })
  ok('登录成功', login.status === 200 && fresh.jar.has('yfe_sid'), login.status)
  const resume = await fresh.req('GET', '/', undefined)
  const rl = resume.location || ''
  ok('登录后访问首页自动回跳回调', resume.status === 302 && rl.startsWith(`http://127.0.0.1:${LOOPBACK_PORT}/callback?`), rl)
  ok('回跳带回原 state', new URL(rl || 'http://x/').searchParams.get('state') === s3, rl)
  ok('回跳后清掉待授权 Cookie', !fresh.jar.has('yfe_dp'), [...fresh.jar.keys()])

  // 8. 桌面会话计入设备列表（kind=desktop）
  const sess = await web.req('GET', '/api/auth/sessions')
  const kinds = (sess.json?.sessions || []).map((s) => s.kind)
  ok('桌面登录出现在设备列表且标为 desktop', kinds.includes('desktop'), kinds)
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
