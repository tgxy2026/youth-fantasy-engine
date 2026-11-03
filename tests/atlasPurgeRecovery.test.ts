// ============ 3.3.3 · B6 删除字段后的清值恢复记录 ============
//
// 钉住：
//   ① 清值失败留一条本机待清理记录（同表+同字段只留一条），重启后还能重试；
//   ② 重试以**回读剩余数**为准：部分清掉仍算失败并保留记录；
//   ③ 清到 0 才删记录；已经 0 时直接收尾、不重复写行；
//   ④ 抛错时保留记录并给出剩余数（读不到就是 -1，不假装清干净）。
import { __resetMockStores, memoryOps } from './mock-memory'
import * as db from '../src/lib/db'
import { saveAtlasSchema } from '../src/lib/atlas/persistence'
import { emptyAtlasSchema } from '../src/lib/atlas/schema'
import { invalidateStorageContext } from '../src/lib/storage/contextEpoch'
import {
  clearPendingFieldPurge, countFieldValues, discardIntactFieldPurge, listPendingFieldPurges, recordPendingFieldPurge, retryPendingFieldPurge,
} from '../src/lib/atlas/purgeRecovery'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-b6-purge'
const TAB = 'races'

async function seedRows() {
  await memoryOps.put('tableRows', { id: 'r1', projectId: PID, tabId: TAB, order: 0, data: { cf_1: 'a', cf_err: 'boom', other: 'keep' } })
  await memoryOps.put('tableRows', { id: 'r2', projectId: PID, tabId: TAB, order: 1, data: { other: 'keep' } })
  await memoryOps.put('tableRows', { id: 'r3', projectId: PID, tabId: TAB, order: 2, data: { cf_1: 'b' } })
}

async function main() {
  __resetMockStores()
  await memoryOps.put('projects', { id: PID, name: 'B6 清值', createdAt: 0, updatedAt: 0 })
  db.setCurrentProject(PID)
  await seedRows()
  await db.setSettingFor(PID, `atlasSchema::${TAB}`, { formatVersion: 1, revision: 1, fields: [{ id: 'cf_1' }] })

  await recordPendingFieldPurge(PID, { tabId: TAB, fieldId: 'cf_1', fieldLabel: '食性', backupId: 'bk-1', remaining: 2 })
  ok('记录后能读到', (await listPendingFieldPurges(PID)).length === 1)
  let attempted = false
  const active = await retryPendingFieldPurge(PID, { tabId: TAB, fieldId: 'cf_1' }, async () => { attempted = true; return 0 })
  ok('定义仍存在时拒绝清理并保留记录', !active.ok && !attempted && (await listPendingFieldPurges(PID)).length === 1)
  ok('拒绝后原值完整', (await countFieldValues(PID, TAB, 'cf_1')) === 2)
  await discardIntactFieldPurge(PID, { tabId: TAB, fieldId: 'cf_1' })
  ok('定义仍在时可移除意图且保留值', (await listPendingFieldPurges(PID)).length === 0 && (await countFieldValues(PID, TAB, 'cf_1')) === 2)
  await recordPendingFieldPurge(PID, { tabId: TAB, fieldId: 'cf_1', fieldLabel: '食性', backupId: 'bk-1', remaining: 2 })
  await db.setSettingFor(PID, `atlasSchema::${TAB}`, { formatVersion: 99, fields: [] })
  const newer = await retryPendingFieldPurge(PID, { tabId: TAB, fieldId: 'cf_1' }, async () => { attempted = true; return 0 })
  ok('未知配置版本不能清理', !newer.ok && !attempted)
  await db.setSettingFor(PID, `atlasSchema::${TAB}`, { formatVersion: 1, revision: 2, fields: [] })
  let dismissRejected = false
  try { await discardIntactFieldPurge(PID, { tabId: TAB, fieldId: 'cf_1' }) } catch { dismissRejected = true }
  ok('定义已删除时不能放弃恢复记录', dismissRejected && (await listPendingFieldPurges(PID)).length === 1)
  const first = await listPendingFieldPurges(PID)
  const at = first[0].at

  await recordPendingFieldPurge(PID, { tabId: TAB, fieldId: 'cf_1', fieldLabel: '食性(改)', backupId: 'bk-2', remaining: 1 })
  const again = await listPendingFieldPurges(PID)
  ok('同表同字段只留一条', again.length === 1 && again[0].backupId === 'bk-2' && again[0].remaining === 1)
  ok('保留最早的时间（不代表本次重试时刻）', again[0].at === at)
  ok('剩余行数按真实数据算', (await countFieldValues(PID, TAB, 'cf_1')) === 2)

  // 部分清理：只删 r1 的值 → 仍剩 r3 ⇒ 失败并保留记录
  let calls = 0
  const partial = await retryPendingFieldPurge(PID, { tabId: TAB, fieldId: 'cf_1' }, async () => {
    calls++
    const row = await memoryOps.get<{ id: string; data: Record<string, string> }>('tableRows', 'r1')
    if (row) { const d = { ...row.data }; delete d.cf_1; await memoryOps.put('tableRows', { ...row, data: d }) }
    return 1
  })
  ok('部分清理仍算失败', !partial.ok && partial.remaining === 1, JSON.stringify(partial))
  ok('失败后保留恢复记录', (await listPendingFieldPurges(PID)).length === 1)

  const good = await retryPendingFieldPurge(PID, { tabId: TAB, fieldId: 'cf_1' }, async () => {
    const row = await memoryOps.get<{ id: string; data: Record<string, string> }>('tableRows', 'r3')
    if (row) { const d = { ...row.data }; delete d.cf_1; await memoryOps.put('tableRows', { ...row, data: d }) }
    return 1
  })
  ok('清到 0 才成功', good.ok && good.remaining === 0, JSON.stringify(good))
  ok('成功后删掉记录', (await listPendingFieldPurges(PID)).length === 0)
  ok('其它字段未被碰', (await memoryOps.get<{ data: Record<string, string> }>('tableRows', 'r1'))?.data.other === 'keep')

  // 已经 0：不再调用清理函数
  await recordPendingFieldPurge(PID, { tabId: TAB, fieldId: 'cf_missing', fieldLabel: '不存在', backupId: 'bk', remaining: 3 })
  let called = 0
  const nothing = await retryPendingFieldPurge(PID, { tabId: TAB, fieldId: 'cf_missing' }, async () => { called++; return 99 })
  ok('已经 0 直接收尾', nothing.ok && nothing.removed === 0 && called === 0)
  ok('收尾同时删记录', (await listPendingFieldPurges(PID)).length === 0)

  // 抛错：保留记录、剩余数如实（能读就是 0，读不到 -1）
  await recordPendingFieldPurge(PID, { tabId: TAB, fieldId: 'cf_err', fieldLabel: '出错', backupId: 'bk', remaining: 1 })
  const failed = await retryPendingFieldPurge(PID, { tabId: TAB, fieldId: 'cf_err' }, async () => { throw new Error('存储不可用') })
  ok('抛错时不声称成功', !failed.ok && failed.error?.includes('存储不可用'))
  ok('抛错后保留记录', (await listPendingFieldPurges(PID)).length === 1)

  const switched = await retryPendingFieldPurge(PID, { tabId: TAB, fieldId: 'cf_err' }, async () => {
    db.setCurrentProject('other-project')
    return 0
  })
  ok('清理期间切项目不会误报成功', !switched.ok)
  db.setCurrentProject(PID)
  ok('切项目后原恢复记录仍在', (await listPendingFieldPurges(PID)).length === 1)

  await clearPendingFieldPurge(PID, TAB, 'cf_err')
  ok('手动放弃时能清记录', (await listPendingFieldPurges(PID)).length === 0)

  const corruptKey = 'atlasPurgePending::p-corrupt'
  await memoryOps.put('meta', { key: corruptKey, value: [null] })
  let corruptRejected = false
  try {
    await recordPendingFieldPurge('p-corrupt', { tabId: TAB, fieldId: 'cf_new', fieldLabel: 'x', backupId: 'bk', remaining: 1 })
  } catch { corruptRejected = true }
  const corrupt = await memoryOps.get<{ value: unknown[] }>('meta', corruptKey)
  ok('损坏的恢复记录拒绝覆盖', corruptRejected && corrupt?.value.length === 1 && corrupt.value[0] === null)

  // 真实入口共享同一锁：清理进行中，其他窗口不能插入 schema 写入。
  {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const tails = new Map<string, Promise<void>>()
    const locks = { request: async <T>(name: string, _opts: unknown, fn: () => Promise<T>): Promise<T> => {
      let release!: () => void
      const mine = new Promise<void>(r => { release = r })
      const before = tails.get(name) ?? Promise.resolve(); tails.set(name, mine)
      await before
      try { return await fn() } finally { release() }
    } }
    Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true })
    Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true })
    try {
      const config = { ...emptyAtlasSchema(), revision: 2 }
      let release!: () => void, entered!: () => void
      const paused = new Promise<void>(r => { release = r })
      const ready = new Promise<void>(r => { entered = r })
      const retry = retryPendingFieldPurge(PID, { tabId: TAB, fieldId: 'cf_1' }, async () => { entered(); await paused; return 0 })
      // 使用仍有值的字段触发实际清理回调。
      await memoryOps.put('tableRows', { id: 'lock-row', projectId: PID, tabId: TAB, order: 4, data: { cf_1: 'v' } })
      await ready
      let saved = false
      const write = saveAtlasSchema(PID, TAB, config).then(() => { saved = true })
      await Promise.resolve(); await Promise.resolve()
      ok('清理期间 schema 写入等待同一把锁', !saved)
      release(); await retry; await write
      ok('清理结束后 schema 写入继续', saved)
      await Promise.all(['one', 'two'].map(fieldId => recordPendingFieldPurge(PID, {
        tabId: TAB, fieldId, fieldLabel: fieldId, backupId: 'bk', remaining: 1,
      })))
      const records = await listPendingFieldPurges(PID)
      ok('并发登记不同字段时两条记录都保留', ['one', 'two'].every(id => records.some(p => p.fieldId === id)))
      await Promise.all(['one', 'two'].map(id => clearPendingFieldPurge(PID, TAB, id)))
      ok('并发移除不同字段时两条记录都移除', !(await listPendingFieldPurges(PID)).some(p => p.fieldId === 'one' || p.fieldId === 'two'))
      let unblock!: () => void, held!: () => void
      const heldPromise = new Promise<void>(r => { held = r })
      const blocked = new Promise<void>(r => { unblock = r })
      const hold = locks.request(`yfe-atlas-purge-list-v1:${PID}`, { mode: 'exclusive' }, async () => { held(); await blocked })
      await heldPromise
      const stale = recordPendingFieldPurge(PID, { tabId: TAB, fieldId: 'stale', fieldLabel: 'stale', backupId: 'bk', remaining: 1 })
      invalidateStorageContext(); unblock(); await hold
      let rejected = false
      try { await stale } catch { rejected = true }
      ok('等待锁期间切换存储后不写入新空间', rejected && !(await listPendingFieldPurges(PID)).some(p => p.fieldId === 'stale'))
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete (globalThis as { window?: unknown }).window
      if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete (globalThis as { navigator?: unknown }).navigator
    }
  }

  console.log(`\natlasPurgeRecovery: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
