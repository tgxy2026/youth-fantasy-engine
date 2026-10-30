// ============ 3.3.2 · P1-5b 桌面客户端授权（主进程侧）============
//
// 【这套流程解决什么】桌面版登录网页账号不能用「在桌面里嵌一个登录框」：
//   · 嵌进去就得在桌面里收密码，一旦实现有疏漏，密码就多了一个落点；
//   · 第三方登录（将来可能的 OAuth）在嵌入页里基本走不通；
//   · 用户也不放心在一个陌生窗口里敲密码。
//
// 所以走「系统浏览器 + 回环端口」：
//   1. 主进程在本机 127.0.0.1 上开一个**临时**端口（端口号由系统分配，不写死）；
//   2. 打开系统浏览器到 `/auth/desktop?challenge=…&port=…&state=…`；
//   3. 用户在浏览器里登录（服务端已有的登录页，带 https 与正常 Cookie 语义）；
//   4. 服务端把一次性 code 回跳到 `http://127.0.0.1:<port>/callback?code=…&state=…`；
//   5. 主进程收到 code，用 verifier 换令牌（PKCE），存进系统安全存储。
//
// 🔴 令牌用 `safeStorage` 加密后落盘，**不写明文**：`userData` 目录在磁盘上是可读的，
//    明文令牌等于把账号交给了任何能读这个目录的程序。
// 🔴 `safeStorage` 不可用（Linux 无 keyring / 老系统）时**退化为仅本次运行有效**，
//    不落盘、不降级成明文。宁可下次重登，也不要在盘上留一枚可读的凭据。
//
// 本文件只做编排；纯逻辑（PKCE、回调校验、令牌封装）都在下面独立函数里，
// 便于 `scripts/verify/desktop-client-332.cjs` 在不启动 Electron 的情况下验证。
const http = require('node:http')
const crypto = require('node:crypto')

/** 回环回调的超时：用户在浏览器里可能还在输密码 */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

// ---------------- 纯逻辑（可单测） ----------------

/** base64url 无填充 */
function b64u(buf) {
  return Buffer.from(buf).toString('base64url')
}

/**
 * 生成 PKCE 的 verifier / challenge。
 * challenge = base64url(sha256(verifier))（S256，与服务端 `challengeOf` 一致）
 */
function createPkce() {
  const verifier = b64u(crypto.randomBytes(32))
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** 随机 state（防"别人在你浏览器里塞一个 code 给你"） */
function createState() {
  return b64u(crypto.randomBytes(16))
}

/**
 * 拼授权页地址。
 * 🔴 端口只允许 1024-65535：低于 1024 在部分系统上需要特权，
 *    服务端也会拒（`desktopAuth.mjs` 里同一判据）。
 */
function buildAuthorizeUrl({ baseUrl, port, challenge, state, name }) {
  if (!(port > 1024 && port < 65536)) throw new Error('回环端口不合法')
  const u = new URL('/auth/desktop', baseUrl)
  u.searchParams.set('challenge', challenge)
  u.searchParams.set('port', String(port))
  u.searchParams.set('state', state)
  if (name) u.searchParams.set('name', name)
  return u.toString()
}

/**
 * 校验回调参数。
 * @returns { ok: true, code } | { ok: false, reason }
 */
function verifyCallback({ query, expectedState }) {
  const code = query?.code ? String(query.code) : ''
  const state = query?.state ? String(query.state) : ''
  const err = query?.error ? String(query.error) : ''
  if (err) return { ok: false, reason: err }
  if (!code) return { ok: false, reason: '回调里没有 code' }
  // 🔴 state 必须全等：不然任何网页都能把任意 code 塞进你的回环端口
  if (state !== expectedState) return { ok: false, reason: 'state 不匹配（可能是伪造的回调）' }
  return { ok: true, code }
}

/** 从一次请求里取出查询参数 */
function parseQuery(req) {
  try {
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    const out = {}
    for (const [k, v] of u.searchParams) out[k] = v
    return { pathname: u.pathname, query: out }
  } catch {
    return { pathname: '/', query: {} }
  }
}

/** 回给浏览器的提示页（纯静态，没有外部资源） */
function resultPage(title, detail, ok) {
  const color = ok ? '#0f766e' : '#b91c1c'
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;height:100vh;display:flex;
align-items:center;justify-content:center;background:#0f1115;color:#e5e7eb}
.box{max-width:440px;padding:32px 36px;background:#171a21;border:1px solid #262b36;border-radius:14px}
h1{font-size:18px;margin:0 0 12px;color:${color}}p{margin:0;color:#9ca3af;font-size:13px}</style>
<div class="box"><h1>${title}</h1><p>${detail}</p></div>`
}

/**
 * 令牌的本地封装。
 *
 * @param safeStorage Electron 的 safeStorage（只用到 isEncryptionAvailable / encryptString / decryptString）
 * 🔴 加密不可用时 `save` **不写盘**，返回 `persisted:false` —— 调用方据此提示
 *    "这次登录只在本次运行有效"。
 */
function createTokenVault({ safeStorage, fs, file }) {
  let memory = ''
  return {
    /** @returns {{ persisted: boolean, reason?: string }} */
    save(token) {
      if (!token) return { persisted: false, reason: 'EMPTY' }
      if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function'
        || !safeStorage.isEncryptionAvailable()) {
        memory = token
        return { persisted: false, reason: 'NO_SAFE_STORAGE' }
      }
      try {
        const buf = safeStorage.encryptString(token)
        fs.writeFileSync(file, buf)
        memory = token
        return { persisted: true }
      } catch (e) {
        memory = token
        return { persisted: false, reason: e && e.message ? String(e.message) : 'ENCRYPT_FAILED' }
      }
    },
    load() {
      if (memory) return memory
      try {
        const buf = fs.readFileSync(file)
        if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function'
          || !safeStorage.isEncryptionAvailable()) return ''
        memory = safeStorage.decryptString(buf)
        return memory
      } catch {
        return ''
      }
    },
    clear() {
      memory = ''
      try { fs.unlinkSync(file) } catch { /* 本来就没有 */ }
    },
    /** 内存里有没有（不读盘） */
    has() { return !!memory },
  }
}

// ---------------- 回环监听 ----------------

/**
 * 起一个只监听 127.0.0.1 的一次性回调服务。
 *
 * @param onCode (query) => Promise<{ ok:boolean, title:string, detail:string }>
 * @returns { port, close, waitForCode }
 */
function startLoopbackServer(onCode, { timeoutMs = CALLBACK_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let finish = null
    const done = new Promise((res) => { finish = res })

    const server = http.createServer(async (req, res) => {
      const { pathname, query } = parseQuery(req)
      if (pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      let outcome
      try {
        outcome = await onCode(query)
      } catch (e) {
        outcome = { ok: false, title: '授权失败', detail: e && e.message ? String(e.message) : '未知错误' }
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(resultPage(outcome.title, outcome.detail, outcome.ok))
      if (!settled) { settled = true; finish(outcome) }
      // 收完这一条就关：不常驻、不复用端口
      setTimeout(() => { try { server.close() } catch { /* 已关 */ } }, 50)
    })

    server.on('error', reject)
    // 🔴 只绑 127.0.0.1：绑 0.0.0.0 等于把回调端口暴露给局域网
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const timer = setTimeout(() => {
        if (!settled) { settled = true; finish({ ok: false, title: '授权超时', detail: '等待浏览器登录超时，请重试' }) }
        try { server.close() } catch { /* ignore */ }
      }, timeoutMs)
      resolve({
        port: addr.port,
        waitForCode: () => done.finally(() => clearTimeout(timer)),
        close: () => { try { server.close() } catch { /* ignore */ } clearTimeout(timer) },
      })
    })
  })
}

module.exports = {
  CALLBACK_TIMEOUT_MS,
  createPkce,
  createState,
  buildAuthorizeUrl,
  verifyCallback,
  parseQuery,
  createTokenVault,
  startLoopbackServer,
}
