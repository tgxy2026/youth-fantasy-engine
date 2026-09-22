// ============ 正文写作 AI 额度（一个基准 + 一组系数）============
//
// 改造前，正文写作链路 18 处额度是**散落的硬编码常量**（校对 6000 / OOC 10000 / 续写 12000…）。
// 现在收敛成「一个基准 × 各功能系数」。本用例盯四件事：
//   ① 🔴 **出厂基准下逐项等于改造前的硬编码值** —— 这是「升级后零行为变化」的保证，
//      也是整次改造最容易悄悄破掉的地方（系数手滑改一位，默认行为就变了）；
//   ② 基准可调时按系数等比换算（且对齐到 100，避免界面上出现 6375 这种数）；
//   ③ 推荐值：本地**不放大**、云端按窗口放大且有上下限；
//   ④ 系数表与展示名表**键集合一致**（漏一个 label 会让面板明细里少一行）。
import {
  WRITER_BUDGET_KINDS, WRITER_BUDGET_LABELS, DEFAULT_WRITER_BASE, DEFAULT_WRITER_BUDGET, WRITER_BASE_LIMITS,
  budgetForKind, previewAt, recommendWriterBase, type WriterBudgetKind,
} from '../src/lib/aiWriterBudget'
import { adviseCapacity } from '../src/lib/modelCapacity'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- ① 🔴 出厂基准下必须复现改造前的硬编码值 ----------
const LEGACY: Record<WriterBudgetKind, number> = {
  'auto-continue': 12000,
  'proofread': 6000,
  'foreshadow-review': 12000,
  'continuity-audit': 12000,
  'consistency-selfcheck': 8000,
  'project-diagnose': 12000,
  'organize-rows': 9000,
  'ai-assist': 4000,
  'name-suggest': 3000,
  'plot-canvas': 6000,
  'jiewenji-proofread': 6000,
  'jiewenji-diagnosis': 8000,
  'jiewenji-review': 8000,
  'jiewenji-ooc': 10000,
  'jiewenji-advice': 8000,
  'jiewenji-pleasure': 8000,
  'jiewenji-opening': 8000,
  'jiewenji-brief': 8000,
  // 节奏与章末钩子（2.4.1·B5 新增）：按 1.0 档，出厂即 8000
  'pace-analysis': 8000,
  // 创意写作（2026-09-18 新增）：分卷大纲按 1.5 档，出厂即 12000
  'outline-generate': 12000,
}
ok('每个 kind 都有对应的"改造前值"断言（新增功能别忘了登记）',
  Object.keys(LEGACY).length === Object.keys(WRITER_BUDGET_KINDS).length,
  `legacy ${Object.keys(LEGACY).length} vs kinds ${Object.keys(WRITER_BUDGET_KINDS).length}`)

for (const [kind, exp] of Object.entries(LEGACY) as [WriterBudgetKind, number][]) {
  const got = budgetForKind(kind, DEFAULT_WRITER_BASE)
  ok(`🔴 出厂 ${DEFAULT_WRITER_BASE} 下 ${kind} = ${exp}（与改造前硬编码一致）`, got === exp, `实得 ${got}`)
}

// ---------- ② 基准可调：等比换算 + 对齐 100 ----------
ok('基准翻倍 → 校对 6000→12000', budgetForKind('proofread', 16000) === 12000, String(budgetForKind('proofread', 16000)))
ok('基准减半 → 校对 6000→3000', budgetForKind('proofread', 4000) === 3000, String(budgetForKind('proofread', 4000)))
ok('基准翻倍 → OOC 10000→20000', budgetForKind('jiewenji-ooc', 16000) === 20000, String(budgetForKind('jiewenji-ooc', 16000)))
ok('换算结果一律对齐到 100（界面上不出现零头）',
  [1234, 4321, 8765].every(b => (Object.keys(WRITER_BUDGET_KINDS) as WriterBudgetKind[]).every(k => budgetForKind(k, b) % 100 === 0)),
  '')
ok('极小基准也不低于 1000（不能把资料层压没了）', budgetForKind('name-suggest', 1000) === 1000, String(budgetForKind('name-suggest', 1000)))
ok('所有系数为正（负系数会让预算变负）', Object.values(WRITER_BUDGET_KINDS).every(v => v > 0))

// ---------- ③ 推荐值：本地跟着 numCtx 走、云端按可用窗口，两边都有上限 ----------
// 2026-09-18 放宽到 30% 档：此前本地被 min(出厂 8000, …) 封死（numCtx 再大也不动）、云端只用 12%。
const CUR = { numCtx: 32768, contextBudget: 24000 }
const localCap = adviseCapacity({ type: 'ollama', model: 'qwen3.5-27b' }, CUR)
ok('本地 32768：推荐基准 = numCtx × 30% = 9800', recommendWriterBase(localCap) === 9800, String(recommendWriterBase(localCap)))

const bigLocal = adviseCapacity({ type: 'ollama', model: 'qwen3.5-27b' }, { numCtx: 65536, contextBudget: 24000 })
ok('🔴 本地 numCtx 翻倍 → 推荐基准跟着翻倍（19700）—— 放宽前这里恒为 8000',
  recommendWriterBase(bigLocal) === 19700, String(recommendWriterBase(bigLocal)))

const smallLocal = adviseCapacity({ type: 'ollama', model: 'llama3-8b' }, { numCtx: 8192, contextBudget: 6000 })
ok('本地小窗口（8192）：推荐基准跟着收紧到 2500',
  recommendWriterBase(smallLocal) === 2500, String(recommendWriterBase(smallLocal)))

const cloudCap = adviseCapacity({ type: 'openai', local: false, model: 'Qwen/Qwen3.5-35B-A3B' }, CUR)
ok('云端 256K：推荐基准 29000（可用窗口 96665 × 30%）',
  recommendWriterBase(cloudCap) === 29000, String(recommendWriterBase(cloudCap)))

const hugeCap = adviseCapacity({ type: 'openai', local: false, model: 'gpt-4.1' }, CUR)
ok('1M 窗口：推荐基准被封顶 120000', recommendWriterBase(hugeCap) === 120000, String(recommendWriterBase(hugeCap)))
ok('推荐基准永远 ≥ 出厂值（云端不会比本地还小）', [cloudCap, hugeCap].every(c => recommendWriterBase(c) >= DEFAULT_WRITER_BASE))
ok('🔴 基准输入框上限 ≥ 云端推荐上限（否则推荐值填不进去）',
  WRITER_BASE_LIMITS.max >= recommendWriterBase(hugeCap), `${WRITER_BASE_LIMITS.max} vs ${recommendWriterBase(hugeCap)}`)

// ---------- ④ 面板明细：键集合一致 + 顺序稳定 ----------
const kindKeys = Object.keys(WRITER_BUDGET_KINDS).sort()
const labelKeys = Object.keys(WRITER_BUDGET_LABELS).sort()
ok('🔴 系数表与展示名表键集合一致（漏 label → 面板明细少一行）',
  kindKeys.join() === labelKeys.join(),
  `缺 label：${kindKeys.filter(k => !labelKeys.includes(k)).join(',') || '无'}；多余 label：${labelKeys.filter(k => !kindKeys.includes(k)).join(',') || '无'}`)

const pv = previewAt(DEFAULT_WRITER_BASE)
ok('previewAt 覆盖全部功能', pv.length === kindKeys.length, String(pv.length))
ok('previewAt 的 value 与 budgetForKind 一致',
  pv.every(x => x.value === budgetForKind(x.kind, DEFAULT_WRITER_BASE)), '')
ok('previewAt 每项都有非空 label', pv.every(x => x.label.trim().length > 0))

// ---------- ⑤ 边界常量 ----------
ok('基准范围含出厂值', WRITER_BASE_LIMITS.min <= DEFAULT_WRITER_BASE && DEFAULT_WRITER_BASE <= WRITER_BASE_LIMITS.max,
  `${WRITER_BASE_LIMITS.min}~${WRITER_BASE_LIMITS.max} 出厂 ${DEFAULT_WRITER_BASE}`)

// ---------- ⑥ 自动跟随模型的出厂设置 ----------
ok('出厂：默认开启「跟随模型自动调整」', DEFAULT_WRITER_BUDGET.autoTuneByModel === true)
ok('出厂：tunedFor 未登记（首次同步只登记指纹、不改值 —— 不动老用户已调好的基准）',
  DEFAULT_WRITER_BUDGET.tunedFor === undefined)
ok('出厂基准 = 出厂常量（面板与同步口径同源）', DEFAULT_WRITER_BUDGET.base === DEFAULT_WRITER_BASE)

console.log(`\n—— writerBudget 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
