/**
 * 备份加密工具（v1.3 新增 · P1 备份加固）
 * 基于浏览器原生 Web Crypto：PBKDF2 派生密钥 + AES-GCM 认证加密。
 * 纯前端、离线，便携版 / 桌面版均可用；不上传任何数据，密码不出本机。
 */

export interface EncryptedEnvelope {
  encrypted: true
  v: 1
  salt: string
  iv: string
  data: string
}

function toB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

const enc = new TextEncoder()
const dec = new TextDecoder()

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** 把任意对象加密为 JSON 字符串（含 salt/iv 的信封格式） */
export async function encryptJSON(obj: unknown, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt)
  const plain = enc.encode(JSON.stringify(obj))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain)
  const env: EncryptedEnvelope = {
    encrypted: true, v: 1,
    salt: toB64(salt.buffer), iv: toB64(iv.buffer), data: toB64(ct),
  }
  return JSON.stringify(env)
}

/** 解密信封为对象；密码错误会抛异常（AES-GCM 完整性校验失败） */
export async function decryptJSON<T>(text: string, password: string): Promise<T> {
  let env: EncryptedEnvelope
  try {
    env = JSON.parse(text)
  } catch {
    throw new Error('迁移包内容不是合法的 JSON 格式')
  }
  if (!env || env.encrypted !== true) throw new Error('该文件不是加密迁移包')
  // 三个字段一起解析：坏一份就整包不可解，逐个别报错反而说不清是哪儿坏了
  let salt: Uint8Array<ArrayBuffer>
  let ct: Uint8Array<ArrayBuffer>
  let iv: Uint8Array<ArrayBuffer>
  try {
    salt = fromB64(env.salt)
    ct = fromB64(env.data)
    iv = fromB64(env.iv)
  } catch {
    throw new Error('迁移包已损坏：加密字段不是合法的 Base64（原数据未改动）')
  }
  const key = await deriveKey(password, salt)
  /**
   * 🔴 3.2.2 · 审计 D6（P2）：解密失败必须给出**能读懂的理由**。
   *
   * WebCrypto 在 AES-GCM 校验失败时抛的 `OperationError` 在 Chromium 里 **message 是空串**，
   * 于是界面只剩「导入失败：」—— 冒号后面什么都没有。作者会误判成"软件卡死 / 原稿丢了"。
   * 这里统一翻成一句可操作的话（密码错与文件损坏在密码学上无法区分，故一并说明）。
   */
  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  } catch {
    throw new Error('密码错误或文件已损坏（解密校验未通过）—— 已有项目未受影响，请确认密码后重试')
  }
  try {
    return JSON.parse(dec.decode(plain)) as T
  } catch {
    throw new Error('迁移包解密后的内容不是合法的 JSON 格式（可能加密内容已损坏）')
  }
}

/** 判断文本是否为加密信封（用于导入时决定要不要问密码） */
export function isEncrypted(text: string): boolean {
  try {
    const o = JSON.parse(text)
    return !!(o && o.encrypted === true)
  } catch {
    return false
  }
}
