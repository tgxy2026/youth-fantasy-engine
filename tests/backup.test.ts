// ============ 备份：上限淘汰 + 恢复往返（#012 / #013）============
// 备份是数据安全的最后一道防线，两头都不能塌：
//   · 上限淘汰 —— 防体积失控（每日备份原先不限量，写一年即 365 份全量快照）
//   · 恢复往返 —— 防「恢复」这个动作本身把数据搞坏
// ⚠️ 关键前提：restoreBackup 内部会为卷/章重新生成 id（applyBundleToProject），
//    故所有比对必须按「结构 + 内容」而非 id，否则会得到假阳性。
import * as db from '../src/lib/db'
import { createDemoProject } from '../src/lib/app/seedData'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const J = (v: unknown) => JSON.stringify(v)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 语义指纹：忽略 id 与时间戳，只认卷章的结构与内容 */
async function fingerprint(p: string) {
  const b = await db.exportProject(p) as any
  const volOrder = new Map<string, number>()
  ;[...(b.volumes ?? [])].sort((a: any, z: any) => a.order - z.order)
    .forEach((v: any, i: number) => volOrder.set(v.id, i))
  const chapters = [...(b.chapters ?? [])]
    .map((c: any) => ({
      v: volOrder.get(c.volumeId) ?? -1, o: c.order, t: c.title,
      c: c.content, s: c.summary, st: c.status, x: !!c.excludeFromNumbering,
    }))
    .sort((a, z) => a.v - z.v || a.o - z.o)
  const volumes = [...(b.volumes ?? [])]
    .map((v: any) => ({ o: v.order, t: v.title, d: v.description }))
    .sort((a, z) => a.o - z.o)
  return {
    chapters: J(chapters), volumes: J(volumes),
    chCount: chapters.length, volCount: volumes.length,
  }
}

__resetMockStores()
const pid = await createDemoProject()
db.setCurrentProject(pid)
// 🔴 2026-10-03 老大定案「示范项目不参与任何备份行为」，而本文件要验证的是**备份 → 篡改 → 恢复**往返。
//    所以把这份示范数据**改名**成普通项目名：内容仍是满血的示范内容（21 章正文，章节数断言不受影响），
//    但不再被备份链路跳过。示范项目本身不备份这件事由文件末尾那段专门断言。
await db.updateProject({ id: pid, name: '备份测试用项目（示范内容副本）' })

// ---------- 1. 恢复往返：备份 → 篡改 + 删章 → 恢复 → 与基线一致 ----------
{
  const b0 = await db.exportProject(pid) as any
  const chapters0: any[] = [...(b0.chapters ?? [])].sort((a, z) => a.order - z.order)
  ok('示范项目有足够章节可供测试', chapters0.length > 1, String(chapters0.length))

  const base = await fingerprint(pid)
  const snap = (await db.createAutoBackup(pid, 'manual', '往返测试基线'))!

  const target = chapters0[0]
  const victim = chapters0[chapters0.length - 1]
  await db.saveChapter({ ...target, content: '【被篡改的正文 SENTINEL】' })
  await db.deleteChapter(victim.id)

  const mutated = await fingerprint(pid)
  ok('改动已生效：章节指纹与基线不同', mutated.chapters !== base.chapters)
  ok('改动已生效：章节数减少 1', mutated.chCount === base.chCount - 1, `${mutated.chCount}/${base.chCount}`)

  await db.restoreBackup(snap.id)
  const restored = await fingerprint(pid)
  ok('恢复后章节数回到基线', restored.chCount === base.chCount, `${restored.chCount}/${base.chCount}`)
  ok('恢复后卷数回到基线', restored.volCount === base.volCount, `${restored.volCount}/${base.volCount}`)
  ok('恢复后卷结构与基线一致', restored.volumes === base.volumes)
  ok('恢复后章节内容完全一致（篡改已撤销、删章已回来）', restored.chapters === base.chapters)
}

// ---------- 2. 上限淘汰：auto5min / daily 各 30，manual 不限 ----------
{
  const LIMIT = db.MAX_AUTO_BACKUPS
  const N = LIMIT + 2
  const fill = async (kind: db.BackupKind, n: number) => {
    for (let i = 0; i < n; i++) {
      await db.createAutoBackup(pid, kind, `${kind}#${i}`)
      await sleep(3) // 拉开 createdAt，确保「淘汰最早的」判定稳定
    }
  }
  const count = async (kind: db.BackupKind) =>
    (await db.listBackups(pid)).filter(b => b.kind === kind).length

  ok(`常量校验：MAX_AUTO_BACKUPS=${LIMIT}、MAX_DAILY_BACKUPS=${db.MAX_DAILY_BACKUPS}`,
     LIMIT === 30 && db.MAX_DAILY_BACKUPS === 30, `${LIMIT}/${db.MAX_DAILY_BACKUPS}`)

  await fill('auto5min', N)
  const autoN = await count('auto5min')
  ok(`auto5min 上限 ${LIMIT}（建 ${N} 份后应剩 ${LIMIT}）`, autoN === LIMIT, String(autoN))

  await fill('daily', N)
  const dayN = await count('daily')
  ok(`daily 上限 ${LIMIT}（建 ${N} 份后应剩 ${LIMIT}）`, dayN === LIMIT, String(dayN))

  // 淘汰的是最早的：#0 应已消失，最新的 #(N-1) 应还在
  const autos = (await db.listBackups(pid)).filter(b => b.kind === 'auto5min')
  ok('auto5min 淘汰的是最早的（#0 已不存在）', !autos.some(b => b.label === 'auto5min#0'))
  ok('auto5min 保留的是最新的', autos.some(b => b.label === `auto5min#${N - 1}`))

  const manualBefore = await count('manual')
  await fill('manual', 5)
  const manualAfter = await count('manual')
  ok('manual 不设上限（新建的 5 份全保留）', manualAfter === manualBefore + 5, `${manualBefore}→${manualAfter}`)
}

// ---------- 3. 孤儿备份：删项目不删备份，应可被识别与清理 ----------
{
  const p2 = await createDemoProject()
  db.setCurrentProject(p2)
  await db.updateProject({ id: p2, name: '孤儿测试用项目（示范内容副本）' }) // 同上：示范项目不备份
  const before = (await db.listOrphanBackups()).length
  await db.createAutoBackup(p2, 'manual', '孤儿测试备份')
  await db.deleteProject(p2)
  const after = (await db.listOrphanBackups()).length
  ok('删除项目后其备份成为孤儿且能被识别', after === before + 1, `${before}→${after}`)
}

// ---------- 示范项目不参与备份（2026-10-03 老大定案） ----------
{
  const { DEMO_PROJECT_NAME, isDemoProjectName } = await import('../src/lib/constants')
  const demo = (await db.createProject(DEMO_PROJECT_NAME, '东方修真', '演示', '', 'full')).id
  db.setCurrentProject(demo)
  const before = (await db.listBackups(demo)).length
  const made = await db.createAutoBackup(demo, 'manual', '示范项目不该被备份')
  const after = (await db.listBackups(demo)).length
  ok('🔴 示范项目：手动备份不生成任何记录', made === null && after === before, `${made ? '生成了' : '未生成'} / ${before}→${after}`)
  await db.createAutoBackup(demo, 'auto5min', '自动备份也不该')
  await db.createAutoBackup(demo, 'daily', '每日备份也不该')
  ok('🔴 示范项目：自动与每日备份同样被跳过', (await db.listBackups(demo)).length === before)
  ok('判定函数认得示范项目名', isDemoProjectName(DEMO_PROJECT_NAME))
  ok('🔴 名字不同的项目照常备份（用户自建项目行为不变）', !isDemoProjectName('我的小说'))
  const mine = (await db.createProject('我的小说', '东方修真', '', '', 'full')).id
  const rec = await db.createAutoBackup(mine, 'manual', '普通项目照常')
  ok('🔴 用户自建项目：备份照常生成', !!rec && (await db.listBackups(mine)).length === 1)
}

console.log(`\nbackup: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
