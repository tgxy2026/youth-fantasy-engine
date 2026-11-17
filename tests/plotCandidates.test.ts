// ============ 剧情候选契约闸（3.6.0 · F 首期）============
//
// 盯五件事（都是"看起来能用、其实会覆盖作者内容"的坑）：
//   ① 只改细纲字段：字段解析不到 / 映射不唯一 ⇒ 不给应用；
//   ② 只认唯一匹配：模板同名两处时不猜；
//   ③ 确认时重读比较：当前值 ≠ 记录旧值 ⇒ 跳过，绝不覆盖；
//   ④ 部分失败如实：逐项结果 + 不宣称原子；
//   ⑤ 撤销只在可核验时提供。
import { readFileSync } from 'node:fs'
import {
  APPLY_OUTCOME_LABEL, OUTLINE_SLOTS, applicabilityOf, describeApplyReport, extractJsonArray,
  outlineFingerprintOf, parsePlotCandidates, planPlotApply, planPlotRevert, resolveOutlineFields,
  type PlotCandidate,
} from '@/lib/creative/plotCandidates'
import {
  applyPlotCandidate, discardPlotCandidate, loadPlotCandidates, outlineFieldKeys,
  outlineFingerprintNow, revertPlotCandidate,
} from '@/lib/creative/plotCandidateStore'
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => readFileSync(p, 'utf8')

const fields = [
  { sourceKey: '一、本章定位::本章一句话事件', label: '本章一句话事件' },
  { sourceKey: '二、节奏设计::章末钩子', label: '章末钩子' },
  { sourceKey: '一、本章定位::本章功能', label: '本章功能' },
]
const resolved3 = resolveOutlineFields(fields).resolved

const cand = (over: Partial<PlotCandidate> = {}): PlotCandidate => ({
  id: 'pc-1', projectId: 'p1', outlineCardId: 'card-1', chapterNo: 3, chapterTitle: '第3章 试',
  outlineFingerprint: 'fp-1', branchPoint: '主角要不要当场揭穿', title: '当场揭穿',
  rationale: '把冲突提前', fields: [
    { slot: '本章一句话事件', key: '一、本章定位::本章一句话事件', label: '本章一句话事件', before: '旧事件', after: '新事件', source: '模型提议' },
  ],
  status: 'pending', createdAt: 1, updatedAt: 1, ...over,
})

console.log('—— plotCandidates：剧情候选契约闸（3.6.0 · F）——')

// ---------- ① 字段解析 ----------
{
  const r = resolveOutlineFields(fields)
  ok('① 三个槽位都能解析到真实键', r.resolved.length === 3)
  ok('① 返回的是存储键而不是展示名', r.resolved[0].key.includes('::'))

  const archived = resolveOutlineFields([...fields, { sourceKey: 'x::章末钩子', label: '章末钩子', archived: true }])
  ok('① 归档字段不参与解析（不制造歧义）', archived.missing.every(m => m.reason !== 'ambiguous') && archived.resolved.some(x => x.slot === '章末钩子'))

  const ambiguous = resolveOutlineFields([
    { sourceKey: 'a::章末钩子', label: '章末钩子' },
    { sourceKey: 'b::钩子', label: '钩子' },
  ])
  ok('🔴 ① 同名/同义两处 ⇒ 判歧义，不给应用', ambiguous.missing.some(m => m.slot === '章末钩子' && m.reason === 'ambiguous'))
  ok('① 完全找不到 ⇒ not-found', resolveOutlineFields([]).missing.every(m => m.reason === 'not-found'))
  ok('① 槽位清单固定为三项（只改细纲的这三处）', OUTLINE_SLOTS.length === 3)
}

// ---------- ② 解析模型输出 ----------
{
  const ctx = {
    projectId: 'p1', outlineCardId: 'card-1', chapterNo: 3, chapterTitle: '第3章 试',
    outlineFingerprint: 'fp-1', resolved: resolved3,
    current: { '一、本章定位::本章一句话事件': '旧事件', '二、节奏设计::章末钩子': '旧钩子' },
    makeId: () => 'id-x', now: 100,
  }
  const text = JSON.stringify([
    { title: '当场揭穿', branchPoint: '要不要当场揭穿', rationale: '冲突提前', fields: { 一句话事件: '新事件', 章末钩子: '新钩子' } },
    { title: '按兵不动', branchPoint: '要不要装作没看见', rationale: '留到后面', fields: { 一句话事件: '旧事件' } },
    { title: '', branchPoint: 'x', fields: { 一句话事件: 'y' } },
    { title: '乱写字段', branchPoint: 'y', fields: { 不存在字段: 'z' } },
  ])
  const r = parsePlotCandidates(text, ctx)
  ok('② 合法候选被保留', r.candidates.length === 1 && r.candidates[0].title === '当场揭穿')
  ok('② 只保留有变化的字段（值没变不给应用）', r.candidates[0].fields.length === 2)
  ok('② 缺标题 / 只写非法字段的候选被丢', r.dropped === 3)
  ok('② before 取的是生成时的当前值', r.candidates[0].fields[0].before === '旧事件')
  ok('② 生成时记下细纲指纹', r.candidates[0].outlineFingerprint === 'fp-1')

  const many = parsePlotCandidates(JSON.stringify(Array.from({ length: 6 }, (_, i) => ({
    title: `t${i}`, branchPoint: 'b', fields: { 一句话事件: `e${i}` },
  }))), ctx)
  ok('② 候选数量受上限约束', many.candidates.length === 3)
  ok('② 从围栏/解释文字里也能切出 JSON', extractJsonArray('好的：\n```json\n[{"a":1}]\n```').startsWith('['))
  ok('② 非 JSON ⇒ 空结果（不抛）', parsePlotCandidates('模型没按格式', ctx).candidates.length === 0)
}

// ---------- ③ 指纹与适用性 ----------
{
  const keys = ['k1', 'k2']
  const a = outlineFingerprintOf({ name: '第3章', data: { k1: 'a', k2: 'b' } }, keys)
  const b = outlineFingerprintOf({ name: '第3章', data: { k2: 'b', k1: 'a' } }, keys)
  const c = outlineFingerprintOf({ name: '第3章', data: { k1: 'a', k2: '改了' } }, keys)
  ok('③ 指纹与字段顺序无关', a === b)
  ok('③ 任一字段变化 ⇒ 指纹变化', a !== c)

  ok('③ 指纹一致才可应用', applicabilityOf(cand(), 'fp-1').canApply)
  ok('🔴 ③ 细纲改过 ⇒ 拒绝（stale）', applicabilityOf(cand(), 'fp-2').reason === 'stale')
  ok('③ 已应用/已放弃/无字段都不可再应用',
    applicabilityOf(cand({ status: 'applied' }), 'fp-1').reason === 'applied'
    && applicabilityOf(cand({ status: 'discarded' }), 'fp-1').reason === 'discarded'
    && applicabilityOf(cand({ fields: [] }), 'fp-1').reason === 'no-fields')
}

// ---------- ④ 应用计划与撤销计划 ----------
{
  const c = cand()
  const key = '一、本章定位::本章一句话事件'
  const okPlan = planPlotApply(c, { name: '第3章', data: { [key]: '旧事件' } }, new Set([key]))
  ok('④ 当前值等于旧值 ⇒ ok', okPlan[0].outcome === 'ok')

  const changed = planPlotApply(c, { name: '第3章', data: { [key]: '作者手改过' } }, new Set([key]))
  ok('🔴 ④ 当前值已变 ⇒ value-changed（不覆盖）', changed[0].outcome === 'value-changed' && changed[0].current === '作者手改过')

  ok('④ 卡不在 ⇒ card-missing', planPlotApply(c, null, new Set([key]))[0].outcome === 'card-missing')
  ok('④ 字段解析不到 ⇒ field-missing', planPlotApply(c, { name: 'x', data: { [key]: '旧事件' } }, new Set())[0].outcome === 'field-missing')

  const applied = {
    at: 1, okCount: 1, skippedCount: 0, writeOk: true,
    items: [{ ...okPlan[0], current: '旧事件', outcome: 'ok' as const }],
  }
  const rev = planPlotRevert(applied, { data: { [key]: '新事件' } })
  ok('④ 仍等于应用后的值 ⇒ 可撤销', rev.revertible.length === 1 && rev.blocked.length === 0)

  const revBlocked = planPlotRevert(applied, { data: { [key]: '作者又改了' } })
  ok('🔴 ④ 应用后又被改 ⇒ 不可撤销，给人工差异', revBlocked.revertible.length === 0 && revBlocked.blocked.length === 1)
  ok('④ 可读的逐项结果文案', /已写入/.test(describeApplyReport(applied)) && /部分/.test(describeApplyReport({ ...applied, okCount: 1, items: [applied.items[0], { ...applied.items[0], outcome: 'value-changed' }] })))
  ok('④ 跳过原因有中文说明', APPLY_OUTCOME_LABEL['value-changed'].includes('未覆盖'))
}

// ---------- ⑤ 接线闸（只改细纲） ----------
{
  const store = read('src/lib/creative/plotCandidateStore.ts')
  ok('🔴 ⑤ 只写细纲卡（saveCardRecord），没有正文/设定写入', /saveCardRecord/.test(store)
    && !/saveChapter/.test(store) && !/commitEntities/.test(store))
  ok('🔴 ⑤ 应用前重读卡并比指纹', /outlineFingerprintOf\(card/.test(store) && /outlineFingerprint !== /.test(store))
  ok('⑤ 逐字段先比对再合并写入', /planPlotApply\(/.test(store) && /filter\(i => i\.outcome === 'ok'\)/.test(store))
  ok('⑤ 撤销先算计划、被改则整体停下', /planPlotRevert\(/.test(store) && /不做半截撤销/.test(store))
  const ui = read('src/components/creative/PlotCandidatePanel.tsx')
  ok('⑤ 界面展示逐字段 旧→新', /line-through/.test(ui) && /f\.after/.test(ui))
  ok('⑤ 界面在过期时禁用应用并说明原因', /stale/.test(ui) && /已禁止应用/.test(ui))
  ok('⑤ 首版只在创意写作页出现', read('src/components/creative/CreativeSetupSection.tsx').includes('PlotCandidatePanel'))
}

// ---------- ⑥ 存储层（真实 mock） ----------
{
  __resetMockStores()
  const pid = (await db.createProject('剧情候选')).id
  const empty = await loadPlotCandidates(pid)
  ok('⑥ 新项目读回空列表', empty.list.length === 0 && !empty.error)

  const missing = await applyPlotCandidate(pid, 'nope')
  ok('⑥ 应用不存在的候选 ⇒ 明确失败', !missing.ok && /找不到/.test(missing.error ?? ''))

  const noReport = await revertPlotCandidate(pid, 'nope')
  ok('⑥ 撤销不存在的候选 ⇒ 明确失败', !noReport.ok && /找不到/.test(noReport.error ?? ''))

  ok('⑥ 放弃不存在的候选 ⇒ false', (await discardPlotCandidate(pid, 'nope', 'x')) === false)
}

// ---------- ⑦ 真实应用路径（mock 存储：细纲卡 → 应用 → 撤销） ----------
{
  __resetMockStores()
  const pid = (await db.createProject('剧情候选应用')).id
  const keys = await outlineFieldKeys(pid)
  ok('⑦ 新项目没有模板快照时回落内置（不是"只能参考"）', keys.resolved.length > 0, JSON.stringify(keys.missing))

  const ev = keys.resolved.find(r => r.slot === '本章一句话事件')
  if (!ev) {
    ok('⑦ 内置模板里能找到「本章一句话事件」', false, JSON.stringify(keys.resolved))
  } else {
    await db.saveCardRecord({
      id: 'card-a', projectId: pid, tabId: 'chapter-outline', name: '第3章 试',
      data: { [ev.key]: '旧事件' }, order: 0, createdAt: 1,
    })
    const fp = await outlineFingerprintNow(pid, 'card-a')
    ok('⑦ 能取到细纲卡指纹', typeof fp === 'string' && fp.length > 0)

    const base = {
      id: 'pc-test', projectId: pid, outlineCardId: 'card-a', chapterNo: 3, chapterTitle: '第3章 试',
      outlineFingerprint: fp!, branchPoint: '要不要当场揭穿', title: '当场揭穿', rationale: '冲突提前',
      fields: [{ slot: '本章一句话事件', key: ev.key, label: ev.label, before: '旧事件', after: '新事件', source: '模型提议' }],
      status: 'pending', createdAt: 1, updatedAt: 1,
    }
    await db.setSettingFor(pid, 'plotCandidates', [base])

    const r = await applyPlotCandidate(pid, 'pc-test')
    ok('⑦ 应用成功并报出写入字段数', r.ok && r.report.okCount === 1 && r.status === 'applied')
    const cards1 = await db.getCardRecordsFor(pid, 'chapter-outline')
    ok('🔴 ⑦ 细纲字段真的变了', cards1.find(c => c.id === 'card-a')?.data[ev.key] === '新事件')
    ok('⑦ 正文没有被碰过（项目里依然没有章节）', (await db.getAllChapters()).length === 0)

    const rv = await revertPlotCandidate(pid, 'pc-test')
    ok('⑦ 撤销把字段写回旧值', rv.ok && rv.reverted === 1)
    const cards2 = await db.getCardRecordsFor(pid, 'chapter-outline')
    ok('⑦ 撤销后确实恢复', cards2.find(c => c.id === 'card-a')?.data[ev.key] === '旧事件')

    // 过期：先改卡，再用旧指纹的候选应用
    await db.saveCardRecord({ ...cards2.find(c => c.id === 'card-a')!, data: { [ev.key]: '作者手改' } })
    await db.setSettingFor(pid, 'plotCandidates', [{ ...base, id: 'pc-stale', fields: [{ ...base.fields[0], before: '作者手改', after: '模型建议' }] }])
    const stale = await applyPlotCandidate(pid, 'pc-stale')
    ok('🔴 ⑦ 细纲改过 ⇒ 拒绝应用（旧指纹）', !stale.ok && /过期/.test(stale.error ?? ''))
    const cards3 = await db.getCardRecordsFor(pid, 'chapter-outline')
    ok('🔴 ⑦ 被拒绝时一个字都没写', cards3.find(c => c.id === 'card-a')?.data[ev.key] === '作者手改')

    // 放弃：状态落库、内容不动
    await discardPlotCandidate(pid, 'pc-stale', '不走这条')
    const list = await loadPlotCandidates(pid)
    ok('⑦ 放弃后状态与理由都在', list.list[0]?.status === 'discarded' && /不走这条/.test(list.list[0]?.discardedReason ?? ''))
    const cards4 = await db.getCardRecordsFor(pid, 'chapter-outline')
    ok('⑦ 放弃不改细纲', cards4.find(c => c.id === 'card-a')?.data[ev.key] === '作者手改')
  }
}

console.log(`\n———— plotCandidates：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
