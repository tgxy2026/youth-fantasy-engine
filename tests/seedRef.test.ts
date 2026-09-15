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

if (errors.length) {
  console.log('\n—— 引用问题明细 ——')
  for (const e of errors) console.log('  ✗ ' + e)
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
if (fail) process.exit(1)
