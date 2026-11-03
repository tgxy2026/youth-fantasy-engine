// ============ WQ1 结果状态治理 + WQ5 输出协议与能力 · 单元测试 ============
//
// 钉住：
//   ① TaskResult 三态：valid / repaired / invalid
//   ② 检查覆盖率：已检/未检统计
//   ③ 自检失败处置：解析失败时的降级策略
//   ④ 能力检测：按模型 ID 推断能力
//   ⑤ 能力降级：JSON/思考模式降级

import { detectCapabilities, shouldUseJsonMode, shouldUseThinking, downgradeJsonOutput, downgradeThinking, checkCapabilities, DEFAULT_CAPABILITIES } from '../src/lib/ai/modelCapabilities'
import { processCheckResults, calculateCoverage, handleParseFailure, aggregateCheckResults, formatCheckSummary, serializeCheckResults, deserializeCheckResults } from '../src/lib/aiTasks/reviewFindings'
import { parseObjectArrayDetailed } from '../src/lib/ai/aiParse'
import type { ModelCapabilities } from '@/lib/ai/modelCapabilities'
import type { CheckItemResult } from '@/lib/aiTasks/reviewFindings'
import type { TaskResult } from '@/lib/revision/revisionTypes'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

// ───────────────── ① TaskResult 三态 ─────────────────
function case1() {
  // valid
  const v1: TaskResult<unknown[]> = { outcome: 'valid', data: [{ a: 1 }], diagnostics: [], truncated: false }
  ok('①① valid 态', v1.outcome === 'valid' && v1.data.length === 1)

  // repaired
  const v2: TaskResult<unknown[]> = { outcome: 'repaired', data: [{ a: 1 }], diagnostics: [{ code: 'stray-punct', detail: '修复了标点' }], truncated: false }
  ok('①② repaired 态', v2.outcome === 'repaired' && v2.diagnostics.length === 1)

  // invalid
  const v3: TaskResult<unknown[]> = { outcome: 'invalid', data: [], diagnostics: [{ code: 'unrecoverable', detail: '解析失败' }], truncated: false }
  ok('①③ invalid 态', v3.outcome === 'invalid' && v3.data.length === 0)

  // ParseDiagnostic
  ok('①④ ParseDiagnostic 结构（code + detail，与 MQ0 契约一致）',
    v3.diagnostics[0].code === 'unrecoverable' && v3.diagnostics[0].detail === '解析失败')
}

// ───────────────── ② 能力检测 ─────────────────
function case2() {
  // 已知模型
  const c1 = detectCapabilities('deepseek-r1')
  ok('②① deepseek-r1 支持 JSON', c1.jsonOutput === true)
  ok('②② deepseek-r1 支持思考', c1.thinking === true)
  ok('②③ deepseek-r1 上下文 65536', c1.maxContext === 65536)

  const c2 = detectCapabilities('gpt-4o')
  ok('②④ gpt-4o 支持 JSON', c2.jsonOutput === true)
  ok('②⑤ gpt-4o 不支持思考', c2.thinking === false)

  const c3 = detectCapabilities('qwen3:4b')
  ok('②⑥ qwen3:4b 前缀匹配', c3.jsonOutput === true && c3.thinking === true)

  // 未知模型
  const c4 = detectCapabilities('unknown-model')
  ok('②⑦ 未知模型用默认', c4.modelId === 'unknown-model' && c4.jsonOutput === true)

  // DEFAULT_CAPABILITIES
  ok('②⑧ 默认能力结构', DEFAULT_CAPABILITIES.jsonOutput === true && DEFAULT_CAPABILITIES.maxContext === 32768)
}

// ───────────────── ③ JSON/思考模式控制 ─────────────────
function case3() {
  const caps: ModelCapabilities = { modelId: 'test', jsonOutput: true, thinking: true, maxContext: 32768, maxOutput: 4096, extra: [] }

  ok('③① JSON 模式启用', shouldUseJsonMode(caps) === true)
  ok('③② 思考模式（推理任务）', shouldUseThinking(caps, 'chapter-review') === true)
  ok('③③ 思考模式（非推理任务）', shouldUseThinking(caps, 'custom') === false)

  const noJson: ModelCapabilities = { modelId: 'test', jsonOutput: false, thinking: false, maxContext: 32768, maxOutput: 4096, extra: [] }
  ok('③④ JSON 模式禁用', shouldUseJsonMode(noJson) === false)
}

// ───────────────── ④ 能力降级 ─────────────────
function case4() {
  const caps: ModelCapabilities = { modelId: 'test', jsonOutput: true, thinking: true, maxContext: 32768, maxOutput: 4096, extra: [] }

  const d1 = downgradeJsonOutput(caps)
  ok('④① JSON 降级', d1.ok && d1.downgraded === 'textOutput')

  const d2 = downgradeThinking(caps)
  ok('④② 思考降级', d2.ok && d2.downgraded === 'normal')

  const noJson: ModelCapabilities = { modelId: 'test', jsonOutput: false, thinking: false, maxContext: 32768, maxOutput: 4096, extra: [] }
  const d3 = downgradeJsonOutput(noJson)
  ok('④③ 已降级不重复降级', d3.ok && d3.reason?.includes('已处于'))
}

// ───────────────── ⑤ 能力校验 ─────────────────
function case5() {
  const caps: ModelCapabilities = { modelId: 'test', jsonOutput: true, thinking: false, maxContext: 4096, maxOutput: 1024, extra: [] }

  const r1 = checkCapabilities(caps, { json: true, thinking: false })
  ok('⑤① 能力满足', r1.ok && r1.missing.length === 0)

  const r2 = checkCapabilities(caps, { json: true, thinking: true })
  ok('⑤② 思考能力缺失', !r2.ok && r2.missing.includes('thinking'))

  const r3 = checkCapabilities(caps, { minContext: 8192 })
  ok('⑤③ 上下文不足', !r3.ok && r3.missing.some(m => m.includes('maxContext')))

  const r4 = checkCapabilities(caps, { minOutput: 2048 })
  ok('⑤④ 输出不足', !r4.ok && r4.missing.some(m => m.includes('maxOutput')))
}

// ───────────────── ⑥ 检查结果处理 ─────────────────
function case6() {
  // 正常解析
  const results = processCheckResults('[{"id":"c1","name":"检查1","level":"严重"},{"id":"c2","name":"检查2","level":"提示"}]', 'default')
  ok('⑥① 正常解析', results.length === 2 && results[0].critical === 1 && results[1].critical === 0)
  ok('⑥② 严重问题计数', results[0].critical === 1)

  // 解析失败
  const failed = processCheckResults('invalid json', 'default')
  ok('⑥③ 解析失败返回 failed', failed.length === 1 && failed[0].status === 'failed')

  // 空数组
  const empty = processCheckResults('[]', 'default')
  ok('⑥④ 空数组', empty.length === 0)

  // 单对象
  const single = processCheckResults('{"id":"c1","name":"检查1","level":"中等"}', 'default')
  ok('⑥⑤ 单对象', single.length === 1)
}

// ───────────────── ⑦ 检查覆盖率 ─────────────────
function case7() {
  const results: CheckItemResult[] = [
    { id: '1', name: '检查1', status: 'done', findings: 2, critical: 1, finishedAt: Date.now() },
    { id: '2', name: '检查2', status: 'done', findings: 1, critical: 0, finishedAt: Date.now() },
    { id: '3', name: '检查3', status: 'failed', findings: 0, critical: 0, error: '解析失败', finishedAt: Date.now() },
    { id: '4', name: '检查4', status: 'pending', findings: 0, critical: 0 },
  ]

  const s = calculateCoverage(results)
  ok('⑦① 总项数', s.total === 4)
  ok('⑦② 已完成', s.done === 2)
  ok('⑦③ 失败', s.failed === 1)
  ok('⑦④ 总问题数', s.totalFindings === 3)
  ok('⑦⑤ 严重问题数', s.criticalFindings === 1)
  ok('⑦⑥ 覆盖率', s.coverage === 0.5)
  ok('⑦⑦ 未全部通过', !s.allPassed)

  const allDone: CheckItemResult[] = [
    { id: '1', name: '检查1', status: 'done', findings: 0, critical: 0, finishedAt: Date.now() },
  ]
  const s2 = calculateCoverage(allDone)
  ok('⑦⑧ 全部通过', s2.allPassed)
}

// ───────────────── ⑧ 自检失败处置 ─────────────────
function case8() {
  // invalid
  const v1: TaskResult<unknown[]> = { outcome: 'invalid', data: [], diagnostics: [{ code: 'unrecoverable', detail: '解析失败' }], truncated: false }
  const f1 = handleParseFailure(v1, 'test')
  ok('⑧① invalid 启用降级', f1.enabled && f1.fallbackResult.length === 1)
  ok('⑧② 不可重试', !f1.shouldRetry)

  // invalid + truncated
  const v2: TaskResult<unknown[]> = { outcome: 'invalid', data: [], diagnostics: [], truncated: true }
  const f2 = handleParseFailure(v2, 'test')
  ok('⑧③ 截断可重试', f2.shouldRetry)

  // valid
  const v3: TaskResult<unknown[]> = { outcome: 'valid', data: [{ a: 1 }], diagnostics: [], truncated: false }
  const f3 = handleParseFailure(v3, 'test')
  ok('⑧④ valid 不降级', !f3.enabled)

  // repaired
  const v4: TaskResult<unknown[]> = { outcome: 'repaired', data: [{ a: 1 }], diagnostics: [], truncated: false }
  const f4 = handleParseFailure(v4, 'test')
  ok('⑧⑤ repaired 不降级', !f4.enabled)
}

// ───────────────── ⑨ 检查结果聚合 ─────────────────
function case9() {
  const results: CheckItemResult[] = [
    { id: '1', name: '检查1', status: 'done', findings: 0, critical: 0, finishedAt: Date.now() },
    { id: '2', name: '检查2', status: 'done', findings: 1, critical: 1, finishedAt: Date.now() },
    { id: '3', name: '检查3', status: 'failed', findings: 0, critical: 0, error: '失败', finishedAt: Date.now() },
  ]

  const a = aggregateCheckResults(results)
  ok('⑨① 通过数', a.passed.length === 1)
  ok('⑨② 失败数', a.failed.length === 2)
}

// ───────────────── ⑩ 格式化与持久化 ─────────────────
function case10() {
  const results: CheckItemResult[] = [
    { id: '1', name: '检查1', status: 'done', findings: 2, critical: 1, finishedAt: Date.now() },
  ]

  // 格式化
  const s = calculateCoverage(results)
  const text = formatCheckSummary(s)
  ok('⑩① 格式化包含覆盖率', text.includes('1/1') && text.includes('%'))

  // 持久化
  const json = serializeCheckResults(results)
  ok('⑩② 序列化', json.length > 0)

  const restored = deserializeCheckResults(json)
  ok('⑩③ 反序列化', restored.length === 1 && restored[0].id === '1')

  // 错误 JSON
  const empty = deserializeCheckResults('invalid')
  ok('⑩④ 错误 JSON 返回空', empty.length === 0)
}

// ───────────────── ⑪ 与 aiParse 集成 ─────────────────
function case11() {
  // 用 parseObjectArrayDetailed 验证 TaskResult 三态
  const v1 = parseObjectArrayDetailed('[]')
  ok('⑪① 空数组 valid', v1.outcome === 'valid' && v1.data.length === 0)

  const v2 = parseObjectArrayDetailed('[{"a":1}]')
  ok('⑪② 单对象 valid', v2.outcome === 'valid' && v2.data.length === 1)

  const v3 = parseObjectArrayDetailed('invalid')
  ok('⑪③ 无效 JSON invalid', v3.outcome === 'invalid')

  const v4 = parseObjectArrayDetailed('[{"a":1},3,"x"]')
  ok('⑪④ 非对象过滤 repaired', v4.outcome === 'repaired' && v4.data.length === 1)
}

// ───────────────── 主函数 ─────────────────
function main() {
  case1()
  case2()
  case3()
  case4()
  case5()
  case6()
  case7()
  case8()
  case9()
  case10()
  case11()
  console.log(`\nq1q5: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
