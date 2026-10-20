// ============ A2 细纲对照 + C1 世界差异 · 单元测试 ============
//
// 钉住：
//   ① 计划字段存在性校验
//   ② 正文引文定位
//   ③ 完成情况判定
//   ④ 额外变化检测
//   ⑤ 版本对齐 (tabId, kind, row.id)
//   ⑥ 新增/删除/修改条目
//   ⑦ 非语义字段忽略
//   ⑧ 同指纹显示内容一致

import {
  validatePlanField,
  locatePlanQuote,
  determineCompletionStatus,
  comparePlanWithBody,
  detectExtraChanges,
  summarizePlanCompare,
  type PlanCompareResult,
} from '../src/lib/aiTasks/planCompare'
import {
  compareWorldVersions,
  formatDiffAsMarkdown,
  type WorldVersionEntry,
} from '../src/lib/world/worldDiff'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

// ───────────────── ① 计划字段校验 ─────────────────
function case1() {
  const r1 = validatePlanField('field1', ['field1', 'field2'], true)
  ok('①① 字段存在且可参考', r1.ok)

  const r2 = validatePlanField('field3', ['field1', 'field2'], true)
  ok('①② 字段不存在', !r2.ok && r2.error?.includes('不在'))

  const r3 = validatePlanField('field1', ['field1', 'field2'], false)
  ok('①③ 不可参考', !r3.ok && r3.error?.includes('不允许'))
}

// ───────────────── ② 正文引文定位 ─────────────────
function case2() {
  const body = '这是第一章的正文内容。\n第二段内容在这里。\n第三段。'

  const r1 = locatePlanQuote('正文内容', body)
  ok('②① 逐字命中', r1.located && r1.paragraphIndices.length === 1)

  const r2 = locatePlanQuote('不存在', body)
  ok('②② 未命中', !r2.located && r2.paragraphIndices.length === 0)

  // 多处相同引文
  const r3 = locatePlanQuote('内容', '正文内容 正文内容')
  ok('②③ 多处命中', r3.located && r3.paragraphIndices.length === 2)
}

// ───────────────── ③ 完成情况判定 ─────────────────
function case3() {
  ok('③① 已完成', determineCompletionStatus('计划', ['计划']) === 'completed')
  ok('③② 未找到', determineCompletionStatus('计划', []) === 'not-found')
  ok('③③ 与计划不同', determineCompletionStatus('计划', ['不同']) === 'different')
}

// ───────────────── ④ 计划比较 ─────────────────
function case4() {
  const r1 = comparePlanWithBody(
    'field1', 'v1', '计划内容',
    '这是正文内容 计划内容 更多内容',
    true, ['field1'],
  )
  ok('④① 比较完成', r1.status === 'partial' && r1.paragraphIndices.length === 1, `实际状态: ${r1.status}`)

  const r2 = comparePlanWithBody(
    'field1', 'v1', '计划内容',
    '这是正文内容',
    true, ['field1'],
  )
  ok('④② 未找到', r2.status === 'not-found')

  const r3 = comparePlanWithBody(
    'field1', 'v1', '计划内容',
    '这是正文内容',
    false, ['field1'],
  )
  ok('④③ 不可参考', r3.status === 'insufficient')

  const r4 = comparePlanWithBody(
    'field3', 'v1', '计划内容',
    '正文',
    true, ['field1'],
  )
  ok('④④ 字段不存在', r4.status === 'insufficient')
}

// ───────────────── ⑤ 额外变化检测 ─────────────────
function case5() {
  const extra = detectExtraChanges('正文内容很长很多字超过十个字符。计划内容。新内容也很长很多字超过十个字符。', ['计划内容'])
  // 🔴 断言改的是**语义**不是"第一条必须是它"：函数按契约要列出**全部**未在计划中的句子，
  //    第一句「正文内容很长…」本来也是额外内容。原先断言 `extra[0].includes('新内容')`
  //    等于要求实现按"重要程度"重排 —— 契约里没有这条，是断言写错了。
  ok('⑤① 检测额外', extra.some(e => e.includes('新内容')), JSON.stringify(extra))

  const none = detectExtraChanges('正文内容。计划内容。', ['计划内容'])
  ok('⑤② 无额外', none.length === 0)
}

// ───────────────── ⑥ 计划比较汇总 ─────────────────
function case6() {
  const results: PlanCompareResult[] = [
    { planFieldId: 'f1', templateVersion: 'v1', planQuote: 'p1', status: 'completed', bodyQuotes: ['p1'], reason: '', paragraphIndices: [0] },
    { planFieldId: 'f2', templateVersion: 'v1', planQuote: 'p2', status: 'not-found', bodyQuotes: [], reason: '', paragraphIndices: [] },
    { planFieldId: 'f3', templateVersion: 'v1', planQuote: 'p3', status: 'different', bodyQuotes: ['p4'], reason: '', paragraphIndices: [0] },
  ]
  const summary = summarizePlanCompare(results, ['新内容'])
  ok('⑥① 汇总正确', summary.total === 3 && summary.completed === 1 && summary.notFound === 1 && summary.different === 1)
  ok('⑥② 额外变化', summary.extraChanges.length === 1)
}

// ───────────────── ⑦ 世界版本条目创建 ─────────────────
function case7() {
  const entry: WorldVersionEntry = {
    tabId: 'characters',
    kind: '人物',
    rowId: '1',
    name: '角色1',
    fields: { name: '角色1', desc: '描述', updatedAt: 123 },
    contentFingerprint: 'fp1',
    active: true,
  }
  ok('⑦① 创建条目', entry.name === '角色1' && entry.tabId === 'characters')
}

// ───────────────── ⑧ 版本对齐 ─────────────────
function case8() {
  const oldEntries: WorldVersionEntry[] = [
    { tabId: 'chars', kind: 'char', rowId: '1', name: '角色1', fields: { name: '角色1' }, contentFingerprint: 'fp1', active: true },
    { tabId: 'chars', kind: 'char', rowId: '2', name: '角色2', fields: { name: '角色2' }, contentFingerprint: 'fp2', active: true },
  ]
  const newEntries: WorldVersionEntry[] = [
    { tabId: 'chars', kind: 'char', rowId: '1', name: '角色1', fields: { name: '角色1' }, contentFingerprint: 'fp1', active: true },
    { tabId: 'chars', kind: 'char', rowId: '3', name: '角色3', fields: { name: '角色3' }, contentFingerprint: 'fp3', active: true },
  ]

  const diff = compareWorldVersions('v1', 'v2', oldEntries, newEntries)
  ok('⑧① 新增数', diff.addedCount === 1)
  ok('⑧② 删除数', diff.removedCount === 1)
  ok('⑧③ 修改数', diff.modifiedCount === 0)
}

// ───────────────── ⑨ 字段差异 ─────────────────
function case9() {
  const oldEntries: WorldVersionEntry[] = [
    { tabId: 'chars', kind: 'char', rowId: '1', name: '角色1', fields: { name: '角色1', desc: '旧描述' }, contentFingerprint: 'fp1', active: true },
  ]
  const newEntries: WorldVersionEntry[] = [
    { tabId: 'chars', kind: 'char', rowId: '1', name: '角色1', fields: { name: '角色1', desc: '新描述' }, contentFingerprint: 'fp2', active: true },
  ]

  const diff = compareWorldVersions('v1', 'v2', oldEntries, newEntries)
  ok('⑨① 修改数', diff.modifiedCount === 1)
  ok('⑨② 字段差异', diff.entryDiffs[0].fieldDiffs.length === 1 && diff.entryDiffs[0].fieldDiffs[0].fieldName === 'desc')
}

// ───────────────── ⑩ 非语义字段忽略 ─────────────────
function case10() {
  const oldEntries: WorldVersionEntry[] = [
    { tabId: 'chars', kind: 'char', rowId: '1', name: '角色1', fields: { name: '角色1', updatedAt: 123, projectSource: 'p1' }, contentFingerprint: 'fp1', active: true },
  ]
  const newEntries: WorldVersionEntry[] = [
    { tabId: 'chars', kind: 'char', rowId: '1', name: '角色1', fields: { name: '角色1', updatedAt: 456, projectSource: 'p2' }, contentFingerprint: 'fp2', active: true },
  ]

  const diff = compareWorldVersions('v1', 'v2', oldEntries, newEntries)
  ok('⑩① 忽略非语义字段', diff.modifiedCount === 0 && diff.unchangedCount === 1)
}

// ───────────────── ⑪ 同指纹显示内容一致 ─────────────────
function case11() {
  const oldEntries: WorldVersionEntry[] = [
    { tabId: 'chars', kind: 'char', rowId: '1', name: '角色1', fields: { name: '角色1', desc: '描述' }, contentFingerprint: 'fp1', active: true },
  ]
  const newEntries: WorldVersionEntry[] = [
    { tabId: 'chars', kind: 'char', rowId: '1', name: '角色1', fields: { name: '角色1', desc: '描述' }, contentFingerprint: 'fp1', active: true },
  ]

  const diff = compareWorldVersions('v1', 'v2', oldEntries, newEntries)
  ok('⑪① 同指纹未变化', diff.unchangedCount === 1 && diff.modifiedCount === 0)
}

// ───────────────── ⑫ 活跃状态变化 ─────────────────
function case12() {
  const oldEntries: WorldVersionEntry[] = [
    { tabId: 'chars', kind: 'char', rowId: '1', name: '角色1', fields: { name: '角色1' }, contentFingerprint: 'fp1', active: true },
  ]
  const newEntries: WorldVersionEntry[] = [
    { tabId: 'chars', kind: 'char', rowId: '1', name: '角色1', fields: { name: '角色1' }, contentFingerprint: 'fp1', active: false },
  ]

  const diff = compareWorldVersions('v1', 'v2', oldEntries, newEntries)
  ok('⑫① 活跃状态变化', diff.modifiedCount === 1 && diff.entryDiffs[0].activeChanged)
}

// ───────────────── ⑬ Markdown 格式化 ─────────────────
function case13() {
  const oldEntries: WorldVersionEntry[] = [
    { tabId: 'chars', kind: 'char', rowId: '1', name: '角色1', fields: { name: '角色1' }, contentFingerprint: 'fp1', active: true },
  ]
  const newEntries: WorldVersionEntry[] = [
    { tabId: 'chars', kind: 'char', rowId: '1', name: '角色1', fields: { name: '角色1', desc: '新描述' }, contentFingerprint: 'fp2', active: true },
  ]

  const diff = compareWorldVersions('v1', 'v2', oldEntries, newEntries)
  const md = formatDiffAsMarkdown(diff)
  ok('⑬① Markdown 格式', md.includes('世界版本差异') && md.includes('修改条目'))
}

// ───────────────── ⑭ 跨世界/重抽 ID 不连续 ─────────────────
function case14() {
  // 不同 tabId 的条目不应被合并
  const oldEntries: WorldVersionEntry[] = [
    { tabId: 'chars', kind: 'char', rowId: '1', name: '角色1', fields: { name: '角色1' }, contentFingerprint: 'fp1', active: true },
  ]
  const newEntries: WorldVersionEntry[] = [
    { tabId: 'nations', kind: 'nation', rowId: '1', name: '国家1', fields: { name: '国家1' }, contentFingerprint: 'fp2', active: true },
  ]

  const diff = compareWorldVersions('v1', 'v2', oldEntries, newEntries)
  ok('⑭① 不同 tabId 分别新增/删除', diff.addedCount === 1 && diff.removedCount === 1)
}

// ───────────────── ⑮ 空版本 ─────────────────
function case15() {
  const diff = compareWorldVersions('v1', 'v2', [], [])
  ok('⑮① 空版本', diff.addedCount === 0 && diff.removedCount === 0 && diff.entryDiffs.length === 0)
}

// ───────────────── 主函数 ─────────────────
function main() {
  case1()
  case2()
  case3()
  case4()
  case5()
  case6()
  case7()
  case8()
  case9()
  case10()
  case11()
  case12()
  case13()
  case14()
  case15()
  console.log(`\na2c1: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
