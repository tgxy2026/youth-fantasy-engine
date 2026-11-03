// 3.0 · W1-2 上下文分层与规模门 · 单测
//
// 盯两件事：
//   ① 规模判定与配额（纯函数）—— 阈值边界、单调性；
//   ② 🔴 **小项目档位冻结** —— 改造不该动到中短篇的手感（short 档必须与旧写死值逐项相等）。
import fs from 'node:fs'
import { BUDGET_MAX, BUDGET_MIN, CHAPTER_RESERVE_CHARS, budgetFromWindow, scaleOf, planFor, LAYER_PLANS, SCALE_GATES } from '../src/lib/ai/contextLayers'

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

// ---------- ③ 小项目档位（预算 3.1.3 起主动上调，其余仍冻结） ----------
{
  /**
   * 🔴 3.1.3 · R3：short 档预算由 12000 抬到 16000（主人 2026-10-18 拍板）。
   *    原断言是"与改造前写死值相等"，那条**已被主动作废** —— 实测 12000 装完前期设定就没了，
   *    章节清单 + 种族生物/物品资源/地理风物 共 19 段被整段丢弃。
   *    这里改成钉住"抬高这件事本身"，防止有人无声地改回 12000（那会让 R3 白做）。
   */
  ok('🔴 short 档预算 = 16000（3.1.3 上调，别悄悄改回 12000）',
    LAYER_PLANS.short.budget === 16_000, String(LAYER_PLANS.short.budget))
  ok('🔴 章节清单预留常量 = 1800 且不超过 short 预算的 1/4',
    CHAPTER_RESERVE_CHARS === 1800 && CHAPTER_RESERVE_CHARS <= LAYER_PLANS.short.budget / 4,
    String(CHAPTER_RESERVE_CHARS))
  ok('🔴 short 档相关章节召回 = 旧默认 8', LAYER_PLANS.short.relatedChapters === 8, String(LAYER_PLANS.short.relatedChapters))
  ok('🔴 short 档章节清单 = 旧默认 200', LAYER_PLANS.short.digestChapters === 200, String(LAYER_PLANS.short.digestChapters))
}

// ---------- ③b 预算按模型窗口算（3.1.3 主人拍板） ----------
{
  /**
   * 口径就一句「窗口 × 0.5」，别再加项目规模系数 ——
   * 项目小的时候装配器装不满就停，不需要提前压低预算（压低只会在项目变长后突然不够）。
   */
  ok('③b 32K 窗口 → 16384', budgetFromWindow(32768) === 16384, String(budgetFromWindow(32768)))
  ok('③b 64K 窗口 → 32768', budgetFromWindow(65536) === 32768, String(budgetFromWindow(65536)))
  ok('③b 128K 窗口 → 65536', budgetFromWindow(131072) === 65536, String(budgetFromWindow(131072)))
  ok('③b 大窗口封顶（2M 不会算出百万字符）', budgetFromWindow(2097152) === BUDGET_MAX, String(budgetFromWindow(2097152)))
  ok('③b 小窗口有下限（8K 不会算出 4000）', budgetFromWindow(8000) === BUDGET_MIN, String(budgetFromWindow(8000)))
  ok('③b 非法值回落规模档兜底', budgetFromWindow(0) === LAYER_PLANS.short.budget && budgetFromWindow(NaN) === LAYER_PLANS.short.budget)
  ok('③b 负向：预算永不超过窗口本身（1 token≈1 字符的保守前提）',
    budgetFromWindow(20000) <= 20000)
}

// ---------- ④ 接线闸（源码级：默认预算必须走规模门，防回退） ----------
{
  const src = fs.readFileSync('src/lib/ai/aiContext.ts', 'utf8')
  /**
   * 3.1.3：默认预算**改成按模型上下文窗口算**（窗口 × 0.5），只有读不到模型配置时才回落规模档。
   * 这条断言随实现改，别再钉回 plan.budget —— 那会让线上大窗口用户白掉一半上下文。
   */
  ok('🔴 默认预算走窗口（opts.budget ?? resolveContextBudget(plan.budget)）',
    /opts\.budget \?\? await resolveContextBudget\(plan\.budget\)/.test(src))
  ok('🔴 窗口解析用 budgetFromWindow + effectiveWindowOf',
    /budgetFromWindow\(effectiveWindowOf\(p\)\)/.test(src))
  ok('🔴 相关章节召回走规模门', /opts\.relatedChapterLimit \?\? plan\.relatedChapters/.test(src))
  ok('🔴 章节清单上限走规模门', /buildChapterDigest\(plan\.digestChapters/.test(src))
  ok('🔴 不再写死 const budget = opts.budget ?? 12000', !/const budget = opts\.budget \?\? 12000/.test(src))

  /**
   * 3.1.3 · R3 的接线闸。
   * 🔴 这三条缺一条，R3 就等于没做：常量抬了但没预留 / 预留了但清单没申请动用 /
   *    或者预留写成固定比例（清单只有几百字时白留空间，把设定段挤出去）。
   */
  ok('🔴 预留按清单实际长度算（不是固定比例）',
    /const reserve = chapterDigest \? Math\.min\(chapterDigest\.length \+ 40, CHAPTER_RESERVE_CHARS\) : 0/.test(src))
  ok('🔴 章节清单申请动用预留额度', /push\('章节清单', chapterDigest, \{ reserved: true \}\)/.test(src))
  ok('🔴 两个数字都来自 contextLayers（不许在 aiContext 里另写 16000 / 1800）',
    /from '@\/lib\/ai\/contextLayers'/.test(src) && !/\b16_000\b|\b1_800\b/.test(src))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
if (fail) process.exit(1)
