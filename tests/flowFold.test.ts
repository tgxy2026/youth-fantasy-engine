// ============ 「同物多写法」归并（D 方案）的回归用例 ============
//
// 背景（2026-09-18 实测，见 docs/2.2.0-C方案复核实验记录.md）：
//   让模型「二遍复核」去泛称（C 方案）实测精度仅约 60%、会误删核心专名、提示词微调即行为翻转
//   → 判定不上。但同一次实测发现草稿里真正的冗余是**同一实体的多种写法**：
//   `胎记`/`左腕胎记`/`暗金胎记`、`吞天诀`/`混沌吞天诀`、`山门`/`山门口`…
//   这类关系用字符串规则就能判 —— 零模型调用、零幻觉、可复现。
//
// 本用例把三条行为钉死：
//   ① 无歧义同物 → **自动并入**（名字进别称，不丢）
//   ② 有歧义（同一核心词多种限定）→ **不合并**，只标 `variantOf` + 默认不勾
//   ③ 刹车：限定语带数字/量词（并列层级）→ 一律不合并，只标注
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { buildDraftBundle, defaultPicked, pickableAsNew } from '../src/lib/flow/draft'
import type { DraftRow } from '../src/lib/flow/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

__resetMockStores()
db.setCurrentProject('flow-fold-test')
// 登记表为空（新项目，正是「拆书灌新书」的真实场景）→ 所有草稿都是 status='new'，
// 于是「默认勾选」只由归并规则决定，不受判重干扰。
const RAW = '吞天诀在他体内运转。混沌吞天诀的真意浮现。左腕胎记发烫。他的暗金胎记与胎记同源。王铁柱走来。铁柱应了一声。'

const rowsOf = (b: Awaited<ReturnType<typeof buildDraftBundle>>) => b.rows as DraftRow[]
const byName = (rows: DraftRow[], n: string) => rows.find(r => r.name === n)

// ---------- ① 无歧义同物 → 自动并入（后缀变体）----------
{
  const b = await buildDraftBundle([{
    source: '第1章', index: 1,
    entities: [
      { type: '物品', name: '吞天诀', desc: '功法简称', evidence: '吞天诀在他体内运转。' },
      { type: '物品', name: '混沌吞天诀', desc: '功法全称', evidence: '混沌吞天诀的真意浮现。' },
    ],
  }], { rawText: RAW })
  const rows = rowsOf(b)
  ok('① 后缀变体（吞天诀 ⊂ 混沌吞天诀）→ 合成 1 条', rows.length === 1, rows.map(r => r.name).join(','))
  const r = byName(rows, '混沌吞天诀')
  ok('  · 本名保留最完整的那个', !!r, rows.map(r => r.name).join(','))
  ok('  · 简称进了别称（名字没丢）', !!r && r.aliases.includes('吞天诀'), (r?.aliases ?? []).join(','))
  ok('  · 记下了「并进来了什么」', !!r && (r.foldedNames ?? []).includes('吞天诀'), (r?.foldedNames ?? []).join(','))
  ok('  · 统计里有归并条数', b.stats.folded === 1, String(b.stats.folded))
  ok('  · 并入的那条默认勾选（它是规范条目）', !!r && defaultPicked(r))
}

// ---------- ② 前缀变体 + 旧路径补不上的情形（模型没给别称）----------
{
  const b = await buildDraftBundle([{
    source: '第1章', index: 1,
    entities: [
      { type: '人物', name: '王铁柱', desc: '', evidence: '王铁柱走来。' },
      { type: '人物', name: '铁柱', desc: '', evidence: '铁柱应了一声。' },
    ],
  }], { rawText: RAW })
  const rows = rowsOf(b)
  ok('🔴 ② 模型没给别称时也能并（王铁柱/铁柱 → 1 条，旧实现会落 2 条重复条目）',
    rows.length === 1 && rows[0]?.name === '王铁柱', rows.map(r => r.name).join(','))
  ok('  · 简称在别称里', rows[0]?.aliases.includes('铁柱') === true, (rows[0]?.aliases ?? []).join(','))
}

// ---------- ③ 有歧义（同一核心词、多种限定）→ 不合并，只标注 + 默认不勾 ----------
{
  const b = await buildDraftBundle([{
    source: '第1章', index: 1,
    entities: [
      { type: '物品', name: '胎记', desc: '印记', evidence: '左腕胎记发烫。' },
      { type: '物品', name: '左腕胎记', desc: '左腕上的暗金鳞片', evidence: '左腕胎记发烫。' },
      { type: '物品', name: '暗金胎记', desc: '暗金色印记', evidence: '他的暗金胎记与胎记同源。' },
    ],
  }], { rawText: RAW })
  const rows = rowsOf(b)
  ok('③ 三条都留着（**一条都不删**）', rows.length === 3, rows.map(r => r.name).join(','))
  ok('  · 核心词那条被标「疑似同物」', !!byName(rows, '胎记')?.variantOf, String(byName(rows, '胎记')?.variantOf))
  ok('🔴 · 两条长名**都不被牵连**（是同物还是并列对象，字符串判不出来 → 宁可不标）',
    !byName(rows, '左腕胎记')?.variantOf && !byName(rows, '暗金胎记')?.variantOf,
    rows.map(r => `${r.name}${r.variantOf ? '≈' : ''}`).join(','))
  ok('  · 被标的默认不勾、两条长名默认勾选',
    !defaultPicked(byName(rows, '胎记')!) &&
    defaultPicked(byName(rows, '左腕胎记')!) && defaultPicked(byName(rows, '暗金胎记')!))
  ok('  · 统计里「疑似同物」= 1', b.stats.variants === 1, String(b.stats.variants))
  ok('  · 归并数为 0（有歧义就不合）', b.stats.folded === 0, String(b.stats.folded))
}

// ---------- ③c 负面对照：共用词头的**两个不同对象**不许被降级 ----------
//   `混沌吞天诀` 与 `噬魂吞天诀` 是两个功法，不是同一物 ——
//   若把长名也标为疑似，就会把一个核心实体默认不勾，作者容易漏掉。
{
  const b = await buildDraftBundle([{
    source: '第1章', index: 1,
    entities: [
      { type: '物品', name: '吞天诀', desc: '', evidence: '' },
      { type: '物品', name: '混沌吞天诀', desc: '', evidence: '' },
      { type: '物品', name: '噬魂吞天诀', desc: '', evidence: '' },
    ],
  }])
  const rows = rowsOf(b)
  ok('③c 只标核心词「吞天诀」，两个功法都保持默认勾选',
    !!byName(rows, '吞天诀')?.variantOf &&
    defaultPicked(byName(rows, '混沌吞天诀')!) && defaultPicked(byName(rows, '噬魂吞天诀')!),
    rows.map(r => `${r.name}${r.variantOf ? '≈' : '✓'}`).join(','))
}

// ---------- ③b 「全选新建」不能把疑似同物的行勾上 ----------
//   这条规则原本只活在 UI 里（一个 if），实机也未必碰得到这种数据 —— 抽成 pickableAsNew 后钉在这里。
{
  const b = await buildDraftBundle([{
    source: '第1章', index: 1,
    entities: [
      { type: '物品', name: '胎记', desc: '', evidence: '' },
      { type: '物品', name: '左腕胎记', desc: '', evidence: '' },
      { type: '物品', name: '暗金胎记', desc: '', evidence: '' },
    ],
  }])
  const rows = rowsOf(b)
  const picked = rows.filter(pickableAsNew).map(r => r.name)
  ok('🔴 ③b「全选新建」不会勾上疑似同物的行（否则作者一点全选就把提示撤销了）',
    !picked.includes('胎记') && picked.includes('左腕胎记') && picked.includes('暗金胎记'),
    picked.join(',') || '(空)')
}

// ---------- ④ 刹车：限定语带数字/量词（并列层级）→ 一律不合并 ----------
{
  const b = await buildDraftBundle([{
    source: '第1章', index: 1,
    entities: [
      { type: '术语', name: '玄脉', desc: '经脉', evidence: '' },
      { type: '术语', name: '三品玄脉', desc: '高品', evidence: '' },
      { type: '术语', name: '四品玄脉', desc: '次高品', evidence: '' },
    ],
  }])
  const rows = rowsOf(b)
  ok('④ 并列层级（三品/四品玄脉）**没被并成一条**', rows.length === 3, rows.map(r => r.name).join(','))
  ok('  · 各层级都没被标为同物（层级是并列的）',
    !byName(rows, '三品玄脉')?.variantOf && !byName(rows, '四品玄脉')?.variantOf,
    rows.map(r => `${r.name}${r.variantOf ? '✗' : ''}`).join(','))
  ok('  · 只标了核心词「玄脉」', !!byName(rows, '玄脉')?.variantOf, String(byName(rows, '玄脉')?.variantOf))
}

// ---------- ⑤ 刹车：单容器但修饰语是数量词 → 仍不合并 ----------
{
  const b = await buildDraftBundle([{
    source: '第1章', index: 1,
    entities: [
      { type: '术语', name: '灵脉', desc: '经脉', evidence: '' },
      { type: '术语', name: '三品灵脉', desc: '三品', evidence: '' },
    ],
  }])
  const rows = rowsOf(b)
  ok('⑤ 单容器但修饰语是「三品」→ 不自动并（品级并列，不该并）',
    rows.length === 2 && !rows.some(r => r.foldedNames?.length), rows.map(r => r.name).join(','))
  ok('  · 改为标注 + 默认不勾', !!byName(rows, '灵脉')?.variantOf && !defaultPicked(byName(rows, '灵脉')!))
}

// ---------- ⑤b 🔴 前缀位一律不处理（实机抓到的两条真误并）----------
//   `青岚宗` ⊂ `青岚宗藏经阁`（宗门 ≠ 它的藏经阁）、`南荒` ⊂ `南荒秘境`（区域 ≠ 区域里的秘境）——
//   短名在前缀位时，长名往往是「短名 + 另一个名词」，指向子体而非同一对象。
{
  const b = await buildDraftBundle([{
    source: '第1章', index: 1,
    entities: [
      { type: '地点', name: '青岚宗', desc: '宗门', evidence: '' },
      { type: '地点', name: '青岚宗藏经阁', desc: '宗门里的藏经阁', evidence: '' },
      { type: '地点', name: '南荒', desc: '区域', evidence: '' },
      { type: '地点', name: '南荒秘境', desc: '区域里的秘境', evidence: '' },
    ],
  }])
  const rows = rowsOf(b)
  ok('🔴 ⑤b 前缀位不并也不标（青岚宗 / 南荒各自留一条，都要能写进去）',
    rows.length === 4 && !rows.some(r => r.foldedNames?.length || r.variantOf),
    rows.map(r => `${r.name}${r.foldedNames?.length ? '⊕' : ''}${r.variantOf ? '≈' : ''}`).join(','))
  ok('  · 四条都默认勾选（不能把宗门这种核心实体误降级）', rows.every(r => defaultPicked(r)))
}

// ---------- ⑥ 负面对照：中间包含不算同物 ----------
{
  const b = await buildDraftBundle([{
    source: '第1章', index: 1,
    entities: [
      { type: '物品', name: '玉牌', desc: '', evidence: '' },
      { type: '物品', name: '青玉腰牌', desc: '', evidence: '' },
    ],
  }])
  const rows = rowsOf(b)
  ok('⑥ 负面对照：中间包含（玉牌 ⊂ 青玉腰牌）**不算同物**（前后缀才算）',
    rows.length === 2 && !rows.some(r => r.variantOf || r.foldedNames?.length), rows.map(r => r.name).join(','))
}

// ---------- ⑦ 负面对照：跨类型不并（同名异类是被允许的）----------
{
  const b = await buildDraftBundle([{
    source: '第1章', index: 1,
    entities: [
      { type: '地点', name: '南荒', desc: '', evidence: '' },
      { type: '术语', name: '南荒', desc: '', evidence: '' },
    ],
  }])
  const rows = rowsOf(b)
  ok('⑦ 负面对照：跨类型不并（同名异类仍由既有 conflict 逻辑处置）',
    rows.length === 2 && !rows.some(r => r.variantOf || r.foldedNames?.length), rows.map(r => r.name).join(','))
  ok('  · 既有的同名异类判定没被破坏', rows.some(r => r.status === 'conflict'),
    rows.map(r => `${r.name}:${r.status}`).join(','))
}

// ---------- ⑧ 负面对照：单字名不参与（最少 2 字）----------
{
  const b = await buildDraftBundle([{
    source: '第1章', index: 1,
    entities: [
      { type: '物品', name: '诀', desc: '', evidence: '' },
      { type: '物品', name: '吞天诀', desc: '', evidence: '' },
    ],
  }])
  ok('⑧ 单字名不参与归并（避免「诀」被并进「吞天诀」这类噪声）',
    rowsOf(b).length === 2 && !rowsOf(b).some(r => r.foldedNames?.length))
}

// ---------- ⑨ 总开关：关掉后回到未归并（证明归并确实在起作用）----------
{
  const entities = [
    { type: '物品' as const, name: '吞天诀', desc: '', evidence: '' },
    { type: '物品' as const, name: '混沌吞天诀', desc: '', evidence: '' },
  ]
  const off = await buildDraftBundle([{ source: '第1章', index: 1, entities }], { foldVariants: false })
  ok('⑨ 负面对照：foldVariants:false → 不归并（2 条）', rowsOf(off).length === 2, rowsOf(off).map(r => r.name).join(','))
  ok('  · 且不计入归并统计', off.stats.folded === 0, String(off.stats.folded))
}

console.log(`\n—— flowFold 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
