// ============ 3.7.0 · W4 状态演变记录 ============
//
// 盯四件事（规划 §3 W4.3）：
//   ① 留痕：状态变更确认后旧值可从记录回溯；覆盖写当前值的行为不变；
//   ② 按章查询：章前无记录返回 null；恰在该章返回该条；乱序 createdAt 按章号优先；
//   ③ 任意条目：物品/势力/关系行与角色卡走同一套记录；
//   ④ 上限/同步：超 500 条如实报告；settingsKV 新键可读回。
import * as db from '../src/lib/db'
import { memoryOps, __resetMockStores } from './mock-memory'
import {
  appendStateRecords, buildStateRecord, evolutionOf, readStateRecords, stateAt,
  STATE_RECORD_KEY, STATE_RECORD_LIMIT, type StateRecord,
} from '../src/lib/settings/stateTrack'
import { applyPostProcess } from '../src/lib/outline/chapterPostProcess'
import { getSettingFor } from '@/lib/db'
import type { RecordRef } from '../src/lib/revision/revisionTypes'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'p-w4'
const CHAR_REF: RecordRef = { kind: 'card', projectId: PID, tabId: 'char-main', id: 'char1' }
const ITEM_REF: RecordRef = { kind: 'row', projectId: PID, tabId: 'items', id: 'item1' }
const ROW_REF: RecordRef = { kind: 'row', projectId: PID, tabId: 'relations', id: 'rel1' }

const rec = (over: Partial<StateRecord> = {}): StateRecord => ({
  id: 'st-1', ref: CHAR_REF, chapterId: 'c3', chapterNo: 3, state: '清醒', createdAt: 1, ...over,
})

async function seed() {
  __resetMockStores()
  db.setStoreOps(memoryOps)
  db.setCurrentProject(PID)
  await memoryOps.put('volumes', { id: 'v1', projectId: PID, order: 0, title: '卷一', createdAt: 1 })
  for (const [id, order, title] of [['c1', 0, '第1章'], ['c2', 1, '第2章'], ['c3', 2, '第3章']] as const) {
    await memoryOps.put('chapters', {
      id, projectId: PID, volumeId: 'v1', order, title, summary: '', status: 'draft',
      content: `${title}正文`, wordCount: 5, createdAt: 1, updatedAt: 1,
    })
  }
  await memoryOps.put('cardRecords', {
    id: 'char1', projectId: PID, tabId: 'char-main', name: '甲', order: 0,
    data: { 姓名: '甲', '一、角色档案::人物状态': '健在' },
  })
  await memoryOps.put('tableRows', {
    id: 'rel1', projectId: PID, tabId: 'relations', order: 0,
    data: { 人物A: '甲', 人物B: '乙', '演变轨迹（按卷）': '（第1章）互为师兄弟' },
  })
}

async function main() {
  // ---------- ① 按章查询边界 ----------
  {
    const list = [rec({ id: 'a', chapterNo: 3, state: '受伤' }), rec({ id: 'b', chapterNo: 7, state: '痊愈' })]
    ok('章前没有记录 → null', stateAt(list, CHAR_REF, 2) === null)
    ok('恰在该章 → 返回该条', stateAt(list, CHAR_REF, 3)?.state === '受伤')
    ok('中间章沿用最近一条', stateAt(list, CHAR_REF, 5)?.state === '受伤')
    ok('之后章取最新一条', stateAt(list, CHAR_REF, 9)?.state === '痊愈')
    const outOfOrder = [
      rec({ id: 'late-created', chapterNo: 7, state: '痊愈', createdAt: 999 }),
      rec({ id: 'early-created', chapterNo: 3, state: '受伤', createdAt: 1 }),
    ]
    ok('乱序 createdAt 按章号优先（第5章仍是第3章那条）', stateAt(outOfOrder, CHAR_REF, 5)?.state === '受伤')
    ok('同章多条按登记时间取最近', stateAt([
      rec({ id: 'old', chapterNo: 4, state: '旧', createdAt: 1 }),
      rec({ id: 'new', chapterNo: 4, state: '新', createdAt: 2 }),
    ], CHAR_REF, 4)?.state === '新')
    ok('非法章号 → null', stateAt(list, CHAR_REF, 0) === null && stateAt(list, CHAR_REF, Number.NaN) === null)
    ok('别的条目互不串（同 id 不同 ref）', stateAt(list, ITEM_REF, 9) === null)
  }

  // ---------- ② 任意条目走同一路径 + 顺序 ----------
  {
    const records = [
      buildStateRecord({ ref: ITEM_REF, chapterId: 'c7', chapterNo: 7, state: '在乙手中', now: 20 }),
      buildStateRecord({ ref: ITEM_REF, chapterId: 'c2', chapterNo: 2, state: '在甲手中', now: 10 }),
      buildStateRecord({ ref: ROW_REF, chapterId: 'c5', chapterNo: 5, state: '结为同盟', now: 30 }),
    ]
    ok('物品/关系与角色卡同路径（都按 ref 归档）', evolutionOf(records, ITEM_REF).length === 2 && evolutionOf(records, ROW_REF).length === 1)
    ok('演变按章号升序', evolutionOf(records, ITEM_REF).map(r => r.chapterNo).join(',') === '2,7')
  }

  // ---------- ③ 章后整理确认后：旧值留痕、当前值仍被更新 ----------
  {
    await seed()
    const item = {
      kind: 'status' as const, key: 'st-x', status: 'changed' as const, label: '甲：重伤', detail: '第3章',
      evidence: '甲身中三刀，倒在血泊里',
      raw: { st: { name: '甲', state: '重伤', evidence: '甲身中三刀，倒在血泊里' }, tabId: 'char-main', cardId: 'char1', fieldKey: '一、角色档案::人物状态' },
    }
    const r = await applyPostProcess({ chapterId: 'c3', content: 'x', chapterTitle: '第3章' }, [item])
    ok('状态确认落库成功', r.created === 1, JSON.stringify(r))
    const card = (await db.getCardRecords('char-main')).find(c => c.id === 'char1')!
    ok('当前值仍按原行为更新', card.data['一、角色档案::人物状态'] === '重伤', card.data['一、角色档案::人物状态'])
    const records = await readStateRecords()
    ok('同时写了一条演变记录', records.length === 1, JSON.stringify(records))
    ok('旧值可从记录回溯', records[0]?.previous === '健在', JSON.stringify(records[0]))
    ok('记录带章号 / 触发 / 证据', !!(records[0]?.chapterNo === 3 && records[0]?.trigger === '章后整理' && records[0]?.evidence), JSON.stringify(records[0]))
    ok('按章可查回该状态', stateAt(records, CHAR_REF, 3)?.state === '重伤')
  }

  // ---------- ④ 关系变化也落一条（ref 指向关系行） ----------
  {
    await seed()
    const item = {
      kind: 'relation' as const, key: 'rel-x', status: 'changed' as const, label: '甲 ↔ 乙', detail: '从师兄弟到反目',
      raw: { rel: { a: '甲', b: '乙', type: '敌对', change: '从师兄弟到反目' }, rowId: 'rel1' },
    }
    const r = await applyPostProcess({ chapterId: 'c3', content: 'x', chapterTitle: '第3章' }, [item])
    ok('关系变化落库成功', r.created === 1, JSON.stringify(r))
    const row = (await db.getTableRows('relations')).find(x => x.id === 'rel1')!
    ok('原「演变轨迹」文本仍是追加（旧文本保留）', row.data['演变轨迹（按卷）'].startsWith('（第1章）互为师兄弟'), row.data['演变轨迹（按卷）'])
    ok('关系备注带真实章号（不再是标题兜底）', row.data['演变轨迹（按卷）'].includes('（第3章）'), row.data['演变轨迹（按卷）'])
    const records = await readStateRecords()
    ok('关系行也有状态记录（ref 指向 relations 行）', records.some(x => x.ref.tabId === 'relations' && x.ref.id === 'rel1'))
    ok('关系记录按章可查', !!stateAt(records, ROW_REF, 3)?.state.includes('反目'))
  }

  // ---------- ⑤ 上限与同步 ----------
  {
    await seed()
    const many = Array.from({ length: STATE_RECORD_LIMIT + 7 }, (_, i) => rec({ id: `bulk-${i}`, chapterNo: 1, createdAt: i }))
    const r = await appendStateRecords(many)
    ok('滚动上限 500 条', r.total === STATE_RECORD_LIMIT, JSON.stringify(r))
    ok('超限条数如实报告（界面据此提示导出）', r.overflow === 7, JSON.stringify(r))
    ok('settingsKV 键可按项目读回（云同步/备份同存储）', Array.isArray(await getSettingFor<unknown>(PID, STATE_RECORD_KEY, null)))
    await db.setSetting(STATE_RECORD_KEY, { broken: true })
    ok('损坏数据读取不炸、按空账本处理', (await readStateRecords()).length === 0)
  }

  console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
  // ---------- 接线闸：角色卡详情有「状态演变」 ----------
  {
    const fs = await import('node:fs')
    const sheet = fs.readFileSync('src/components/world/CharacterSheet.tsx', 'utf8')
    const comp = fs.readFileSync('src/components/world/StateEvolution.tsx', 'utf8')
    ok('角色卡详情挂了 StateEvolution（kind: card）', sheet.includes('<StateEvolution') && sheet.includes("kind: 'card'"))
    ok('状态演变组件只追加（appendStateRecords + buildStateRecord）', comp.includes('appendStateRecords(') && comp.includes('buildStateRecord(') && comp.includes('target: recordRef'))
    ok('组件支持手动补登（章号 + 状态）', comp.includes('placeholder="章号"') && comp.includes('补登'))
  }

  if (fail > 0) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })