// ============ 存储 / 并发小闸契约（3.6.0 · 零覆盖长期债）============
//
// 这三个文件在覆盖率报告里是「零测试提及」，但各自守着一件**出事就难查**的事：
//   · `withProjectSettingsLock`：不支持跨窗口锁时**拒绝保存**，绝不能"静默不加锁地写"；
//   · `withAtlasSchemaLock`：同源串行化 schema 改动与恢复检查；
//   · `idbMigrateUtil`：迁移时判库存在（不创建）、删库永不 reject（尽力而为）。
// 这里用桩把「有没有锁 / 支不支持 / 抛不抛错」四条分支都走一遍。
import { withProjectSettingsLock } from '../src/lib/storage/projectSettingsLock'
import { withAtlasSchemaLock } from '../src/lib/atlas/schemaLock'
import { idbDbExists, idbDeleteDatabase } from '../src/lib/storage/idbMigrateUtil'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const g = globalThis as unknown as Record<string, unknown>
/**
 * 临时替换全局并还原。
 * 🔴 必须用 `defineProperty`：Node 22 的 `navigator` 是**只读 getter**，直接赋值会抛
 *    「only a getter」—— 而本测试恰恰要模拟「有 window 但没有 navigator.locks」。
 */
function withGlobals(patch: Record<string, unknown>, run: () => Promise<void>) {
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const k of Object.keys(patch)) {
    saved.set(k, Object.getOwnPropertyDescriptor(g, k))
    Object.defineProperty(g, k, { value: patch[k], writable: true, configurable: true, enumerable: true })
  }
  const restore = () => {
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(g, k, desc)
      else delete g[k]
    }
  }
  return run().finally(restore)
}

// ---------- ① withProjectSettingsLock ----------
{
  // 有 locks：走锁，并把回调结果透传
  let usedKey = ''
  await withGlobals({
    window: {},
    navigator: { locks: { request: async (key: string, _o: unknown, fn: () => Promise<unknown>) => { usedKey = key; return fn() } } },
  }, async () => {
    const r = await withProjectSettingsLock('p1', 'chapters', async () => 42)
    ok('① 有 navigator.locks ⇒ 走独占锁并透传结果', r === 42)
    ok('① 锁名带项目与键（不同项目/键不互相串行）', usedKey === 'yfe-project-setting:p1:chapters', usedKey)
  })

  // 没有 locks 但存在 window：必须**拒绝**，而不是不加锁地写
  await withGlobals({ window: {}, navigator: {} }, async () => {
    let ran = false
    const err = await withProjectSettingsLock('p1', 'chapters', async () => { ran = true; return 1 }).then(() => null, (e: Error) => e)
    ok('🔴 ① 不支持跨窗口锁时拒绝保存（绝不静默无锁写入）', !!err && /不支持跨窗口写入保护/.test(err.message), String(err))
    ok('① 拒绝时不执行写入回调', ran === false)
  })

  // 非浏览器环境（无 window / 无 locks）：直接执行
  await withGlobals({ window: undefined, navigator: {} }, async () => {
    const r = await withProjectSettingsLock('p1', 'chapters', async () => 'ok')
    ok('① 非浏览器环境直接执行（测试 / 主进程）', r === 'ok')
  })
}

// ---------- ② withAtlasSchemaLock ----------
{
  let usedKey = ''
  await withGlobals({
    window: {},
    navigator: { locks: { request: async (key: string, opts: { mode: string }, fn: () => Promise<unknown>) => { usedKey = `${key}|${opts.mode}`; return fn() } } },
  }, async () => {
    const r = await withAtlasSchemaLock('p1', 'chars', async () => 'done')
    ok('② 有 locks ⇒ 独占锁 + 透传结果', r === 'done' && usedKey === 'yfe-atlas-schema-v1:p1:chars|exclusive', usedKey)
  })

  await withGlobals({ window: undefined, navigator: {} }, async () => {
    const r = await withAtlasSchemaLock('p1', 'chars', async () => 'no-lock')
    ok('② 无锁环境直接执行', r === 'no-lock')
  })

  // 回调抛错要原样冒出去（不能吞掉，否则 schema 改动失败会被当成成功）
  await withGlobals({ window: undefined, navigator: {} }, async () => {
    const err = await withAtlasSchemaLock('p1', 'chars', async () => { throw new Error('schema boom') }).then(() => null, (e: Error) => e)
    ok('🔴 ② 回调抛错原样冒出去', !!err && err.message === 'schema boom', String(err))
  })
}

// ---------- ③ idbDbExists ----------
{
  await withGlobals({ indexedDB: undefined }, async () => {
    ok('③ 没有 indexedDB ⇒ 判不存在（迁移里当"没有旧库"）', (await idbDbExists('x')) === false)
  })

  await withGlobals({ indexedDB: { databases: async () => [{ name: 'a' }, { name: 'b' }] } }, async () => {
    ok('③ 列表里有 ⇒ true', (await idbDbExists('a')) === true)
    ok('③ 列表里没有 ⇒ false', (await idbDbExists('zzz')) === false)
  })

  await withGlobals({ indexedDB: { databases: async () => { throw new Error('unsupported') } } }, async () => {
    ok('③ databases() 不可用 ⇒ 兜底判"存在"（交给 openDB 判定，不误删）', (await idbDbExists('a')) === true)
  })
}

// ---------- ④ idbDeleteDatabase 永不 reject ----------
{
  await withGlobals({ indexedDB: undefined }, async () => {
    ok('④ 没有 indexedDB ⇒ 直接完成', (await idbDeleteDatabase('x')) === undefined)
  })

  const mk = (fire: (req: Record<string, unknown>) => void) => ({
    deleteDatabase: () => {
      const req: Record<string, unknown> = {}
      setTimeout(() => fire(req), 0)
      return req
    },
  })
  await withGlobals({ indexedDB: mk(r => (r.onblocked as () => void)()) }, async () => {
    ok('④ 被占用（blocked）也完成，不卡迁移收尾', (await idbDeleteDatabase('x')) === undefined)
  })
  await withGlobals({ indexedDB: mk(r => (r.onerror as () => void)()) }, async () => {
    ok('④ 删除失败也完成（尽力而为，不 reject）', (await idbDeleteDatabase('x')) === undefined)
  })
  await withGlobals({ indexedDB: { deleteDatabase: () => { throw new Error('boom') } } }, async () => {
    ok('④ deleteDatabase 直接抛也完成', (await idbDeleteDatabase('x')) === undefined)
  })
}

console.log(`\n———— 存储/并发小闸：${pass} 通过 / ${fail} 失败 ————`)
if (fail) process.exit(1)
