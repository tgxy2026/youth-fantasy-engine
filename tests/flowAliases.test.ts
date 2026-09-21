// ============ 「别称 / 简称」归并 与 判重 的回归用例 ============
//
// 背景（2026-09-18 用示范项目自身正文做对照验证时抓到）：
//   正文里同一实体常以简称出现（`铁柱`＝`王铁柱`、`吞天诀`＝`混沌吞天诀`）。
//   旧实现有两个后果：
//     ① 简称被当成独立实体 → 设定表里落出重复条目；
//     ② `settingLedger.classify` 只拿**抽出的名字**跟登记表的「名+别称」比，
//        带着别称的信息没用上 → 正文用简称的章全判成"未登记"，召回无谓地掉。
// 这里把三条行为钉死：合并、最优本名、判重认别称。
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { buildDraftBundle } from '../src/lib/flow/draft'
import { resolveSlot } from '../src/lib/flow/fieldMap'
import { classify, type EntityRegistry } from '../src/lib/settingLedger'
import type { DraftRow } from '../src/lib/flow/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

__resetMockStores()
db.setCurrentProject('flow-aliases-test')

// ---------- ① 同章：本名 + 别称 → 一条，别称写进「别称」字段 ----------
{
  const b = await buildDraftBundle([{
    source: '第1章', index: 1,
    entities: [{ type: '人物', name: '王铁柱', aliases: ['铁柱', '阿柱'], tier: '次要', desc: '铁匠', evidence: '王铁柱提锤走来。' }],
  }], { rawText: '王铁柱提锤走来。' })
  ok('① 只出一条草稿', b.stats.total === 1, String(b.stats.total))
  const r = b.rows[0] as DraftRow
  ok('  · 本名保持最完整的', r.name === '王铁柱', r.name)
  ok('  · 别称都收进 row.aliases', r.aliases.length === 2 && r.aliases.includes('铁柱') && r.aliases.includes('阿柱'), r.aliases.join(','))
  const aliasKey = resolveSlot('char-secondary', '别称') as string
  const f = r.fields.find(x => x.key === aliasKey)
  ok('  · 别称写进了卡片「别称」字段', !!f && f.value.includes('铁柱'), f?.value ?? '(无)')
}

// ---------- ② 跨章：第1章给全称、第5章只有简称 → 合成一条（本名取最长）----------
{
  const b = await buildDraftBundle([
    { source: '第1章', index: 1, entities: [{ type: '人物', name: '王铁柱', aliases: ['铁柱'], tier: '次要', desc: '铁匠', evidence: '王铁柱提锤走来。' }] },
    { source: '第5章', index: 5, entities: [{ type: '人物', name: '铁柱', desc: '', evidence: '铁柱应了一声。' }] },
  ], { rawText: '王铁柱提锤走来。铁柱应了一声。' })
  ok('🔴 跨章简称被并进本名那条（不是两条重复条目）', b.stats.total === 1, b.rows.map(r => r.name).join(','))
  const r = b.rows[0] as DraftRow
  ok('  · 本名取最完整的「王铁柱」', r.name === '王铁柱', r.name)
  ok('  · 两个来源都记上了（章节 1 与 5）', r.chapters.join(',') === '1,5', r.chapters.join(','))
  ok('  · 简称留在别称里', r.aliases.includes('铁柱'), r.aliases.join(','))
}

// ---------- ③ 反向：先简称、后全称，本名仍要提升为全称 ----------
{
  const b = await buildDraftBundle([
    { source: '第2章', index: 2, entities: [{ type: '人物', name: '铁柱', desc: '', evidence: '铁柱应了一声。' }] },
    { source: '第6章', index: 6, entities: [{ type: '人物', name: '王铁柱', aliases: ['铁柱'], desc: '', evidence: '王铁柱提锤走来。' }] },
  ], { rawText: '铁柱应了一声。王铁柱提锤走来。' })
  ok('先出现简称、后出现全称 → 仍是一条，且本名提升为全称',
    b.stats.total === 1 && (b.rows[0] as DraftRow).name === '王铁柱',
    b.rows.map(r => r.name).join(','))
}

// ---------- ④ 同一情形的**反向对照**：D 方案（同物多写法归并，09-18）已把这条局限补上 ----------
//   09-18 之前：模型没给别称 → `铁柱` 与 `王铁柱` 落成两条重复条目（当时如实钉住为「已知局限」）。
//   09-18 之后：`draft.foldNameVariants` 按「前后缀即同物」确定性归并 → 合成一条。
//   本用例保留的意义变成**看门狗**：将来若有人关掉/改坏归并，这条会立刻红。
{
  const batches = [
    { source: '第2章', index: 2, entities: [{ type: '人物' as const, name: '铁柱', desc: '', evidence: '' }] },
    { source: '第7章', index: 7, entities: [{ type: '人物' as const, name: '王铁柱', desc: '', evidence: '' }] },
  ]
  const b = await buildDraftBundle(batches, { rawText: '' })
  ok('🔴 模型没给别称时也能合成一条（D 方案补上了旧局限）',
    b.stats.total === 1 && (b.rows[0] as DraftRow).name === '王铁柱',
    b.rows.map(r => r.name).join(','))
  ok('  · 简称进了别称（名字没丢）', (b.rows[0] as DraftRow).aliases.includes('铁柱'),
    (b.rows[0] as DraftRow).aliases.join(','))
  // 负面对照：关掉归并 → 回到 2 条，证明上一条确实是归并在起作用（不是别处顺手合的）
  const off = await buildDraftBundle(batches, { rawText: '', foldVariants: false })
  ok('  · 负面对照：关掉归并后确实回到 2 条（证明归并有效）',
    off.stats.total === 2, off.rows.map(r => r.name).join(','))
}

// ---------- ⑤ 判重：抽出实体自带的别称也要参与比对 ----------
{
  // 道号 / 俗名这种**子串匹配抓不到**的别称，正是旧实现漏掉的那类
  const reg: EntityRegistry = {
    人物: [{ name: '青玄子', aliases: [], tabId: 'char-npc', id: 'p1' }],
    势力: [], 地点: [], 种族: [], 物品: [], 术语: [],
  }
  const withAlias = classify([{ type: '人物', name: '守拙道人', aliases: ['青玄子'], desc: '', evidence: '' }], reg)
  ok('🔴 别称命中登记表 → 判为已登记（旧实现会判成"未登记"）',
    withAlias[0]!.status !== 'new', withAlias[0]!.status)
  const without = classify([{ type: '人物', name: '守拙道人', desc: '', evidence: '' }], reg)
  ok('  · 负面对照：不带别称时确实是"未登记"（证明上面那条有判别力）',
    without[0]!.status === 'new', without[0]!.status)
}

// ---------- ⑥ 判重：登记表自己带别称的老行为不能坏 ----------
{
  const reg: EntityRegistry = {
    术语: [{ name: '噬命诀', aliases: ['吞命诀'], tabId: 'terms', id: 't1' }],
    人物: [], 势力: [], 地点: [], 种族: [], 物品: [],
  }
  const out = classify([{ type: '术语', name: '吞命诀', desc: '', evidence: '' }], reg)
  ok('登记表侧别称仍能命中（老行为未坏）', out[0]!.status === 'registered', out[0]!.status)
}

console.log(`\n—— flowAliases 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
