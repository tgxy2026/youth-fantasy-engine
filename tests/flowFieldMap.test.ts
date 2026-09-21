// ============ 声明式字段映射表的回归用例 ============
//
// lib/flow/fieldMap.ts 把「抽取出的实体」映射到「目标设定表 + 具体字段」。它是**弱引用**：
// 把「身份定位」写成「身份」，或给 terms 声明一个它根本没有的「别称」列，
// **不会报任何错**，只会在落库时静默丢字段（用户看到的是一条残缺条目），或更糟——
// 写进一个 schema 里不存在的键，在表里多出一列谁也看不见的幽灵数据。
// 本用例把「落点必须真实存在」这件事钉死在测试里：schema 一动、这里就红。
import { TABS } from '../src/lib/schema'
import { KIND_MAP, resolveFieldPath, resolveSlot, targetTabOf } from '../src/lib/flow/fieldMap'
import type { SettingEntityType } from '../src/lib/aiTasks'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const KINDS: SettingEntityType[] = ['人物', '势力', '地点', '种族', '物品', '术语']
const tabExists = (id: string) => TABS.some(t => t.id === id)

// ---------- ① 表口径固定：六类实体各写哪张表（防"拆书悄悄写进别的表"） ----------
// 这份预期与 settingLedger.TABLE_TARGET 是**同一套口径** —— 两处若漂移，
// 同一实体在「一键续写补登」与「一键拆书」里会落进不同的表，作者根本对不上。
const EXPECT_TAB: Record<string, string> = {
  人物: 'char-secondary', 势力: 'nations', 地点: 'geography', 种族: 'races', 物品: 'items', 术语: 'terms',
}
for (const k of KINDS) {
  ok(`映射存在：${k}`, !!KIND_MAP[k])
  ok(`目标表口径：${k} → ${EXPECT_TAB[k]}`, KIND_MAP[k].tabId === EXPECT_TAB[k], KIND_MAP[k].tabId)
  ok(`目标页签真实存在：${KIND_MAP[k].tabId}`, tabExists(KIND_MAP[k].tabId), KIND_MAP[k].tabId)
}

// ---------- ② 卡片型按 tier 分流的三张角色卡都必须真实存在 ----------
{
  const tiers = KIND_MAP['人物'].tabByTier ?? {}
  ok('人物按 tier 分流', Object.keys(tiers).length === 3, JSON.stringify(tiers))
  for (const [tier, tid] of Object.entries(tiers)) {
    ok(`人物 tier「${tier}」→ 页签存在（${tid}）`, tabExists(tid), tid)
  }
  ok('targetTabOf：主要 → char-main', targetTabOf('人物', '主要') === 'char-main', targetTabOf('人物', '主要'))
  ok('targetTabOf：次要 → char-secondary', targetTabOf('人物', '次要') === 'char-secondary')
  ok('targetTabOf：NPC → char-npc', targetTabOf('人物', 'NPC') === 'char-npc')
  ok('targetTabOf：tier 缺失时回落到默认卡（不是崩掉）', targetTabOf('人物') === 'char-secondary', targetTabOf('人物'))
  ok('targetTabOf：非人物类型忽略 tier', targetTabOf('势力', '主要') === 'nations')
}

// ---------- ③ 每个 kind 的「主名落点」必须能解析出来 ----------
for (const k of KINDS) {
  const key = resolveSlot(KIND_MAP[k].tabId, KIND_MAP[k].nameField)
  ok(`🔴 ${k} 的主名落点可解析（${KIND_MAP[k].nameField}）`, !!key, String(key))
}
// 人物：三张卡都必须能放下「姓名」
for (const tid of ['char-main', 'char-secondary', 'char-npc']) {
  ok(`人物主名落点：${tid} 有「姓名」`, !!resolveSlot(tid, '姓名'), tid)
}

// ---------- ④ 「一句话描述」至少要有一个候选落点存在 ----------
for (const k of KINDS) {
  const cands = KIND_MAP[k].descFields ?? []
  const hit = resolveFieldPath(KIND_MAP[k].tabId, cands)
  ok(`🔴 ${k} 的描述落点可解析（候选：${cands.join(' / ')}）`, !!hit, cands.join(' / '))
}
// 人物：主要/次要卡的描述落在「身份定位」，NPC 卡落在「身份」——同一条声明要能两边都命中
ok('人物描述落点：char-main → 身份定位', resolveFieldPath('char-main', ['身份定位', '身份'])?.field === '身份定位')
ok('人物描述落点：char-npc → 身份（NPC 卡没有「身份定位」）',
  resolveFieldPath('char-npc', ['身份定位', '身份'])?.field === '身份',
  String(resolveFieldPath('char-npc', ['身份定位', '身份'])?.field))

// ---------- ⑤ 负面对照：terms 表**没有**「别称」列 ----------
// 这是"声明式映射表"最容易骗过人的地方：别称在其它表都有，顺手给术语也声明一个，
// 表面上无害，实际落库时因为找不到列而静默丢弃。
ok('负面对照：terms 表确无「别称」列（若将来加了，这条会红，提醒同步 KIND_MAP）',
  resolveSlot('terms', '别称') === null, String(resolveSlot('terms', '别称')))
ok('术语的 aliasField 留空（无处可写就不声明）', KIND_MAP['术语'].aliasField === undefined,
  String(KIND_MAP['术语'].aliasField))
ok('对照：geography 有「别称」列', !!resolveSlot('geography', '别称'))

// ---------- ⑥ 别称落点（声明了就必须能解析） ----------
for (const k of KINDS) {
  const af = KIND_MAP[k].aliasField
  if (!af) continue
  const key = resolveSlot(KIND_MAP[k].tabId, af)
  ok(`${k} 声明了别称落点「${af}」且可解析`, !!key, String(key))
}

// ---------- ⑦ 扩展字段槽（B2 全字段抽取要用）至少有一个候选能落地 ----------
for (const k of KINDS) {
  for (const s of KIND_MAP[k].slots ?? []) {
    const hit = resolveFieldPath(KIND_MAP[k].tabId, s.to)
    ok(`${k}.${s.from} 的候选落点至少一个存在`, !!hit, s.to.join(' / '))
  }
}

// ---------- ⑧ 解析不存在的字段必须返回 null（而不是硬造一个键） ----------
ok('不存在的字段名 → null', resolveSlot('geography', '这个字段不存在') === null)
ok('不存在的页签 → null', resolveSlot('no-such-tab', '名称') === null)
ok('卡片型返回 `模块::字段`（不是裸字段名）',
  (resolveSlot('char-main', '姓名') ?? '').includes('::'), String(resolveSlot('char-main', '姓名')))
ok('表格型返回裸列名', resolveSlot('geography', '名称') === '名称', String(resolveSlot('geography', '名称')))

console.log(`\n—— flowFieldMap 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
