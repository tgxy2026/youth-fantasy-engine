// ============ B2 全字段：字段冲突检测 + 落点优先级 ============
//
// 两条按详细设计来的行为：
//  ① §7.2 冲突检测 —— 同一实体在不同块对**同一字段**给出互不包含的值，
//     不能静默挑一个（挑错 = 往设定表里写错数据），要如实列出交作者取舍。
//     但「更详细」不算冲突（`青岚宗` vs `青岚宗外门`），否则真矛盾会被详略差异淹没。
//  ② 落点优先级 —— 人物的 `descFields` 与 slot `identity` 都指「身份定位」。
//     desc 是一句话概括、identity 是明确身份，后者更准 → 让 identity 先占，
//     desc 退让（但 `descKey` 仍指向那一格，界面折叠行的摘要不空着）。
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { buildDraftBundle } from '../src/lib/flow/draft'
import { resolveSlot } from '../src/lib/flow/fieldMap'
import type { DraftRow } from '../src/lib/flow/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

__resetMockStores()
db.setCurrentProject('draft-fields-test')

const rowsOf = (b: Awaited<ReturnType<typeof buildDraftBundle>>) => b.rows as DraftRow[]
const byName = (rows: DraftRow[], n: string) => rows.find(r => r.name === n)
const fieldOf = (r: DraftRow, tabId: string, name: string) => {
  const k = resolveSlot(tabId, name)
  return k ? r.fields.find(f => f.key === k)?.value : undefined
}

// ---------- ① 冲突检测：两块给不同的境界 ----------
{
  const b = await buildDraftBundle([
    { source: '第1章', index: 1, entities: [{ type: '人物', name: '陈渊', desc: '', evidence: '', fields: { realm: '淬体一重' } }] },
    { source: '第5章', index: 5, entities: [{ type: '人物', name: '陈渊', desc: '', evidence: '', fields: { realm: '聚灵一重' } }] },
  ])
  const r = byName(rowsOf(b), '陈渊') as DraftRow
  ok('🔴 ① 同字段不同值 → 记成冲突（不静默挑一个）', (r.conflicts?.length ?? 0) === 1, JSON.stringify(r.conflicts))
  ok('  · 冲突里写明了是哪个字段（用表里的中文列名）', r.conflicts?.[0]?.field === '实力境界', String(r.conflicts?.[0]?.field))
  ok('  · 两个值都在（作者才知道该留哪个）',
    r.conflicts?.[0]?.existing === '淬体一重' && r.conflicts?.[0]?.incoming === '聚灵一重',
    JSON.stringify(r.conflicts?.[0]))
  ok('  · 冲突条置信度被扣 0.3（与「两块一致且无冲突」那条相比）',
    Math.abs((0.8 - r.confidence) - 0.3) < 1e-6, String(r.confidence))
  ok('  · 主值取更长的那个（字段本身仍要有个值）',
    fieldOf(r, r.tabId, '实力境界') === '聚灵一重' || fieldOf(r, r.tabId, '实力境界') === '淬体一重',
    String(fieldOf(r, r.tabId, '实力境界')))
}

// ---------- ② 负面对照：更详细的写法不算冲突 ----------
{
  const b = await buildDraftBundle([
    { source: '第1章', index: 1, entities: [{ type: '人物', name: '陈渊', desc: '', evidence: '', fields: { faction: '青岚宗' } }] },
    { source: '第3章', index: 3, entities: [{ type: '人物', name: '陈渊', desc: '', evidence: '', fields: { faction: '青岚宗外门' } }] },
  ])
  const r = byName(rowsOf(b), '陈渊') as DraftRow
  ok('② 负面对照：「青岚宗」vs「青岚宗外门」是详略差异，**不算冲突**',
    (r.conflicts?.length ?? 0) === 0, JSON.stringify(r.conflicts))
  ok('  · 保留更详细的那个', fieldOf(r, r.tabId, '所属势力') === '青岚宗外门',
    String(fieldOf(r, r.tabId, '所属势力')))
}

// ---------- ③ 归一化后相同也不算冲突 ----------
{
  const b = await buildDraftBundle([
    { source: '第1章', index: 1, entities: [{ type: '人物', name: '陈渊', desc: '', evidence: '', fields: { realm: '淬体三重' } }] },
    { source: '第2章', index: 2, entities: [{ type: '人物', name: '陈渊', desc: '', evidence: '', fields: { realm: '淬体三重。' } }] },
  ])
  ok('③ 只差标点/空白 → 不算冲突', (byName(rowsOf(b), '陈渊')?.conflicts?.length ?? 0) === 0,
    JSON.stringify(byName(rowsOf(b), '陈渊')?.conflicts))
}

// ---------- ③b 🔴 叙述型字段不报冲突（实测 38% 草稿被标冲突的元凶）----------
//   「壮实，嗓门大」vs「身板结实」是互补描述，「陈渊：兄长」vs「陈渊：兄妹」是同义写法 ——
//   都该安静合并（取更长），只有**硬事实字段**（境界/品级/类别/危险度/掌权者/实力等级）才报冲突。
{
  const b = await buildDraftBundle([
    { source: '第1章', index: 1, entities: [{ type: '人物', name: '王铁柱', desc: '', evidence: '', fields: { appearance: '壮实，嗓门大', relations: '陈渊：兄长' } }] },
    { source: '第4章', index: 4, entities: [{ type: '人物', name: '王铁柱', desc: '', evidence: '', fields: { appearance: '身板结实', relations: '陈渊：兄妹' } }] },
  ])
  const r = byName(rowsOf(b), '王铁柱') as DraftRow
  ok('🔴 ③b 叙述型字段（外貌/人际关系）差异**不算冲突**', (r.conflicts?.length ?? 0) === 0, JSON.stringify(r.conflicts))
  ok('  · 但仍然合并、取更详细的一份', (fieldOf(r, r.tabId, '外貌特征') ?? '').length > 0,
    String(fieldOf(r, r.tabId, '外貌特征')))
  // 负面对照：同两个块若在**硬事实字段**上不同，就必须报冲突（证明上面不是「一律不报」）
  const b2 = await buildDraftBundle([
    { source: '第1章', index: 1, entities: [{ type: '人物', name: '王铁柱', desc: '', evidence: '', fields: { realm: '淬体一重' } }] },
    { source: '第4章', index: 4, entities: [{ type: '人物', name: '王铁柱', desc: '', evidence: '', fields: { realm: '聚灵一重' } }] },
  ])
  ok('  · 负面对照：硬事实字段（实力境界）仍会报冲突', (byName(rowsOf(b2), '王铁柱')?.conflicts?.length ?? 0) === 1)
}

// ---------- ④ 落点优先级：identity 抢到「身份定位」，desc 退让 ----------
{
  const b = await buildDraftBundle([
    { source: '第1章', index: 1, entities: [{ type: '人物', name: '陈渊', tier: '主要', desc: '废脉少年', evidence: '', fields: { identity: '青岚宗外门弟子' } }] },
  ])
  const r = byName(rowsOf(b), '陈渊') as DraftRow
  ok('🔴 ④ identity 写进「身份定位」（B2 的细节字段优先于一句话概括）',
    fieldOf(r, r.tabId, '身份定位') === '青岚宗外门弟子', String(fieldOf(r, r.tabId, '身份定位')))
  ok('  · descKey 仍指向那一格（界面折叠行摘要不空着）',
    !!r.descKey && r.fields.find(f => f.key === r.descKey)?.value === '青岚宗外门弟子',
    String(r.descKey))
  ok('  · 同一列没被写两次（幽灵重复键）', new Set(r.fields.map(f => f.key)).size === r.fields.length,
    r.fields.map(f => f.key).join(','))
}

// ---------- ⑤ 没有 identity 时 desc 正常落到「身份定位」----------
{
  const b = await buildDraftBundle([
    { source: '第1章', index: 1, entities: [{ type: '人物', name: '张三', tier: 'NPC', desc: '杂役院管事', evidence: '' }] },
  ])
  const r = byName(rowsOf(b), '张三') as DraftRow
  ok('⑤ 无 identity → desc 落到「身份定位」（回退正常）',
    fieldOf(r, r.tabId, '身份定位') === '杂役院管事' || fieldOf(r, 'char-npc', '身份') === '杂役院管事',
    `${r.tabId} / ${fieldOf(r, r.tabId, '身份定位') ?? fieldOf(r, r.tabId, '身份')}`)
}

// ---------- ⑥ 表格型（地点）的字段也按 slots 落 ----------
{
  const b = await buildDraftBundle([
    { source: '第1章', index: 1, entities: [{
      type: '地点', name: '南荒秘境', desc: '秘境', evidence: '',
      fields: { category: '秘境', danger: '高', role: '藏有第二道残简' },
    }] },
  ])
  const r = byName(rowsOf(b), '南荒秘境') as DraftRow
  ok('⑥ 地点字段按 slots 落进 geography 的列',
    fieldOf(r, 'geography', '类别') === '秘境' && fieldOf(r, 'geography', '危险等级') === '高',
    JSON.stringify(r.fields.map(f => `${f.label}=${f.value}`)))
  ok('  · 描述仍进「备注」', fieldOf(r, 'geography', '备注') === '秘境', String(fieldOf(r, 'geography', '备注')))
}

console.log(`\n—— draftFields 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
