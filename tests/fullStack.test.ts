// ============ WQ6/WQ7/WQ8/W7/WT1 · 单元测试 ============
//
// 钉住：
//   ① 全请求生命周期取消
//   ② 首响应/空闲超时
//   ③ 受限重试
//   ④ 部分结果保留
//   ⑤ 并行归属
//   ⑥ 真实 usage 记录
//   ⑦ 证据校验
//   ⑧ 文本守卫
//   ⑨ 固定样本对照
//   ⑩ 故障注入
//   ⑪ 跨设备冲突
//   ⑫ 版本校验
//   ⑬ 模板代次与升级预览

import {
  createLifecycle,
  transitionLifecycle,
  checkTimeouts,
  decideRetry,
  preservePartialResult,
  createTruncateReceipt,
  handleCancellation,
  DEFAULT_TIMEOUTS,
  type RequestLifecycle,
} from '../src/lib/ai/streaming'
import {
  summarizePrompt,
  checkParallelAttribution,
  aggregateUsage,
  generateReviewMaterials,
  generateDedupKey,
  type RequestAttribution,
  type UsageRecord,
} from '../src/lib/ai/callTracking'
import {
  checkEvidence,
  guardText,
  compareWithFixedSample,
  batchCompareWithFixedSamples,
  calculateQualityScore,
  detectUnknownFields,
  type CitationInfo,
  type FixedSample,
} from '../src/lib/ai/qualityGuard'
import {
  shouldInjectFault,
  injectFault,
  detectConflict,
  checkDataVersion,
  createMigrationState,
  startMigration,
  completeMigration,
  failMigration,
  strictWrite,
  type FaultInjectionConfig,
} from '../src/lib/revision/faultInjection'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

// ───────────────── ① 请求生命周期 ─────────────────
function case1() {
  const lc = createLifecycle('req-1', 2)
  ok('①① 创建生命周期', lc.status === 'pending' && lc.retryCount === 0)

  const lc2 = transitionLifecycle(lc, 'connecting')
  ok('①② 状态转移', lc2.status === 'connecting')

  const lc3 = transitionLifecycle(lc2, 'first-byte', { firstByteAt: Date.now() })
  ok('①③ 首响应', lc3.status === 'first-byte' && lc3.firstByteAt !== undefined)

  const lc4 = transitionLifecycle(lc3, 'streaming', { text: 'hello', tokens: 3 })
  ok('①④ 流式', lc4.status === 'streaming' && lc4.textReceived === 'hello')

  const lc5 = transitionLifecycle(lc4, 'completed')
  ok('①⑤ 完成', lc5.status === 'completed' && lc5.finishedAt !== undefined)
}

// ───────────────── ② 超时检查 ─────────────────
function case2() {
  const lc = createLifecycle('req-1')
  const t1 = checkTimeouts(lc, { ...DEFAULT_TIMEOUTS, totalTimeout: 100 })
  // 刚创建，不会超时
  ok('②① 未超时', !t1.timedOut)

  // 模拟已超时
  const oldLc: RequestLifecycle = {
    ...lc,
    startedAt: Date.now() - 200,
    lastActivityAt: Date.now() - 200,
    status: 'streaming',
  }
  const t2 = checkTimeouts(oldLc, { ...DEFAULT_TIMEOUTS, totalTimeout: 100 })
  ok('②② 超时', t2.timedOut && t2.timeoutType === 'total')
}

// ───────────────── ③ 受限重试 ─────────────────
function case3() {
  const lc = createLifecycle('req-1', 2)

  // 可重试错误
  const r1 = decideRetry(lc, 'timeout')
  ok('③① 可重试', r1.canRetry && r1.remainingRetries === 2)

  // 不可重试错误
  const r2 = decideRetry(lc, 'invalid request')
  ok('③② 不可重试', !r2.canRetry)

  // 已达最大重试
  const lc2 = { ...lc, retryCount: 2 }
  const r3 = decideRetry(lc2, 'timeout')
  ok('③③ 已达最大重试', !r3.canRetry && r3.remainingRetries === 0)

  // 指数退避
  const lc3 = { ...lc, retryCount: 1 }
  const r4 = decideRetry(lc3, 'timeout')
  ok('③④ 指数退避', r4.retryDelayMs >= 1000 && r4.retryDelayMs <= 2000)
}

// ───────────────── ④ 部分结果保留 ─────────────────
function case4() {
  const data = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 }
  const serializer = (v: typeof data) => JSON.stringify(v)

  // 不截断
  const r1 = preservePartialResult(data, 1000, serializer)
  ok('④① 不截断', !r1.truncated)

  // 截断
  const r2 = preservePartialResult(data, 10, serializer)
  ok('④② 截断', r2.truncated && r2.truncateReason !== undefined)
}

// ───────────────── ⑤ 截断回执 ─────────────────
function case5() {
  const r1 = createTruncateReceipt('hello', 100)
  ok('⑤① 不截断', !r1.truncated)

  const r2 = createTruncateReceipt('hello world this is a long text', 10)
  ok('⑤② 截断', r2.truncated && r2.originalLength > r2.truncatedLength)
}

// ───────────────── ⑥ 取消处理 ─────────────────
function case6() {
  const lc = createLifecycle('req-1')
  const cancelled = transitionLifecycle(lc, 'cancelled')
  const r = handleCancellation(cancelled, { data: 'partial' })
  ok('⑥① 取消处理', r.cancelled && r.cancelledAt !== undefined)
}

// ───────────────── ⑦ 提示词摘要 ─────────────────
function case7() {
  const s = summarizePrompt('系统提示词', '用户提示词', ['tool1', 'tool2'])
  ok('⑦① 摘要生成', s.systemSummary.length > 0 && s.estimatedTokens > 0)
  ok('⑦② 工具调用', s.toolCalls.length === 2)
}

// ───────────────── ⑧ 并行归属 ─────────────────
function case8() {
  const existing: RequestAttribution[] = [
    { requestId: 'req-1', jobId: 'job-1', projectId: 'p1', startedAt: Date.now() },
  ]

  // 同一任务不能并行
  const r1 = checkParallelAttribution(existing, { requestId: 'req-2', jobId: 'job-1', projectId: 'p1' })
  ok('⑧① 同一任务冲突', !r1.canParallel && r1.conflicts.length > 0)

  // 不同任务可并行
  const r2 = checkParallelAttribution(existing, { requestId: 'req-2', jobId: 'job-2', projectId: 'p1' })
  ok('⑧② 不同任务可并行', r2.canParallel)
}

// ───────────────── ⑨ Usage 聚合 ─────────────────
function case9() {
  const records: UsageRecord[] = [
    { requestId: 'r1', modelId: 'gpt-4o', inputTokens: 100, outputTokens: 50, totalTokens: 150, inputChars: 200, outputChars: 100, durationMs: 1000, recordedAt: Date.now() },
    { requestId: 'r2', modelId: 'gpt-4o', inputTokens: 200, outputTokens: 100, totalTokens: 300, inputChars: 400, outputChars: 200, durationMs: 2000, recordedAt: Date.now() },
  ]
  const agg = aggregateUsage(records)
  ok('⑨① 聚合正确', agg.totalInputTokens === 300 && agg.totalOutputTokens === 150 && agg.requestCount === 2)
  ok('⑨② 模型分布', agg.modelDistribution['gpt-4o'] === 2)
}

// ───────────────── ⑩ 复盘材料 ─────────────────
function case10() {
  const materials = generateReviewMaterials(
    'req-1',
    { systemSummary: 'sys', userSummary: 'user', toolCalls: [], estimatedTokens: 100 },
    { requestId: 'req-1', modelId: 'gpt-4o', inputTokens: 100, outputTokens: 50, totalTokens: 150, inputChars: 200, outputChars: 100, durationMs: 1000, recordedAt: Date.now() },
    'response',
  )
  ok('⑩① 复盘材料生成', materials.length === 3 && materials[0].type === 'prompt')
}

// ───────────────── ⑪ 去重键 ─────────────────
function case11() {
  const k1 = generateDedupKey('job-1', 'review', 'ch1', 'hash1')
  ok('⑪① 去重键生成', k1.dedupKey.includes('job-1') && k1.canDeduplicate)

  const k2 = generateDedupKey(undefined, undefined, undefined, 'hash1')
  ok('⑪② 无去重', !k2.canDeduplicate)
}

// ───────────────── ⑫ 证据校验 ─────────────────
function case12() {
  const citations: CitationInfo[] = [
    { quote: '引文1', source: 'ch1', located: true },
    { quote: '引文2', source: 'ch2', located: true },
  ]
  const knownSources = new Set(['ch1', 'ch2'])

  const r1 = checkEvidence(citations, '正文内容', knownSources)
  ok('⑫① 通过', r1.passed)

  // 重复引文
  const dup: CitationInfo[] = [
    { quote: '引文1', source: 'ch1', located: true },
    { quote: '引文1', source: 'ch1', located: true },
  ]
  const r2 = checkEvidence(dup, '正文', knownSources)
  ok('⑫② 重复引文', r2.isDuplicate && !r2.passed)

  // 无法定位
  const unloc: CitationInfo[] = [{ quote: '引文', source: 'ch1', located: false }]
  const r3 = checkEvidence(unloc, '正文', knownSources)
  ok('⑫③ 无法定位', !r3.isLocated && !r3.passed)
}

// ───────────────── ⑬ 文本守卫 ─────────────────
function case13() {
  const knownFacts = new Set(['事实1', '事实2'])

  const r1 = guardText('事实1 事实2', '事实1 事实2 新内容', knownFacts, ['新内容'])
  ok('⑬① 通过', r1.passed && r1.factRetentionRate === 1)

  const r2 = guardText('事实1 事实2', '新内容', knownFacts, [])
  ok('⑬② 事实丢失', !r2.passed && r2.factRetentionRate < 1)

  // 过度缩短
  const r3 = guardText('很长很长的正文', '短', new Set(), [])
  ok('⑬③ 过度缩短', r3.falsePositives > 0)
}

// ───────────────── ⑭ 固定样本对照 ─────────────────
function case14() {
  const sample: FixedSample = { sampleId: 's1', input: 'test', expectedOutput: 'hello world', tolerance: 10 }

  const r1 = compareWithFixedSample(sample, 'hello world')
  ok('⑭① 完全匹配', r1.passed)

  const r2 = compareWithFixedSample(sample, 'different')
  ok('⑭② 不匹配', !r2.passed)

  // 批量
  const samples: FixedSample[] = [
    { sampleId: 's1', input: 'a', expectedOutput: 'hello', tolerance: 5 },
    { sampleId: 's2', input: 'b', expectedOutput: 'world', tolerance: 5 },
  ]
  const outputs = { s1: 'hello', s2: 'world' }
  const results = batchCompareWithFixedSamples(samples, outputs)
  ok('⑭③ 批量对照', results.length === 2 && results.every(r => r.passed))
}

// ───────────────── ⑮ 质量评分 ─────────────────
function case15() {
  const evidenceResult = {
    passed: true,
    isForged: false,
    isDuplicate: false,
    isLocated: true,
    issues: [],
    diagnostics: [],
  }
  const textResult = {
    passed: true,
    factRetentionRate: 1,
    falsePositives: 0,
    issues: [],
  }
  const sampleResults = [
    { sampleId: 's1', passed: true, charDiff: 0, similarity: 1, issues: [] },
  ]

  const score = calculateQualityScore(evidenceResult, textResult, sampleResults)
  ok('⑮① 评分计算', score.score > 0 && score.score <= 100)
  ok('⑮② 各维度分', score.evidenceScore === 40 && score.textScore === 30 && score.factRetentionScore === 30)
}

// ───────────────── ⑯ 未知字段检测 ─────────────────
function case16() {
  const knownFields = new Set(['name', 'age', 'city'])
  const aliases = new Map([['n', 'name'], ['years', 'age']])

  const r1 = detectUnknownFields({ name: 'John', age: 30, unknown: 'value' }, knownFields, aliases)
  ok('⑯① 未知字段', r1.hasUnknownFields && r1.unknownFields.includes('unknown'))

  const r2 = detectUnknownFields({ n: 'John', years: 30 }, knownFields, aliases)
  ok('⑯② 别名识别', !r2.hasUnknownFields && r2.suggestions.length > 0)
}

// ───────────────── ⑰ 故障注入 ─────────────────
function case17() {
  // 不注入
  const config1: FaultInjectionConfig = { enabled: false, faultType: 'write-fail', probability: 1 }
  const r1 = injectFault(config1, () => 'success')
  ok('⑰① 不注入', r1 === 'success')

  // 注入
  const config2: FaultInjectionConfig = { enabled: true, faultType: 'write-fail', probability: 1 }
  const r2 = injectFault(config2, () => 'success')
  ok('⑰② 注入', typeof r2 === 'object' && 'injected' in r2 && (r2 as any).injected)

  // 判断
  ok('⑰③ 判断注入', shouldInjectFault(config2))
}

// ───────────────── ⑱ 跨设备冲突 ─────────────────
function case18() {
  const r1 = detectConflict(1, 1, 'hash1', 'hash1')
  ok('⑱① 无冲突', !r1.hasConflict)

  const r2 = detectConflict(1, 2, 'hash1', 'hash2')
  ok('⑱② 有冲突', r2.hasConflict && r2.conflictType === 'structure')
}

// ───────────────── ⑲ 版本校验 ─────────────────
function case19() {
  // 🔴 参数顺序是 (fileVersion, currentVersion, minVersion)：
  //    「版本过高」＝ 文件比软件新 ⇒ file 2 > current 1。原先写成 (1,2,0) 反而是"文件偏旧且合法"。
  const r1 = checkDataVersion(2, 1, 0)
  ok('⑲① 版本过高', !r1.compatible && r1.action === 'upgrade', JSON.stringify(r1))

  const r2 = checkDataVersion(0, 2, 1)
  ok('⑲② 版本过低', !r2.compatible && r2.action === 'downgrade')

  const r3 = checkDataVersion(1, 2, 0)
  ok('⑲③ 兼容', r3.compatible)
}

// ───────────────── ⑳ 迁移状态 ─────────────────
function case20() {
  const state = createMigrationState('mig-1')
  ok('⑳① 创建', state.status === 'pending')

  const started = startMigration(state)
  ok('⑳② 开始', started.status === 'running')

  const completed = completeMigration(started, 'backup-1')
  ok('⑳③ 完成', completed.status === 'completed' && completed.backupId === 'backup-1')

  const failed = failMigration(started, 'error')
  ok('⑳④ 失败', failed.status === 'failed' && failed.error === 'error')
}

// ───────────────── ⑵ 严格写盘 ─────────────────
function case21() {
  // 简化测试：验证函数签名
  const writeOp = async () => { return 'ok' }
  const readBackOp = async () => 'ok'
  const validator = (a: string, b: string) => a === b

  strictWrite(writeOp, readBackOp, validator).then(r => {
    ok('⑵① 严格写盘', r.ok)
  })
}

// ───────────────── 主函数 ─────────────────
async function main() {
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
  case12()
  case13()
  case14()
  case15()
  case16()
  case17()
  case18()
  case19()
  case20()
  await case21()
  console.log(`\nfull-stack: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
