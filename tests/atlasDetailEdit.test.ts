// ============ 图鉴详情就地编辑（3.1.3 · 2026-10-19；3.7.1 开放纯跨表与角色单选）============
//
// 锁三件事：
//   ① 哪些字段能在详情里改 —— 文本 / 有候选的下拉 / 角色单选 / 纯跨表关联 / 自定义六类型放开，
//      编号、自引用父级（上级 / 层级归属）、所属地图、角色多选、日期、无候选下拉（历法）一律留在表格；
//   ② 「撤销本次改动」只回滚详情动过的那几栏，表格里其它未保存草稿一根不动；
//   ③ 回滚到库值时把草稿**摘干净**（不留下一条等值草稿，否则 dirty 会假亮、保存按钮永远可点）。
import { atlasDetailEditable } from '../src/lib/atlas/editability'
import { ATLAS_TABS, resolveAtlasFields } from '../src/lib/atlas/schema'
import { TABS } from '../src/lib/schema'
import { revertDraftCells, type DraftMap } from '../src/components/sheets/tableSheetDraftOps'
import type { ResolvedAtlasField } from '../src/lib/atlas/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 造一个解析后的字段（只写测试关心的那几项） */
function field(over: Partial<ResolvedAtlasField> & { key: string }): ResolvedAtlasField {
  return {
    label: over.key,
    source: 'builtin',
    groupId: 'basic',
    order: 0,
    tableVisible: true,
    detailVisible: true,
    searchable: true,
    aiReadable: true,
    aiWritable: false,
    appliesTo: '*',
    ...over,
  }
}

// ── ① 可编辑性 ──
const cases: Array<[string, ResolvedAtlasField, string | undefined, boolean]> = [
  ['内置纯文本（名称）可改', field({ key: '名称', builtinType: 'text' }), undefined, true],
  ['内置长文本（能力特性）可改', field({ key: '能力特性', builtinType: 'textarea' }), undefined, true],
  ['内置有候选下拉（类别）可改', field({ key: '类别', builtinType: 'select', options: ['人族', '魔兽'] }), undefined, true],
  ['编号不可改（自动生成 + 唯一校验）', field({ key: '编号', builtinType: 'text' }), 'items', false],
  ['角色单选列（当前持有者）可改', field({ key: '当前持有者', builtinType: 'character' }), 'items', true],
  ['角色多选列仍不可改', field({ key: '知情者', builtinType: 'characters' }), undefined, false],
  ['纯跨表引用（国家势力·地理位置）可改', field({ key: '地理位置', builtinType: 'tableRef', refTab: 'geography', refCol: '名称' }), 'nations', true],
  ['纯跨表引用（地理风物·势力归属）可改', field({ key: '势力归属', builtinType: 'tableRef', refTab: 'nations', refCol: '名称' }), 'geography', true],
  ['自引用父级（传 tabId：物品·上级）不可改', field({ key: '上级', builtinType: 'tableRef', refTab: 'items', refCol: '名称' }), 'items', false],
  ['自引用父级（不传 tabId：上级）不可改', field({ key: '上级', builtinType: 'tableRef', refTab: 'items', refCol: '名称' }), undefined, false],
  ['自引用父级（传 tabId：地理·层级归属）不可改', field({ key: '层级归属', builtinType: 'tableRef', refTab: 'geography', refCol: '名称' }), 'geography', false],
  ['自引用父级（不传 tabId：层级归属）不可改', field({ key: '层级归属', builtinType: 'tableRef', refTab: 'geography', refCol: '名称' }), undefined, false],
  ['地图绑定（地理·所属地图）不可改', field({ key: '所属地图', builtinType: 'tableRef', refTab: 'geomaps', refCol: '名称' }), 'geography', false],
  ['缺少来源表的 tableRef 不可改', field({ key: '残缺引用', builtinType: 'tableRef' }), 'items', false],
  ['结构化日期不可改', field({ key: '发生时间', builtinType: 'date' }), undefined, false],
  ['无候选下拉（历法）不可改', field({ key: '历法', builtinType: 'select' }), undefined, false],
  ['空的候选数组同样不可改', field({ key: 'x', builtinType: 'select', options: [] }), undefined, false],
  ['自定义字段一律可改', field({ key: 'cf_a', source: 'custom', customType: 'longText' }), undefined, true],
  ['自定义多选可改', field({ key: 'cf_b', source: 'custom', customType: 'multiSelect', options: ['甲'] }), undefined, true],
]
for (const [name, f, tabId, want] of cases) {
  ok(name, atlasDetailEditable(f, tabId) === want, `实际 ${atlasDetailEditable(f, tabId)}`)
}

// ── ①-b 四个图鉴页签真实 schema 逐项核验 ──
const expectedLocked: Record<string, string[]> = {
  races: ['编号', '上级'],
  items: ['编号', '上级'],
  nations: ['编号', '上级'],
  geography: ['编号', '层级归属', '所属地图'],
}
const expectedUnlockedRef: Record<string, string[]> = {
  races: [],
  items: ['当前持有者'],
  nations: ['地理位置'],
  geography: ['势力归属'],
}
for (const tabId of ATLAS_TABS) {
  const tab = TABS.find(t => t.id === tabId)
  ok(`存在图鉴页签定义：${tabId}`, !!tab)
  if (!tab) continue
  const resolved = resolveAtlasFields(tab, { purpose: 'detail', ignoreAppliesTo: true })
  const locked = resolved.filter(f => !atlasDetailEditable(f, tabId)).map(f => f.key)
  ok(
    `${tabId} 锁定字段清单一致`,
    locked.length === expectedLocked[tabId].length && expectedLocked[tabId].every(k => locked.includes(k)),
    `实际锁定=[${locked.join(', ')}]`,
  )
  for (const key of expectedUnlockedRef[tabId]) {
    const f = resolved.find(x => x.key === key)
    ok(`${tabId}.${key} 已开放图鉴可编辑`, !!f && atlasDetailEditable(f, tabId))
  }
}

// ── ② / ③ 撤销本次改动 ──
const base = { 名称: '冰狼', 类别: '魔兽', 备注: '' }

// 详情里改了「名称」和「类别」，表格里另有一栏「备注」的未保存改动 —— 撤销只能动前两栏
const drafts: DraftMap = {
  r1: { 名称: '冰原狼', 类别: '灵兽', 备注: '表格里改的，不许动' },
  r2: { 名称: '另一行' },
}
const after = revertDraftCells(drafts, base, 'r1', { 名称: '冰狼', 类别: '魔兽' })

ok('回滚到库值 ⇒ 该栏草稿被摘掉', !('名称' in (after.r1 ?? {})) && !('类别' in (after.r1 ?? {})), JSON.stringify(after.r1))
ok('表格里其它未保存改动一根不动', after.r1?.备注 === '表格里改的，不许动', JSON.stringify(after.r1))
ok('别的行原样保留', after.r2?.名称 === '另一行', JSON.stringify(after.r2))
ok('不修改原对象（纯函数）', drafts.r1.名称 === '冰原狼', JSON.stringify(drafts.r1))

// 回滚到一个**不等于库值**的快照（进入编辑态时该栏本来就带着草稿）
const keep: DraftMap = { r1: { 名称: '冰原狼', 类别: '灵兽' } }
const back = revertDraftCells(keep, base, 'r1', { 名称: '半兽', 类别: '魔兽' })
ok('快照值≠库值 ⇒ 草稿写成快照值', back.r1?.名称 === '半兽', JSON.stringify(back.r1))
ok('快照值=库值的那栏照样摘掉', !('类别' in (back.r1 ?? {})), JSON.stringify(back.r1))

// 撤干净之后整行草稿应当消失（否则 dirtyKeys 会永远非空）
const wipe = revertDraftCells({ r1: { 名称: '冰原狼' } }, base, 'r1', { 名称: '冰狼' })
ok('撤干净 ⇒ 整行草稿被删除', wipe.r1 === undefined && !('r1' in wipe), JSON.stringify(wipe))

// 三种"无事可做"的情形都必须原样返回（同一引用，避免无谓重渲染）
const untouched: DraftMap = { r1: { 备注: 'x' } }
ok('该行本来没草稿 ⇒ 原样返回', revertDraftCells(untouched, base, 'r9', { 名称: '冰狼' }) === untouched)
ok('快照里没有任何一栏有草稿 ⇒ 原样返回', revertDraftCells(untouched, base, 'r1', { 名称: '冰狼' }) === untouched)
ok('空快照 ⇒ 原样返回', revertDraftCells(untouched, base, 'r1', {}) === untouched)

console.log(`\natlasDetailEdit: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
