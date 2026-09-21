/**
 * 示范项目种子 · 跨表引用对账（**真跑一遍 createDemoProject**，再校验落库数据）
 *
 * 为什么要有它：
 *   种子里大量使用「跨表引用」列（tableRef）—— 时间脉络的地理位置、伏笔的地理位置、
 *   势力的上级、卡片的「所属势力 / 种族 / 地理位置」……这些列在界面上是**下拉选**，
 *   值写错不会报错，只会静默地显示成空白或裸文本（地图叠加、势力树、联动统统失效）。
 *   本项目已经因为「同名异写」吃过亏（见 seed-schema-check 的注释），所以把引用合法性也闸住。
 *
 * 与 seed-schema-check 的分工：
 *   · seed-schema-check：查「键名对不对」（键写错 → 界面一片空白）
 *   · 本用例：查「值指向的东西在不在」（值指向不存在的条目 → 联动失效）
 *
 * 本用例**真的执行一遍播种**，所以 formByExamples / card() / 表格行三条填充路径全被覆盖。
 */
import * as db from '../src/lib/db'
import { createDemoProject } from '../src/lib/seedData'
import { __resetMockStores } from './mock-memory'
import { TABS, CARD_TABLE_REF_FIELDS } from '../src/lib/schema'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

__resetMockStores()
const pid = await createDemoProject()
db.setCurrentProject(pid)

// ---------- 收集落库数据 ----------
type Row = { tabId: string; data: Record<string, string> }
const rowsByTab: Record<string, Row[]> = {}

for (const t of TABS) {
  if (t.type !== 'table' && t.type !== 'map') continue
  const rows = await db.getTableRows(t.id)
  if (rows.length) rowsByTab[t.id] = rows.map(r => ({ tabId: t.id, data: r.data as Record<string, string> }))
}

/** 某表某列的取值集合（用于校验引用） */
function pool(tabId: string, col: string): Set<string> {
  return new Set((rowsByTab[tabId] ?? []).map(r => r.data[col]).filter(Boolean))
}

const errors: string[] = []
let checked = 0

// ---------- ① 表格的跨表引用列 ----------
for (const t of TABS) {
  const rows = rowsByTab[t.id]
  if (!rows || !t.columns) continue
  for (const col of t.columns) {
    if (col.type !== 'tableRef') continue
    const target = pool(col.refTab!, col.refCol!)
    for (const r of rows) {
      const v = r.data[col.name]
      if (!v) continue
      checked++
      if (!target.has(v)) {
        errors.push(`[${t.id}] 「${col.name}」=「${v}」—— ${col.refTab}.${col.refCol} 里没有这个值`)
      }
    }
  }
  // 历法列：取值必须来自项目级历法配置（种子写的是 `[{ name: '灵历' }]`）
  const calCol = t.columns.find(c => (c as { calendar?: boolean }).calendar)
  if (calCol) {
    const valid = new Set(['灵历'])
    for (const r of rows) {
      const v = r.data[calCol.name]
      if (!v) continue
      checked++
      if (!valid.has(v)) errors.push(`[${t.id}] 「${calCol.name}」=「${v}」不在历法配置里`)
    }
  }
}

// ---------- ② 角色卡的跨表引用字段 ----------
for (const tabId of ['char-main', 'char-secondary', 'char-npc']) {
  const cards = await db.getCardRecords(tabId)
  for (const card of cards) {
    for (const [field, ref] of Object.entries(CARD_TABLE_REF_FIELDS)) {
      const v = card.data[field]
      if (!v) continue
      checked++
      const target = pool(ref.tabId, ref.col)
      if (!target.has(v)) {
        errors.push(`[卡片:${tabId}] ${card.name} 的「${field}」=「${v}」—— ${ref.tabId}.${ref.col} 里没有这个值`)
      }
    }
  }
}

// ---------- ③ 断言 ----------
ok('确实读到了表格数据（前置条件）', Object.keys(rowsByTab).length >= 8, Object.keys(rowsByTab).join(','))
ok(`跨表引用全部有效（共校验 ${checked} 处）`, errors.length === 0, errors.slice(0, 8).join(' | '))

// 引用列不能全是空的 —— 全空等于"功能看不到"，属于演示失效
const geoRefs = [
  ...(rowsByTab['timeline'] ?? []).map(r => r.data['地理位置']),
  ...(rowsByTab['foreshadow'] ?? []).map(r => r.data['地理位置']),
].filter(Boolean)
ok('时间脉络/伏笔的地理位置有数据（地图叠加才演示得出来）', geoRefs.length >= 20, String(geoRefs.length))

const facRefs = (rowsByTab['faction-rels'] ?? []).map(r => r.data['势力A']).filter(Boolean)
ok('势力关系有力数据（势力图谱才演示得出来）', facRefs.length >= 5, String(facRefs.length))

// ---------- ④ 功能覆盖：每个需要种子的表格页签都不该是空的 ----------
// 排除三类：只读汇总视图（chapter-master 由卷台账聚合）、地图（geomaps 由迁移建、格子需作者手绘）、
// 画布（plot-canvas 靠 AI 现场生成）。
const SKIP_TABS = new Set(['chapter-master', 'geomaps', 'geography-map', 'plot-canvas'])
const emptyTabs: string[] = []
for (const t of TABS) {
  if (t.type !== 'table') continue
  if (SKIP_TABS.has(t.id)) continue
  if (!(await db.getTableRows(t.id)).length) emptyTabs.push(`${t.id}（${t.name}）`)
}
ok('所有表格页签都有示例数据（功能都能看到）', emptyTabs.length === 0, emptyTabs.join('、'))

// 2026-09-20：「其他设定」改成**卡片型**，于是它掉到了上面这条闸的覆盖面之外（④ 只查 type==='table'）。
// 卡片型资料页签同样"不该是空的"，这里单独补一条 —— 免得改完形态就没人管它了。
const miscCards = await db.getCardRecords('misc-settings')
ok('「其他设定」示例数据是卡片（改形态后表格口径盖不到它，故单独断）',
  miscCards.length >= 3, `卡片 ${miscCards.length} 张`)
ok('  · 卡片的存储键是 `设定内容::内容`（schema / 迁移 / 这里三处必须一致）',
  miscCards.some(c => (c.data['设定内容::内容'] ?? '').trim().length > 0),
  JSON.stringify(Object.keys(miscCards[0]?.data ?? {})))
ok('  · 卡名非空（卡名就是设定名，设定检索与引用高亮都取它）',
  miscCards.length > 0 && miscCards.every(c => !!c.name?.trim()))

// ---------- ⑤ 「人物」列必须是真人物 ----------
// 2026-09-19：示范项目《人物关系》里出现过「萧景行 ↔ 中州萧家」—— 中州萧家是《国家势力》里的世家。
// 这类错误界面上**不会报错**（就是一格文本，下拉也不校验），但语义是错的：
// 《人物关系》的设计是「人物两两关系台账」，混进组织会让"关系失忆"这道防线失效，
// 而且 AI 整理会照着一个错范式继续生成。上面的 ① 只查 tableRef，人物列一直没闸 —— 就是这里补上的。
const cardNames = new Set<string>()
for (const tabId of ['char-main', 'char-secondary', 'char-npc']) {
  for (const c of await db.getCardRecords(tabId)) if (c.name?.trim()) cardNames.add(c.name.trim())
}
ok('确实读到了角色卡（前置条件）', cardNames.size >= 5, String(cardNames.size))

const personErrors: string[] = []
let personChecked = 0
for (const t of TABS) {
  const rows = rowsByTab[t.id]
  if (!rows || !t.columns) continue
  for (const col of t.columns) {
    if (col.type !== 'character') continue          // characters（多人列）种子里暂未使用
    for (const r of rows) {
      const v = (r.data[col.name] ?? '').trim()
      if (!v) continue
      personChecked++
      if (!cardNames.has(v)) personErrors.push(`[${t.id}] 「${col.name}」=「${v}」—— 不是任何一张角色卡的名字`)
    }
  }
}
ok(`「人物」列的值都是真角色（共校验 ${personChecked} 处）`, personErrors.length === 0, personErrors.slice(0, 6).join(' | '))

// ---------- ⑥ 关系表不该有重复条目（A-B 与 B-A 视为同一条）----------
// 2026-09-19：「陈渊 ↔ 血鸦（敌对）」在示范项目里被登记了两遍。
// 设计上「已有关系不会重复生成」，手录也不该重复 —— 重复行会让关系图谱出现两条同向边，
// 也会让「按关系类型着色 / 点边看详情」这类联动看起来像坏了。
const dupErrors: string[] = []
for (const tabId of ['relations', 'faction-rels']) {
  const rows = rowsByTab[tabId] ?? []
  const cols = TABS.find(t => t.id === tabId)?.columns ?? []
  const [ac, bc] = cols
  const tc = cols.find(c => c.type === 'select')
  if (!ac || !bc) continue
  const seen = new Map<string, number>()
  rows.forEach((r, i) => {
    const a = (r.data[ac.name] ?? '').trim()
    const b = (r.data[bc.name] ?? '').trim()
    if (!a || !b) return
    const key = [a, b].sort().join('↔') + '|' + (tc ? (r.data[tc.name] ?? '') : '')
    if (seen.has(key)) dupErrors.push(`${tabId} 第 ${seen.get(key)! + 1} 行与第 ${i + 1} 行重复：${a} ↔ ${b}`)
    else seen.set(key, i)
  })
}
ok('关系表无重复条目（无序对）', dupErrors.length === 0, dupErrors.join(' | '))

if (errors.length) {
  console.log('\n—— 引用问题明细 ——')
  for (const e of errors) console.log('  ✗ ' + e)
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
if (fail) process.exit(1)
