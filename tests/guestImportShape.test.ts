// ============ 3.2.3 · R4：游客导入的行形态兼容（P0 回归）============
//
// 缺陷（已修复，本文件是它的回归闸）：
//   三端导出同为 `kind:'portable-data'`，但 `stores` 行形态不同 —— 游客导出是**数组**，
//   桌面/便携写出的是**主键→记录的对象**。`importGuestData` 旧实现只认数组，且「先清空再写入」
//   ⇒ 喂桌面/便携导出文件时：**清库 + 导入 0 条 + 返回成功**。实测复现：游客导入桌面备份后整库变空。
//
// 修复口径：两种形态都收（`Object.values` 兼容键化），并且「一条可导入记录都没有」时**直接拒绝**，
// 本机数据一个字都不动。
import { ops } from '../src/lib/db/core'
import { importGuestData, guestDataObject } from '../src/lib/db/guestData'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PROJECT = { id: 'p1', name: '既有项目', genre: '玄幻', intro: '', projectType: 'full', createdAt: 1, updatedAt: 1 }
const CHAPTER = { id: 'c1', projectId: 'p1', volumeId: 'v1', title: '第一章', content: '既有正文-不许丢', summary: '', wordCount: 9, order: 0, status: '草稿', tags: [], createdAt: 1, updatedAt: 1 }

async function seed() {
  await ops.bulkDel('projects', ['p1', 'p2'])
  await ops.bulkDel('chapters', ['c1', 'c2'])
  await ops.put('projects', PROJECT)
  await ops.put('chapters', CHAPTER)
}
const snapshot = async () => ({
  projects: (await ops.getAll<{ id: string }>('projects')).map(r => r.id).sort(),
  chapters: (await ops.getAll<{ id: string; content?: string }>('chapters')).map(r => `${r.id}:${r.content ?? ''}`).sort(),
})
const fileOf = (stores: unknown) => JSON.stringify({ app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: 1, stores })

/** 桌面/便携真实导出形态：store → 主键→记录 */
const KEYED = {
  projects: { p2: { ...PROJECT, id: 'p2', name: '导入的项目' } },
  chapters: { c2: { ...CHAPTER, id: 'c2', content: '导入的正文' } },
}
/** 游客真实导出形态：store → 行数组 */
const ARRAY = {
  projects: [{ ...PROJECT, id: 'p2', name: '导入的项目' }],
  chapters: [{ ...CHAPTER, id: 'c2', content: '导入的正文' }],
}

async function main() {
  // ---------- ① 键化形态（桌面/便携导出）：这是 P0 的现场 ----------
  {
    await seed()
    const before = await snapshot()
    const r = await importGuestData(fileOf(KEYED))
    const after = await snapshot()
    ok('🔴 ① 键化文件导入返回成功', r.ok === true, JSON.stringify(r))
    ok('🔴 ① 记录落地（不是空库）', JSON.stringify(after) === JSON.stringify({ projects: ['p2'], chapters: ['c2:导入的正文'] }), JSON.stringify(after))
    ok('① 旧内容被替换（导入是替换语义，不是合并）', after.chapters.join() !== before.chapters.join())
    ok('① 不会残留导入前的记录', !after.projects.includes('p1'))
  }

  // ---------- ② 数组形态（游客自己导出）仍然可用 ----------
  {
    await seed()
    const r = await importGuestData(fileOf(ARRAY))
    const after = await snapshot()
    ok('② 数组文件导入成功', r.ok === true, JSON.stringify(r))
    ok('② 内容正确', JSON.stringify(after) === JSON.stringify({ projects: ['p2'], chapters: ['c2:导入的正文'] }), JSON.stringify(after))
  }

  // ---------- ③ 被数组展开污染的老文件（{"0":…,"1":…}）----------
  {
    await seed()
    const polluted = {
      projects: { 0: { ...PROJECT, id: 'p2', name: '老文件项目' } },
      chapters: { 0: { ...CHAPTER, id: 'c2', content: '老文件正文' } },
    }
    const r = await importGuestData(fileOf(polluted))
    const after = await snapshot()
    ok('③ 数字键老文件能导入', r.ok === true, JSON.stringify(r))
    ok('🔴 ③ 按记录里的真实主键落库', JSON.stringify(after) === JSON.stringify({ projects: ['p2'], chapters: ['c2:老文件正文'] }), JSON.stringify(after))
  }

  // ---------- ④ 一条可导入记录都没有 ⇒ 拒绝，且绝不清库 ----------
  {
    await seed()
    const before = await snapshot()
    const r = await importGuestData(fileOf({ unknownStore: [{ id: 'x' }] }))
    const after = await snapshot()
    ok('🔴 ④ 无可用记录时拒绝导入', r.ok === false, JSON.stringify(r))
    ok('🔴 ④ 本机数据一个字都没动', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after))
    ok('④ 拒绝理由说得清', /没有可导入的记录/.test(r.error ?? ''), String(r.error))
  }

  // ---------- ⑤ 非法文件照样拒绝（不回归旧校验）----------
  {
    await seed()
    const before = await snapshot()
    const wrongKind = await importGuestData(JSON.stringify({ app: 'youth-fantasy-engine', kind: 'project-bundle', stores: {} }))
    const broken = await importGuestData('{ not json')
    const empty = await importGuestData('   ')
    const after = await snapshot()
    ok('⑤ 非本软件格式被拒', wrongKind.ok === false && /格式标识/.test(wrongKind.error ?? ''), String(wrongKind.error))
    ok('⑤ 坏 JSON 被拒', broken.ok === false && /损坏/.test(broken.error ?? ''), String(broken.error))
    ok('⑤ 空文件被拒', empty.ok === false && /空文件/.test(empty.error ?? ''), String(empty.error))
    ok('⑤ 三次拒绝后数据仍完好', JSON.stringify(after) === JSON.stringify(before))
  }

  // ---------- ⑥ 自往返：导出 → 导入，内容不变（导入路径没被改坏）----------
  {
    await seed()
    const exported = await guestDataObject()
    const r = await importGuestData(JSON.stringify(exported.data))
    const after = await snapshot()
    ok('⑥ 游客自往返成功', r.ok === true, JSON.stringify(r))
    ok('🔴 ⑥ 正文与标识逐字一致', after.chapters[0] === 'c1:既有正文-不许丢', JSON.stringify(after))
  }

  console.log(`\n———— guestImportShape：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
