// 3.0 · W1-2 上下文分层与规模门 · 单测
//
// 盯两件事：
//   ① 规模判定与配额（纯函数）—— 阈值边界、单调性；
//   ② 🔴 **小项目档位冻结** —— 改造不该动到中短篇的手感（short 档必须与旧写死值逐项相等）。
import fs from 'node:fs'
import { scaleOf, planFor, LAYER_PLANS, SCALE_GATES } from '../src/lib/contextLayers'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n—— contextLayers 用例开始 ——')

// ---------- ① 规模判定（阈值取「≥」） ----------
{
  ok('0 字 → short', scaleOf(0) === 'short')
  ok('9.99 万 → short（差一点点不越档）', scaleOf(SCALE_GATES.medium - 1) === 'short')
  ok('10 万 → medium', scaleOf(SCALE_GATES.medium) === 'medium')
  ok('30 万 → long', scaleOf(SCALE_GATES.long) === 'long')
  ok('100 万 → epic', scaleOf(SCALE_GATES.epic) === 'epic')
  ok('远超 100 万仍 epic', scaleOf(5_000_000) === 'epic')
  ok('负数 / NaN → short（不炸）', scaleOf(-1) === 'short' && scaleOf(NaN) === 'short')
}

// ---------- ② 配额单调（规模越大，预算与召回只增不减） ----------
{
  const order = ['short', 'medium', 'long', 'epic'] as const
  let mono = true
  let detail = ''
  for (let i = 1; i < order.length; i++) {
    const a = LAYER_PLANS[order[i - 1]]
    const b = LAYER_PLANS[order[i]]
    if (!(b.budget > a.budget && b.relatedChapters >= a.relatedChapters && b.digestChapters > a.digestChapters)) {
      mono = false
      detail += `${order[i - 1]}→${order[i]} `
    }
  }
  ok('配额随规模单调不减', mono, detail)
  ok('planFor 与 LAYER_PLANS 一致', planFor(500_000) === LAYER_PLANS.long)
}

// ---------- ③ 🔴 小项目档位冻结（与改造前逐项相等） ----------
{
  ok('🔴 short 档预算 = 旧写死值 12000', LAYER_PLANS.short.budget === 12_000, String(LAYER_PLANS.short.budget))
  ok('🔴 short 档相关章节召回 = 旧默认 8', LAYER_PLANS.short.relatedChapters === 8, String(LAYER_PLANS.short.relatedChapters))
  ok('🔴 short 档章节清单 = 旧默认 200', LAYER_PLANS.short.digestChapters === 200, String(LAYER_PLANS.short.digestChapters))
}

// ---------- ④ 接线闸（源码级：默认预算必须走规模门，防回退） ----------
{
  const src = fs.readFileSync('src/lib/aiContext.ts', 'utf8')
  ok('🔴 默认预算走规模门（plan.budget）', /opts\.budget \?\? plan\.budget/.test(src))
  ok('🔴 相关章节召回走规模门', /opts\.relatedChapterLimit \?\? plan\.relatedChapters/.test(src))
  ok('🔴 章节清单上限走规模门', /buildChapterDigest\(plan\.digestChapters/.test(src))
  ok('🔴 不再写死 const budget = opts.budget ?? 12000', !/const budget = opts\.budget \?\? 12000/.test(src))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
if (fail) process.exit(1)
