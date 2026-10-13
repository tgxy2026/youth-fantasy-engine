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
'use strict'

const { createHash, createHmac } = require('node:crypto')

// ============ 通用 ============
const REQ_TIMEOUT_MS = 60000 // 云盘上传可能慢于本地写文件；给 60s
const MAX_BYTES = 64 * 1024 * 1024 // 同步快照是加密 JSON，几十 MB 量级封顶

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
    res = await fetch(url.toString(), {
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
 *          username?:string, password?:string}} init
 */
async function webdavRequest(url, init) {
  let u
  try {
    u = assertHttpUrl(url)
  } catch (e) {
    return fail(e && e.message ? e.message : e)
  }
  const opts = init || {}
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
 *          style?:'path'|'virtual'}} p
 */
async function s3Request(p) {
  let base
  try {
    base = assertHttpUrl(p.endpoint)
  } catch (e) {
    return fail(e && e.message ? e.message : e)
  }
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

module.exports = { webdavRequest, s3Request, signS3, signV4ForTest, encodePath }
