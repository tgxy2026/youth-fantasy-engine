// ============ 备份可恢复性演练 · 单测（3.6.2 · W3）============
//
// 这个模块存在的意义是"在作者去恢复之前，先告诉他哪几份其实已经坏了"。
// 所以它自己不能说谎：
//   · 坏了的必须报出来（并给可读原因）；
//   · 没检查的必须说"没检查"（不能把"没看"当成"没问题"）；
//   · 全程**只读** —— 体检把数据改了，比不体检更糟。
import * as db from '../src/lib/db'
import { runBackupDrill, drillSummary } from '../src/lib/db/backupDrill'
import { __resetMockStores, memoryOps, __dumpAll } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function main() {
  __resetMockStores()
  const p = await db.createProject('演练用书', '东方修真', '', '', 'full')
  db.setCurrentProject(p.id)

  // 1. 没有备份时
  {
    const r = await runBackupDrill(p.id)
    ok('1a 无备份 → points 为空', r.points.length === 0)
    ok('1b 无备份 → 结论说「没有备份可检查」（不是空白）', drillSummary(r).includes('没有备份'),
      drillSummary(r))
  }

  // 2. 正常备份全部可恢复
  {
    await db.createAutoBackup(p.id, 'manual', '正常备份 A')
    await db.createAutoBackup(p.id, 'manual', '正常备份 B')
    const r = await runBackupDrill(p.id)
    ok('2a 两份备份都被检查到', r.points.length === 2, String(r.points.length))
    ok('2b 全部可恢复', r.restorableCount === 2 && r.brokenCount === 0)
    ok('2c 结论说「全部可恢复」', drillSummary(r).includes('全部可恢复'), drillSummary(r))
    ok('2d 时间点按倒序（新 → 旧）', r.points[0].createdAt >= r.points[1].createdAt)
  }

  // 3. 坏一份 → 必须报出来
  {
    const metas = await db.listBackups(p.id)
    const victim = metas[0]
    const raw = await memoryOps.get<{ bundle: Record<string, unknown> }>('backupPayloads', victim.id)
    const broken = JSON.parse(JSON.stringify(raw))
    delete broken.bundle.volumes          // 结构不完整
    await memoryOps.put('backupPayloads', broken)

    const r = await runBackupDrill(p.id)
    ok('3a 坏掉的那份被判为不可恢复', r.brokenCount === 1, String(r.brokenCount))
    const bad = r.points.find(x => !x.restorable)
    ok('3b 给出了可读原因（说明缺什么）', !!bad && /volumes/.test(bad.reason ?? ''), bad?.reason ?? '')
    ok('3c 结论点明「有 N 份已无法恢复」', /已无法恢复/.test(drillSummary(r)), drillSummary(r))
    ok('3d 另一份不受牵连（照常可恢复）', r.restorableCount === 1, String(r.restorableCount))
  }

  // 4. 窗口：7 天之外的不算进来
  {
    __resetMockStores()
    const p2 = await db.createProject('窗口测试书', '', '', '', 'full')
    db.setCurrentProject(p2.id)
    const meta = await db.createAutoBackup(p2.id, 'manual', '很久以前的')
    // 把元数据与载荷的时间一起改旧（只改元数据不会影响窗口判断，但保持数据一致更真实）
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000
    const m = await memoryOps.get<Record<string, unknown>>('backups', meta!.id)
    await memoryOps.put('backups', { ...m, createdAt: old })

    const r = await runBackupDrill(p2.id)
    ok('4a 30 天前的备份不在 7 天窗口内', r.points.length === 0, String(r.points.length))

    const wide = await runBackupDrill(p2.id, { days: 60 })
    ok('4b 窗口放宽到 60 天就能看到它', wide.points.length === 1, String(wide.points.length))
  }

  // 5. 超出上限：必须如实说"没检查"
  {
    __resetMockStores()
    const p3 = await db.createProject('上限测试书', '', '', '', 'full')
    db.setCurrentProject(p3.id)
    for (let i = 0; i < 5; i++) await db.createAutoBackup(p3.id, 'manual', `备份 ${i}`)
    const r = await runBackupDrill(p3.id, { maxPoints: 2 })
    ok('5a 只检查上限内的份数', r.points.length === 2, String(r.points.length))
    ok('🔴 5b 未检查的份数如实带出（3 份）', r.skipped === 3, String(r.skipped))
    ok('🔴 5c 结论里写明「另有 N 份未检查」（不把没看说成没问题）',
      /另有 3 份未检查/.test(drillSummary(r)), drillSummary(r))
  }

  // 6. 只读：跑完存储逐字节不变
  {
    __resetMockStores()
    const p4 = await db.createProject('只读测试书', '', '', '', 'full')
    db.setCurrentProject(p4.id)
    await db.createAutoBackup(p4.id, 'manual', '只读检查')
    const before = __dumpAll()
    await runBackupDrill(p4.id)
    const after = __dumpAll()
    ok('🔴 6a 演练全程只读：存储前后逐字节一致', before === after,
      before === after ? '' : '演练改动了存储')
  }
}

await main()

console.log(`\nbackupDrill: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
