// ============ HTTP 小工具（响应 / 请求体 / Cookie / IP） ============
// 只用 node: 内置模块 —— 服务端同样遵守「零运行时依赖」政策。

export function sendJSON(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

export function sendText(res, status, text, extraHeaders = {}) {
  const body = Buffer.from(String(text), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

/** 读取请求体，超过 limit 立刻中止（不把超大请求读进内存，1.7G 机器经不起） */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const fail = (code) => {
      if (done) return
      done = true
      const err = new Error(code)
      err.code = code
      // 不再读，直接丢弃后续数据，避免占着连接又占着内存
      req.destroy()
      reject(err)
    }
    req.on('data', (c) => {
      if (done) return
      size += c.length
      if (size > limit) return fail('BODY_TOO_LARGE')
      chunks.push(c)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (e) => {
      if (done) return
      done = true
      reject(e)
    })
    req.on('aborted', () => fail('ABORTED'))
  })
}

/**
 * 解析 JSON 请求体。
 * 🔴 空 body 一律按「格式错误」处理，不做「空表也能过」的妥协 ——
 *    否则一次误发的空 PUT 就能把用户整库清成 `{}`。
 */
export async function readJSONBody(req, limit) {
  const buf = await readBody(req, limit)
  if (!buf.length) {
    const e = new Error('EMPTY_BODY')
    e.code = 'EMPTY_BODY'
    throw e
  }
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    const e = new Error('BAD_JSON')
    e.code = 'BAD_JSON'
    throw e
  }
}

export function parseCookies(req) {
  const raw = req.headers.cookie
  if (!raw) return {}
  const out = {}
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

/**
 * 组装 Set-Cookie。
 * 🔴 生产走 HTTPS 时必须带 Secure；这里按请求协议自动判断，
 *    否则 http 调试期 Cookie 会被浏览器直接丢掉（表现为「登录成功了但一刷新就退出」）。
 */
export function buildCookie(name, value, { maxAge, secure, httpOnly = true, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`]
  if (httpOnly) parts.push('HttpOnly')
  if (secure) parts.push('Secure')
  parts.push('SameSite=Lax')
  if (typeof maxAge === 'number') parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`)
  return parts.join('; ')
}

/** 客户端 IP（华为云轻量直连，无前置代理；若将来加 CDN 再改这里） */
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim()
  return req.socket?.remoteAddress || 'unknown'
}

export function isSecureReq(req) {
  if (req.headers['x-forwarded-proto'] === 'https') return true
  return false // 直连时靠 TLS 终结在反代，故此处默认 false
}
