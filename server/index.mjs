// ============ 青春幻想引擎 · 网页版服务端 ============
//
// 形态：单进程 Node（零运行时依赖）+ systemd 托管；前端是同一份 `dist/` 产物。
//
// 三条设计主线：
//   1. **前端零改动**：注入 `window.__YFE_PORTABLE__` 让前端走它已有的 HTTP StoreOps
//      （`portableStore`），接口契约与便携版完全一致（/api/data、/api/blob…）。
//   2. **未登录由服务端挡**：未登录的 HTML 请求直接给登录页，前端不会看到 401 红条。
//   3. **每个用户一个目录**：<DATA_DIR>/users/<uid>/，备份 = 拷 data 目录。
//
// 🔴 安全基线：路径遍历前缀断言、请求体上限、登录/注册限流、Cookie HttpOnly+SameSite、
//    密码 scrypt、会话 HMAC 签名、外置 store 白名单。任何一条都不是「以后再补」。
import { createServer } from 'node:http'
import { createReadStream, statSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, extname, normalize, sep } from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream'

import {
  WWW_DIR, DATA_DIR, MAX_BODY, DEFAULT_QUOTA, SESSION_TTL_MS, SESSION_COOKIE,
  GUEST_COOKIE, GUEST_COOKIE_TTL_MS,
  REGISTER_MODE, BOOTSTRAP_INVITE,
} from './lib/config.mjs'
import { sendJSON, sendText, readBody, readJSONBody, parseCookies, buildCookie, clientIp } from './lib/http.mjs'
import { rateLimit, resetLimit } from './lib/ratelimit.mjs'
import { renderAuthPage, renderResetPage } from './lib/authPage.mjs'
import {
  loadUsers, findByName, findById, createUser, touchLogin, setUsedBytes, listUsers,
  claimInvite, createInvite, listInvites, newUserId, setActiveSession, clearActiveSession,
  markIssued, resetPasswordByInvite,
} from './lib/users.mjs'
import {
  hashPassword, verifyPassword, loadOrCreateSecret, signSession, verifySessionToken,
  validateName, validatePassword,
} from './lib/auth.mjs'
import {
  readUserData, writeUserData, usageOf, userDataFile,
  readBlob, writeBlob, deleteBlob, listBlobs, ensureUserDir,
} from './lib/userdata.mjs'
import { SECRET_FILE } from './lib/config.mjs'

const PORT = Number(process.env.PORT || 80)
const HOST = process.env.HOST || '0.0.0.0'
const APP = 'youth-fantasy-engine-web'

// ---------- 启动初始化 ----------
let SECRET
try {
  loadUsers() // 🔴 用户表损坏必须在这里就炸，不能带着空表继续跑
  SECRET = loadOrCreateSecret(SECRET_FILE)
} catch (e) {
  console.error('[boot] 启动失败：', e instanceof Error ? e.message : e)
  process.exit(1)
}

// 只在**首次**初始化时生成引导邀请码。
// 🔴 判据不能只看「用户数为 0」：首次启动后若没人注册就重启，会再发一个新的邀请码，
//    重启几次就攒几个 —— 每个都是能注册的有效凭据。用 invites 里的标记位判断才幂等。
if (listUsers().length === 0 && !listInvites().some((i) => i.note === '首次启动自动生成')) {
  // 🔴 maxUses 必须是 1：引导码是「给第一个账号用」的，多用途码一旦流出就等于开了后门
  const r = createInvite({ code: BOOTSTRAP_INVITE || '', maxUses: 1, note: '首次启动自动生成' })
  if (r.ok) {
    console.log('='.repeat(56))
    console.log(`[boot] 初始邀请码：${r.code}`)
    console.log('[boot] 用它注册第一个账号；之后在服务器上用 node admin.mjs invite 生成')
    console.log('='.repeat(56))
  } else {
    console.error('[boot] 初始邀请码生成失败：', r.error)
  }
}

// ---------- 认证 ----------
/**
 * 校验请求的会话，并区分**为什么无效**。
 * 🔴 reason 必须精确：前端要靠它把「登录过期」和「账号在别处登录」说成两句不同的话 ——
 *    混成一句「未登录」会让用户反复登录反复被踢，却完全看不出原因。
 * @returns {{user: object|null, reason: ''|'NO_TOKEN'|'EXPIRED'|'NO_USER'|'REPLACED'}}
 */
function authCheck(req) {
  const token = parseCookies(req)[SESSION_COOKIE]
  if (!token) return { user: null, reason: 'NO_TOKEN' }
  const uid = verifySessionToken(token, SECRET)
  if (!uid) return { user: null, reason: 'EXPIRED' }
  const u = findById(uid)
  if (!u) return { user: null, reason: 'NO_USER' }
  // 单会话：服务端记录的活跃 token 与本次请求不一致 ⇒ 已被别处的登录顶掉
  if (!u.session || u.session.token !== token) return { user: null, reason: 'REPLACED' }
  return { user: u, reason: '' }
}

function authUser(req) {
  return authCheck(req).user
}

/** 401 的 code：前端据此分流提示文案 */
const sessionCode = (reason) => (reason === 'REPLACED' ? 'SESSION_REPLACED' : 'SESSION_EXPIRED')

const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https'

// ---------- 访问统计（WEB-17 · 方案 E：最小自研计数） ----------
//
// 【为什么不用第三方】自托管 umami/plausible 在这台 1.7 GB 内存的机器上跑不动；
// 百度统计/GA 要么带广告代码、要么国内访问不稳，且都要往页面里插第三方脚本。
// 这里只追加一行极短的日志，零依赖、零内存成本、数据全在自己手里。
//
// 🔴 **只记类型，不记 IP、不记用户名、不记任何路径参数**：
//    统计的目的是「有没有人来、来了会不会注册」，不需要知道是谁。
//    记了 IP 就等于把访客行为和个人挂上钩，那份隐私成本不值这几行日志。
// 🔴 只在「有人访问页面」和「认证动作」时记，静态资源（65 个 chunk）一律不记 ——
//    否则一次刷新就刷出几十行，既拖慢 IO 也没信息量。
const STATS_LOG = process.env.YFE_STATS || '/opt/yfe/logs/stats.log'
/** 本地日期（YYYY-MM-DD）。
 * 🔴 不能用 `toISOString().slice(0,10)`：那是 **UTC** 日期。服务器虽已设 Asia/Shanghai，
 *    但 UTC 与本地差 8 小时 ⇒ 本地凌晨 0–8 点的活动会被记成「昨天」，
 *    而汇总脚本按本地日期取数，这部分数据永远汇总不进去（静默丢失）。
 *    踩过一次：统计看着正常，其实每天最早那批访客全没被计入。 */
function todayLocal() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function recordStat(type) {
  try {
    mkdirSync(STATS_LOG.slice(0, STATS_LOG.lastIndexOf('/')), { recursive: true })
    appendFileSync(STATS_LOG, `${todayLocal()}\t${type}\n`)
  } catch { /* 统计失败绝不能影响主流程 */ }
}

function sessionCookie(req, uid) {
  const token = signSession(uid, Date.now() + SESSION_TTL_MS, SECRET)
  // 直连 http 时不加 Secure（否则浏览器直接丢弃 Cookie）；走 https 反代时自动加
  return buildCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_MS, secure: isHttps(req) })
}

/**
 * 签发会话并写入「活跃会话」记录。
 * 🔴 单会话的关键一步：每次登录都覆盖 `user.session` ⇒ 旧设备的下一个请求
 *    会发现服务端记的 token 与自己不符，立刻失效（WEB-02 跨设备并发的根治方案）。
 *    同一浏览器多标签页共用同一 Cookie，不会自己踢自己。
 */
function issueSession(req, uid) {
  const token = signSession(uid, Date.now() + SESSION_TTL_MS, SECRET)
  setActiveSession(uid, token)
  return buildCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_MS, secure: isHttps(req) })
}

const clearCookie = (req) => buildCookie(SESSION_COOKIE, '', { maxAge: 0, secure: isHttps(req) })

/** 游客「知情同意」标记：点了 /guest 才种下，一年有效 */
const guestCookie = (req) => buildCookie(GUEST_COOKIE, '1', { maxAge: GUEST_COOKIE_TTL_MS, secure: isHttps(req) })
const clearGuestCookie = (req) => buildCookie(GUEST_COOKIE, '', { maxAge: 0, secure: isHttps(req) })

function publicUser(u) {
  return {
    name: u.name,
    id: u.id,
    quotaBytes: u.quotaBytes,
    usedBytes: u.usedBytes,
    createdAt: u.createdAt,
  }
}

// ---------- 静态资源 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map'])
const GZIP_MIN_BYTES = 1024

/** 白名单式前缀断言：规范化后必须仍在 WWW_DIR 之内 */
function resolveSafe(urlPath) {
  let rel
  try { rel = decodeURIComponent(urlPath) } catch { return null }
  rel = rel.replace(/[\\/]+/g, '/')
  if (rel.includes('\0')) return null
  const abs = normalize(join(WWW_DIR, rel))
  const base = normalize(WWW_DIR)
  if (abs !== base && !abs.startsWith(base.endsWith(sep) ? base : base + sep)) return null
  return abs
}

/**
 * 404 页面（WEB-15）。
 * 🔴 原来是一句纯文本 `Not Found` —— 访客手误打错地址、或从旧分享链接进来时，
 *    看到一句英文技术术语会直接关掉。现在给一句人话 + 回首页的入口。
 *    做成 HTML 而不复用 index.html：404 时加载整个 SPA 是浪费（用户不会在这里操作）。
 */
function notFoundPage(path) {
  const safe = escapeForHtml(String(path || '').slice(0, 120))
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>页面不存在 · 青春幻想引擎</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  background:#f7f4ee;color:#2c2c2a;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.card{width:100%;max-width:420px;background:#fff;border:1px solid #e8e1d5;border-radius:14px;padding:32px 28px;text-align:center}
h1{margin:0 0 10px;font-size:19px;font-weight:600;color:#1f1d1a;letter-spacing:.04em}
p{margin:0 0 6px;font-size:13px;line-height:1.8;color:#6b6459}
code{display:block;margin:12px 0 20px;padding:8px 10px;font-size:12px;color:#8a8278;
  background:#f6f2ea;border-radius:7px;word-break:break-all}
a{display:inline-block;padding:9px 22px;font-size:13px;color:#fff;background:#8a6d1f;border-radius:8px;text-decoration:none;letter-spacing:.05em;transition:background .15s}
a:hover{background:#755c19}
</style></head><body><div class="card">
<h1>这个页面不存在</h1>
<p>可能是地址输错了，或者旧版本的分享链接已失效。</p>
<code>${safe}</code>
<a href="/">回到首页</a>
</div></body></html>`
}

function sendNotFound(req, res, path) {
  const body = Buffer.from(notFoundPage(path), 'utf8')
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function baseHeaders(ext, isIndex) {
  return {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': isIndex ? 'no-cache, must-revalidate' : 'public, max-age=31536000, immutable',
  }
}

function serveFile(req, res, abs, ext) {
  let st
  try { st = statSync(abs) } catch { return false }
  if (!st.isFile()) return false

  const isIndex = abs.endsWith(sep + 'index.html')
  const headers = baseHeaders(ext, isIndex)
  headers['Last-Modified'] = st.mtime.toUTCString()

  const inm = req.headers['if-modified-since']
  if (inm) {
    const since = Date.parse(inm)
    if (!Number.isNaN(since) && Math.floor(st.mtimeMs / 1000) <= Math.floor(since / 1000)) {
      res.writeHead(304, headers)
      res.end()
      return true
    }
  }

  const wantGzip = COMPRESSIBLE.has(ext) && st.size >= GZIP_MIN_BYTES
    && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))
  if (wantGzip) headers['Content-Encoding'] = 'gzip'
  else headers['Content-Length'] = st.size

  res.writeHead(200, headers)
  if (req.method === 'HEAD') { res.end(); return true }

  const stream = createReadStream(abs)
  if (wantGzip) {
    pipeline(stream, createGzip(), res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('[static]', err.message)
    })
  } else {
    stream.pipe(res)
    stream.on('error', () => res.destroy())
  }
  return true
}

/**
 * 给 index.html 注入运行时标记。
 * 🔴 必须注入在 </head> 之前、且早于任何 module 脚本求值 —— 前端 `PORTABLE` 是
 *    **模块求值期**读取的常量，晚一步就永远是 false，整条存储链路会退回 IndexedDB。
 */
/**
 * 游客模式常驻告知条（注入到 </body> 前）。
 *
 * 🔴 为什么由服务端注入而不是前端组件：前端在游客模式（IndexedDB）下没有任何「数据在哪」的提示
 *    —— `decideDataDockView` 原先连数据坞都不渲染。这条 DOM 是**独立于 React 树**的最后一道防线：
 *    即使前端渲染失败，用户也能看到「数据只在本机」并找到注册入口。
 *    用户关掉后记在 localStorage，不会每次刷新都骚扰。
 */
const GUEST_BANNER = `
<div id="yfe-guest-tip" style="position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 32px);padding:8px 14px;border-radius:999px;background:rgba(28,26,23,.94);border:1px solid rgba(201,162,39,.45);color:#d8d2c6;font-size:12px;line-height:1.5;box-shadow:0 6px 24px -8px rgba(0,0,0,.65);font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif">
  <span style="color:#d9a04a;font-weight:500;white-space:nowrap">游客模式</span>
  <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">数据仅存本机浏览器，请及时导出备份</span>
  <a href="/login" style="color:#d9a04a;text-decoration:none;border-bottom:1px solid rgba(217,160,74,.4);white-space:nowrap">注册账号</a>
  <button type="button" onclick="__yfeDismissGuestTip()" aria-label="关闭提示" style="background:none;border:0;color:#8a8278;cursor:pointer;font-size:16px;line-height:1;padding:0 2px">&times;</button>
</div>
<script>
(function () {
  var K = 'yfe-guest-tip-off';
  try { if (localStorage.getItem(K) === '1') { var e = document.getElementById('yfe-guest-tip'); if (e) e.style.display = 'none'; } } catch (err) {}
  window.__yfeDismissGuestTip = function () {
    try { localStorage.setItem(K, '1'); } catch (err) {}
    var el = document.getElementById('yfe-guest-tip');
    if (el) el.style.display = 'none';
  };
})();
</script>`

const escapeForHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

/**
 * 账号态常驻胶囊（注入到 </body> 前）。
 *
 * 🔴 为什么必须有它：登录后会话保留 30 天，而界面上**原本没有任何登出入口** ——
 *    用户被永久锁在云端模式下，既回不到登录页、也切不到游客模式（实测主人被卡住）。
 *    顺带解决另一个缺口：界面上看不到「已用 / 配额」，只能撞上限才知道。
 *
 * 与 `GUEST_BANNER` 的差异：**不可关闭**。游客胶囊关掉只是少一条提示，
 * 这个关掉就再也找不到退出入口了 —— 宁可常驻，也不留死角。
 */
const ACCOUNT_BANNER = (name) => `
<div id="yfe-acct" style="position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 32px);padding:7px 14px;border-radius:999px;background:rgba(28,26,23,.9);border:1px solid rgba(148,140,128,.28);color:#cfc8bc;font-size:12px;line-height:1.5;box-shadow:0 6px 20px -10px rgba(0,0,0,.6);opacity:.72;transition:opacity .18s,border-color .18s;font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif" onmouseover="this.style.opacity='1';this.style.borderColor='rgba(201,162,39,.45)'" onmouseout="this.style.opacity='.72';this.style.borderColor='rgba(148,140,128,.28)'">
  <span style="color:#d9a04a;font-weight:500;white-space:nowrap">${escapeForHtml(name)}</span>
  <span id="yfe-acct-quota" style="white-space:nowrap;color:#9a9084">云端空间</span>
  <a href="/logout" style="color:#9a9084;text-decoration:none;border-bottom:1px solid rgba(148,140,128,.4);white-space:nowrap;transition:color .15s" onmouseover="this.style.color='#d9a04a'" onmouseout="this.style.color='#9a9084'">退出</a>
</div>
<script>
(function () {
  function fmt(b) {
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
    return b + ' B';
  }
  fetch('/api/auth/me', { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (j) {
    if (!j || !j.ok || !j.user) return;
    var el = document.getElementById('yfe-acct-quota');
    if (el) el.textContent = '已用 ' + fmt(j.user.usedBytes) + ' / ' + fmt(j.user.quotaBytes);
  }).catch(function () {});
})();
</script>`

let indexCache = null
function renderIndex(user) {
  if (!indexCache) {
    const p = join(WWW_DIR, 'index.html')
    indexCache = existsSync(p) ? readFileSync(p, 'utf8') : '<!doctype html><p>前端产物缺失</p>'
  }

  // 两种形态：
  //  · 已登录（云端存储）⇒ 注入 __YFE_PORTABLE__，前端走它已有的 HTTP StoreOps（接口即 /api/data）
  //  · 游客（本地存储）  ⇒ **绝不注入** __YFE_PORTABLE__，前端于是走 IndexedDB（DESKTOP/PORTABLE 皆 false）
  const script = user
    ? `<script>window.__YFE_PORTABLE__={apiBase:""};window.__YFE_WEB__=1;`
      + `window.__YFE_USER__=${JSON.stringify({
        name: user.name, quotaBytes: user.quotaBytes, usedBytes: user.usedBytes,
      })};</script>`
    // 🔴 游客也必须是「网页版」：`__YFE_WEB__` 决定前端是否把「便携版」字样换成「网页版」。
    //    漏注入的后果是游客看到「便携版不提供在线更新」「本机存储 ./data/…」——全是错的说法。
    : '<script>window.__YFE_GUEST__=1;window.__YFE_WEB__=1;</script>'

  const insertAt = indexCache.includes('</head>') ? '</head>' : ''
  let html = insertAt ? indexCache.replace(insertAt, `${script}</head>`) : script + indexCache
  if (html.includes('</body>')) {
    const banner = user ? ACCOUNT_BANNER(user.name) : GUEST_BANNER
    html = html.replace('</body>', `${banner}</body>`)
  }
  return html
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const path = url.split('?')[0]
  const qs = new URLSearchParams(url.split('?')[1] || '')
  const ip = clientIp(req)

  // ---- 注册 ----
  if (path === '/api/auth/register' && req.method === 'POST') {
    if (REGISTER_MODE === 'closed') return sendJSON(res, 403, { ok: false, error: '本站暂未开放注册' })
    const rl = rateLimit(`reg:${ip}`, 5, 60 * 60 * 1000)
    if (!rl.ok) return sendJSON(res, 429, { ok: false, error: `注册过于频繁，请 ${rl.retryAfter} 秒后再试` })

    let body
    try { body = await readJSONBody(req, 8 * 1024) } catch { return sendJSON(res, 400, { ok: false, error: '请求格式错误' }) }

    const nv = validateName(body.name)
    if (!nv.ok) return sendJSON(res, 400, { ok: false, error: nv.error })
    const pv = validatePassword(body.password)
    if (!pv.ok) return sendJSON(res, 400, { ok: false, error: pv.error })
    if (findByName(nv.value)) return sendJSON(res, 409, { ok: false, error: '该用户名已被占用' })

    // ---- 临界区准备：把可能失败 / 可能慢的步骤全部放到「占码」之前 ----
    // 密码哈希（scrypt，约数十毫秒）必须在这里做完：它若放在 claimInvite 之后，
    // 就等于在「占码」与「建用户」之间让出了事件循环 —— 见 claimInvite 的注释。
    const uid = newUserId()
    const pwdHash = hashPassword(pv.value)

    let inviteCode = ''
    if (REGISTER_MODE === 'invite') {
      inviteCode = String(body.invite || '').trim().toUpperCase()
      if (!inviteCode) return sendJSON(res, 400, { ok: false, error: '请填写邀请码' })
    }

    // 🔴 临界区（全同步，中间不得出现 await）：占码 → 建用户
    if (inviteCode) {
      const claim = claimInvite(inviteCode, uid, nv.value)
      if (!claim.ok) return sendJSON(res, 400, { ok: false, error: claim.error })
    }
    const user = createUser({ id: uid, name: nv.value, passwordHash: pwdHash, invite: inviteCode })
    ensureUserDir(user.id)
    touchLogin(user.id) // 注册即登录，最后登录时间此刻就是现在（否则界面显示「—」）
    // 🔴 临界区结束
    console.log(`[auth] 新用户注册：${user.name} (${user.id}) from ${ip}${inviteCode ? ` 邀请码=${inviteCode}` : ''}`)
    recordStat('register')
    return sendJSON(res, 200, { ok: true, user: publicUser(user) }, {
      // 注册即登录：种会话，同时清掉游客标记（否则下次打开还会被当成游客）
      'Set-Cookie': [issueSession(req, user.id), clearGuestCookie(req)],
    })
  }

  // ---- 登录 ----
  if (path === '/api/auth/login' && req.method === 'POST') {
    const rl = rateLimit(`login:${ip}`, 12, 10 * 60 * 1000)
    if (!rl.ok) return sendJSON(res, 429, { ok: false, error: `尝试次数过多，请 ${rl.retryAfter} 秒后再试` })

    let body
    try { body = await readJSONBody(req, 8 * 1024) } catch { return sendJSON(res, 400, { ok: false, error: '请求格式错误' }) }

    const user = findByName(body.name)
    // 🔴 用户名不存在与密码错误返回**同一句话**：分开提示等于免费提供用户名枚举
    if (!user || !verifyPassword(String(body.password || ''), user.pwd)) {
      return sendJSON(res, 401, { ok: false, error: '用户名或密码不正确' })
    }
    resetLimit(`login:${ip}`)
    touchLogin(user.id)
    console.log(`[auth] 登录：${user.name} from ${ip}`)
    recordStat('login')
    return sendJSON(res, 200, { ok: true, user: publicUser(findById(user.id)) }, {
      'Set-Cookie': [issueSession(req, user.id), clearGuestCookie(req)],
    })
  }

  // ---- 退出 ----
  if (path === '/api/auth/logout' && req.method === 'POST') {
    // 抹掉活跃会话：否则退出后旧 Cookie 仍被服务端认可（单会话下等于没退干净）
    const u = authUser(req)
    if (u) clearActiveSession(u.id)
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(req) })
  }

  // ---- 凭邀请码重置密码（WEB-06） ----
  if (path === '/api/auth/reset' && req.method === 'POST') {
    // 限流口径与登录一致：重置是暴力试邀请码的主要入口，必须按 IP 卡住
    const rl = rateLimit(`reset:${ip}`, 5, 10 * 60 * 1000)
    if (!rl.ok) return sendJSON(res, 429, { ok: false, error: `尝试次数过多，请 ${rl.retryAfter} 秒后再试` })

    let body
    try { body = await readJSONBody(req, 8 * 1024) } catch { return sendJSON(res, 400, { ok: false, error: '请求格式错误' }) }

    const nv = validateName(body.name)
    if (!nv.ok) return sendJSON(res, 400, { ok: false, error: nv.error })
    const pv = validatePassword(body.password)
    if (!pv.ok) return sendJSON(res, 400, { ok: false, error: pv.error })
    const invite = String(body.invite || '').trim().toUpperCase()
    if (!invite) return sendJSON(res, 400, { ok: false, error: '请填写注册时使用的那张邀请码' })

    const r = resetPasswordByInvite(nv.value, invite, hashPassword(pv.value))
    if (!r.ok) return sendJSON(res, 400, { ok: false, error: r.error })

    console.log(`[auth] 密码重置（凭邀请码）：${r.value.name} from ${ip}`)
    recordStat('reset')
    return sendJSON(res, 200, { ok: true, name: r.value.name })
  }

  // ---- 当前用户 ----
  if (path === '/api/auth/me' && req.method === 'GET') {
    // 用自己的 authCheck（此处位于公共 chk 定义之前，不能借用）
    const me = authCheck(req)
    if (!me.user) return sendJSON(res, 401, { ok: false, error: '未登录', code: sessionCode(me.reason) })
    const u = me.user
    // 🔴 不再每次调用都 usageOf() 重算：那会**递归遍历整个用户目录**（data.json + 全部外置 blob），
    //    重度用户几千个文件时是几百毫秒的同步 IO，而页面加载 + 底部胶囊每次都要调这个接口。
    //    usedBytes 由 PUT /api/data 与 blob 写入时同步维护，这里直接返回记录值即可
    //    （配额提示不需要精确到字节，滞后一次保存完全可接受）。
    return sendJSON(res, 200, { ok: true, user: publicUser(u) })
  }

  if (path === '/api/ping') {
    return sendJSON(res, 200, { ok: true, app: APP, now: Date.now() })
  }

  // ---- 以下全部需要登录 ----
  // 🔴 用 authCheck 而非 authUser：reason 要传给 401 的 code，前端靠它区分
  //    「登录过期」与「账号在别处登录」两句提示（WEB-02 单会话）。
  const chk = authCheck(req)
  const user = chk.user

  // ---- 整库读写（契约与便携版一致）----
  if (path === '/api/data') {
    if (!user) return sendJSON(res, 401, { ok: false, error: '未登录', code: sessionCode(chk.reason) })

    if (req.method === 'GET') {
      const r = readUserData(user.id)
      if (r.missing) return sendJSON(res, 404, { missing: true, path: userDataFile(user.id) })
      return sendJSON(res, 200, { text: r.text, path: userDataFile(user.id) })
    }

    // PUT（便携版常规写盘）与 POST（beforeunload 的 sendBeacon）都要接受
    if (req.method === 'PUT' || req.method === 'POST') {
      let buf
      try {
        buf = await readBody(req, MAX_BODY)
      } catch (e) {
        if (e && e.code === 'BODY_TOO_LARGE') {
          return sendJSON(res, 413, { ok: false, error: `数据超过单次上限（${Math.round(MAX_BODY / 1048576)} MB）` })
        }
        return sendJSON(res, 400, { ok: false, error: '请求体读取失败' })
      }
      if (!buf.length) return sendJSON(res, 400, { ok: false, error: '空数据被拒绝' })

      const text = buf.toString('utf8')
      let parsed
      try { parsed = JSON.parse(text) } catch { return sendJSON(res, 400, { ok: false, error: '内容不是有效 JSON' }) }
      // 🔴 kind 必须校验：只查 stores 会放过「结构不完整但能解析」的载荷
      //    （例如一次误发的空对象 `{}` 之外的畸形数据）。口径与 importGuestData /
      //    importDesktopData 一致 —— 三端数据契约靠这个字面量识别，漏一处就等于开了一个
      //    「能把用户整库写成残缺结构」的后门。
      if (!parsed || typeof parsed !== 'object' || typeof parsed.stores !== 'object') {
        return sendJSON(res, 400, { ok: false, error: '数据结构无效（缺少 stores）' })
      }
      if (parsed.kind !== 'portable-data') {
        return sendJSON(res, 400, { ok: false, error: '数据格式不是本软件的数据文件（缺少 kind 标识）' })
      }

      // 配额：新整库 + 现有外置数据（blobs）不得超过配额
      const currentData = existsSync(userDataFile(user.id)) ? statSync(userDataFile(user.id)).size : 0
      const blobsBytes = Math.max(0, usageOf(user.id) - currentData)
      const incoming = buf.length
      if (incoming + blobsBytes > user.quotaBytes) {
        const fmt = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)
        return sendJSON(res, 413, {
          ok: false,
          error: `存储空间不足：本次写入后约 ${fmt(incoming + blobsBytes)}，配额 ${fmt(user.quotaBytes)}`,
          quotaBytes: user.quotaBytes,
          usedBytes: incoming + blobsBytes,
        })
      }

      try {
        await writeUserData(user.id, text)
      } catch (e) {
        console.error('[data] 写入失败', user.name, e instanceof Error ? e.message : e)
        return sendJSON(res, 500, { ok: false, error: '服务器写入失败，请稍后重试' })
      }
      setUsedBytes(user.id, incoming + blobsBytes)
      return sendJSON(res, 200, { ok: true })
    }
    return sendJSON(res, 405, { ok: false, error: 'Method Not Allowed' })
  }

  // ---- 外置大块数据 ----
  if (path === '/api/blob' || path === '/api/blob/list') {
    if (!user) return sendJSON(res, 401, { ok: false, error: '未登录', code: sessionCode(chk.reason) })
    const store = qs.get('store') || ''

    if (path === '/api/blob/list' && req.method === 'GET') {
      const r = listBlobs(user.id, store)
      if (!r.ok) return sendJSON(res, 400, { ok: false, error: 'store 不允许' })
      return sendJSON(res, 200, { ok: true, ids: r.ids })
    }

    if (path === '/api/blob') {
      const id = qs.get('id') || ''
      if (!id) return sendJSON(res, 400, { ok: false, error: '缺少 id' })

      if (req.method === 'GET') {
        const r = readBlob(user.id, store, id)
        if (!r.ok) return sendJSON(res, 400, { ok: false, error: 'store 不允许' })
        if (r.missing) return sendJSON(res, 404, { ok: false, error: '不存在' })
        return sendJSON(res, 200, { ok: true, value: r.value })
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        let value
        try { value = await readJSONBody(req, MAX_BODY) } catch { return sendJSON(res, 400, { ok: false, error: '请求格式错误' }) }
        const r = await writeBlob(user.id, store, id, value)
        if (!r.ok) return sendJSON(res, 400, { ok: false, error: 'store 不允许' })
        setUsedBytes(user.id, usageOf(user.id))
        return sendJSON(res, 200, { ok: true })
      }
      if (req.method === 'DELETE') {
        const r = deleteBlob(user.id, store, id)
        if (!r.ok) return sendJSON(res, 400, { ok: false, error: 'store 不允许' })
        setUsedBytes(user.id, usageOf(user.id))
        return sendJSON(res, 200, { ok: true })
      }
      return sendJSON(res, 405, { ok: false, error: 'Method Not Allowed' })
    }
  }

  return sendJSON(res, 404, { ok: false, error: '接口不存在' })
}

// ---------- 服务器 ----------
const server = createServer((req, res) => {
  const started = Date.now()
  const url = req.url || '/'

  res.on('finish', () => {
    // 静态资源不记日志，否则 journal 会被 65 个 chunk 刷满
    if (url.startsWith('/api/') || res.statusCode >= 400) {
      console.log(`${req.method} ${res.statusCode} ${Date.now() - started}ms ${url.slice(0, 120)}`)
    }
  })

  if (req.method !== 'GET' && req.method !== 'HEAD' && !req.url?.startsWith('/api/')) {
    return sendText(res, 405, 'Method Not Allowed')
  }

  if (url.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      console.error('[api] 未捕获异常', e)
      if (!res.headersSent) sendJSON(res, 500, { ok: false, error: '服务器内部错误' })
      else res.destroy()
    })
    return
  }

  const [pathOnly] = url.split('?')

  // 静态资源：直接发（无需登录）
  const abs = resolveSafe(pathOnly)
  if (!abs) return sendText(res, 403, 'Forbidden')

  // ---- 页面级路由：必须**先于**静态/HTML 判定 ----
  // 🔴 这两个路径没有扩展名、也不存在于磁盘上，若放到后面的 HTML 分支里，
  //    会被「静态文件找不到 ⇒ 404」提前拦掉（实测 curl 直接拿到 404）。
  if (pathOnly === '/guest') {
    res.writeHead(302, { Location: '/', 'Set-Cookie': guestCookie(req), 'Cache-Control': 'no-store' })
    return res.end()
  }
  if (pathOnly === '/login') {
    // 从游客切回账号：清掉知情标记，让登录页重新出现
    const u = authUser(req)
    const setCookies = [clearGuestCookie(req)]
    if (u) setCookies.push(clearCookie(req))
    res.writeHead(302, { Location: '/', 'Set-Cookie': setCookies, 'Cache-Control': 'no-store' })
    return res.end()
  }
  if (pathOnly === '/reset') {
    // 重置密码页（WEB-06：凭邀请码）。已登录的人不需要重置 ⇒ 直接回工作台，
    // 避免「在已登录状态下打开重置页」这种会让用户困惑的分支。
    const u = authUser(req)
    if (u) {
      res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' })
      return res.end()
    }
    const html = renderResetPage({})
    const body = Buffer.from(html, 'utf8')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'SAMEORIGIN',
    })
    return res.end(req.method === 'HEAD' ? undefined : body)
  }
  if (pathOnly === '/logout') {
    // 退出登录：会话与游客标记一并清除，回到「登录页」这个真正的入口分流点。
    // 两条 cookie 都要清：只清会话的话，曾经点过「游客试用」的人会直接掉进游客模式，
    // 而不是回到登录页（用户会以为「退出后怎么还是这个界面」）。
    const u = authUser(req)
    if (u) clearActiveSession(u.id)
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': [clearCookie(req), clearGuestCookie(req)],
      'Cache-Control': 'no-store',
    })
    return res.end()
  }

  const ext = extname(abs).toLowerCase()
  // 根路径是无条件页面入口（不靠 Accept 判断）：任何访客打 `/` 都应该看到登录页或工作台。
  // 其余「无扩展名」的路径才需要 Accept: text/html —— 否则 /etc/passwd 这类探测请求
  // 也会拿到 200 首页（安全扫描记软 404，日志也失真）。
  const isRoot = pathOnly === '/' || pathOnly === ''
  const isHtmlRequest = ext === '.html' || isRoot
    || (!ext && String(req.headers.accept || '').includes('text/html'))

  if (!isHtmlRequest) {
    if (serveFile(req, res, abs, ext)) return
    return sendNotFound(req, res, pathOnly)
  }

  // ---- HTML：未登录给登录页，已登录给注入后的 index.html，游客给游客版 ----
  const cookies = parseCookies(req)
  const user = authUser(req)
  const isGuest = !user && cookies[GUEST_COOKIE] === '1'

  if (!user && !isGuest) {
    // 只在根路径与「无扩展名」的路径上给登录页；/assets 之类不会走到这里
    if (pathOnly === '/' || !ext) {
      const html = renderAuthPage({ mode: REGISTER_MODE })
      recordStat('visit_loginpage')
      const body = Buffer.from(html, 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'SAMEORIGIN',
      })
      return res.end(req.method === 'HEAD' ? undefined : body)
    }
    return sendText(res, 401, 'Unauthorized')
  }

  // user 为 null 时 renderIndex 走游客分支（不注入 __YFE_PORTABLE__ ⇒ 前端用 IndexedDB）
  const html = renderIndex(user)
  recordStat(user ? 'visit_cloud' : 'visit_guest')
  const body = Buffer.from(html, 'utf8')
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
})

server.listen(PORT, HOST, () => {
  console.log(`[yfe-web] listening on http://${HOST}:${PORT}`)
  console.log(`[yfe-web] www=${WWW_DIR} data=${DATA_DIR} quota=${(DEFAULT_QUOTA / 1048576).toFixed(0)}MB mode=${REGISTER_MODE}`)
})

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[yfe-web] ${sig} received, shutting down`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000)
  })
}
