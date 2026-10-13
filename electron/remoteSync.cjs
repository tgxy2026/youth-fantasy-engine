// 主进程 · 私有网盘同步内核（WebDAV / S3 兼容）· 3.0.2 新增
//
// 为什么必须有这一层：渲染进程 nodeIntegration=false，且浏览器同源策略会拦掉
//   跨域请求（WebDAV 服务器与 S3 端点几乎都不会回 CORS 头）。桌面版唯一的「后端」就是主进程，
//   与既有 `net:fetch`（联网检索）、`sync:readFile/writeFile`（本地云盘目录）同一道理。
//
// 🔴 安全性：这不是通用网络出口，而是**只认两类协议语义**的窄接口：
//   · WebDAV：GET / PUT / PROPFIND / MKCOL / DELETE，路径经 URL 解析（拒 file: 等）
//   · S3：GET / PUT / HEAD（SigV4 签名），endpoint 同样只允许 http/https
//   凭据（WebDAV 密码 / S3 secretKey）由渲染层随每次请求传入，主进程**一律不落盘、不记忆**
//   —— 与 `net:set-proxy` 的「渲染层持有配置、主进程不存储」同一条纪律。
//
// 🔴 与 syncTransport.FileTransport 的三态口径对齐：网络失败 / 认证失败 / 不存在 必须分开上报，
//   绝不能把「读不到」糊成「空库」（那会导致一次 push 覆盖云端真实数据）。
//
// 🔴🔴 自签证书开关（3.0.2 · 后补）：自建 NAS（群晖 / 威联通 / 极空间 / MinIO）常用**自签证书**，
//   默认走系统证书链会直接 `ERR_CERT_AUTHORITY_INVALID` 连不上。用户显式打开「信任自签证书」后，
//   本内核改用**专用 partition 会话**（而非全局 fetch）发请求，并在该会话上注册
//   `setCertificateVerifyProc` 放行「证书链不受信」这一类错误。
//   安全边界三重收窄：
//     ① 只挂在这个专用会话上 ⇒ 应用其余流量（AI 接口、联网检索、检查更新）仍走系统严格校验；
//     ② 开关默认**关**，且只随 WebDAV/S3 配置存本机 localStorage，不进同步载荷；
//     ③ 放行要同时满足「错误类别＝证书链不受信」**且**「证书确实覆盖该主机名、且在有效期内」；
//        主机名不符 / 已吊销 / 已过期 / 证书解析失败 一律回退 Chromium 严格校验
//        —— 不是「一律不校验」。判据见 isSelfSignedError + certCoversHost。
//   实机证据：`.workbuddy/tmp/selfsigned-live-probe.cjs`（开关开/关皆验）＋
//            `.workbuddy/tmp/selfsigned-mismatch-probe.cjs`（主机名不符必须仍被拒）。
'use strict'

const { createHash, createHmac } = require('node:crypto')

// ============ 通用 ============
const REQ_TIMEOUT_MS = 60000 // 云盘上传可能慢于本地写文件；给 60s
const MAX_BYTES = 64 * 1024 * 1024 // 同步快照是加密 JSON，几十 MB 量级封顶

// ============ 自签证书：专用会话（延迟 require electron，便于单测直接加载本文件）============
// 🔴 为什么用 `session.fromPartition` 而不是给全局 fetch 打参数：Electron 的证书校验回调只能挂在
//    session 上，且 **`net.fetch(url, { session })` 实测不触发 `setCertificateVerifyProc`**
//    （只有 `ses.fetch()` 触发 —— 2026-10-13 用真实 Electron 44 探针逐条验过）。
const CERT_PARTITION = 'yfe-private-cloud'
/** 只有用户显式打开开关后才为真；每次请求由渲染层传入，等于「逐请求显式授权」，主进程不落盘。 */
let trustSelfSignedActive = false
let certSession = null
let certProcRegistered = false
let certProcState = null // 上次注册时的开关态，用于「开关变化才重挂」

/**
 * 该证书错误是否属于「自签 / 私有 CA 未入系统根」这一档（可被开关放行）。
 * 🔴 刻意**不含**主机名不匹配 / 已吊销 / 已过期 —— 那几类是真风险信号，
 *    放行等于把开关变成「一律不校验」，与「只多信一张自签证书」的承诺不符。
 *    `-200` 恰是「主机名不符」的错误码，故**不在**下表内。
 *
 * ⚠️ 实测（Electron 44 · 2026-10-13）：**主机名不符时 Chromium 也会报 -202 /
 *    AUTHORITY_INVALID**（因为 CA 本来就不可信），错误码无法区分二者 ⇒
 *    必须再叠加「证书是否真的覆盖本主机名」的判据，见 certCoversHost()。
 */
const SELF_SIGNED_CODES = new Set([
  -202, // 证书链不受信（自签 / 私有 CA 未导入系统根）—— 开关的主目标
  -214, // 弱签名算法
  -216, // 弱密钥
  -217, // 名称约束违规
])
const SELF_SIGNED_RESULTS = /ERR_CERT_(AUTHORITY_INVALID|WEAK_SIGNATURE_ALGORITHM|WEAK_KEY|NAME_CONSTRAINT_VIOLATION)/

function isSelfSignedError(req) {
  if (!req) return false
  if (typeof req.errorCode === 'number' && SELF_SIGNED_CODES.has(req.errorCode)) return true
  return SELF_SIGNED_RESULTS.test(String(req.verificationResult || ''))
}

/**
 * 🔴🔴 安全边界的关键一环：证书是否**真的覆盖**该主机名。
 *
 * 为什么必须有它：实测（Electron 44）主机名不符与纯自签**报同一个错误码**，
 *   只看错误码 = 主机名不符也会被放行 —— 那等于「一律不校验」，是我第一版踩的坑
 *   （被 .workbuddy/tmp/selfsigned-mismatch-probe.cjs 当场抓出）。
 *
 * 判据（三重，全过才算「只是证书链不受信」）：
 *   ① 能解析出证书（Node 内置 crypto.X509Certificate，零依赖）；
 *   ② 证书覆盖请求主机名（域名走 checkHost；IP 走 checkIP，并**兼容把 IP 写成 DNS SAN** 的常见做法）；
 *   ③ 证书**仍在有效期内**（过期证书不放行 —— 过期是真风险信号）。
 * 任一条不满足 ⇒ 交回 Chromium 严格校验（`callback(-3)`）。
 */
function certCoversHost(req) {
  try {
    const pem = req && req.certificate && req.certificate.data
    if (typeof pem !== 'string' || !pem) return false
    // 延迟取，避免顶层依赖（本文件要在无 Electron 的纯 Node 单测里加载）
    const { X509Certificate } = require('node:crypto')
    const cert = new X509Certificate(pem)
    const host = String(req.hostname || '').replace(/^\[|\]$/g, '').toLowerCase() // 去掉 IPv6 方括号
    if (!host) return false
    // ② 覆盖判定：先按域名 / IP 正规判，再兜底扫 SAN 串（兼容 IP 被写成 DNS SAN 的情况）
    let covered = false
    try { covered = Boolean(cert.checkHost(host)) } catch { covered = false }
    if (!covered) {
      try { covered = Boolean(cert.checkIP(host)) } catch { covered = false }
    }
    if (!covered) {
      // 兜底：SAN 里可能存在 `DNS:192.168.1.10` 这种「把 IP 当 DNS 名」的写法。
      // 🔴 只做**逐条全等**比较（不做通配 / 不做后缀匹配），避免把「*.example.com」之类的
      //    通配规则误判成覆盖 —— 通配的正规判定交给上面的 checkHost。
      const san = String(cert.subjectAltName || '')
      covered = san
        .split(/,\s*/)
        .some((entry) => {
          const v = entry.replace(/^(DNS|IP Address|IP):/i, '').trim().toLowerCase()
          return v === host
        })
    }
    if (!covered) return false
    // ③ 有效期（不信任已过期 / 尚未生效的证书）
    const now = Date.now()
    const from = cert.validFromDate instanceof Date ? cert.validFromDate.getTime() : Date.parse(cert.validFrom)
    const to = cert.validToDate instanceof Date ? cert.validToDate.getTime() : Date.parse(cert.validTo)
    if (Number.isFinite(from) && now < from) return false
    if (Number.isFinite(to) && now > to) return false
    return true
  } catch {
    return false // 解析失败一律不放行（默认拒绝）
  }
}

/**
 * 取（并配置）专用 partition 会话。只有 `session` 可用时才会创建。
 * 回调语义（Electron 官方）：`0` = 接受；`-2` = 拒绝；`-3` = 沿用 Chromium 的校验结果。
 */
function getCertSession() {
  if (certSession) return certSession
  let session
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    session = require('electron').session
  } catch {
    return null // 单测 / 纯 Node 环境：无 Electron，退回全局 fetch（开关自然失效，不报错）
  }
  if (!session || typeof session.fromPartition !== 'function') return null
  try {
    // cache:false —— 同步是「权威数据搬运」，不要被 HTTP 缓存搅乱 rev 判定
    certSession = session.fromPartition(CERT_PARTITION, { cache: false })
  } catch {
    certSession = null
  }
  return certSession
}

/** 按当前开关态（重）挂证书校验回调；开关变化时才重挂，避免每次请求都动 session。 */
function ensureCertProc() {
  const ses = getCertSession()
  if (!ses || typeof ses.setCertificateVerifyProc !== 'function') return null
  if (certProcRegistered && certProcState === trustSelfSignedActive) return ses
  if (!trustSelfSignedActive) {
    // 关掉开关：还原 Chromium 默认严格校验（并清掉 network service 里可能缓存的放行结果）
    try { ses.setCertificateVerifyProc(null) } catch { /* 忽略 */ }
    certProcRegistered = false
    certProcState = false
    return ses
  }
  try {
    ses.setCertificateVerifyProc((req, callback) => {
      // 🔴🔴 两个条件**同时**满足才放行 —— 缺一不可：
      //   ① 错误类别是「证书链不受信」（而非主机名不符 / 已吊销 / 过期等错误码）；
      //   ② 证书**确实覆盖当前主机名**且在有效期内（实测主机名不符会同报 -202，只看①会误放行）。
      // 其余一律 `callback(-3)` 交回 Chromium 严格校验 —— 该拒还是拒。
      if (isSelfSignedError(req) && certCoversHost(req)) callback(0) // 0 = 接受该证书
      else callback(-3) // -3 = 沿用 Chromium 的校验结果
    })
    certProcRegistered = true
    certProcState = true
  } catch {
    certProcRegistered = false
  }
  return ses
}
function setTrustSelfSigned(on) {
  trustSelfSignedActive = on === true
  ensureCertProc()
}

/** 结果形状：{ ok:true, status, text, headers } | { ok:false, error, status?, code? } —— **永不 throw** */
function fail(error, extra) {
  return Object.assign({ ok: false, error: String(error || '请求失败') }, extra || {})
}

/** 只允许 http/https（拒绝 file: 等，防借它读本地文件） */
function assertHttpUrl(raw) {
  const u = new URL(String(raw))
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('不允许的协议：' + u.protocol)
  }
  return u
}

/**
 * 发一次请求并按大小上限流式读取（超限中止）。返回 { status, text, headers }。
 * @param {URL} url
 * @param {{method?:string, headers?:Record<string,string>, body?:string|null}} init
 */
async function request(url, init) {
  const opts = init || {}
  const method = String(opts.method || 'GET').toUpperCase()
  const headers = {}
  for (const [k, v] of Object.entries(opts.headers || {})) {
    const lk = String(k).toLowerCase()
    // 与 net:fetch 同口径：不带 cookie/referer/origin/host，防把主进程会话带出去
    if (lk === 'cookie' || lk === 'referer' || lk === 'origin' || lk === 'host') continue
    if (v == null) continue
    headers[k] = String(v)
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS)
  let res
  try {
    // 🔴 开关打开时改走专用 partition 会话的 fetch —— 只有 `ses.fetch` 会触发
    //    `setCertificateVerifyProc`（全局 fetch / `net.fetch(url,{session})` 实测都不触发）。
    const ses = trustSelfSignedActive ? ensureCertProc() : null
    const doFetch = ses && typeof ses.fetch === 'function'
      ? (u, o) => ses.fetch(u, o)
      : (u, o) => fetch(u, o)
    res = await doFetch(url.toString(), {
      method,
      headers,
      body: (method === 'GET' || method === 'HEAD') ? undefined : (opts.body == null ? undefined : String(opts.body)),
      redirect: 'follow',
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (res.url && !/^https?:/i.test(res.url)) {
    return fail('被重定向到非 http(s) 地址，已中止')
  }
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null
  const chunks = []
  let received = 0
  if (reader) {
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      received += step.value.byteLength
      if (received > MAX_BYTES) {
        try { await reader.cancel() } catch { /* 忽略 */ }
        return fail('响应超过 ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB 上限，已中止', { status: res.status })
      }
      chunks.push(Buffer.from(step.value))
    }
  } else {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > MAX_BYTES) {
      return fail('响应超过 ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB 上限，已中止', { status: res.status })
    }
    chunks.push(buf)
  }
  const outHeaders = {}
  try {
    for (const [k, v] of res.headers.entries()) outHeaders[k.toLowerCase()] = v
  } catch { /* 忽略 header 读取失败 */ }
  return { ok: true, status: res.status, text: Buffer.concat(chunks).toString('utf-8'), headers: outHeaders }
}

/** 把 URL path 各段做最小百分号编码（保留 / 分隔；空格、中文、特殊符号转义；不重复编码已转义字符） */
function encodePath(p) {
  return String(p)
    .split('/')
    .map((seg) => {
      // 已经是 %XX 形式的段不再二次编码（避免 %25 之类）
      if (/%[0-9A-Fa-f]{2}/.test(seg)) return seg
      return encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    })
    .join('/')
}

// ============ WebDAV ============
/**
 * WebDAV 请求。凭据由渲染层传入（username/password），主进程不落盘。
 * @param {string} url 完整请求 URL
 * @param {{method?:string, headers?:Record<string,string>, body?:string|null,
 *          username?:string, password?:string, trustSelfSigned?:boolean}} init
 */
async function webdavRequest(url, init) {
  let u
  try {
    u = assertHttpUrl(url)
  } catch (e) {
    return fail(e && e.message ? e.message : e)
  }
  const opts = init || {}
  // 🔴 逐请求显式授权：只有本次调用带了 trustSelfSigned:true 才放宽证书校验
  setTrustSelfSigned(opts.trustSelfSigned === true)
  const headers = Object.assign({}, opts.headers || {})
  const user = typeof opts.username === 'string' ? opts.username : ''
  const pass = typeof opts.password === 'string' ? opts.password : ''
  // Basic 认证：WebDAV 服务（坚果云 / Nextcloud / Synology / 群晖 WebDAV 等）均支持
  if (user || pass) {
    headers['Authorization'] = 'Basic ' + Buffer.from(user + ':' + pass, 'utf-8').toString('base64')
  }
  try {
    return await request(u, { method: opts.method, headers, body: opts.body })
  } catch (err) {
    return fail(err && err.message ? err.message : err)
  }
}

// ============ S3 兼容（AWS SigV4）============
/**
 * AWS Signature V4 签名所需的最小实现（只够 S3 的 PUT/GET/HEAD，含 UNSIGNED-PAYLOAD）。
 *
 * 🔴 为什么手写而不是引 aws-sdk：本项目 dependencies 为空（零依赖政策，见 package.json），
 *    而 SigV4 是**公开且稳定**的算法（AWS 文档明示），手写约 60 行即可，且完全可单测
 *    （见 tests/s3Signature.test.ts 的官方测试向量）。
 */

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

/** SigV4 规范：对 URI path 逐段编码；对象键里的 / 保留 */
function s3CanonicalUri(pathname) {
  return encodePath(pathname || '/')
}

/** SigV4 规范：query 按 key 排序、各自编码后用 & 连接 */
function s3CanonicalQuery(searchParams) {
  const pairs = []
  for (const [k, v] of searchParams.entries()) {
    pairs.push([k, v])
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return pairs
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&')
}

/** 把 header 名排序、小写、值 trim 后拼成规范头 */
function s3CanonicalHeaders(headers, signedNames) {
  const sorted = [...signedNames].sort()
  const lines = sorted.map((n) => n.toLowerCase() + ':' + String(headers[n] ?? headers[n.toLowerCase()] ?? '').trim())
  return { canonical: lines.join('\n') + '\n', signed: sorted.map((n) => n.toLowerCase()).join(';') }
}

/**
 * 生成 SigV4 认证头。
 *
 * 🔴 拆成 signV4（纯算法：调用方给全部头与载荷哈希）+ signS3（S3 策略：补 host /
 *    x-amz-content-sha256 / x-amz-date 三头）两层，好处是**官方测试向量可逐字节校准**：
 *    AWS 的 aws-sig-v4-test-suite `get-vanilla` 用例的规范头集只有 `host;x-amz-date`
 *    （不含 x-amz-content-sha256），只有留出「调用方完全控制头集」的入口，才能用它对照——
 *    否则永远只能自己和自己比（我第一版就是这么把测试写歪的）。
 *
 * @param {{method:string, url:string, headers:Record<string,string>, payloadHash:string,
 *          accessKey:string, secretKey:string, region:string, service:string, now:Date}} p
 * @returns {{Authorization:string, signed:string}}
 */
function signV4(p) {
  const method = String(p.method || 'GET').toUpperCase()
  const u = new URL(p.url)
  const amzDate = p.now.toISOString().replace(/[:-]|\.\d{3}/g, '') // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = p.payloadHash

  const headers = Object.assign({}, p.headers || {})
  const signedNames = Object.keys(headers)
  const { canonical, signed } = s3CanonicalHeaders(headers, signedNames)

  const canonicalRequest = [
    method,
    s3CanonicalUri(u.pathname),
    s3CanonicalQuery(u.searchParams),
    canonical,
    signed,
    payloadHash,
  ].join('\n')

  const credentialScope = dateStamp + '/' + p.region + '/' + p.service + '/aws4_request'
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  let k = Buffer.from('AWS4' + p.secretKey, 'utf-8')
  for (const part of [dateStamp, p.region, p.service, 'aws4_request']) {
    k = hmac(k, part)
  }
  const signature = createHmac('sha256', k).update(stringToSign).digest('hex')

  const authorization =
    'AWS4-HMAC-SHA256 Credential=' + p.accessKey + '/' + credentialScope +
    ', SignedHeaders=' + signed +
    ', Signature=' + signature

  return { Authorization: authorization, signed, amzDate, payloadHash, credentialScope, signature }
}

/**
 * S3 专用签名：在 signV4 之上补 S3 必需的三头（host / x-amz-content-sha256 / x-amz-date）。
 * @param {{method:string, url:string, headers?:Record<string,string>, payload:string|null,
 *          accessKey:string, secretKey:string, region?:string, service?:string, now?:Date}} p
 * @returns {{Authorization:string}}
 */
function signS3(p) {
  const u = new URL(p.url)
  const now = p.now || new Date()
  // 载荷哈希：本项目用 UNSIGNED-PAYLOAD（HTTPS 下 S3 接受；避免把整个 body 再算一次 SHA256）
  const payloadHash = p.payload == null ? sha256Hex('') : 'UNSIGNED-PAYLOAD'

  const headers = Object.assign({}, p.headers || {})
  headers['host'] = u.host
  headers['x-amz-content-sha256'] = payloadHash
  headers['x-amz-date'] = now.toISOString().replace(/[:-]|\.\d{3}/g, '') // YYYYMMDDTHHMMSSZ

  const r = signV4({
    method: p.method || 'GET', url: p.url, headers, payloadHash,
    accessKey: p.accessKey, secretKey: p.secretKey,
    region: p.region || 'us-east-1', service: p.service || 's3', now,
  })
  return { Authorization: r.Authorization, 'x-amz-date': headers['x-amz-date'], 'x-amz-content-sha256': payloadHash, host: u.host }
}

/** 供测试使用的纯 SigV4 入口（不带 S3 头策略）。 */
function signV4ForTest(p) {
  return signV4(Object.assign({ region: 'us-east-1', service: 'service', now: new Date() }, p))
}

/**
 * S3 请求（自动签名）。凭据由渲染层传入，主进程不落盘。
 * @param {{endpoint:string, path:string, method?:string, headers?:Record<string,string>,
 *          body?:string|null, accessKey:string, secretKey:string, region?:string,
 *          style?:'path'|'virtual', trustSelfSigned?:boolean}} p
 */
async function s3Request(p) {
  let base
  try {
    base = assertHttpUrl(p.endpoint)
  } catch (e) {
    return fail(e && e.message ? e.message : e)
  }
  // 🔴 逐请求显式授权：只有本次调用带了 trustSelfSigned:true 才放宽证书校验
  setTrustSelfSigned(p.trustSelfSigned === true)
  const path = String(p.path || '')
  let url
  if (p.style === 'virtual') {
    // 虚拟主机风格：https://bucket.endpoint/key
    url = new URL(base.protocol + '//' + p.bucket + '.' + base.host + encodePath(path || '/'))
  } else {
    url = new URL(base.protocol + '//' + base.host + encodePath(path || '/'))
  }
  const method = String(p.method || 'GET').toUpperCase()
  const payload = (method === 'PUT') ? (p.body == null ? '' : String(p.body)) : null
  let auth
  try {
    auth = signS3({
      method, url: url.toString(), headers: p.headers || {}, payload,
      accessKey: p.accessKey, secretKey: p.secretKey, region: p.region || 'us-east-1',
    })
  } catch (err) {
    return fail('签名失败：' + (err && err.message ? err.message : err))
  }
  const headers = Object.assign({}, p.headers || {}, auth)
  try {
    return await request(url, { method, headers, body: payload })
  } catch (err) {
    return fail(err && err.message ? err.message : err)
  }
}

module.exports = { webdavRequest, s3Request, signS3, signV4ForTest, encodePath, setTrustSelfSigned, isSelfSignedError, certCoversHost }
