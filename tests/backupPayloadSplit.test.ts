// ============ C2（2.4.2）备份元数据 / 载荷分离 + 备份外置 ============
//
// 这一层最怕的三种静默失败：
//   ① 只删了一半（元数据删了载荷还在 → 白占空间；载荷删了元数据还在 → 列表里是空壳）；
//   ② 老库没迁移时列表崩 / 体积显示 0（兼容读取必须兜住）；
//   ③ 外置文件与「迁移包」互相被当成对方吃进去。
// 另把「本地专属 store 单一判据」也钉住 —— 它是本轮把 6 处硬编码收成一个常量的成果。
import * as db from '../src/lib/db'
import { memoryOps, __resetMockStores } from './mock-memory'
import { createDemoProject } from '../src/lib/app/seedData'
import { SYNC_STORES, LOCAL_ONLY_STORES, isLocalOnlyStore } from '../src/lib/sync/syncCore'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ backupPayloadSplit')

__resetMockStores()
const pid = await createDemoProject()
// 🔴 2026-10-03：示范项目不参与备份，本文件要验证载荷分离 ⇒ 改名成普通项目（内容仍是满血示范数据）。
await db.updateProject({ id: pid, name: '载荷分离测试用项目' })
db.setCurrentProject(pid)

// ---------- 1. 本地专属 store 单一判据 ----------
{
  ok('backups 属本地专属', isLocalOnlyStore('backups'))
  ok('backupPayloads 属本地专属', isLocalOnlyStore('backupPayloads'))
  ok('普通 store 不算本地专属', !isLocalOnlyStore('projects') && !isLocalOnlyStore('chapters'))
  ok('本地专属清单里没有混入业务表', LOCAL_ONLY_STORES.length === 2, LOCAL_ONLY_STORES.join(','))
  ok('backupPayloads 已登记进 SYNC_STORES（作为对账依据）', (SYNC_STORES as readonly string[]).includes('backupPayloads'))
}

// ---------- 2. 写入即分离 ----------
const backupId = await (async () => {
  const rec = (await db.createAutoBackup(pid, 'manual', '分离测试'))!
  const metas = await memoryOps.getAll<Record<string, unknown>>('backups')
  const payloads = await memoryOps.getAll<Record<string, unknown>>('backupPayloads')
  const meta = metas.find(m => m.id === rec.id)
  const payload = payloads.find(p => p.id === rec.id)
  ok('元数据带 bytes', rec.bytes > 0, String(rec.bytes))
  ok('backups 记录里不再有 bundle', !!meta && !('bundle' in meta), JSON.stringify(Object.keys(meta ?? {})))
  ok('backups 记录带 bytes', typeof meta?.bytes === 'number' && (meta!.bytes as number) > 0)
  ok('backupPayloads 里有对应载荷', !!payload && !!payload.bundle)
  ok('载荷带 projectId（删项目/清孤儿时按项目批量删）', payload?.projectId === pid)
  return rec.id
})()

// ---------- 3. 列表不读载荷 ----------
{
  const list = await db.listBackups(pid)
  const one = list.find(b => b.id === backupId)
  ok('列表能列出该备份', !!one)
  ok('🔴 列表项不含 bundle（列表零成本的关键）', !!one && !('bundle' in one), JSON.stringify(Object.keys(one ?? {})))
  ok('列表项体积可直接用', !!one && one.bytes > 0, String(one?.bytes))
  ok('列表按时间倒序', list.every((b, i) => i === 0 || b.createdAt <= list[i - 1].createdAt))
}

// ---------- 4. 老库兼容读取（未迁移） ----------
{
  // 造一条「元数据 + 载荷同条」的 v11 之前老记录
  const legacy = {
    id: 'legacy-1', projectId: pid, kind: 'daily', label: '老格式备份',
    createdAt: Date.now() - 1000,
    bundle: { project: { id: pid, name: '示例' }, volumes: [], chapters: [], formData: [], tableRows: [], cardRecords: [] },
  }
  await memoryOps.put('backups', legacy)

  const list = await db.listBackups(pid)
  const got = list.find(b => b.id === 'legacy-1')
  ok('老记录仍能列出', !!got)
  ok('老记录体积由 bundle 现算（不是 0）', !!got && got.bytes > 0, String(got?.bytes))
  ok('老记录出库时被剥掉 bundle', !!got && !('bundle' in got))
  ok('getBackupPayload 能回退读到老记录的 bundle', (await db.getBackupPayload('legacy-1'))?.project !== undefined)
}

// ---------- 5. 数据迁移：幂等 ----------
{
  const n1 = await db.migrateBackupPayloads()
  ok('迁移搬走 1 条老记录', n1 === 1, String(n1))
  const raw = await memoryOps.getAll<Record<string, unknown>>('backups')
  const moved = raw.find(r => r.id === 'legacy-1')
  ok('迁移后 backups 记录不再带 bundle', !!moved && !('bundle' in moved))
  ok('迁移后补上了 bytes', typeof moved?.bytes === 'number' && (moved!.bytes as number) > 0)
  ok('迁移后载荷进了 backupPayloads', !!(await memoryOps.get<Record<string, unknown>>('backupPayloads', 'legacy-1')))
  const n2 = await db.migrateBackupPayloads()
  ok('🔴 再跑一次为 0（幂等）', n2 === 0, String(n2))
}

// ---------- 6. 删除两侧一起删 ----------
{
  await db.deleteBackup(backupId)
  ok('元数据已删', !(await memoryOps.get('backups', backupId)))
  ok('🔴 载荷也一起删（不留孤儿载荷）', !(await memoryOps.get('backupPayloads', backupId)))
}

// ---------- 7. 外置文件：往返 + 认得出迁移包 ----------
{
  const rec = (await db.createAutoBackup(pid, 'manual', '外置测试'))!
  const f = await db.buildBackupFile(rec.id)
  ok('能打出外置文件', !!f && f.content.length > 0)
  ok('文件名带书名与时间戳', !!f && f.filename.startsWith('青春幻想引擎-备份-') && f.filename.endsWith('.json'), f?.filename)
  const parsed = db.parseBackupFile(f!.content)
  ok('解析回来是同一份备份', parsed.meta.id === rec.id && parsed.bundle.project.name === (await db.exportProject(pid)).project.name)
  ok('带格式标记与版本号', parsed.kind === 'yfe-backup' && parsed.version === db.BACKUP_FILE_VERSION)

  let msg = ''
  try { db.parseBackupFile(JSON.stringify({ project: { id: 'p' }, volumes: [] })) } catch (e) { msg = (e as Error).message }
  ok('🔴 把迁移包当备份文件会被明确拒绝', msg.includes('迁移包'), msg)

  // 从外置文件恢复**当前项目**
  const target = (await db.getAllChapters())[0]
  await db.saveChapter({ ...target, content: '【外置恢复 SENTINEL】' })
  ok('改动已生效', (await db.getAllChapters()).some(c => c.content?.includes('外置恢复 SENTINEL')))
  await db.restoreBundleToProject(pid, parsed.bundle)
  ok('🔴 恢复后哨兵内容被覆盖回备份时状态', !(await db.getAllChapters()).some(c => c.content?.includes('外置恢复 SENTINEL')))
  await db.deleteBackup(rec.id)
}


console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
