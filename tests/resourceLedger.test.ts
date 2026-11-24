// ============ 3.7.0 · W3 资源账本 ============
//
// 盯五件事（规划 §3 W3.3）：
//   ① 抽取→确认：未勾选不落库；勾选后持有者更新 + 轨迹追加，旧值不丢；
//   ② 未登记物品只提示（不凭空建条目，也不允许勾选落库）；
//   ③ 连续性：第 5 章已赠人、第 8 章仍写「他的剑」能检出；无矛盾样本不误报；
//   ④ 上限与同步：超 200 条如实报告 overflow，settingsKV 新键可读回；
//   ⑤ 同章同笔不重复记账（重跑整理不会记两遍）。
import fs from 'node:fs'
import * as db from '../src/lib/db'
import { memoryOps, __resetMockStores } from './mock-memory'
import { setSettingFor, getSettingFor } from '@/lib/db'
import {
  appendResourceTransfers, detectHolderConflicts, holderAt, readResourceTransfers,
  RESOURCE_TRANSFER_KEY, RESOURCE_TRANSFER_LIMIT, transfersOfItem, type ResourceTransfer,
} from '../src/lib/settings/resourceLedger'
import { matchResources, applyPostProcess } from '../src/lib/outline/chapterPostProcess'
import { parseChapterChanges } from '../src/lib/aiTasks/postProcess'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'p-w3'
const itemRow = {
  id: 'item1', projectId: PID, tabId: 'items', order: 0,
  data: { 名称: '青锋剑', 别称: '青锋', 当前持有者: '甲', 流转轨迹: '（第1章）铁匠→甲', 类别: '法宝' },
}
const tr = (over: Partial<ResourceTransfer> = {}): ResourceTransfer => ({
  id: 'rt-1', itemId: 'item1', itemName: '青锋剑', chapterId: 'c5', chapterNo: 5,
  kind: '转移', from: '甲', to: '乙', evidence: '甲把青锋剑递给乙', createdAt: 1, ...over,
})

async function seed() {
  __resetMockStores()
  db.setStoreOps(memoryOps)
  db.setCurrentProject(PID)
  await memoryOps.put('volumes', { id: 'v1', projectId: PID, order: 0, title: '卷一', createdAt: 1 })
  await memoryOps.put('chapters', {
    id: 'c1', projectId: PID, volumeId: 'v1', order: 0, title: '第1章', summary: '', status: 'draft',
    content: '第1章正文', wordCount: 5, createdAt: 1, updatedAt: 1,
  })
  await memoryOps.put('tableRows', itemRow)
}

async function main() {
  // ---------- ① 按章推算持有者（纯函数，边界） ----------
  {
    const list = [tr({ id: 'a', chapterNo: 5, to: '乙' }), tr({ id: 'b', chapterNo: 9, to: '丙' })]
    ok('第4章还没有记录 → undefined', holderAt(list, 'item1', 4) === undefined)
    ok('第5章起归乙', holderAt(list, 'item1', 5) === '乙')
    ok('第8章仍是乙（≤N 的最后一笔）', holderAt(list, 'item1', 8) === '乙')
    ok('第9章起归丙', holderAt(list, 'item1', 9) === '丙')
    ok('乱序登记按章号优先，不按数组顺序', holderAt([tr({ id: 'late', chapterNo: 9, to: '丙' }), tr({ id: 'early', chapterNo: 5, to: '乙' })], 'item1', 6) === '乙')
    ok('遗失/消耗后不再有持有者', holderAt([tr({ chapterNo: 5, kind: '失去', to: '' })], 'item1', 6) === undefined)
    ok('章号非法不猜', holderAt([tr({ chapterNo: 0 })], 'item1', 0) === undefined)
    ok('按物品筛选且按章升序', transfersOfItem(list, 'item1').map(t => t.chapterNo).join(',') === '5,9')
  }

  // ---------- ② 连续性：赠人后仍写「他的剑」可检出；无矛盾不误报 ----------
  {
    const items = [{ id: 'item1', name: '青锋剑', aliases: ['青锋'] }]
    const transfers = [tr({ chapterNo: 5, to: '乙', evidence: '甲把剑递给乙' })]
    const chapters = [
      { id: 'c5', chapterNo: 5, title: '第5章', content: '甲把青锋剑递给乙。' },
      { id: 'c8', chapterNo: 8, title: '第8章', content: '甲握紧他的青锋剑，冲向山门。' },
    ]
    const hits = detectHolderConflicts({ chapters, items, transfers, personNames: new Set(['甲', '乙']) })
    ok('第8章「甲的剑」与账本（乙持有）冲突被检出', hits.length === 1 && hits[0].chapterNo === 8, JSON.stringify(hits))
    ok('证据带原句片段', hits[0]?.evidence.includes('他的青锋剑') || hits[0]?.evidence.includes('青锋剑'))
    ok('第5章当下转手不误报', hits.every(h => h.chapterNo !== 5))

    const clean = detectHolderConflicts({
      chapters: [{ id: 'c9', chapterNo: 9, title: '第9章', content: '乙擦拭他的青锋剑。' }],
      items, transfers, personNames: new Set(['甲', '乙']),
    })
    ok('持有者本人「他的剑」不误报', clean.length === 0, JSON.stringify(clean))
    const noLedger = detectHolderConflicts({ chapters, items, transfers: [], personNames: new Set(['甲', '乙']) })
    ok('没有账本记录时不做冲突判定（不知道就不猜）', noLedger.length === 0)
    const unknownPerson = detectHolderConflicts({
      chapters: [{ id: 'c8', chapterNo: 8, title: '第8章', content: '路人的青锋剑掉在地上。' }],
      items, transfers, personNames: new Set(['甲', '乙']),
    })
    ok('未登记人名不取样（宁缺毋滥）', unknownPerson.length === 0)
  }

  // ---------- ③ 抽取解析：物品类进入 resources，证据必须存在 ----------
  {
    const parsed = parseChapterChanges(JSON.stringify([
      { kind: '物品', item: '青锋剑', action: '转移', from: '甲', to: '乙', quantity: 1, evidence: '甲把青锋剑递给乙' },
      { kind: '物品', item: '无证据物品', action: '获得' },
      { kind: '物品', item: '乱写', action: '倒卖', evidence: '他把乱写卖掉' },
    ]))
    ok('有证据的物品条目被解析', parsed.resources.length === 2, JSON.stringify(parsed.resources))
    ok('没有原文证据的一律丢弃', parsed.resources.every(r => !!r.evidence))
    ok('不认识的动作退化为「转移」（不丢候选、不误记成获得）',
      parsed.resources.find(r => r.item === '乱写')?.action === '转移')
  }

  // ---------- ④ 比对：未登记只提示；已登记有变化；重跑不重复 ----------
  {
    const found = [
      { item: '青锋剑', action: '转移' as const, from: '甲', to: '乙', evidence: '甲把青锋剑递给乙' },
      { item: '未登记宝箱', action: '获得' as const, from: '', to: '甲', evidence: '他捡到一只未登记宝箱' },
    ]
    const rows = [itemRow]
    const first = matchResources(found, rows, 5, 'c5', [])
    ok('已登记物品 → 有变化可勾选', first.find(i => i.label.startsWith('青锋剑'))?.status === 'changed')
    ok('未登记物品 → unregistered（只提示）', first.find(i => i.label.startsWith('未登记宝箱'))?.status === 'unregistered')
    ok('未登记条目不带落库载荷（绝不凭空建）', !(first.find(i => i.label.startsWith('未登记宝箱'))?.raw as { transfer?: unknown }).transfer)
    const id = (first.find(i => i.label.startsWith('青锋剑'))?.raw as { transfer: ResourceTransfer }).transfer.id
    const again = matchResources(found, rows, 5, 'c5', [tr({ id })])
    ok('账本已有同一笔 → 无变化（重跑不重复记）', again.find(i => i.label.startsWith('青锋剑'))?.status === 'registered')
  }

  // ---------- ⑤ 确认落库：未勾选不动；勾选后持有者 + 轨迹追加、旧文本保留 ----------
  {
    await seed()
    const found = [{ item: '青锋剑', action: '转移' as const, from: '甲', to: '乙', evidence: '甲把青锋剑递给乙' }]
    const items = matchResources(found, [itemRow], 5, 'c1')
    // 只勾「未登记」那条（本例没有）→ 不落库
    const none = await applyPostProcess({ chapterId: 'c1', content: 'x', chapterTitle: '第1章' }, items.filter(i => i.status === 'unregistered'))
    ok('未勾选任何可落库条目 → 什么都没写', none.created === 0 && (await readResourceTransfers()).length === 0)

    const r = await applyPostProcess({ chapterId: 'c1', content: 'x', chapterTitle: '第1章' }, items)
    ok('勾选后落库成功', r.created === 1, JSON.stringify(r))
    const row = (await db.getTableRows('items')).find(x => x.id === 'item1')!
    ok('当前持有者更新为接收方', row.data['当前持有者'] === '乙', row.data['当前持有者'])
    ok('流转轨迹只追加、旧文本保留', row.data['流转轨迹'].startsWith('（第1章）铁匠→甲') && row.data['流转轨迹'].includes('甲→乙'), row.data['流转轨迹'])
    ok('其它字段一字未动', row.data['类别'] === '法宝' && row.data['别称'] === '青锋')
    const ledger = await readResourceTransfers()
    ok('结构化流转记录落库（settingsKV）', ledger.length === 1 && ledger[0].to === '乙')
    const raw = await getSettingFor<unknown>(PID, RESOURCE_TRANSFER_KEY, null)
    ok('settingsKV 键可按项目读回（云同步/备份走同一份存储）', Array.isArray(raw))
  }

  // ---------- ⑥ 账本写失败：表格行必须回滚，不留半截状态 ----------
  {
    await seed()
    const badOps = {
      ...memoryOps,
      put: async (store: string, value: unknown) => {
        if (store === 'settingsKV') throw new Error('settingsKV down')
        return memoryOps.put(store as never, value as never)
      },
    }
    db.setStoreOps(badOps as never)
    const found = [{ item: '青锋剑', action: '转移' as const, from: '甲', to: '乙', evidence: '甲把青锋剑递给乙' }]
    const items = matchResources(found, [itemRow], 5, 'c1')
    const r = await applyPostProcess({ chapterId: 'c1', content: 'x', chapterTitle: '第1章' }, items)
    db.setStoreOps(memoryOps)
    const row = (await db.getTableRows('items')).find(x => x.id === 'item1')!
    ok('账本写失败 → 该条目标为失败', r.created === 0 && r.failed.length === 1, JSON.stringify(r))
    ok('账本写失败 → 表格行回滚到原值（不出现半截状态）', row.data['当前持有者'] === '甲' && row.data['流转轨迹'] === '（第1章）铁匠→甲', row.data['当前持有者'] + ' | ' + row.data['流转轨迹'])
  }

  // ---------- ⑦ 上限：超 200 条如实报告 overflow，不静默 ----------
  {
    await seed()
    const many = Array.from({ length: RESOURCE_TRANSFER_LIMIT + 5 }, (_, i) => tr({ id: `bulk-${i}`, chapterNo: 1 }))
    const r = await appendResourceTransfers(many)
    ok('账本滚动上限 200 条', r.total === RESOURCE_TRANSFER_LIMIT, JSON.stringify(r))
    ok('被移出本地的条数如实报告（界面据此提示导出）', r.overflow === 5, JSON.stringify(r))
    await setSettingFor(PID, RESOURCE_TRANSFER_KEY, [{ broken: true }])
    ok('损坏数据读取不炸、按空账本处理', (await readResourceTransfers()).length === 0)
  }

  // ---------- ⑧ 读库失败 ⇒ 中止追加：绝不拿空基线覆盖旧账本 ----------
  {
    await seed()
    await setSettingFor(PID, RESOURCE_TRANSFER_KEY, [tr({ id: 'old-1', chapterNo: 2 })])
    const badOps = {
      ...memoryOps,
      get: async (store: string, id: string) => {
        if (store === 'settingsKV') throw new Error('settingsKV read down')
        return memoryOps.get(store as never, id as never)
      },
    }
    db.setStoreOps(badOps as never)
    const r = await appendResourceTransfers([tr({ id: 'new-1', chapterNo: 6 })])
    db.setStoreOps(memoryOps)
    ok('读库失败 ⇒ 中止追加（appended 0）', r.appended === 0, JSON.stringify(r))
    const raw = await getSettingFor<ResourceTransfer[]>(PID, RESOURCE_TRANSFER_KEY, [])
    ok('读库失败不覆盖旧账本（旧记录原样还在）', raw.length === 1 && raw[0].id === 'old-1', JSON.stringify(raw))
  }

  // ---------- 集成闸：连续性检查真的接了物品持有冲突 ----------
  {
    const src = fs.readFileSync('src/lib/outline/continuityCheck.ts', 'utf8')
    ok('连续性检查调用 detectHolderConflicts（不是只写单测）', src.includes('detectHolderConflicts(') && src.includes("db.getTableRows('items')") && src.includes('readResourceTransfers()'))
    ok('冲突只报 warn（不改正文）', /severity: 'warn'[\s\S]{0,200}物品持有/.test(src))
  }

  console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })