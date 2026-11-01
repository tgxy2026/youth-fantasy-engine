// ============ 3.3.3 · B-07 图鉴字段配置写入的跨窗口临界区 ============
//
// 钉住：
//   ① 同源两个窗口同时用 revision N 写同一张表 ⇒ 一个成功（N+1）、另一个**明确被拒**；
//      最终存储只前进一代，不出现"两边都成功、后写覆盖前者"。
//   ② 没有 Web Locks 的环境保持原行为（串行调用照常成功）。
//   ③ 拒绝错误文案指向"其他窗口"，作者知道要重开字段设置，而不是以为保存成功。
// 🔴 Web Locks 用内存 FIFO 队列模拟；这是源码级证据，不等于真实 Edge 双标签或桌面/便携文件后端验证。
import { __resetMockStores, memoryOps } from './mock-memory'
import * as db from '../src/lib/db'
import { emptyAtlasSchema } from '../src/lib/atlas/schema'
import { loadAtlasSchema, saveAtlasSchema } from '../src/lib/atlas/persistence'
import type { AtlasSchemaConfig } from '../src/lib/atlas/types'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-atlas-race'
const TAB = 'races' as const

function installLock() {
  let tail: Promise<void> = Promise.resolve()
  const locks = {
    request: async <T>(_name: string, _opts: unknown, cb: () => Promise<T>): Promise<T> => {
      let release!: () => void
      const mine = new Promise<void>(r => { release = r })
      const prev = tail
      tail = mine
      await prev
      try { return await cb() } finally { release() }
    },
  }
  ;(globalThis as unknown as { window?: unknown }).window = globalThis
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true })
}

function removeLock() {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
}

function withField(base: AtlasSchemaConfig, label: string): AtlasSchemaConfig {
  return {
    ...base,
    fields: [{
      id: 'cf_race', label, type: 'text', description: '', options: [], appliesTo: '*',
      groupId: 'g1', order: 0, tableVisible: true, detailVisible: true, searchable: true,
      aiReadable: true, aiWritable: true, archived: false,
    }],
    groups: [{ id: 'g1', label: '扩展', order: 0 }],
  }
}

async function main() {
  __resetMockStores()
  await memoryOps.put('projects', { id: PID, name: 'B07 字段并发', createdAt: 0, updatedAt: 0 })
  db.setCurrentProject(PID)

  const base = emptyAtlasSchema()
  const first = await saveAtlasSchema(PID, TAB, withField(base, '食性'))
  ok('首次写入 revision=1', first.revision === 1, `${first.revision}`)

  installLock()
  const stale = withField({ ...first, revision: 1 }, '食性')
  // 两个窗口都拿着 revision=1 同时写：锁内重读后只有一个能过
  const results = await Promise.allSettled([
    saveAtlasSchema(PID, TAB, stale),
    saveAtlasSchema(PID, TAB, { ...stale, fields: [{ ...stale.fields[0], label: '食性2' }] }),
  ])
  const okCount = results.filter(r => r.status === 'fulfilled').length
  const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined
  ok('并发写入只成功一个', okCount === 1, JSON.stringify(results.map(r => r.status)))
  ok('另一个明确被拒（不是静默覆盖）', !!rejected && String(rejected.reason).includes('其他窗口'), String(rejected?.reason))
  const loaded = await loadAtlasSchema(PID, TAB)
  const stored = loaded.config
  ok('存储只前进一代', stored?.revision === 2, `${stored?.revision}`)
  ok('失败者的字段改动没有覆盖成功者', stored?.fields[0]?.label === '食性' || stored?.fields[0]?.label === '食性2')

  removeLock()
  const plain = await saveAtlasSchema(PID, TAB, withField({ ...stored!, revision: stored!.revision }, '无锁'))
  ok('无 Web Locks 时保持原行为', plain.revision === stored!.revision + 1, `${plain.revision}`)

  removeLock()
  delete (globalThis as unknown as { window?: unknown }).window

  console.log(`\natlasSchemaConcurrency: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()