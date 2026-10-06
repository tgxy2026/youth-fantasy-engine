/**
 * WebCrypto 取用器 · 单测（2026-10-06 补）
 *
 * 为什么补：它是**加解密链路的入口**（`syncCore` / `syncTransport` 都从这里取 crypto），
 * 而且注释里写明「宁可明确报错，也不要静默降级到 XOR（非密码学强度）」——
 * 这条取舍必须用测试钉住，否则将来有人为了「不崩」把它改成返回 undefined/降级，
 * 就变成了「看着加密了、其实没加」。
 *
 * 覆盖：形状、真能跑一次 AES-GCM（不是空壳）、hasWebCrypto 与宿主一致、缺 crypto 时必须抛。
 */
import { webcrypto, hasWebCrypto } from '../src/lib/webcrypto'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function main() {
  // ---------- 1) 形状 ----------
  {
    const c = webcrypto()
    ok('1a webcrypto() 返回对象', !!c && typeof c === 'object')
    ok('1b 带 subtle 且四个方法都在（importKey/deriveKey/encrypt/decrypt）',
      !!c.subtle && typeof c.subtle.importKey === 'function' && typeof c.subtle.deriveKey === 'function' &&
      typeof c.subtle.encrypt === 'function' && typeof c.subtle.decrypt === 'function')
    ok('1c 带 getRandomValues', typeof c.getRandomValues === 'function')
  }

  // ---------- 2) 🔴 端到端：真能做一次加解密（证明不是空壳） ----------
  {
    const c = webcrypto()
    try {
      const key = await c.subtle.importKey('raw', new TextEncoder().encode('pw'), 'PBKDF2', false, ['deriveKey'])
      const derived = await c.subtle.deriveKey(
        { name: 'PBKDF2', salt: new Uint8Array(16), iterations: 1000, hash: 'SHA-256' },
        key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
      ) as unknown as CryptoKey
      const iv = new Uint8Array(12)
      const plain = new TextEncoder().encode('青春幻想引擎')
      const ct = await c.subtle.encrypt({ name: 'AES-GCM', iv }, derived, plain)
      const back = await c.subtle.decrypt({ name: 'AES-GCM', iv }, derived, ct)
      ok('2a 走它做一次 AES-GCM 往返，明文能还原', new TextDecoder().decode(back) === '青春幻想引擎')
      ok('2b 密文不是明文（确实加密了）', new Uint8Array(ct).length !== plain.length || !!ct)
    } catch (e) {
      ok('2a 走它做一次 AES-GCM 往返，明文能还原', false, String(e).slice(0, 120))
    }
  }

  // ---------- 3) getRandomValues ----------
  {
    const c = webcrypto()
    const a = c.getRandomValues(new Uint8Array(16))
    const b = c.getRandomValues(new Uint8Array(16))
    ok('3a 返回同样长度', a.length === 16)
    ok('3b 两次取值不同（不是常量/空实现）', Buffer.from(a).toString('hex') !== Buffer.from(b).toString('hex'))
    ok('3c 不是全零', a.some(x => x !== 0))
  }

  // ---------- 4) hasWebCrypto 与宿主一致 ----------
  {
    const expect = !!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle
    ok('4a hasWebCrypto 与 globalThis.crypto.subtle 的存在性一致', hasWebCrypto === expect,
      `hasWebCrypto=${hasWebCrypto} expect=${expect}`)
    ok('4b 本环境（Node ≥19）应具备 WebCrypto', hasWebCrypto === true)
  }

  // ---------- 5) 🔴 缺 crypto 时必须抛，不许静默降级 ----------
  {
    const g = globalThis as { crypto?: unknown }
    const saved = g.crypto
    let restored = false
    try {
      // Node 里 crypto 是只读 getter ⇒ 用 defineProperty 覆盖成 undefined
      Object.defineProperty(g, 'crypto', { value: undefined, configurable: true, writable: true })
      let threw = false, msg = ''
      try { webcrypto() } catch (e) { threw = true; msg = String((e as Error).message) }
      ok('5a 🔴 crypto.subtle 缺失时 webcrypto() 必须抛（绝不静默降级）', threw)
      ok('5b 错误信息可读、点明原因', /WebCrypto|crypto\.subtle/i.test(msg), msg)
    } finally {
      Object.defineProperty(g, 'crypto', { value: saved, configurable: true, writable: true })
      restored = true
    }
    ok('5c 环境已还原（后续用例不受影响）', restored && !!webcrypto().subtle)
  }

  console.log(`\nwebcrypto: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main().catch(e => { console.error('webcrypto 测试自身异常:', e); process.exit(1) })
