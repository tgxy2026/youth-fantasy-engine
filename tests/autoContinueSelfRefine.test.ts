// WQ1-2（3.2.0）：连写自检三态化的负向控制测试
//
// 锁死两件事：
//   ① summarizeSelfCheck 汇总规则 —— 必选项失败/取消绝不汇总成"通过"；
//   ② WithStatus 审查函数在**未配模型**时返回 failed，而不是空数组
//      （旧 `.catch(() => [])` 把请求失败吞成"无问题"，是 Q1 登记病灶）。
import { summarizeSelfCheck } from '../src/lib/outline/autoContinue'
import { aiContinuityAuditWithStatus, aiForeshadowReviewWithStatus } from '../src/lib/aiTasks/audit'
import { aiOocCheckWithStatus } from '../src/lib/aiTasks/jieWenJi'
import type { StepExecutionResult } from '../src/lib/revision/revisionTypes'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const done = (sourceId: string, findings: Array<{ level?: string }> = []): StepExecutionResult<Array<{ level?: string }>> =>
  ({ state: 'completed', coverage: { requested: 1, completed: 1, failed: 0, skipped: 0 }, sourceId, result: { outcome: 'valid', data: findings, diagnostics: [], truncated: false } })
const bad = (sourceId: string, state: 'failed' | 'cancelled' = 'failed'): StepExecutionResult<Array<{ level?: string }>> =>
  ({ state, coverage: { requested: 1, completed: 0, failed: state === 'failed' ? 1 : 0, skipped: 0 }, sourceId, errorCode: state === 'cancelled' ? 'cancelled' : 'boom' })

// ---------- summarizeSelfCheck 汇总规则 ----------
{
  const all = summarizeSelfCheck([done('continuity'), done('ooc'), done('foreshadow')])
  ok('三项全 completed（空 findings）⇒ completed', all.state === 'completed')
  ok('completed 时 coverage 请求数 = 3', all.coverage?.requested === 3 && all.coverage?.completed === 3)

  const partial = summarizeSelfCheck([done('continuity'), bad('ooc'), done('foreshadow')])
  ok('一项失败 ⇒ partial', partial.state === 'partial')
  ok('partial 不是 completed（不得显示自检通过）', partial.state !== 'completed')
  ok('partial coverage 记失败数', partial.coverage?.failed === 1)
  ok('partial issues 带失败项来源', (partial.issues ?? []).some(i => String(i).includes('ooc')))

  const allBad = summarizeSelfCheck([bad('continuity'), bad('ooc'), bad('foreshadow')])
  ok('三项全失败 ⇒ failed', allBad.state === 'failed')

  const cancelled = summarizeSelfCheck([done('continuity'), bad('ooc', 'cancelled'), bad('foreshadow')])
  ok('有取消项 ⇒ cancelled（作者取消优先上报）', cancelled.state === 'cancelled')

  const none = summarizeSelfCheck([])
  ok('零项（正文太短跳过）⇒ completed', none.state === 'completed')

  // 负向控制：合法空结果与失败混在一起时，绝不允许汇总成 completed
  const mixed = summarizeSelfCheck([done('continuity'), bad('ooc')])
  ok('负向控制：合法空 + 一项失败 ≠ completed', mixed.state !== 'completed')
}

// ---------- WithStatus：未配模型时是失败，不是空数组 ----------
{
  // 测试环境无模型配置 ⇒ requireProviderFor 抛错 ⇒ 内核 catch 成 failed。
  // 旧行为是 `.catch(() => [])` ⇒ 调用方看到"无问题"。
  const r = await aiContinuityAuditWithStatus('设定资料', '正文内容'.repeat(50))
  ok('未配模型：连续性审查 ⇒ failed', r.state === 'failed')
  ok('未配模型：带 errorCode', typeof r.errorCode === 'string' && r.errorCode.length > 0)
  ok('未配模型：无 data（不是合法空结果）', r.result === undefined)

  const o = await aiOocCheckWithStatus('设定资料', '正文内容'.repeat(50))
  ok('未配模型：OOC 检查 ⇒ failed', o.state === 'failed')

  const f = await aiForeshadowReviewWithStatus('设定资料')
  ok('未配模型：伏笔审查 ⇒ failed', f.state === 'failed')

  // 负向控制：三个失败项汇总后不得是 completed
  const sum = summarizeSelfCheck([r, o, f])
  ok('负向控制：三项全失败汇总 ⇒ failed', sum.state === 'failed')
}

console.log(`\nautoContinueSelfRefine: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
