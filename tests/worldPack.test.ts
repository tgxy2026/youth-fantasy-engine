// ============ 世界引擎 · 世界包（3.0 · W4-1a）============
//
// 世界包是「跨作品引用」的唯一载体 ⇒ 断言锁三件事：
//   ① **抽什么**（范围单一真源；且**绝不含**正文 / 卷章 / 角色卡 / 对话）；
//   ② **剥项目字段**（否则引入方的世界会带着源项目的 pid，删源项目时被一起清掉）；
//   ③ **指纹只认内容**（id / name / origin 变了不影响；内容变了必须变）。
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import {
  worldPackTabSpecs, collectWorldPack, worldPackFingerprint, serializeWorldPack, parseWorldPack,
} from '../src/lib/world/worldPack'
import type { WorldPackTable } from '../src/lib/world/worldPack'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function main() {
  // ---------- 1) 抽包范围：单一真源 ----------
  {
    const specs = worldPackTabSpecs()
    const ids = specs.map(s => `${s.tabId}:${s.kind}`)

    for (const t of ['worldbase', 'power']) ok(`范围含 ${t}（母级 form）`, ids.includes(`${t}:form`))
    for (const t of ['worldbase', 'power', 'politics', 'economy', 'belief', 'justice']) {
      ok(`范围含 ${t}（子项 sub）`, ids.includes(`${t}:sub`))
    }
    for (const t of ['nations', 'geography', 'races', 'items', 'history', 'terms']) {
      ok(`范围含 ${t}（表格 table）`, ids.includes(`${t}:table`))
    }
    ok('范围含 misc-settings（卡片 card）', ids.includes('misc-settings:card'))

    // 🔴 绝不含：正文 / 卷章 / 角色卡 / 对话 / 运行账本
    const mustExclude = ['editor', 'volumes', 'chapters', 'char-main', 'char-secondary', 'char-npc',
      'relations', 'tavernReports', 'aiRuns', 'outline', 'chapterMaster']
    for (const t of mustExclude) ok(`范围不含 ${t}`, !specs.some(s => s.tabId === t))

    ok('清单无重复条目', new Set(ids).size === ids.length)
  }

  // ---------- 2) 抽包：只读、剥项目字段、空表不出条目 ----------
  {
    __resetMockStores()
    await db.saveFormData('worldbase', { '世界设定::时代': '架空大唐', '世界设定::空字段': '   ' })
    await db.saveFormData('power', {})   // 空表单 → 不该产出条目
    await db.saveTableRow({ id: 'r1', projectId: '', tabId: 'nations', data: { '国家势力::名称': '大唐' }, order: 0 })
    await db.saveCardRecord({ id: 'c1', projectId: '', tabId: 'misc-settings', name: '历法', data: { '其他设定::说明': '十二时辰' }, order: 0 })
    await db.saveSubSet('power', { id: 's1', projectId: '', tabId: '', name: '炼气体系', data: { '力量体系::境界': '炼气' }, order: 0 })
    await db.setSubActive('power', 's1', true)
    await db.saveSubSet('politics', { id: 's2', projectId: '', tabId: '', name: '北境政权', data: { '政治架构::体制': '分封' }, order: 0 })

    const pack = await collectWorldPack({ name: '测试世界', projectName: '测试书' })
    ok('世界名与来源写入', pack.name === '测试世界' && pack.origin.projectName === '测试书', JSON.stringify(pack.origin))
    ok('schema = 1', pack.schema === 1)
    ok('指纹非空', !!pack.fingerprint)

    const has = (tabId: string, kind: string) => pack.tables.some(t => t.tabId === tabId && t.kind === kind)
    ok('含 worldbase（有填充的表单）', has('worldbase', 'form'))
    ok('空表单 power 未产出条目', !has('power', 'form'))
    ok('含 nations 表格', has('nations', 'table'))
    ok('含 misc-settings 卡片', has('misc-settings', 'card'))
    ok('含 power 子项', has('power', 'sub'))
    ok('含 politics 子项（制度四页签）', has('politics', 'sub'))

    const nat = pack.tables.find(t => t.tabId === 'nations')
    ok('nations 行已抽到', !!nat && nat.rows.length === 1)
    const row0 = nat ? nat.rows[0] : { id: '', data: {}, order: 0 }
    ok('🔴 行内不含 projectId（否则引入方带着源项目归属）', !('projectId' in row0))
    ok('🔴 行内不含 tabId', !('tabId' in row0))
    ok('🔴 行内不含 updatedAt / createdAt', !('updatedAt' in row0) && !('createdAt' in row0))
    ok('行的 data 原样保留', row0.data['国家势力::名称'] === '大唐')

    const card = pack.tables.find(t => t.tabId === 'misc-settings')
    ok('卡片的展示名带过来', !!card && card.rows[0].name === '历法')

    ok('活跃子项随包带走', Array.isArray(pack.activeSubs.power) && pack.activeSubs.power.includes('s1'))
    ok('未设活跃的表 ⇒ 空列表（不误标活跃）', !pack.activeSubs.politics || pack.activeSubs.politics.length === 0)
  }

  // ---------- 3) 指纹：只认内容 ----------
  {
    type FP = { tables: WorldPackTable[]; activeSubs: Record<string, string[]> }
    const a: FP = { tables: [{ tabId: 'x', kind: 'form', rows: [{ id: 'x', data: { b: '2', a: '1' }, order: 0 }] }], activeSubs: {} }
    const b: FP = { tables: [{ tabId: 'x', kind: 'form', rows: [{ id: 'x', data: { a: '1', b: '2' }, order: 0 }] }], activeSubs: {} }
    ok('键序不同、内容相同 ⇒ 指纹相同（稳定序列化）', worldPackFingerprint(a) === worldPackFingerprint(b))

    const c: FP = { tables: [{ tabId: 'x', kind: 'form', rows: [{ id: 'x', data: { a: '9', b: '2' }, order: 0 }] }], activeSubs: {} }
    ok('内容变了 ⇒ 指纹变', worldPackFingerprint(a) !== worldPackFingerprint(c))

    const d: FP = { ...a, activeSubs: { x: ['s1'] } }
    ok('活跃列表变了 ⇒ 指纹变', worldPackFingerprint(a) !== worldPackFingerprint(d))
  }

  // ---------- 4) 序列化往返 / 非法输入 ----------
  {
    __resetMockStores()
    await db.saveFormData('worldbase', { '世界设定::时代': '架空大唐' })
    const pack = await collectWorldPack({ name: '往返世界', projectName: 'P' })
    const round = parseWorldPack(serializeWorldPack(pack))
    ok('往返后内容与指纹一致',
      !!round && round.fingerprint === pack.fingerprint && JSON.stringify(round.tables) === JSON.stringify(pack.tables))
    const back = parseWorldPack(serializeWorldPack(pack))
    const flat = (back?.tables ?? []).flatMap(t => t.rows)
    ok('往返后**行内**不带 projectId / tabId（「来源」只应留在 origin）',
      flat.length > 0 && flat.every(r => !Object.keys(r).includes('projectId') && !Object.keys(r).includes('tabId')))
    ok('非法 JSON ⇒ null（不抛）', parseWorldPack('{oops') === null)
    ok('schema 不符 ⇒ null', parseWorldPack('{"schema":2,"tables":[],"activeSubs":{}}') === null)
    ok('缺 tables ⇒ null', parseWorldPack('{"schema":1}') === null)
    ok('缺 activeSubs ⇒ null', parseWorldPack('{"schema":1,"tables":[]}') === null)
  }

  console.log(`\nworldPack: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
})
