// ============ 3.3.3 · B6 删除字段后的清值恢复记录 ============
//
// 钉住：
//   ① 清值失败留一条本机待清理记录（同表+同字段只留一条），重启后还能重试；
//   ② 重试以**回读剩余数**为准：部分清掉仍算失败并保留记录；
//   ③ 清到 0 才删记录；已经 0 时直接收尾、不重复写行；
//   ④ 抛错时保留记录并给出剩余数（读不到就是 -1，不假装清干净）。
import { __resetMockStores, memoryOps } from './mock-memory'
import * as db from '../src/lib/db'
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

  console.log(`\natlasPurgeRecovery: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
