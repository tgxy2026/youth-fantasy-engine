// ============ AI 度量 · 单测（3.6.2 · W5）============
//
// 四件必须钉住的事：
//   ① 五类事件计数准确，且 `acceptanceRate` 在"从未展示"时是 **null** 而不是 0；
//   ② 环形上限滚动：超了丢最旧，不无限长；
//   ③ **键空间隔离**：换项目不串（存在全局 meta，不是项目设置）；
//   ④ 坏数据不崩：非数组 / 元素畸形 / 超大，逐条丢弃而不是整份作废。
import {
  AI_METRICS_KEY,
  AI_METRICS_MAX,
  __resetAiMetricsCache,
  appendRing,
  clearAiMetrics,
  flushAiMetrics,
  recordAiMetric,
  sanitizeEntries,
  summarizeAiMetrics,
  summarizeEntries,
  type AiMetricEntry,
} from '../src/lib/ai/metrics'
import * as db from '../src/lib/db'
import { __resetMockStores, memoryOps } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function E(feature: AiMetricEntry['feature'], event: AiMetricEntry['event'], at = 1000): AiMetricEntry {
  return { at, feature, event }
}

// ---------- 1. 汇总计数 ----------
{
  const entries: AiMetricEntry[] = [
    E('candidate', 'shown', 10), E('candidate', 'shown', 11), E('candidate', 'shown', 12),
    E('candidate', 'accepted', 13), E('candidate', 'rejected', 14),
    E('candidate', 'regenerated', 15), E('candidate', 'undone', 16),
    E('proofread', 'shown', 20), E('proofread', 'accepted', 21),
  ]
  const s = summarizeEntries(entries)
  const cand = s.find(x => x.feature === 'candidate')
  ok('1a 五类事件各计数正确',
    cand?.shown === 3 && cand?.accepted === 1 && cand?.rejected === 1 && cand?.regenerated === 1 && cand?.undone === 1,
    JSON.stringify(cand))
  ok('1b 采纳率 = accepted / shown（1/3）', Math.abs((cand?.acceptanceRate ?? 0) - 1 / 3) < 1e-9, String(cand?.acceptanceRate))
  const proof = s.find(x => x.feature === 'proofread')
  ok('1c 另一功能独立统计', proof?.shown === 1 && proof?.accepted === 1 && proof?.acceptanceRate === 1)

  const empty = summarizeEntries([])
  ok('1d 没有数据时返回空数组（不返回一堆 0 行）', empty.length === 0, String(empty.length))
  const onlyShown = summarizeEntries([E('candidate', 'shown')])
  ok('1e 🔴 只展示未采纳 → 采纳率 0（不是 null）', onlyShown[0].acceptanceRate === 0)
  const neverShown = summarizeEntries([E('candidate', 'accepted')])
  ok('1f 🔴 从未展示却有采纳（数据异常）→ 采纳率 null（不除零）', neverShown[0].acceptanceRate === null)
}

// ---------- 2. 时间过滤 ----------
{
  const entries = [E('candidate', 'shown', 100), E('candidate', 'accepted', 2000)]
  const recent = summarizeEntries(entries, 1000)
  ok('2a since 之前的条目不计数', recent[0].shown === 0 && recent[0].accepted === 1, JSON.stringify(recent[0]))
}

// ---------- 3. 环形上限 ----------
{
  const list: AiMetricEntry[] = []
  for (let i = 0; i < 5; i++) list.push(E('candidate', 'shown', i + 1))
  const capped = appendRing(list, E('candidate', 'accepted', 99), 3)
  ok('3a 超出上限后长度固定为上限', capped.length === 3, String(capped.length))
  ok('3b 丢的是最旧的（5 条 + 1 新 = 6，留最后 3 条：4,5,99）', capped.map(e => e.at).join(',') === '4,5,99', capped.map(e => e.at).join(','))
  ok('3c 未超限时原样追加', appendRing(list, E('candidate', 'accepted', 99), 10).length === 6)
}

// ---------- 4. 坏数据清洗 ----------
{
  ok('4a 非数组 → 空数组', sanitizeEntries('nope').length === 0 && sanitizeEntries(null).length === 0)
  ok('4b 元素畸形逐条丢弃，好的一条留下',
    sanitizeEntries([
      { at: 1, feature: 'candidate', event: 'shown' },
      { at: 'x', feature: 'candidate', event: 'shown' },
      { at: 2, feature: 'unknown-feature', event: 'shown' },
      { at: 3, feature: 'candidate', event: 'unknown-event' },
      { feature: 'candidate', event: 'shown' },
      null,
      42,
    ]).length === 1)
  ok('4c 负数/0 时间戳视为无效', sanitizeEntries([{ at: 0, feature: 'candidate', event: 'shown' }]).length === 0)
  ok('4d 超大数组不崩（1 万条）',
    sanitizeEntries(Array.from({ length: 10000 }, (_, i) => ({ at: i + 1, feature: 'other', event: 'shown' }))).length === 10000)
}

// ---------- 5. 端到端：记录 → 落库 → 汇总 ----------
async function endToEnd() {
  __resetMockStores()
  __resetAiMetricsCache()
  const p1 = await db.createProject('度量测试书一', '', '', '', 'full')
  db.setCurrentProject(p1.id)

  recordAiMetric('candidate', 'shown')
  recordAiMetric('candidate', 'shown')
  recordAiMetric('candidate', 'accepted')
  recordAiMetric('proofread', 'shown')
  recordAiMetric('proofread', 'rejected')
  await flushAiMetrics()

  const s1 = await summarizeAiMetrics()
  const cand = s1.find(x => x.feature === 'candidate')
  const proof = s1.find(x => x.feature === 'proofread')
  ok('5a 端到端：候选 展示 2 / 采纳 1', cand?.shown === 2 && cand?.accepted === 1, JSON.stringify(cand))
  ok('5b 端到端：校对 展示 1 / 放弃 1', proof?.shown === 1 && proof?.rejected === 1, JSON.stringify(proof))

  // 🔴 键空间：存在全局 meta（不是项目设置）
  const rawMeta = await memoryOps.get<{ key: string }>('meta', AI_METRICS_KEY)
  ok('5c 🔴 落在全局 meta，键名不带项目 id', !!rawMeta, String(rawMeta))
  const projSettings = await memoryOps.getAll<{ key: string }>('settingsKV')
  ok('5d 🔴 不混进项目设置（settingsKV）', !projSettings.some(r => r.key.includes('ai.metrics')),
    projSettings.map(r => r.key).join(','))

  // 换项目后统计不变（度量是"本机这段时期的手感"，不按书分）
  const p2 = await db.createProject('度量测试书二', '', '', '', 'full')
  db.setCurrentProject(p2.id)
  __resetAiMetricsCache()   // 模拟重启：缓存清掉，从存储读
  const s2 = await summarizeAiMetrics()
  ok('5e 🔴 换项目后统计不串、不丢（同一份全局度量）',
    (s2.find(x => x.feature === 'candidate')?.shown ?? 0) === 2,
    JSON.stringify(s2.map(x => [x.feature, x.shown])))

  // 清空
  await clearAiMetrics()
  __resetAiMetricsCache()
  const s3 = await summarizeAiMetrics()
  ok('5f 清空后归零（且已落库，重启不会复活）', s3.length === 0, JSON.stringify(s3))

  // 落库内容确实是数组且长度受控
  recordAiMetric('candidate', 'shown')
  await flushAiMetrics()
  const stored = await memoryOps.get<{ value: unknown }>('meta', AI_METRICS_KEY)
  ok('5g 存储里的值是非空数组', Array.isArray(stored?.value) && (stored!.value as unknown[]).length === 1,
    JSON.stringify(stored?.value))
}

await endToEnd()

// ---------- 6. 上限常量 ----------
{
  ok('6a 环形上限就是 2000（改它要同步改文档）', AI_METRICS_MAX === 2000, String(AI_METRICS_MAX))
}

console.log(`\naiMetrics: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
