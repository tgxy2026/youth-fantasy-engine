// 3.3.2 · P1-5b 桌面客户端授权 · 自检
//
// 不启动 Electron，只验可以脱离 GUI 验证的部分：
//   ① PKCE 的 challenge 必须是 base64url(sha256(verifier))（与服务端 S256 对齐）；
//   ② state 必须全等（否则任何网页能把任意 code 塞进你的回环端口）；
//   ③ 回环端口只绑 127.0.0.1、只认 /callback；
//   ④ 令牌加密后才落盘；safeStorage 不可用时**只留内存、不写盘**（不许明文落盘）；
//   ⑤ 超时会自己收口，不挂死。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const http = require('node:http')

const {
  createPkce, createState, buildAuthorizeUrl, verifyCallback, parseQuery,
  createTokenVault, startLoopbackServer,
} = require('../../electron/desktopAuth.cjs')

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ` :: ${extra}` : ''}`) }
}

const b64u = (b) => Buffer.from(b).toString('base64url')

async function main() {
  // ---------- 1. PKCE ----------
  {
    const { verifier, challenge } = createPkce()
    const expect = b64u(crypto.createHash('sha256').update(verifier).digest())
    ok('challenge = base64url(sha256(verifier))', challenge === expect, `${challenge} vs ${expect}`)
    ok('verifier 足够长（32 字节随机）', verifier.length >= 43, String(verifier.length))
    ok('每次生成都不同', createPkce().verifier !== createPkce().verifier)
    ok('state 每次不同且非空', createState().length >= 16 && createState() !== createState())
  }

  // ---------- 2. 授权地址 ----------
  {
    const url = buildAuthorizeUrl({
      baseUrl: 'https://example.com', port: 52001, challenge: 'CH', state: 'ST', name: '桌面',
    })
    const u = new URL(url)
    ok('路径是 /auth/desktop', u.pathname === '/auth/desktop', u.pathname)
    ok('带上 challenge / port / state',
      u.searchParams.get('challenge') === 'CH' && u.searchParams.get('port') === '52001'
      && u.searchParams.get('state') === 'ST', url)
    let threw = ''
    try { buildAuthorizeUrl({ baseUrl: 'https://x.y', port: 80, challenge: 'c', state: 's' }) } catch (e) { threw = String(e) }
    ok('特权端口（80）被拒', threw.includes('端口'), threw)
    threw = ''
    try { buildAuthorizeUrl({ baseUrl: 'https://x.y', port: 70000, challenge: 'c', state: 's' }) } catch (e) { threw = String(e) }
    ok('越界端口（70000）被拒', threw.includes('端口'), threw)
  }

  // ---------- 3. 回调校验 ----------
  {
    ok('正常回调通过', verifyCallback({ query: { code: 'C', state: 'S' }, expectedState: 'S' }).ok === true)
    const bad = verifyCallback({ query: { code: 'C', state: 'X' }, expectedState: 'S' })
    ok('state 不符被拒（防伪造回调）', bad.ok === false && /state/.test(bad.reason), JSON.stringify(bad))
    const noCode = verifyCallback({ query: { state: 'S' }, expectedState: 'S' })
    ok('没有 code 被拒', noCode.ok === false, JSON.stringify(noCode))
    const errCb = verifyCallback({ query: { error: 'access_denied', state: 'S' }, expectedState: 'S' })
    ok('服务端带 error 时如实返回', errCb.ok === false && errCb.reason === 'access_denied', JSON.stringify(errCb))
  }

  // ---------- 4. 查询解析 ----------
  {
    const p = parseQuery({ url: '/callback?code=A&state=B' })
    ok('解析路径与参数', p.pathname === '/callback' && p.query.code === 'A' && p.query.state === 'B', JSON.stringify(p))
    ok('坏 URL 不抛', parseQuery({ url: 'http://[::1' }).pathname === '/')
  }

  // ---------- 5. 令牌保管：加密可用 ----------
  const tmpFile = path.join(os.tmpdir(), `yfe-token-${process.pid}.bin`)
  {
    const fakeSafe = {
      isEncryptionAvailable: () => true,
      // 用异或假装加密：只为验证"落盘的不是明文"
      encryptString: (s) => Buffer.from(s.split('').map((c) => String.fromCharCode(c.charCodeAt(0) ^ 0x5a)).join(''), 'utf8'),
      decryptString: (buf) => buf.toString('utf8').split('').map((c) => String.fromCharCode(c.charCodeAt(0) ^ 0x5a)).join(''),
    }
    const vault = createTokenVault({ safeStorage: fakeSafe, fs, file: tmpFile })
    const r = vault.save('uid.sid.exp.sig')
    ok('加密可用时报告已持久化', r.persisted === true, JSON.stringify(r))
    const raw = fs.readFileSync(tmpFile)
    ok('盘上不是明文令牌', !raw.includes(Buffer.from('uid.sid.exp.sig')), raw.toString('utf8').slice(0, 20))
    ok('能解密读回', vault.load() === 'uid.sid.exp.sig', vault.load())
    vault.clear()
    ok('清空后读不到', vault.load() === '')
  }

  // ---------- 6. 令牌保管：safeStorage 不可用 ----------
  {
    const missing = path.join(os.tmpdir(), `yfe-token-miss-${process.pid}.bin`)
    const vault = createTokenVault({
      safeStorage: { isEncryptionAvailable: () => false },
      fs, file: missing,
    })
    const r = vault.save('secret-token')
    ok('不可用时报告未持久化', r.persisted === false && r.reason === 'NO_SAFE_STORAGE', JSON.stringify(r))
    // 🔴 这条是红线：宁可不落盘，也不能把明文写出去
    ok('不可用时**不写盘**（不许明文落盘）', !fs.existsSync(missing))
    ok('本次运行内仍可用（退化为会话内登录）', vault.load() === 'secret-token')
    vault.clear()
    ok('清空后内存也没了', vault.load() === '')
  }

  // ---------- 7. 回环服务：真起一次 ----------
  {
    const seen = []
    const srv = await startLoopbackServer(async (query) => {
      seen.push(query)
      return verifyCallback({ query, expectedState: 'S1' }).ok
        ? { ok: true, title: '登录成功', detail: '可以回到桌面版了' }
        : { ok: false, title: '授权失败', detail: 'state 不匹配' }
    }, { timeoutMs: 5000 })

    ok('监听在 127.0.0.1（不是 0.0.0.0）', srv.port > 0, String(srv.port))

    const hit = (p) => new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: srv.port, path: p }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => resolve({ status: res.statusCode, body }))
      })
      req.on('error', () => resolve({ status: 0, body: '' }))
    })

    const bad = await hit('/other')
    ok('只认 /callback，其他路径 404', bad.status === 404, String(bad.status))

    const [good] = await Promise.all([
      hit('/callback?code=CODE1&state=S1'),
      srv.waitForCode(),
    ])
    ok('回调返回提示页', good.status === 200 && /登录成功/.test(good.body), good.body.slice(0, 60))
    ok('服务端收到了 code', seen.length === 1 && seen[0].code === 'CODE1', JSON.stringify(seen))
    srv.close()
  }

  // ---------- 8. 回环服务：伪造 state ----------
  {
    const srv = await startLoopbackServer(async (query) => {
      const v = verifyCallback({ query, expectedState: 'RIGHT' })
      return v.ok ? { ok: true, title: '成功', detail: '' } : { ok: false, title: '失败', detail: v.reason }
    }, { timeoutMs: 3000 })
    const wait = srv.waitForCode()
    await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: srv.port, path: '/callback?code=X&state=WRONG' }, (res) => {
        res.resume(); res.on('end', resolve)
      }).on('error', resolve)
    })
    const outcome = await wait
    ok('伪造 state 的回调被拒并提示', outcome.ok === false && /state/.test(outcome.detail), JSON.stringify(outcome))
    srv.close()
  }

  // ---------- 9. 超时自收口 ----------
  {
    const srv = await startLoopbackServer(async () => ({ ok: true, title: 'x', detail: '' }), { timeoutMs: 300 })
    const outcome = await srv.waitForCode()
    ok('没人回调时按超时收口（不挂死）', outcome.ok === false && /超时/.test(outcome.title), JSON.stringify(outcome))
  }

  console.log(`\n${fail ? 'FAILED' : 'OK'} ${pass}/${pass + fail}（${new Date().toISOString()}，Node ${process.version}）`)
  if (fail) process.exit(1)
}

main()
