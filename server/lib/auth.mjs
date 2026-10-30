// ============ 认证原语：密码哈希 / 会话签名 / 用户名校验 ============
//
// 【为什么用 scrypt 而不是 sha256】写作工具的账号背后是作者几年的稿子，
// 库一旦泄露，弱口令在 sha256 面前等于明文。scrypt 是内存硬的（N=16384 约吃 16 MB），
// 批量爆破的性价比直接掉一个数量级；而且它是 node:crypto 内置的，不引入任何依赖。
//
// 【会话为什么不用存表】签名 Cookie（uid.exp.hmac）是无状态的：重启不掉线、不必清理过期行。
// 代价是「无法单方面踢人」—— 现阶段不需要，真要踢就换会话密钥（全员重登，可接受）。
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { writeTextAtomicSync } from './atomic.mjs'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 64

export function hashPassword(password) {
  const salt = randomBytes(16)
  // maxmem 必须显式给足：默认 32 MB，128*N*r = 16 MB 虽够，但留余量避免参数微调时突然抛错
  const key = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 96 * 1024 * 1024 })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`
}

/** 校验密码。任何解析异常都按「不匹配」处理，绝不抛给调用方 */
export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const [, n, r, p, saltHex, hashHex] = parts
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(hashHex, 'hex')
    if (!salt.length || !expected.length) return false
    const key = scryptSync(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 96 * 1024 * 1024,
    })
    return key.length === expected.length && timingSafeEqual(key, expected)
  } catch {
    return false
  }
}

/** 读取（或首次生成）会话签名密钥 */
export function loadOrCreateSecret(file) {
  if (existsSync(file)) {
    try {
      const s = readFileSync(file, 'utf8').trim()
      if (s.length >= 32) return Buffer.from(s, 'hex')
    } catch { /* 落到重建 */ }
  }
  const buf = randomBytes(32)
  writeTextAtomicSync(file, buf.toString('hex'))
  return buf
}

const b64u = (buf) => Buffer.from(buf).toString('base64url')

/**
 * 签发会话令牌（3.3.2 起为 4 段：`uid.sid.exp.sig`）。
 *
 * 🔴 为什么要加 `sid`：旧格式只有 `uid`，一个账号签出的所有令牌互相不可区分，
 *    服务端只能靠「记住当前那一个」来实现撤销（即单会话）。带上 `sid` 之后，
 *    同一个账号的多台设备各持一段可单独撤销的标识，撤销也不必再顶掉别人。
 * @param {string} uid 用户 id
 * @param {string} sid 会话 id（随机，随会话表一起存）
 * @param {number} exp 过期时间戳（ms）
 * @param {Buffer} secret 服务端签名密钥
 */
export function signSession(uid, sid, exp, secret) {
  if (!uid || !sid) throw new Error('signSession 需要 uid 与 sid')
  const payload = `${uid}.${sid}.${exp}`
  const sig = b64u(createHmac('sha256', secret).update(payload).digest())
  return `${payload}.${sig}`
}

/**
 * 令牌摘要 —— 会话表里**只存这个**，不存明文令牌。
 *
 * 🔴 换掉明文的意义：`users.json` 会被备份、会被运维拷走、可能被误传。
 *    存明文＝把每台设备的登录凭据一起交出去；存 HMAC 摘要，即使泄漏也换不回令牌。
 * 🔴 前缀 `session:` 是域分隔，避免与密码哈希等其他用途共用密钥时产生交叉场景。
 */
export function hashToken(token, secret) {
  return b64u(createHmac('sha256', secret).update(`session:${token}`).digest())
}

/**
 * 验签 + 验过期。
 * @returns {{ uid: string, sid: string } | null} 无效返回 null。
 *   3 段旧令牌（`uid.exp.sig`）仍然接受，`sid` 返回空串 —— **升级时不能让所有老会话立刻掉线**。
 */
export function verifySessionToken(token, secret) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  // 4 段 = 新格式；3 段 = 3.3.1 及更早的旧格式
  if (parts.length !== 4 && parts.length !== 3) return null
  const legacy = parts.length === 3
  const uid = parts[0]
  const sid = legacy ? '' : parts[1]
  const expStr = legacy ? parts[1] : parts[2]
  const sig = legacy ? parts[2] : parts[3]
  const exp = Number(expStr)
  if (!uid || !Number.isFinite(exp)) return null
  const payload = legacy ? `${uid}.${expStr}` : `${uid}.${sid}.${expStr}`
  const expect = b64u(createHmac('sha256', secret).update(payload).digest())
  // 长度不等时 timingSafeEqual 会抛错，先挡掉
  if (sig.length !== expect.length) return null
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null
  if (Date.now() > exp) return null
  return { uid, sid }
}

/** 用户名规则：2–24 位，允许中英文、数字、下划线、连字符 */
const NAME_RE = /^[\w\u4e00-\u9fa5-]{2,24}$/u
/** 保留名：避免与未来路由或系统标识冲突 */
const RESERVED = new Set(['admin', 'root', 'system', 'api', 'yfe', 'koke', '管理员', '系统'])

export function validateName(name) {
  const s = String(name || '').trim()
  if (!NAME_RE.test(s)) return { ok: false, error: '用户名需 2–24 位，仅限中英文、数字、下划线、连字符' }
  if (RESERVED.has(s.toLowerCase())) return { ok: false, error: '该用户名不可用' }
  return { ok: true, value: s }
}

export function validatePassword(pwd) {
  const s = String(pwd || '')
  if (s.length < 6) return { ok: false, error: '密码至少 6 位' }
  if (s.length > 128) return { ok: false, error: '密码过长' }
  return { ok: true, value: s }
}
