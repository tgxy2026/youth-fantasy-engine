/**
 * 备份加密工具 · 单测（2026-10-06 补）
 *
 * 为什么补：`lib/crypto.ts` 是**安全关键**模块（备份加密导出/导入，唯一消费者 BackupManager），
 * 但长期零测试覆盖 —— 属于「改了没人拦、坏了用户在真实数据上才发现」的那一类。
 * 加密写错的方向特别危险：**静默返回垃圾**（用户以为备份是好的），所以这里重点钉「必须抛」。
 *
 * 覆盖：往返一致、信封格式、错误密码必须抛、密文篡改必须抛、随机性（salt/iv 不复用）、
 *       边界输入（空对象/中文/emoji/长文本）、残缺信封的失败方式、isEncrypted 判据。
 */
import { encryptJSON, decryptJSON, isEncrypted, type EncryptedEnvelope } from '../src/lib/crypto'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
/** 断言异步调用会抛（返回 true）——「必须抛」是这批测试的主线 */
async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false } catch { return true }
}

async function main() {
  // ---------- 1) 往返一致 ----------
  {
    const obj = { a: 1, b: '中文', c: [1, 2, { d: true }], e: null }
    const enc = await encryptJSON(obj, 'pw-123')
    ok('1a 加密产物是字符串', typeof enc === 'string' && enc.length > 0)
    const dec = await decryptJSON<typeof obj>(enc, 'pw-123')
    ok('1b 解密与原文深度一致', JSON.stringify(dec) === JSON.stringify(obj), JSON.stringify(dec))
    ok('1c 明文不出现在密文里（真加密了）', !enc.includes('中文') && !enc.includes('"a"'))
  }

  // ---------- 2) 信封格式 ----------
  {
    const enc = await encryptJSON({ x: 1 }, 'pw')
    const env = JSON.parse(enc) as EncryptedEnvelope
    ok('2a 信封带 encrypted:true', env.encrypted === true)
    ok('2b 信封带版本位 v', env.v === 1, String(env.v))
    ok('2c 信封含 salt / iv / data 三段', !!env.salt && !!env.iv && !!env.data)
    // salt 16B / iv 12B → base64 长度可推（16→24 含 padding、12→16）
    ok('2d salt 长度符合 16 字节', Buffer.from(env.salt, 'base64').length === 16, String(Buffer.from(env.salt, 'base64').length))
    ok('2e iv 长度符合 12 字节', Buffer.from(env.iv, 'base64').length === 12, String(Buffer.from(env.iv, 'base64').length))
    ok('2f 信封本身可被 isEncrypted 认出', isEncrypted(enc))
  }

  // ---------- 3) 🔴 错误密码必须抛（不能静默出垃圾） ----------
  {
    const enc = await encryptJSON({ secret: '重要数据' }, 'right-pw')
    ok('3a 错误密码解密必须抛（AES-GCM 完整性校验）', await throws(() => decryptJSON(enc, 'wrong-pw')))
    ok('3b 空密码解密必须抛', await throws(() => decryptJSON(enc, '')))
    // 负面对照思路：正确密码必须能解出来 —— 否则「3a 抛了」可能只是因为整体坏了
    const good = await decryptJSON<{ secret: string }>(enc, 'right-pw')
    ok('3c 正确密码仍能解开（证明 3a 有判别力）', good.secret === '重要数据')
  }

  // ---------- 4) 🔴 密文被篡改必须抛 ----------
  {
    const enc = await encryptJSON({ n: 1 }, 'pw')
    const env = JSON.parse(enc) as EncryptedEnvelope
    const bytes = Buffer.from(env.data, 'base64')
    bytes[0] = bytes[0] ^ 0xff                       // 翻转第一个字节
    const tampered = JSON.stringify({ ...env, data: bytes.toString('base64') })
    ok('4a 篡改密文后解密必须抛（GCM 认证标签）', await throws(() => decryptJSON(tampered, 'pw')))
    const env2 = JSON.parse(enc) as EncryptedEnvelope
    const ivBytes = Buffer.from(env2.iv, 'base64'); ivBytes[0] ^= 0xff
    const badIv = JSON.stringify({ ...env2, iv: ivBytes.toString('base64') })
    ok('4b 篡改 iv 后解密必须抛', await throws(() => decryptJSON(badIv, 'pw')))
  }

  // ---------- 5) 随机性：salt/iv 不得复用 ----------
  {
    const a = JSON.parse(await encryptJSON({ same: true }, 'pw')) as EncryptedEnvelope
    const b = JSON.parse(await encryptJSON({ same: true }, 'pw')) as EncryptedEnvelope
    ok('5a 两次加密的 salt 不同', a.salt !== b.salt)
    ok('5b 两次加密的 iv 不同', a.iv !== b.iv)
    ok('5c 同一明文两次密文不同（未复用密钥流）', a.data !== b.data)
  }

  // ---------- 6) 边界输入 ----------
  {
    for (const [label, obj] of [
      ['空对象', {}],
      ['空数组', []],
      ['中英混排', { t: '第一章 · 风起😀 ——”引号“与\\反斜杠' }],
      ['含换行与制表', { t: 'a\nb\tc' }],
      ['深嵌套', { a: { b: { c: { d: { e: [1, 2, 3] } } } } }],
      ['长文本', { t: 'x'.repeat(120000) }],
    ] as [string, unknown][]) {
      const enc = await encryptJSON(obj, 'p')
      const dec = await decryptJSON(enc, 'p')
      ok(`6 ${label} 往返一致`, JSON.stringify(dec) === JSON.stringify(obj))
    }
  }

  // ---------- 7) 解密入参非法时的失败方式（要抛、且信息可读） ----------
  {
    ok('7a 非 JSON 文本必须抛', await throws(() => decryptJSON('not json at all', 'p')))
    ok('7b 普通 JSON（无 encrypted 位）必须抛', await throws(() => decryptJSON('{"a":1}', 'p')))
    ok('7c encrypted:false 必须抛', await throws(() => decryptJSON('{"encrypted":false}', 'p')))
    let msg = ''
    try { await decryptJSON('not json', 'p') } catch (e) { msg = String((e as Error).message) }
    ok('7d 错误信息可读（不是 undefined/空）', msg.length > 4, msg)
    // 残缺信封：缺 salt/iv/data —— 必须抛而不是静默成功
    const env = JSON.parse(await encryptJSON({ a: 1 }, 'p')) as EncryptedEnvelope
    ok('7e 缺 data 的信封必须抛', await throws(() => decryptJSON(JSON.stringify({ ...env, data: '' }), 'p')))
    ok('7f 缺 salt 的信封必须抛', await throws(() => decryptJSON(JSON.stringify({ ...env, salt: '' }), 'p')))
  }

  // ---------- 8) isEncrypted 判据（决定导入时要不要问密码） ----------
  {
    ok('8a 普通文本 → false', isEncrypted('hello') === false)
    ok('8b 普通 JSON → false', isEncrypted('{"a":1}') === false)
    ok('8c 加密信封 → true', isEncrypted(await encryptJSON({ a: 1 }, 'p')) === true)
    ok('8d encrypted:"true"（字符串）→ false（严格布尔判据）', isEncrypted('{"encrypted":"true"}') === false)
    ok('8e null/空串 → false', isEncrypted('') === false && isEncrypted('null') === false)
  }

  console.log(`\ncrypto: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main().catch(e => { console.error('crypto 测试自身异常:', e); process.exit(1) })
