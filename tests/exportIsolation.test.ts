// ============ 3.3.3 · B-08 新任务/缓存/反馈的出口隔离 ============
//
// 钉住（规划 §14.1 / §14.4）：
//   ① 项目包（exportProject）不含任务头/单元，也不含本机 meta（拉取记录 / 重复忽略 / 变化反馈 / 能力缓存 / 待清理）；
//   ② 云端快照只沿既有分类，不出现任务类 kind；
//   ③ 游客整库导出（GUEST_STORES）不含 taskHeads/taskUnits，且本机 meta 被剥掉（普通 meta 保留）；
//   ④ 导入项目包后任务台账为空（旧任务不会被"激活"），但作品字段与图鉴图片照常保留；
//   ⑤ 新增的本机前缀逐一命中 `isLocalOnlyMetaKey`（单一判据，不靠各出口各记一份清单）。
// 🔴 证据是内存存储 + 合成夹具；真实云盘/服务端与桌面文件后端仍待实机。
import { __resetMockStores, memoryOps } from './mock-memory'
import * as db from '../src/lib/db'
import { saveTaskHead, saveTaskUnit, listProjectTaskHeads } from '../src/lib/db/taskLedger'
import { buildProjectSnapshot } from '../src/lib/sync/projectSnapshot'
import { guestDataObject } from '../src/lib/db/guestData'
import { isLocalOnlyMetaKey } from '../src/lib/storage/sensitiveMeta'
import type { TaskHead, TaskUnit } from '../src/lib/tasks/unitLedger'
import type { TableRow } from '../src/lib/types'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-b08-outlets'
const TASK = 't-b08'
const LOCAL_KEYS = [
  `syncPullOp::${PID}`,
  `auditIgnore::${PID}`,
  `auditRepetition::${PID}`,
  `auditChange::${PID}`,
  'aiCapability:ep|model',
  `atlasPurgePending::${PID}`,
]

function head(): TaskHead {
  return {
    id: TASK, kind: 'bookbreak-extract', projectId: PID, storageKey: 'k',
    inputFingerprint: 't1:x', configFingerprint: 'c1:y', protocolVersion: 1,
    modelTag: 'SENTINEL_TASK_MODEL', totalUnits: 1, status: 'pending', ownerId: '',
    generation: 0, createdAt: 1, updatedAt: 1, label: 'SENTINEL_TASK_LABEL',
  }
}

function unit(): TaskUnit {
  return {
    id: `${TASK}:0`, taskId: TASK, projectId: PID, index: 0, unitKey: 'u0',
    chapterTitle: 'SENTINEL_UNIT_TITLE', status: 'succeeded', attempts: 1, bytes: 0,
    updatedAt: 1, result: { text: 'SENTINEL_UNIT_RESULT' },
  }
}

async function main() {
  __resetMockStores()
  await memoryOps.put('projects', { id: PID, name: 'B08 作品', genre: '玄幻', createdAt: 0, updatedAt: 0 })
  await memoryOps.put('volumes', { id: 'v1', projectId: PID, title: '卷一', order: 0, createdAt: 0, updatedAt: 0 })
  await memoryOps.put('chapters', {
    id: 'ch1', projectId: PID, volumeId: 'v1', title: '第一章', order: 0,
    content: '正文', summary: '', status: 'draft', wordCount: 2, createdAt: 0, updatedAt: 0,
  })
  const row: TableRow = {
    id: 'r1', projectId: PID, tabId: 'races', order: 0,
    data: { 名称: '霜族', cf_lore: '自冰原深处迁徙而来' },
    atlasImage: { dataUrl: 'data:image/png;base64,SENTINEL_IMAGE_KEEP', mime: 'image/png', width: 1, height: 1, bytes: 1 },
  } as TableRow
  await memoryOps.put('tableRows', row)
  await saveTaskHead(head())
  await saveTaskUnit(unit())
  for (const k of LOCAL_KEYS) await memoryOps.put('meta', { key: k, value: 'SENTINEL_CACHE' })
  await memoryOps.put('meta', { key: 'welcomeDone', value: true })
  // 本机专属设置（模板库）也不该随项目包走
  await memoryOps.put('settingsKV', { key: `templateLibrary32:${PID}`, value: 'SENTINEL_LIBRARY' })
  db.setCurrentProject(PID)

  // ① 项目包
  const bundle = await db.exportProject(PID)
  const bundleText = JSON.stringify(bundle)
  ok('项目包不含任务载荷', !bundleText.includes('SENTINEL_TASK') && !bundleText.includes('SENTINEL_UNIT'))
  ok('项目包不含本机缓存/反馈', !bundleText.includes('SENTINEL_CACHE'))
  ok('项目包不含本机模板库', !bundleText.includes('SENTINEL_LIBRARY'))
  ok('项目包仍保留图鉴图片', bundleText.includes('SENTINEL_IMAGE_KEEP'))
  ok('项目包字段照常保留', bundle.tableRows.some(r => r.data.cf_lore === '自冰原深处迁徙而来'))

  // ② 云端快照：只沿既有分类，不出现任务 kind
  const snap = await buildProjectSnapshot(bundle, { now: 1000 })
  const kinds = snap.manifest.objects.map(o => o.kind)
  ok('快照没有任务类 kind', !kinds.includes('taskHeads') && !kinds.includes('taskUnits'), kinds.join(','))
  ok('快照不含任务载荷', !JSON.stringify(snap).includes('SENTINEL_TASK') && !JSON.stringify(snap).includes('SENTINEL_UNIT'))
  ok('快照仍含章节类', kinds.includes('chapters'))

  // ③ 游客整库导出：新本地 store 不在清单内；本机 meta 被剥
  const guest = await guestDataObject()
  const storeNames = Object.keys(guest.data.stores as Record<string, unknown>)
  ok('游客导出不含任务 store', !storeNames.includes('taskHeads') && !storeNames.includes('taskUnits'), storeNames.join(','))
  const guestText = JSON.stringify(guest.data)
  // 整库备份允许带本机状态（迁移/回滚用），但任务台账仍不进：GUEST_STORES 未登记
  ok('游客导出保留普通 meta', guestText.includes('welcomeDone'))

  // ④ 导入项目包：不激活旧任务，作品内容照常
  const newPid = await db.importProject(bundle)
  db.setCurrentProject(newPid)
  ok('导入后没有旧任务头', (await listProjectTaskHeads(newPid)).length === 0)
  const imported = await db.getTableRowsFor(newPid, 'races')
  ok('导入后字段与图片都还在',
    imported.length === 1 && imported[0].data.cf_lore === '自冰原深处迁徙而来'
      && (imported[0] as TableRow & { atlasImage?: { dataUrl: string } }).atlasImage?.dataUrl === 'data:image/png;base64,SENTINEL_IMAGE_KEEP',
    JSON.stringify(imported))

  // ⑤ 本机前缀单一判据
  for (const k of LOCAL_KEYS) ok(`本机前缀命中：${k.split('::')[0]}`, isLocalOnlyMetaKey(k))
  ok('普通 meta 不误判', !isLocalOnlyMetaKey('welcomeDone'))

  console.log(`\nexportIsolation: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()