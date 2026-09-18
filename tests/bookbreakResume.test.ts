// ============ 拆书「断点续跑」的判定用例 ============
//
// 续跑的价值全在**阶段内断点**上：60 章的书抽到第 30 章被中止，继续时应当从第 31 章开始
// ——从阶段头重跑等于把前 30 章白抽一遍，那这个功能就没有意义。
//
// 三个容易错、且错了不报错的点：
//   ① **改了原文还续跑** → 抽出的内容与章节整体错位（看起来一切正常，设定却全串位）；
//   ② **交出的种子批次是引用而非副本** → 抽取过程污染界面存的断点，越续越乱；
//   ③ **已完成数超过单元数**（切分参数变小）→ 下标越界。
import { planResume, type BookBreakResume } from '../src/lib/bookbreak/run'
import { firstUnfinishedStage } from '../src/lib/flow/pipeline'
import type { EntityBatch } from '../src/lib/flow/draft'
import type { FlowProgress, StageState } from '../src/lib/flow/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function batch(index: number, names: string[]): EntityBatch {
  return {
    index, source: `第${index}章`,
    entities: names.map(n => ({ name: n, type: '人物' as const, desc: `${n}的描述`, evidence: '原句' })),
  }
}
function resumeOf(over: Partial<BookBreakResume> = {}): BookBreakResume {
  return {
    bag: {}, from: 'extract', doneUnits: 3, totalUnits: 6,
    batches: [batch(1, ['陈渊']), batch(2, ['萧景行'])],
    label: '已完成 3/6 个抽取单元',
    ...over,
  }
}

// ---------- ① 首次运行 ----------
{
  const r = planResume(6, undefined)
  ok('没有断点 → 从头跑，无种子批次', r.start === 0 && r.seedBatches.length === 0 && r.reason === 'fresh', JSON.stringify(r))
  ok('断点里 doneUnits=0 也算首次（不假装续跑）', planResume(6, resumeOf({ doneUnits: 0 })).reason === 'fresh')
}

// ---------- ② 断点有效 → 从已完成之后接着跑 ----------
{
  const r = planResume(6, resumeOf())
  ok('🔴 从已完成之后开始（抽了 3 块 → 从第 4 块起）', r.start === 3, String(r.start))
  ok('装回上次抽好的批次（不重抽）', r.seedBatches.length === 2 && r.seedBatches[0].entities[0].name === '陈渊',
    JSON.stringify(r.seedBatches.map(b => b.index)))
  ok('判定为 resume', r.reason === 'resume')
}

// ---------- ③ 🔴 改了原文 → 断点失效，从零重抽 ----------
{
  const r = planResume(7, resumeOf())   // 上次 6 个单元，这次切出 7 个 → 原文变了
  ok('🔴 单元数对不上 → 判定失效', r.reason === 'invalidated', r.reason)
  ok('🔴 失效时不接旧下标（否则抽出的内容与章节整体错位）', r.start === 0, String(r.start))
  ok('失效时也不带旧批次（旧批次对应的是旧原文）', r.seedBatches.length === 0, String(r.seedBatches.length))
}

// ---------- ④ 边界：已完成数 > 单元数 ----------
{
  const r = planResume(2, resumeOf({ doneUnits: 9, totalUnits: 2 }))
  ok('已完成数超过单元数 → 钳到末尾，不越界', r.start === 2, String(r.start))
  ok('  这种情况下流程不会死循环（start === unitsLen，循环直接不执行）', r.start === 2)
}

// ---------- ⑤ 🔴 种子批次必须是副本 ----------
{
  const src = resumeOf({ batches: [batch(1, ['陈渊'])] })
  const r = planResume(6, src)
  r.seedBatches[0].entities.push({ name: '污染', type: '人物', desc: 'x', evidence: 'x' })
  r.seedBatches[0].source = '被改了'
  ok('🔴 改种子批次不影响传入的断点（否则界面存的那份被污染，越续越乱）',
    src.batches[0].entities.length === 1 && src.batches[0].source === '第1章',
    `entities=${src.batches[0].entities.length} source=${src.batches[0].source}`)
}

// ---------- ⑥ 续跑起点：找第一个没跑完的阶段 ----------
{
  const st = (id: string, status: StageState['status']): StageState =>
    ({ id, label: id, status, ratio: 0, detail: '' })
  const progressOf = (...stages: StageState[]): FlowProgress =>
    ({ status: 'cancelled', ratio: 0, stages, current: null, message: '' })

  ok('全部跑完 → 返回空串（调用方 run("") 退化成从头跑，安全兜底）',
    firstUnfinishedStage(progressOf(st('a', 'done'), st('b', 'done'))) === '')
  ok('🔴 skipped 不算断点（它是"不需要跑"，例如只出大纲时的连写阶段）',
    firstUnfinishedStage(progressOf(st('split', 'done'), st('persist', 'done'), st('extract', 'done'),
      st('draft', 'done'), st('worldview', 'skipped'))) === '',
    firstUnfinishedStage(progressOf(st('a', 'done'), st('b', 'skipped'))))
  ok('正在跑的阶段就是断点', firstUnfinishedStage(progressOf(st('a', 'done'), st('b', 'running'))) === 'b')
  ok('被中止的阶段（cancelled）是断点',
    firstUnfinishedStage(progressOf(st('a', 'done'), st('b', 'cancelled'), st('c', 'cancelled'))) === 'b')
  ok('失败阶段也是断点（重试从那里开始）',
    firstUnfinishedStage(progressOf(st('a', 'done'), st('b', 'failed'), st('c', 'pending'))) === 'b')
}

console.log(`\n—— bookbreakResume 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
