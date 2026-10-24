// 手动探针（不进分批清单）：验证「游客导入三端导出文件」的实际行为。
//
// 背景：三端导出都是 `kind:'portable-data'`，但 `stores` 的形态不同 ——
//   · 游客导出：每个 store 是**行数组**（`collectAll()` 返回数组）
//   · 桌面/便携导出：每个 store 是**主键 -> 记录的对象**（`data.stores` 本来就是键化结构）
// `importGuestData` 只认数组（`Array.isArray(...) ? ... : []`），而它**先清空再写入**。
// 这个探针就是看：喂一份键化形态的合法导出文件，会不会清库。
import { ops } from '../src/lib/db/core'
import { importGuestData, guestDataObject } from '../src/lib/db/guestData'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('PASS ' + name) } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

const project = { id: 'p1', name: '既有项目', genre: '玄幻', intro: '', projectType: 'full', createdAt: 1, updatedAt: 1 }
const chapter = { id: 'c1', projectId: 'p1', volumeId: 'v1', title: '第一章', content: '既有正文-不许丢', summary: '', wordCount: 9, order: 0, status: '草稿', tags: [], createdAt: 1, updatedAt: 1 }

async function seedLocal() {
  await ops.put('projects', project)
  await ops.put('chapters', chapter)
}
const dump = async () => ({
  projects: (await ops.getAll<{ id: string }>('projects')).map(r => r.id),
  chapters: (await ops.getAll<{ id: string; content?: string }>('chapters')).map(r => `${r.id}:${r.content ?? ''}`),
})

async function main() {
  // ---------- ① 键化形态（桌面/便携导出的真实形状）----------
  await seedLocal()
  const before = await dump()
  ok('前置：本地已有 1 项目 / 1 章', before.projects.length === 1 && before.chapters.length === 1, JSON.stringify(before))

  const keyedExport = JSON.stringify({
    app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: 1,
    stores: {
      projects: { p1: { ...project, name: '导入进来的项目' } },
      chapters: { c1: { ...chapter, content: '导入进来的正文' } },
    },
  })
  const r1 = await importGuestData(keyedExport)
  const afterKeyed = await dump()
  ok('键化文件：importGuestData 返回成功', r1.ok === true, JSON.stringify(r1))
  ok('键化文件：导入后项目仍在（不丢）', afterKeyed.projects.length === 1, JSON.stringify(afterKeyed))
  ok('键化文件：导入后正文仍在（不丢）', afterKeyed.chapters.length === 1, JSON.stringify(afterKeyed))
  ok('键化文件：确实换成了文件里的内容',
    afterKeyed.chapters[0] === 'c1:导入进来的正文', JSON.stringify(afterKeyed))

  // ---------- ② 数组形态（游客自己导出的形状）----------
  await seedLocal()
  const arrayExport = JSON.stringify({
    app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 1, savedAt: 1,
    stores: { projects: [project], chapters: [{ ...chapter, content: '数组形态的正文' }] },
  })
  const r2 = await importGuestData(arrayExport)
  const afterArray = await dump()
  ok('数组文件：导入成功', r2.ok === true)
  ok('数组文件：内容正确', afterArray.chapters[0] === 'c1:数组形态的正文', JSON.stringify(afterArray))

  // ---------- ③ 游客自己导出的对象能否被自己导入（自往返）----------
  await seedLocal()
  const self = await guestDataObject()
  const r3 = await importGuestData(JSON.stringify(self.data))
  const afterSelf = await dump()
  ok('自往返：游客导出 → 游客导入 成功', r3.ok === true)
  ok('自往返：正文与标识不变', afterSelf.chapters[0] === 'c1:既有正文-不许丢', JSON.stringify(afterSelf))

  console.log(`\n———— importGuestShape：${pass} 通过 / ${fail} 失败 ————`)
  if (fail) process.exitCode = 1
}
main().catch(e => { console.error(e); process.exitCode = 1 })
