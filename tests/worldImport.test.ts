// ============ 世界引擎 · 引入（3.0 · W4-1c）============
//
// 「跨作品引用」的全部含义就是这里 ⇒ 断言锁四件事：
//   ① 引入 = 把 A 项目的世界**搬进** B 项目（含表单 / 表格 / 卡片 / 子项四型）；
//   ② **覆盖式**且幂等（先清后写；重复引入结果一致）；
//   ③ 引入**指定版本** = 当时那份快照，而不是最新草稿（不可变版本的意义）；
//   ④ 子项活跃状态随引入带过来（否则 AI 侧静默失忆，界面却看不出问题）。
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import { createWorldFromCurrentProject, freezeWorld, updateWorldDraft } from '../src/lib/worlds'
import { importWorldIntoCurrent, getWorldImportRecord } from '../src/lib/worldImport'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function main() {
  // ---------- 1) 引入：A 项目的世界 → B 项目 ----------
  {
    __resetMockStores()
    db.setCurrentProject('pA')
    await db.saveFormData('worldbase', { '世界设定::时代': '架空大唐' })
    await db.saveTableRow({ id: 'ra1', projectId: 'pA', tabId: 'nations', data: { '国家势力::名称': '大唐' }, order: 0 })
    await db.saveSubSet('power', { id: 'sa1', projectId: 'pA', tabId: '', name: '炼气体系', data: { '力量体系::境界': '炼气' }, order: 0 })
    await db.setSubActive('power', 'sa1', true)
    const w = await createWorldFromCurrentProject('大唐世界', 'A书')

    db.setCurrentProject('pB')
    const rec = await importWorldIntoCurrent(w.id)
    ok('引入返回记录', !!rec && rec.worldId === w.id)
    ok('溯源已写入（per 项目）', (await getWorldImportRecord())?.worldName === '大唐世界')
    ok('记录含被写入的表清单', !!rec && rec.tabIds.includes('worldbase') && rec.tabIds.includes('nations'))

    ok('表单内容已写入 B', (await db.getFormData('worldbase'))['世界设定::时代'] === '架空大唐')
    const rows = await db.getTableRows('nations')
    ok('表格行已写入 B', rows.length === 1 && rows[0].data['国家势力::名称'] === '大唐')
    const subs = await db.getSubSets('power')
    ok('子项已写入 B', subs.length === 1 && subs[0].name === '炼气体系')
    ok('🔴 活跃状态随引入带过来（否则 AI 静默不带它）', (await db.getActiveSubIds('power')).includes(subs[0].id))
    ok('🔴 新行 id 是新的（不跟源项目撞主键）', rows[0].id !== 'ra1')
    ok('引入的行归属当前项目', rows[0].projectId === 'pB')
  }

  // ---------- 2) 覆盖式 ＋ 幂等 ----------
  {
    __resetMockStores()
    db.setCurrentProject('pA')
    await db.saveFormData('worldbase', { '世界设定::时代': '架空大唐' })
    await db.saveTableRow({ id: 'r1', projectId: 'pA', tabId: 'nations', data: { '国家势力::名称': '大唐' }, order: 0 })
    const w = await createWorldFromCurrentProject('世界X', 'A')

    db.setCurrentProject('pB')
    await db.saveTableRow({ id: 'local1', projectId: 'pB', tabId: 'nations', data: { '国家势力::名称': '本地国' }, order: 0 })
    await importWorldIntoCurrent(w.id)
    const rows = await db.getTableRows('nations')
    ok('🔴 覆盖式：本地旧行被清掉（不是追加）',
      rows.length === 1 && rows[0].data['国家势力::名称'] === '大唐', JSON.stringify(rows.map(r => r.data)))

    await importWorldIntoCurrent(w.id)
    ok('重复引入幂等（仍 1 行）', (await db.getTableRows('nations')).length === 1)
  }

  // ---------- 3) 引入指定版本 = 当时快照 ----------
  {
    __resetMockStores()
    db.setCurrentProject('pA')
    await db.saveFormData('worldbase', { '世界设定::时代': '初版' })
    const w = await createWorldFromCurrentProject('世界Y')
    await freezeWorld(w.id, '初版')     // v1 = 初版快照
    await updateWorldDraft(w.id, [
      { tabId: 'worldbase', kind: 'form', rows: [{ id: 'worldbase', data: { '世界设定::时代': '改版' }, order: 0 }] },
    ], {})

    db.setCurrentProject('pB')
    await importWorldIntoCurrent(w.id, 1)
    ok('🔴 引入 v1 = 当时那份快照，而不是最新草稿',
      (await db.getFormData('worldbase'))['世界设定::时代'] === '初版',
      (await db.getFormData('worldbase'))['世界设定::时代'])
    ok('溯源记下版本号', (await getWorldImportRecord())?.version === 1)

    await importWorldIntoCurrent(w.id, 0)
    ok('引入草稿 = 最新内容（版本号 0）',
      (await db.getFormData('worldbase'))['世界设定::时代'] === '改版'
      && (await getWorldImportRecord())?.version === 0)
  }

  // ---------- 4) 找不到时返回 null（不抛）----------
  {
    __resetMockStores()
    db.setCurrentProject('pB')
    ok('世界不存在 ⇒ null', (await importWorldIntoCurrent('nope')) === null)
    ok('版本不存在 ⇒ null', (await importWorldIntoCurrent('nope', 3)) === null)
  }

  console.log(`\nworldImport: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  if (e && e.stack) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
