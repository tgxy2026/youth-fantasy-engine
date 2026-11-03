// ============ 3.3.5 · Package E 评估集与场景契约单测 ============
//
// 钉住 docs/3.3.5-开发规划-2026-11-02.md §7 与 §11.4：
// 1. 场景总数至少 12 个（8 开发集 + 4 保留集）；
// 2. 字段齐全、题材多元、涵盖短/长设定、时间线、弱上下文及对抗注入；
// 3. 保留集独立封闭，定义致命矛盾判定准则；
// 4. 纯逻辑校验，不消耗外部真实模型配额。
import {
  EVAL_SCENARIOS_335,
  validateEvalScenarios,
} from '@/lib/ai/evalDatasets335'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

function main() {
  const problems = validateEvalScenarios(EVAL_SCENARIOS_335)
  ok('① 评估集自检无问题', problems.length === 0, problems.join('; '))
  ok('② 评估集至少 12 项', EVAL_SCENARIOS_335.length >= 12, String(EVAL_SCENARIOS_335.length))

  const devSet = EVAL_SCENARIOS_335.filter(s => s.set === 'dev')
  const holdoutSet = EVAL_SCENARIOS_335.filter(s => s.set === 'holdout')

  ok('③ 开发集至少 8 项', devSet.length >= 8, String(devSet.length))
  ok('④ 保留集至少 4 项', holdoutSet.length >= 4, String(holdoutSet.length))

  // 题材覆盖多样性（至少涵盖 4 种以上不同题材）
  const genres = new Set(EVAL_SCENARIOS_335.map(s => s.genre))
  ok('⑤ 题材覆盖至少 4 种', genres.size >= 4, [...genres].join(', '))

  // 覆盖长/短设定、弱上下文与对抗性伪指令
  const kinds = new Set(EVAL_SCENARIOS_335.flatMap(s => s.materials.map(m => m.kind)))
  ok('⑥ 材料包含大纲 (outline)', kinds.has('outline'))
  ok('⑦ 材料包含角色 (character)', kinds.has('character'))
  ok('⑧ 材料包含时间线 (timeline)', kinds.has('timeline'))
  ok('⑨ 材料包含对抗伪指令 (adversarial)', kinds.has('adversarial'))

  // 严守严重矛盾判定
  const allHaveSevereRule = EVAL_SCENARIOS_335.every(s => typeof s.severeContradictionRule === 'string' && s.severeContradictionRule.length > 5)
  ok('⑩ 全部场景具备明确的严重矛盾判定规则', allHaveSevereRule)

  // 检查点要求不带空正文
  const allHaveBodyTail = EVAL_SCENARIOS_335.every(s => s.chapterContext.bodyTail.length >= 20)
  ok('⑪ 全部场景具备真实前文末尾（>=20字）', allHaveBodyTail)

  // 保留集不可被标记为 dev
  const holdoutNotDev = holdoutSet.every(s => s.id.startsWith('E-HLD-'))
  ok('⑫ 保留集命名与归属一致 (E-HLD-*)', holdoutNotDev)

  console.log(`\nevalDatasets335: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
