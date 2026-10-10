// ============ P0 数据安全审计：导出/导入往返 + 迁移幂等 ============
// 设计原则：所有比对在本地脚本内完成，控制台只输出 PASS/FAIL 摘要行，
// 失败时最多打印一处差异片段（±120 字符），控制 token 消耗。
import * as db from '../src/lib/db'
import { createDemoProject } from '../src/lib/app/seedData'
import type { ProjectBundle } from '../src/lib/db'
import type { Chapter, TableRow } from '../src/lib/types'
import { __resetMockStores, __dumpAll, memoryOps } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
function firstDiff(a: string, b: string): string {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return `@${i} …${a.slice(Math.max(0, i - 60), i + 60)} ⟷ ${b.slice(Math.max(0, i - 60), i + 60)}…`
}
const J = (v: unknown) => JSON.stringify(v)
type AnyRec = Record<string, any>

/**
 * 往返语义比对：id 与时间戳允许变化（导入会重发 id、刷新时间戳），
 * 但内容与结构必须一一对应。返回 null 表示一致，否则返回首处差异描述。
 */
function semCompare(b1: AnyRec, b2: AnyRec): string | null {
  // 1) 项目字段（剔除 id/时间戳）
  const pj = (b: AnyRec) => { const { id, createdAt, updatedAt, ...rest } = b.project; return J(rest) }
  if (pj(b1) !== pj(b2)) return `project 字段不一致: ${firstDiff(pj(b1), pj(b2))}`
  // 2) 卷：按标题对齐
  const volArr = (b: AnyRec) => [...(b.volumes as AnyRec[])].sort((a, z) => a.title.localeCompare(z.title) || a.order - z.order)
  const v1 = volArr(b1), v2 = volArr(b2)
  if (v1.length !== v2.length) return `卷数不一致 ${v1.length}/${v2.length}`
  const volMap = (arr: AnyRec[]) => { const m = new Map<string, number>(); arr.forEach((v, i) => m.set(v.id, i)); return m }
  const m1 = volMap(v1), m2 = volMap(v2)
  for (let i = 0; i < v1.length; i++) {
    const a = v1[i], z = v2[i]
    if (a.title !== z.title || a.description !== z.description || a.order !== z.order)
      return `卷#${i}(${a.title}) 内容不一致: ${firstDiff(J(a), J(z))}`
  }
  // 3) 章节：按 (卷序号, 卷内序) 对齐
  const chSem = (b: AnyRec, m: Map<string, number>) =>
    [...(b.chapters as Chapter[])].map(c => ({ v: m.get(c.volumeId) ?? -1, o: c.order, t: c.title, c: c.content, s: c.summary, st: c.status, w: c.wordCount, x: !!c.excludeFromNumbering }))
      .sort((a, z) => a.v - z.v || a.o - z.o)
  const c1 = chSem(b1, m1), c2 = chSem(b2, m2)
  if (J(c1) !== J(c2)) return `章节数据不一致（${c1.length}/${c2.length} 章）: ${firstDiff(J(c1), J(c2))}`
  // 章节位次映射（行 id 的 ch-<chapterId> 前缀比对用）
  const chMapOf = (b: AnyRec, m: Map<string, number>) => {
    const arr = [...(b.chapters as Chapter[])].sort((a, z) => (m.get(a.volumeId) ?? -1) - (m.get(z.volumeId) ?? -1) || a.order - z.order)
    const mp = new Map<string, number>(); arr.forEach((c, i) => mp.set(c.id, i)); return mp
  }
  const cm1 = chMapOf(b1, m1), cm2 = chMapOf(b2, m2)
  // 4) 台账/表格行：tabId 里的卷 id 归一为卷位次，行 id 的章 id 归一为章位次
  const tabNorm = (tab: unknown, m: Map<string, number>) => {
    const t = String(tab)
    return t.startsWith('chapter-vol-') ? `VOL${m.get(t.slice('chapter-vol-'.length)) ?? -1}` : t
  }
  const rowsOf = (b: AnyRec, m: Map<string, number>, cm: Map<string, number>) =>
    [...((b.tableRows ?? []) as TableRow[])].map(r => ({
      tab: tabNorm(r.tabId, m), o: r.order ?? 0, d: r.data,
      rid: String(r.id).startsWith('ch-') ? `§CH${cm.get(String(r.id).slice(3)) ?? '?'}§` : 'row',
    })).sort((a, z) => a.tab.localeCompare(z.tab) || a.o - z.o || J(a.d).localeCompare(J(z.d)))
  const r1 = rowsOf(b1, m1, cm1), r2 = rowsOf(b2, m2, cm2)
  if (r1.length !== r2.length) return `表格行数不一致 ${r1.length}/${r2.length}`
  for (let i = 0; i < r1.length; i++) if (J(r1[i]) !== J(r2[i])) return `表格行#${i} 不一致: ${firstDiff(J(r1[i]), J(r2[i]))}`
  // 5) 表单
  const fd = (b: AnyRec) => J([...((b.formData ?? []) as AnyRec[])].sort((a, z) => String(a.tabId).localeCompare(String(z.tabId))).map(f => [f.tabId, f.data]))
  if (fd(b1) !== fd(b2)) return '表单数据不一致'
  // 6) 卡片（原有一行 `const cr = ...` 是死代码且类型错误，strict 模式暴露后删除；实际比对用下方 crSem）
  const crSem = (b: AnyRec) => J([...((b.cardRecords ?? []) as AnyRec[])].map(r => [r.tabId, r.name, r.data]).sort((a, z) => J(a).localeCompare(J(z))))
  if (crSem(b1) !== crSem(b2)) return '卡片数据不一致'
  // 7) 码字统计
  const ds = (b: AnyRec) => J(((b.dailyStats ?? []) as AnyRec[]).map(s => [s.date, s.words]).sort((a, z) => String(a[0]).localeCompare(String(z[0]))))
  if (ds(b1) !== ds(b2)) return '码字统计不一致'
  // 8) 项目级设置
  // 🔴 id 归一化（2026-10-05 补）：`worldSubActive::<tabId>` 的值是 **cardRecords 的 id 数组**，
  //    导入时会整体重发 id（`remapSettingValue` 负责把旧 id 映射到新 id，防悬空）。
  //    故这里必须像上面处理 `ch-<chapterId>` 行 id 那样，把 id 归一为**条目位次**再比 ——
  //    否则每轮往返都因 id 换代而假报「不一致」，而真正的语义（哪些条目活跃）其实是一致的。
  const activeIdRank = (b: AnyRec) => {
    const cards = [...((b.cardRecords ?? []) as AnyRec[])].map(r => `${r.tabId}\u0000${r.name}`).sort()
    const rank = new Map<string, number>()
    cards.forEach((k, i) => rank.set(k, i))
    const byId = new Map<string, string>()
    for (const r of (b.cardRecords ?? []) as AnyRec[]) byId.set(String(r.id), `${r.tabId}\u0000${r.name}`)
    return { rank, byId }
  }
  const st = (b: AnyRec) => {
    const { rank, byId } = activeIdRank(b)
    return J(((b.settingsKV ?? b.settings ?? []) as AnyRec[]).map(s => {
      const key = String(s.key)
      if (key.includes('worldSubActive::') && Array.isArray(s.value)) {
        // 归一为「条目位次」集合（排序后比，避免活跃序本身带来的噪声）
        const ranks = (s.value as unknown[])
          .map(id => { const k = byId.get(String(id)); return k === undefined ? -1 : rank.get(k) ?? -2 })
          .sort((a, z) => a - z)
        return [key, ranks]
      }
      return [key, s.value]
    }).sort((a, z) => String(a[0]).localeCompare(String(z[0]))))
  }
  if (st(b1) !== st(b2)) return `项目设置不一致: ${firstDiff(st(b1), st(b2))}`
  return null
}

// ---------- 1. 示范项目 导出→清库→导入→再导出 往返一致性 ----------
__resetMockStores()
const pid = await createDemoProject()
db.setCurrentProject(pid)
const b1 = await db.exportProject(pid) as unknown as AnyRec
ok('导出非空（含章节数据）', !!b1?.project && (b1.chapters?.length ?? 0) > 0,
  `chapters=${b1?.chapters?.length} rows=${b1?.tableRows?.length}`)

__resetMockStores()
const newPid = await db.importProject(b1 as unknown as ProjectBundle)
db.setCurrentProject(newPid)
const b2 = await db.exportProject(newPid) as unknown as AnyRec
const diff = semCompare(b1, b2)
if (diff) {
  // 诊断：对照 b1/b2 各自的「卷 id 集合」与「台账行引用的卷 id 集合」
  for (const [tag, b] of [['b1', b1], ['b2', b2]] as const) {
    const volIds = new Set((b.volumes as AnyRec[]).map(v => v.id))
    const refs = new Set((b.tableRows as AnyRec[]).filter(r => String(r.tabId).startsWith('chapter-vol-')).map(r => String(r.tabId).slice('chapter-vol-'.length)))
    const dangling = [...refs].filter(id => !volIds.has(id))
    console.log(`  [诊断] ${tag} 卷数=${volIds.size} 行引用卷数=${refs.size} 悬空引用=${dangling.length}`)
    if (dangling.length) console.log(`  [诊断] ${tag} 悬空引用=[${dangling.slice(0, 2).join(',')}] 卷id=[${[...volIds].slice(0, 2).join(',')}]`)
  }
}
ok('往返（导出→导入→导出）语义一致', diff === null, diff ?? '')

// ---------- 2. migrateChapterLedger：旧单表 → 按卷拆表，且幂等 ----------
// 复用示范项目的项目记录，但清空其卷/章/台账，注入 1.8 时代的旧格式单表数据
__resetMockStores()
const pid2 = await createDemoProject()
for (const store of ['volumes', 'chapters', 'tableRows'] as const) {
  const all = await memoryOps.getAll<{ id: string; projectId: string }>(store)
  const mine = all.filter(r => r.projectId === pid2)
  if (mine.length) await memoryOps.bulkDel(store, mine.map(r => r.id))
}
db.setCurrentProject(pid2)
await db.saveTableRow({ id: 'r-vol', projectId: pid2, tabId: 'chapter-master', order: 0, data: { '章节标题': '第一卷' } })
await db.saveTableRow({ id: 'ch-c1', projectId: pid2, tabId: 'chapter-master', order: 1, data: { '章节号': '第1章', '章节标题': '废脉', '所属卷': '第一卷', '出场人物': '陈渊' } })
await db.saveTableRow({ id: 'ch-c3', projectId: pid2, tabId: 'chapter-master', order: 2, data: { '章节号': '第2章', '章节标题': '塔灵', '所属卷': '第一卷' } })

await db.migrateChapterLedger()
const vols2 = await db.getAllVolumes()
const snap1 = __dumpAll()
await db.migrateChapterLedger()
ok('migrateChapterLedger 幂等（跑两遍全库快照一致）', snap1 === __dumpAll(), snap1 === __dumpAll() ? '' : '第二次运行产生了写差异')
const volId = vols2[0]?.id ?? ''
const masterLeft = (await memoryOps.getAll<TableRow>('tableRows')).filter(r => r.tabId === 'chapter-master').length
const volRows = (await memoryOps.getAll<TableRow>('tableRows')).filter(r => r.tabId === `chapter-vol-${volId}`)
ok('旧单表已拆为卷台账（1 卷 2 行，无残留 chapter-master）',
  vols2.length === 1 && masterLeft === 0 && volRows.length === 2,
  `vols=${vols2.length} master残留=${masterLeft} 卷台账行=${volRows.length} 行id=[${volRows.map(r => r.id).join(',')}]`)

// ---------- 3. migrateChapterNumbering：全局连续号，且幂等 ----------
// 注入与台账行 id 对齐的章节（ch-c1/ch-c2/ch-c3），台账行补 ch-c2（序章，不计入序号）
const mkChapter = (id: string, order: number, title: string, exclude?: boolean): Chapter =>
  ({ id, projectId: pid2, volumeId: volId, order, title, content: '', summary: '', status: '构思', wordCount: 0, createdAt: 0, updatedAt: 0, ...(exclude ? { excludeFromNumbering: true } : {}) })
await db.saveChapter(mkChapter('ch-c1', 0, '废脉'))
await db.saveChapter(mkChapter('ch-c2', 1, '序章', true))
await db.saveChapter(mkChapter('ch-c3', 2, '塔灵'))
await db.saveTableRow({ id: 'ch-c2', projectId: pid2, tabId: `chapter-vol-${volId}`, order: 1, data: { '章节号': '番外', '章节标题': '序章' } })
await db.migrateChapterNumbering()
const snapAfter1 = __dumpAll()
const ledgerOf = async () => (await memoryOps.getAll<TableRow>('tableRows')).filter(r => r.tabId === `chapter-vol-${volId}`)
const noOf = async (t: string) => (await ledgerOf()).find(r => r.data['章节标题'] === t)?.data['章节号'] ?? '(缺行)'
const orderOf = async (t: string) => (await ledgerOf()).find(r => r.data['章节标题'] === t)?.order
await db.migrateChapterNumbering()
ok('migrateChapterNumbering 幂等（跑两遍全库快照一致）', snapAfter1 === __dumpAll(), '第二次运行产生了写差异')
ok('章节号全局连续且「不计入序号」保留手填值',
  await noOf('废脉') === '第1章' && await noOf('序章') === '番外' && await noOf('塔灵') === '第2章' && await orderOf('塔灵') === 2,
  `废脉=${await noOf('废脉')} 序章=${await noOf('序章')} 塔灵=${await noOf('塔灵')} 塔灵行order=${await orderOf('塔灵')}`)

console.log(`\n===== 结果：${pass} PASS / ${fail} FAIL =====`)
process.exit(fail > 0 ? 1 : 0)
