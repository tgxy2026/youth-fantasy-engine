// ============ WebCrypto 取用器（叶子模块，不 import 任何项目内模块）============
// 2026-09-19 结构优化 D7：自 syncCore.ts 抽出。
//
// 🔴 为什么必须单独一个文件、而不能放在 syncCore 里让别处引：
//    syncCore 已经 import 了 syncTransport（用它的 createIdleTransport），
//    若 syncTransport 反过来 import syncCore 取这个函数，就构成
//    `syncCore ↔ syncTransport` 环 —— `tests/importCycles` 会直接报红，
//    而这类环在浏览器里可能以 TDZ 形式炸在模块求值期（tsc 与单测都看不出来）。
//
// 🔴 为什么不能直接用 `globalThis.crypto`：lib.dom 把它声明成「一定存在」，
//    而老 Node（< 19）与非安全上下文（http 页面）下它其实是 undefined ——
//    直接读会在运行期炸。故这里用一个**局部收窄过的最小形状**，并给显式报错。

/** WebCrypto 的最小形状（只列本项目用到的四个方法）。外部无引用 → 不 export。 */
type CryptoApi = {
  subtle: {
    importKey(...a: unknown[]): Promise<unknown>
    deriveKey(...a: unknown[]): Promise<unknown>
    /** AES-GCM / SHA-256 按规范返回 ArrayBuffer */
    encrypt(...a: unknown[]): Promise<ArrayBuffer>
    decrypt(...a: unknown[]): Promise<ArrayBuffer>
    digest(...a: unknown[]): Promise<ArrayBuffer>
  }
  getRandomValues(a: Uint8Array): Uint8Array
}

/** 宿主形状：`crypto` 是可选的 —— 这正是不能用 lib.dom 声明的原因。外部无引用 → 不 export。 */
type CryptoHost = { crypto?: CryptoApi }

/**
 * 取 WebCrypto。
 *
 * 调用点通常已用 `hasSubtle`（`!!(globalThis as CryptoHost).crypto?.subtle`）把守，
 * 这里的 throw 是兜底 —— 宁可明确报错，也不要静默降级到 XOR（那是非密码学强度，
 * 只用于「HTTP 公网降级」这一条已废弃路径）。
 */
export function webcrypto(): CryptoApi {
  const c = (globalThis as CryptoHost).crypto
  if (!c || !c.subtle) throw new Error('当前环境不支持 WebCrypto（crypto.subtle 缺失）')
  return c
}

/** 当前环境是否具备 WebCrypto（加密载荷走 AES-GCM，否则走 XOR 混淆降级）。 */
export const hasWebCrypto = typeof globalThis !== 'undefined' && !!(globalThis as CryptoHost).crypto?.subtle
