// ============ 3.3.2 · P1 桌面授权交换（一次性授权码）============
//
// 【要解决的问题】桌面版不共用浏览器 Cookie：用户不能在 Electron 里直接登录（也不该把
//   密码交给渲染进程），但账号数据在服务器上。行业做法是「系统浏览器登录 → 回环跳转交回
//   一次性授权码 → 桌面用 code + verifier 换长期令牌」。
//
// 【为什么是 PKCE 而不是简单回调】
//   回环地址 `http://127.0.0.1` 是**任何本机程序都能监听**的。若回调只带 code，
//   恶意程序可以抢先占端口拿到别人的 code。加 verifier 之后，code 本身换不出令牌 ——
//   因为恶意程序不知道桌面进程内存里那个随机 verifier（RFC 7636 的 S256 流程）。
//
// 🔴 五条不可让步的校验：
//   1. `state` 必须与桌面发起时保存的完全一致（防把攻击者的授权塞给受害者）；
//   2. `port` 必须在发起时登记的范围内，回调只跳 `127.0.0.1`（不跳 localhost、不跳外网）；
//   3. `code` 单次使用 + 60 秒过期（内存表，进程重启即失效 —— 重试成本远小于持久化风险）；
//   4. `SHA256(verifier)` 必须等于发起时的 `challenge`；
//   5. 令牌只放 JSON 响应体，**绝不进 URL、不进日志**。
//
// ⚠️ 内存表是刻意的：授权码只活 60 秒，落盘反而多一处可被读到的凭据。
//    代价是服务重启后那 60 秒内的授权要重来一次，用户重新点一下即可。
import { createHash, randomBytes } from 'node:crypto'

/** 待授权参数暂存的 Cookie 名（登录前把 challenge/port/state 带上，登录完再取回） */
export const DESKTOP_PENDING_COOKIE = 'yfe_dp'
/** 待授权参数的有效期：10 分钟（够走完登录/注册） */
export const DESKTOP_PENDING_TTL_MS = 10 * 60 * 1000
/** 授权码有效期：60 秒 */
export const DESKTOP_CODE_TTL_MS = 60 * 1000

const B64URL = /^[A-Za-z0-9_-]+$/
const STATE_RE = /^[A-Za-z0-9_-]{8,64}$/
const CHALLENGE_RE = /^[A-Za-z0-9_-]{32,64}$/

/** code 摘要（内存表里只存摘要，不存明文 code） */
const codeKey = (code) => createHash('sha256').update(`desktop:${code}`).digest('base64url')

/** challenge 校验：S256 的 base64url(SHA256(verifier))，长度 43 位 */
export function challengeOf(verifier) {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * 校验桌面发起参数。
 * @returns {{ ok: true, challenge: string, port: number, state: string } | { ok: false, error: string }}
 */
export function parseDesktopRequest(params) {
  const challenge = String(params.get('challenge') || '')
  const state = String(params.get('state') || '')
  const portRaw = String(params.get('port') || '')
  if (!CHALLENGE_RE.test(challenge) || !B64URL.test(challenge)) return { ok: false, error: 'challenge 无效' }
  if (!STATE_RE.test(state) || !B64URL.test(state)) return { ok: false, error: 'state 无效' }
  if (!/^\d{2,5}$/.test(portRaw)) return { ok: false, error: 'port 无效' }
  const port = Number(portRaw)
  // 只接受非特权端口：避免把授权码投递到 80/443 之类的系统端口上的其他服务
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, error: 'port 超出允许范围' }
  return { ok: true, challenge, port, state }
}

/** 把待授权参数编成 Cookie 值（含发起时间，用于过期判定） */
export function encodePending({ challenge, port, state, now = Date.now() }) {
  const raw = JSON.stringify({ c: challenge, p: port, s: state, at: now })
  return Buffer.from(raw, 'utf8').toString('base64url')
}

/** 解出待授权参数；任何异常/过期都返回 null（**不抛**，页面层不该因坏 Cookie 500） */
export function decodePending(value, now = Date.now()) {
  if (typeof value !== 'string' || !value) return null
  let obj
  try { obj = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { return null }
  if (!obj || typeof obj !== 'object') return null
  const { c, p, s, at } = obj
  if (typeof c !== 'string' || typeof s !== 'string' || !Number.isFinite(p) || !Number.isFinite(at)) return null
  if (now - at > DESKTOP_PENDING_TTL_MS) return null
  // 与 parseDesktopRequest 同一口径再校验一次：Cookie 可被用户篡改
  const again = parseDesktopRequest(new URLSearchParams({ challenge: c, port: String(p), state: s }))
  if (!again.ok) return null
  return { challenge: c, port: p, state: s, at }
}

// ---------- 一次性授权码（内存表） ----------
/** codeKey -> { uid, challenge, port, exp } */
const codes = new Map()

function sweep(now) {
  for (const [k, v] of codes) if (v.exp <= now) codes.delete(k)
}

/**
 * 签发授权码。
 * @returns {{ code: string, expiresAt: number }}
 */
export function issueCode({ uid, challenge, port, now = Date.now() }) {
  sweep(now)
  const code = randomBytes(32).toString('base64url')
  const expiresAt = now + DESKTOP_CODE_TTL_MS
  codes.set(codeKey(code), { uid, challenge, port, exp: expiresAt })
  return { code, expiresAt }
}

/**
 * 换取：校验 code 单次使用 + 未过期 + verifier 与 challenge 匹配。
 *
 * 🔴 先删后验：即使 verifier 不对，这次 code 也作废。否则攻击者可以拿抢到的 code
 *    无限次试 verifier（虽然 256 位随机猜不中，但没有理由给这个入口保留重试能力）。
 */
export function redeemCode({ code, verifier, now = Date.now() }) {
  sweep(now)
  if (typeof code !== 'string' || !code) return { ok: false, error: '缺少授权码', status: 400 }
  if (typeof verifier !== 'string' || verifier.length < 32 || verifier.length > 128) {
    return { ok: false, error: 'verifier 无效', status: 400 }
  }
  const key = codeKey(code)
  const rec = codes.get(key)
  if (!rec) return { ok: false, error: '授权码无效或已使用', status: 400 }
  codes.delete(key)
  if (rec.exp <= now) return { ok: false, error: '授权码已过期', status: 400 }
  if (challengeOf(verifier) !== rec.challenge) return { ok: false, error: '授权码与本次请求不匹配', status: 400 }
  return { ok: true, uid: rec.uid, port: rec.port }
}

/** 仅供自检：当前未消费的授权码条数（不导出明文） */
export function pendingCodeCount() {
  return codes.size
}
