// ============ 拆书「断点续跑」的判定用例 ============
//
// 续跑的价值全在**阶段内断点**上：60 章的书抽到第 30 章被中止，继续时应当从第 31 章开始
// ——从阶段头重跑等于把前 30 章白抽一遍，那这个功能就没有意义。
//
// 三个容易错、且错了不报错的点：
//   ① **改了原文还续跑** → 抽出的内容与章节整体错位（看起来一切正常，设定却全串位）；
//   ② **交出的种子批次是引用而非副本** → 抽取过程污染界面存的断点，越续越乱；
//   ③ **已完成数超过单元数**（切分参数变小）→ 下标越界。
import {
  planResume, initialBookBreakResume, bookBreakResumeKey, bookBreakResumeIssue, bookBreakResumeOwnerCurrent,
  type BookBreakResume,
} from '../src/lib/bookbreak/run'
import { firstUnfinishedStage } from '../src/lib/flow/pipeline'
import { setCurrentProject } from '../src/lib/db'
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

// ---------- ④ 断点身份：原文 / 参数 / 项目 / 存储 四类误续必须拦住 ----------
{
  // 断点身份要拿"当前项目"比对，而 node 里没有打开过的书库 ⇒ 显式给一个项目 id
  setCurrentProject('bookbreak-resume-test')
  const raw = '第一章 风起\n' + '甲'.repeat(20)
  const fresh = initialBookBreakResume(raw, {})
  ok('🔴 ④ 新断点自带原文与校验信息（切页后可继续，不必让作者重贴全文）',
    fresh.sourceText === raw && typeof fresh.resumeKey === 'string' && !!fresh.projectId && !!fresh.storageKey)
  ok('🔴 ④ 新断点没有伪造进度与失败单元', fresh.doneUnits === 0 && fresh.failedUnits!.length === 0)
  ok('🔴 ④ 身份一致的断点可以直接续', bookBreakResumeIssue(raw, {}, fresh) === '',
    bookBreakResumeIssue(raw, {}, fresh))

  // 同块数改文：切分结果一样（都是 1 章），但原文变了 —— 这正是最容易漏的一类误续
  const edited = '第一章 风起\n' + '乙'.repeat(20)
  ok('🔴 ④ 同块数但原文改过 ⇒ 拒绝续跑（不套旧批次）',
    bookBreakResumeIssue(edited, {}, fresh).includes('原文已变化'), bookBreakResumeIssue(edited, {}, fresh))

  // 参数变化（只改上限也算）
  ok('🔴 ④ 拆书参数变化 ⇒ 拒绝续跑（块会重新切，旧批次会错位）',
    bookBreakResumeIssue(raw, { maxUnits: 9 }, fresh).includes('参数已变化'), bookBreakResumeIssue(raw, { maxUnits: 9 }, fresh))
  ok('🔴 ④ 打开/关闭「写入正文」这类开关也计入参数',
    bookBreakResumeKey({}) !== bookBreakResumeKey({ persistToChapters: false }))

  // 项目 / 存储空间变化
  const otherProject = { ...fresh, projectId: '另一本书' }
  ok('🔴 ④ 断点属于别的项目 ⇒ 拒绝并提示回原项目',
    bookBreakResumeIssue(raw, {}, otherProject).includes('断点不属于当前项目'), bookBreakResumeIssue(raw, {}, otherProject))
  ok('🔴 ④ owner 判定同时看项目与存储空间',
    bookBreakResumeOwnerCurrent(fresh) === true && bookBreakResumeOwnerCurrent({ ...fresh, storageKey: 'other' }) === false)
  ok('🔴 ④ 存储空间变化 ⇒ 拒绝续跑',
    bookBreakResumeIssue(raw, {}, { ...fresh, storageKey: 'other' }).includes('断点不属于当前项目'))

  // 老版本断点（没有新增字段）
  const legacy = { ...fresh, sourceText: undefined, resumeKey: undefined }
  ok('🔴 ④ 旧断点缺原文/校验信息 ⇒ 明确要求从头重跑',
    bookBreakResumeIssue(raw, {}, legacy).includes('旧断点缺少原文'), bookBreakResumeIssue(raw, {}, legacy))

  // 进度不合法
  ok('🔴 ④ 进度越界 ⇒ 提示核对（不静默从头跑）',
    bookBreakResumeIssue(raw, {}, { ...fresh, doneUnits: 99, totalUnits: 3 }).includes('进度不完整'))
  ok('🔴 ④ 有进度却没有切分结果 ⇒ 拒绝续跑',
    bookBreakResumeIssue(raw, {}, { ...fresh, doneUnits: 1, totalUnits: 2 }).includes('缺少原始切分结果'))

  // 断点里的单元数与原始切分结果不一致（参数变小后 totalUnits 会缩水）
  const chapters = [
    { index: 1, title: '第1章', text: '甲'.repeat(10), charStart: 0, charEnd: 12 },
    { index: 2, title: '第2章', text: '乙'.repeat(10), charStart: 12, charEnd: 24 },
  ]
  const split = { chapters, mode: 'chapters' as const, stats: { count: 2, chars: 24, estTokens: 12, truncated: false } }
  const withSplit = { ...fresh, doneUnits: 1, totalUnits: 2, bag: { split } }
  ok('🔴 ④ 断点与原始切分结果一致 ⇒ 允许续跑', bookBreakResumeIssue(raw, {}, withSplit) === '',
    bookBreakResumeIssue(raw, {}, withSplit))
  ok('🔴 ④ 单元数与切分结果不符 ⇒ 拒绝续跑（下标会越界）',
    bookBreakResumeIssue(raw, {}, { ...withSplit, totalUnits: 5 }).includes('不一致'),
    bookBreakResumeIssue(raw, {}, { ...withSplit, totalUnits: 5 }))
}

console.log(`\n—— bookbreakResume 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
