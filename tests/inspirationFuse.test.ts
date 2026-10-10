// ============ A3（2.5.1）灵感夹 + 灵感融合 ============
//
// 三段：
//  ① 灵感夹 CRUD（trim / 去重 / 200 条上限 / 删除）——存储走 node 内存后端；
//  ② parseFusedIdeas：结构解析 + 键名中英双认 + basedOn 越界剔除去重；
//  ③ 结构约定：PlotCanvas 的 idea 卡型存在且不进 HEADER_TO_TYPE（AI 简报永远产不出 idea 卡）。
import { readFileSync } from 'node:fs'
import * as db from '../src/lib/db'
import { addItem, removeItem, loadBox, INSPIRATION_MAX } from '../src/lib/creative/inspirationBox'
import { parseFusedIdeas } from '../src/lib/aiTasks/inspiration'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ inspirationFuse')

// ---------- ① 灵感夹 CRUD ----------
{
  await db.setSetting('inspirationBox', []) // 起点干净
  const r1 = await addItem('  主角在钟楼里遇见未来的自己。 ', [])
  ok('新增：trim 后入库', r1.added && r1.items[0].text === '主角在钟楼里遇见未来的自己。')
  const r2 = await addItem('主角在钟楼里遇见未来的自己。', r1.items)
  ok('🔴 逐字重复 → 拒绝（added=false，列表不变）', !r2.added && r2.items.length === 1 && r2.reason === 'dup')
  const r3 = await addItem('   ', r1.items)
  ok('空白输入 → 拒绝', !r3.added && r3.reason === 'empty')

  let items = r1.items
  for (let i = 0; i < 3; i++) items = (await addItem(`灵感 ${i + 1}`, items)).items
  ok('多条追加保序', items.map(i => i.text).join('|') === '主角在钟楼里遇见未来的自己。|灵感 1|灵感 2|灵感 3')
  ok('每条都有 id 与 createdAt', items.every(i => !!i.id && i.createdAt > 0))

  const afterDel = await removeItem(items[1].id, items)
  ok('删除后列表减一且不误删他人', afterDel.length === 3 && !afterDel.some(i => i.id === items[1].id))

  // 上限：填满后拒绝并如实说明
  let full = afterDel
  while (full.length < INSPIRATION_MAX) full = (await addItem(`占位 ${full.length}`, full)).items
  const over = await addItem('超出上限的一条', full)
  ok(`🔴 上限 ${INSPIRATION_MAX} 条：超出拒绝（reason=full）`, !over.added && over.reason === 'full' && over.items.length === INSPIRATION_MAX)
  // 持久化一致：loadBox 读回的与最后写入一致
  ok('loadBox 读回与写入一致', (await loadBox()).length === INSPIRATION_MAX)
  await db.setSetting('inspirationBox', [])
}

// ---------- ② parseFusedIdeas ----------
{
  const good = JSON.stringify({
    cards: [
      { text: '钟楼的钟声停了，主角在停摆的指针里看见了三年后的自己。', basedOn: [1, 3] },
      { text: '未来的自己其实是反派布下的镜像，逼主角亲手敲碎它。', basedOn: [2] },
    ],
  })
  const r = parseFusedIdeas(good, 3)
  ok('两张卡都解析出来', r.length === 2)
  ok('text 原样保留', r[0].text.includes('停摆的指针'))
  ok('basedOn 保留且有序', r[0].basedOn.join(',') === '1,3' && r[1].basedOn.join(',') === '2')

  // 中文键名容错
  const zh = JSON.stringify({ cards: [{ '创意': '城门后的影子会倒着走。', '依据': [2] }] })
  ok('键名中文化也能认（创意/依据）', parseFusedIdeas(zh, 3)[0]?.text === '城门后的影子会倒着走。'
    && parseFusedIdeas(zh, 3)[0]?.basedOn.join(',') === '2')

  // basedOn：越界剔除、去重、非数字丢弃
  const messy = JSON.stringify({ cards: [{ text: 'A', basedOn: [1, 1, 4, 0, -1, '2', 'x'] }] })
  ok('🔴 basedOn 越界/重复/非数字 → 剔除去重（只留 1、2）',
    JSON.stringify(parseFusedIdeas(messy, 3)[0].basedOn) === '[1,2]',
    JSON.stringify(parseFusedIdeas(messy, 3)[0].basedOn))
  ok('text 为空的条目跳过（不产空卡）', parseFusedIdeas(JSON.stringify({ cards: [{ text: '', basedOn: [1] }, { text: 'B' }] }), 3).length === 1)
  ok('模型回 ideas 键名也认', parseFusedIdeas(JSON.stringify({ ideas: [{ text: 'C', basedOn: [] }] }), 2).length === 1)
  ok('完全没按结构回 → 空数组（调用方如实提示，不静默给垃圾）', parseFusedIdeas('我就是不想按格式来', 2).length === 0)
}

// ---------- ③ 结构约定：idea 卡型 ----------
{
  const src = readFileSync('src/components/outline/PlotCanvas.tsx', 'utf8')
  ok("🔴 CardType 含 'idea' 且 TYPE_META 登记了颜色与标签",
    src.includes("'beat' | 'idea'") && src.includes("idea: { label: '灵感融合'"))
  ok("🔴 idea 不进 HEADER_TO_TYPE（AI 简报永远产不出 idea 卡）",
    !src.includes("'灵感融合': 'idea'"))
  ok('灵感融合任务已在门面登记（否则设置页看不到提示词）',
    readFileSync('src/lib/ai/aiTasks.ts', 'utf8').includes('inspiration-fuse'))
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
