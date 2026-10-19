// 3.0 · W2-1b 章后整理 · 单测
//
// 盯三件事：
//   ① `parseChapterChanges` 解析容错（扁平数组 + kind 分派）；
//   ② 三类**确定性比对**的命中 / 未命中分界（🔴 AI 只抽候选，判「是否已登记」是我们的事）；
//   ③ 🔴 **源码闸** —— 只追加不覆盖、不凭空建条目、走 aiParse（禁裸 JSON.parse）。
import fs from 'node:fs'
import { parseChapterChanges } from '../src/lib/aiTasks/postProcess'
import { matchForeshadows, matchRelations, matchStatuses } from '../src/lib/outline/chapterPostProcess'
import type { CardRecord, TableRow } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const row = (id: string, tabId: string, data: Record<string, string>): TableRow =>
  ({ id, projectId: 'p', tabId, data, order: 0 })
const card = (id: string, name: string, data: Record<string, string>): CardRecord =>
  ({ id, projectId: 'p', tabId: 'char-main', name, data, order: 0 })

console.log('\n—— chapterPostProcess 用例开始 ——')

// ---------- ① parseChapterChanges ----------
{
  const r = parseChapterChanges(JSON.stringify([
    { kind: '伏笔', action: '埋设', code: 'F0001', content: '断剑上的刻纹' },
    { kind: '伏笔', action: '回收', code: '', content: '那句没说完的话' },
    { kind: '关系', a: '林昭', b: '苏合', type: '盟友', change: '从猜忌到结盟' },
    { kind: '状态', name: '林昭', state: '重伤昏迷', evidence: '林昭倒在血泊里' },
  ]))
  ok('伏笔抽到 2 条', r.foreshadows.length === 2)
  ok('action 认「埋设/回收」', r.foreshadows[0].action === '埋设' && r.foreshadows[1].action === '回收')
  ok('关系 a/b/type 正确', r.relations.length === 1 && r.relations[0].a === '林昭' && r.relations[0].type === '盟友')
  ok('状态 name/state/evidence 正确', r.statuses.length === 1 && r.statuses[0].state === '重伤昏迷')

  // 容错
  const dirty = parseChapterChanges(JSON.stringify([
    { kind: '伏笔', content: '' },                       // 空内容 → 丢
    { kind: '伏笔', content: '有效', action: '怪值' },     // action 非法 → 归「埋设」
    { kind: '关系', a: '甲' },                            // 缺 b → 丢
    { kind: '状态', name: '乙' },                          // 缺 state → 丢
    { kind: '不认识', name: '丙', state: 'x' },            // kind 不认识 → 丢
    { kind: '状态', name: '丁', state: '存活' },
    { kind: '状态', name: '丁', state: '又一条' },         // 同名去重
  ]))
  ok('空内容 / 缺字段 / 未知 kind 一律丢', dirty.foreshadows.length === 1 && dirty.relations.length === 0 && dirty.statuses.length === 1)
  ok('action 非法归「埋设」', dirty.foreshadows[0].action === '埋设')
  ok('状态同名去重', dirty.statuses.length === 1 && dirty.statuses[0].name === '丁')

  {
    const bad = parseChapterChanges('这不是 JSON')
    ok('非 JSON 输入不炸、返回空', !bad.foreshadows.length && !bad.relations.length && !bad.statuses.length)
  }
  ok('代码块围栏包裹也能解析', parseChapterChanges('```json\n[{"kind":"状态","name":"戊","state":"晋级"}]\n```').statuses.length === 1)
}

// ---------- ② matchForeshadows ----------
{
  const rows = [
    row('f1', 'foreshadow', { '编号': 'F0001', '伏笔内容': '断剑上的刻纹' }),
    row('f2', 'foreshadow', { '编号': 'F0002', '伏笔内容': '无名的墓碑' }),
  ]
  const hitCode = matchForeshadows([{ action: '埋设', code: 'F0001', content: '断剑上的刻纹' }], rows)
  ok('按编号命中 → changed + matchedId', hitCode[0].status === 'changed' && hitCode[0].matchedId === 'f1')

  const lower = matchForeshadows([{ action: '回收', code: 'f0001', content: 'x' }], rows)
  ok('编号大小写不敏感', lower[0].status === 'changed' && lower[0].matchedId === 'f1')

  const hitName = matchForeshadows([{ action: '埋设', code: '', content: '无名的墓碑' }], rows)
  ok('无编号时按内容归一化命中', hitName[0].status === 'changed' && hitName[0].matchedId === 'f2')

  const miss = matchForeshadows([{ action: '埋设', code: 'F9999', content: '从未登记过' }], rows)
  ok('🔴 未命中 → new（只提示，不凭空建）', miss[0].status === 'new' && miss[0].detail.includes('请先去登记'))
}

// ---------- ③ matchRelations ----------
{
  const rows = [
    row('r1', 'relations', { '人物A': '林昭', '人物B': '苏合', '关系类型': '盟友', '演变轨迹（按卷）': '旧' }),
    row('r2', 'relations', { '人物A': '林昭', '人物B': '苏合', '关系类型': '敌对', '演变轨迹（按卷）': '' }),
  ]
  const same = matchRelations([{ a: '林昭', b: '苏合', type: '盟友', change: '结盟' }], rows)
  ok('同对同类型命中 → changed', same[0].status === 'changed' && same[0].matchedId === 'r1')

  const typed = matchRelations([{ a: '林昭', b: '苏合', type: '敌对', change: '反目' }], rows)
  ok('同对多类型时按类型精确命中', typed[0].matchedId === 'r2')

  const reversed = matchRelations([{ a: '苏合', b: '林昭', type: '盟友', change: 'x' }], rows)
  ok('人物 A/B 顺序颠倒也能命中（无序匹配）', reversed[0].status === 'changed')

  const miss = matchRelations([{ a: '甲', b: '乙', type: '', change: '初识' }], rows)
  ok('🔴 未命中 → new（提示先登记）', miss[0].status === 'new' && miss[0].detail.includes('请先去登记'))
}

// ---------- ④ matchStatuses ----------
{
  const cards = [
    { tabId: 'char-main', list: [card('c1', '林昭', { 姓名: '林昭' })] },
    { tabId: 'char-npc', list: [card('c2', '路人甲', { 姓名: '路人甲' })] },
  ]
  const found = matchStatuses([{ name: '林昭', state: '重伤昏迷', evidence: '倒在血泊里' }], cards)
  ok('按名命中角色卡（不炸，且带 matchedId）', found[0].matchedId === 'c1')
  ok('状态条目带 label / evidence', found[0].label.includes('林昭') && found[0].evidence === '倒在血泊里')

  const noc = matchStatuses([{ name: '查无此人', state: '存活', evidence: '' }], cards)
  ok('🔴 找不到卡 → new（提示建卡，不凭空建）', noc[0].status === 'new' && noc[0].detail.includes('找不到'))
}

// ---------- ⑤ 🔴 源码闸 ----------
{
  const src = fs.readFileSync('src/lib/outline/chapterPostProcess.ts', 'utf8')
  ok('🔴 只追加不覆盖：伏笔走 appendCode',
    src.includes('appendCode(row.data[col], raw.code)'))
  ok('🔴 关系走 appendNote（追加，不覆盖属性列）',
    src.includes("appendNote(row.data['演变轨迹（按卷）'], note)"))
  ok('🔴 不凭空建条目（无 saveTableRow 新建 / 无 uid 建行）',
    !src.includes('nextAutoCode') && !src.includes("db.saveTableRow({\n      id:"))
  ok('实体复用既有 commitEntities（不重写比对）', src.includes('commitEntities(entityRaws'))

  const pp = fs.readFileSync('src/lib/aiTasks/postProcess.ts', 'utf8')
  ok('🔴 走 aiParse（parseObjectArray），禁裸 JSON.parse', pp.includes('parseObjectArray') && !pp.includes('JSON.parse'))
  ok('结构化必传 json: true', pp.includes('json: true'))
  ok('不可信文本包裹（newAuthorFence / authorBlock）', pp.includes('newAuthorFence') && pp.includes('authorBlock'))
  // WQ1-4：早退逻辑搬进 WithStatus 内核（正文为空 ⇒ completed 的合法空，不发请求）；
  // 包装函数把 result 的 data 取出，EMPTY_CHANGES 仍是无结果时的兜底。
  ok('正文为空直接早退（不发请求）', pp.includes("if (!body) return one('completed')"))
  ok('🔴 走三态解析（parseChapterChangesDetailed），失败可与合法空区分',
    pp.includes('parseChapterChangesDetailed') && pp.includes("outcome === 'invalid'"))
}

console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
