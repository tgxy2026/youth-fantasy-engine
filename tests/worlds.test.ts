// ============ 世界库 · 封存与不可变版本（3.0 · W4-1b）============
//
// 世界库是「版本封存 / 跨作品引用」的落点 ⇒ 断言锁三件事：
//   ① **封存出来的版本不可变**（改草稿一个字节都不能动到已封存的版本）；
//   ② **不是项目级数据**（切项目仍可读；这正是「同一世界供多个作品引用」的前提）；
//   ③ 版本号单调递增、指纹跟着草稿走。
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import {
  createWorldFromCurrentProject, freezeWorld, updateWorldDraft, renameWorld, draftDiffers,
} from '../src/lib/worlds'
import type { WorldPackTable } from '../src/lib/worldTypes'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const draftOf = (era: string): WorldPackTable[] => [
  { tabId: 'worldbase', kind: 'form', rows: [{ id: 'worldbase', data: { '世界设定::时代': era }, order: 0 }] },
]

async function main() {
  // ---------- 1) 从当前项目抽包入库 ----------
  {
    __resetMockStores()
    db.setCurrentProject('p1')
    await db.saveFormData('worldbase', { '世界设定::时代': '架空大唐' })
    await db.saveTableRow({ id: 'r1', projectId: 'p1', tabId: 'nations', data: { '国家势力::名称': '大唐' }, order: 0 })

    const w = await createWorldFromCurrentProject('大唐世界', '测试书')
    ok('世界已入库', !!w.id && w.name === '大唐世界')
    ok('来源记录项目与书名', w.origin.projectId === 'p1' && w.origin.projectName === '测试书')
    ok('草稿含抽到的内容', w.tables.length >= 2, String(w.tables.length))
    ok('初始无版本', w.versions.length === 0)

    const listed = await db.listWorlds()
    ok('列表能读到', listed.some(x => x.id === w.id))
  }

  // ---------- 2) 封存：不可变版本 ----------
  {
    __resetMockStores()
    db.setCurrentProject('p1')
    await db.saveFormData('worldbase', { '世界设定::时代': '初版' })
    const w0 = await createWorldFromCurrentProject('世界A')

    const w1 = await freezeWorld(w0.id, '初版定稿')
    ok('封存产生 v1', !!w1 && w1.versions.length === 1 && w1.versions[0].v === 1)
    ok('v1 带备注', !!w1 && w1.versions[0].note === '初版定稿')
    ok('v1 指纹 = 当时草稿指纹', !!w1 && w1.versions[0].fingerprint === w0.fingerprint)

    const w2 = await updateWorldDraft(w0.id, draftOf('改版'), {})
    ok('改草稿后草稿指纹变了', !!w2 && w2.fingerprint !== w0.fingerprint)
    ok('🔴 已封存版本不受影响（版本存的是当时那份副本）',
      !!w2 && w2.versions[0].fingerprint === w0.fingerprint
      && JSON.stringify(w2.versions[0].tables) === JSON.stringify(w0.tables),
      JSON.stringify(w2?.versions[0]?.tables))

    const w3 = await freezeWorld(w0.id)
    ok('再封存 ⇒ v2（单调递增）', !!w3 && w3.versions.length === 2 && w3.versions[1].v === 2)
    ok('v2 指纹 = 新草稿', !!w3 && w3.versions[1].fingerprint === w2?.fingerprint)
    ok('无备注时不写 note 字段', !!w3 && !('note' in w3.versions[1]))
  }

  // ---------- 3) draftDiffers：草稿 vs 最新封存 ----------
  {
    __resetMockStores()
    db.setCurrentProject('p1')
    await db.saveFormData('worldbase', { '世界设定::时代': '初版' })
    const w0 = await createWorldFromCurrentProject('世界B')
    ok('无版本且草稿非空 ⇒ 视为未封存', draftDiffers(w0) === true)

    const w1 = await freezeWorld(w0.id)
    ok('刚封存 ⇒ 一致', !!w1 && draftDiffers(w1) === false)

    const w2 = await updateWorldDraft(w0.id, draftOf('x'), {})
    ok('改草稿后 ⇒ 不一致（提示需再封）', !!w2 && draftDiffers(w2) === true)
  }

  // ---------- 4) 🔴 非项目级：切项目仍可读 ----------
  {
    __resetMockStores()
    db.setCurrentProject('p1')
    await db.saveFormData('worldbase', { '世界设定::时代': '架空大唐' })
    const w = await createWorldFromCurrentProject('跨作品世界')
    db.setCurrentProject('p2')   // 切到另一个项目
    const seen = await db.listWorlds()
    const hit = seen.find(x => x.id === w.id)
    ok('🔴 切项目后世界库仍可读（**非项目级**数据）', !!hit)
    ok('来源仍是 p1，而不是当前项目', !!hit && hit.origin.projectId === 'p1')
  }

  // ---------- 5) 重命名 / 删除 / 找不到时的行为 ----------
  {
    __resetMockStores()
    db.setCurrentProject('p1')
    await db.saveFormData('worldbase', { '世界设定::时代': 'x' })
    const w = await createWorldFromCurrentProject('旧名')

    const r = await renameWorld(w.id, '  新名  ')
    ok('重命名去掉首尾空格', !!r && r.name === '新名')
    ok('重命名不动内容指纹', !!r && r.fingerprint === w.fingerprint)

    await db.deleteWorld(w.id)
    const after = await db.listWorlds()
    ok('删除后列表不再有它', !after.some(x => x.id === w.id))
    ok('对不存在的世界 freeze ⇒ null（不抛）', (await freezeWorld(w.id)) === null)
    ok('对不存在的世界 updateDraft ⇒ null', (await updateWorldDraft(w.id, [], {})) === null)
  }

  console.log(`\nworlds: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
