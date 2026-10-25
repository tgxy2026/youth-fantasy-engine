import { hash } from './fixtures/table-fixtures.mjs'

/**
 * 计量实现版本。
 * 🔴 v2（2026-10-25 16:40）：修一处**假绿** —— `--mode compare` 遇到环境/夹具/阈值不兼容时，
 *    错误被 catch 吞掉、状态仍停在 `baseline-recorded`，执行器据此 exit 0，等于「比不了也算过」。
 *    修法与影响：compare 失败必须落 `failed`；因为改了执行器，指纹随之变化，
 *    v1 的旧基线（`.workbuddy/tmp/table-performance-024EoR/`，node v22.23.2 采）**不再可比**，
 *    需要在 v2 下重采基线 —— 这是有意的，不是回归。
 * 🔴 v3（2026-10-25 17:40）：P0 余项补指标 —— **筛选 / 清筛选 / 连续滚动分布**。
 *    新增样本键 filter(5) / clear(5) / scroll(40)，阈值各自独立；同样需要重采基线。
 */
export const MEASUREMENT_VERSION = 3
export const SAMPLE_PLAN = Object.freeze({ warmup: 1, open: 5, input: 30, save: 10, filter: 5, clear: 5, scroll: 40 })
/** 全部计时指标。新增指标必须同时进 SAMPLE_PLAN / THRESHOLDS / validateSamples / compareBaseline */
export const METRIC_KEYS = Object.freeze(['open', 'input', 'save', 'filter', 'clear', 'scroll'])
export const THRESHOLDS = Object.freeze({
  medium: { openP50: 1000, openMax: 2000, inputP95: 100, saveP95: 1000, filterP95: 500, clearP95: 500 },
  large: { openP50: 2000, openMax: 3000, inputP95: 120, saveP95: 1500, filterP95: 800, clearP95: 800 },
// 🔴 scroll 暂不设阈值：实测 medium 单步 P50 107 / P95 141ms（每步约新挂 8 行 × 74 列），
//    远未到 60fps，属 P3 待优化项。这轮只**如实记录分布**，不给它一个「刚好能过」的门槛 ——
//    那等于把没做完的优化用数字掩盖掉。等 P3 把行级订阅/稳定 props 做完再冻结 scroll 阈值。
})
export function summarize(samples, minimum = 1) {
  if (samples.length < minimum || samples.some(n => !Number.isFinite(n) || n < 0)) throw new Error('Invalid or insufficient timing samples')
  const ordered = [...samples].sort((a, b) => a - b)
  // Nearest-rank quantile, including P50; raw order is retained separately in reports.
  return { count: samples.length, p50: ordered[Math.ceil(ordered.length * .5) - 1], p95: ordered[Math.ceil(ordered.length * .95) - 1], worst: ordered.at(-1) }
}
export function validateSamples(metrics, plan = SAMPLE_PLAN) {
  return Object.fromEntries(METRIC_KEYS.map(key => [key, summarize(metrics[key], plan[key])]))
}
export function comparisonKey(report) {
  return hash({ measurementVersion: report.measurementVersion, environmentHash: report.environmentHash,
    measurementHash: report.measurementHash, fixtureHash: report.fixtureHash, backend: report.backend, samplePlan: report.samplePlan, thresholds: report.thresholds })
}
export function compareBaseline(current, baseline) {
  const { integrityHash, ...body } = baseline
  if (!integrityHash || hash(body) !== integrityHash || !baseline.checks?.length || baseline.checks.some(c => c.ok !== true)) throw new Error('Baseline integrity or functional prerequisites invalid')
  if (baseline.mode !== 'measure' || baseline.status !== 'baseline-recorded' || baseline.measurementVersion !== MEASUREMENT_VERSION || !baseline.baselineId || baseline.baselineId !== comparisonKey(baseline)) throw new Error('Invalid frozen baseline')
  if (comparisonKey(current) !== baseline.baselineId) throw new Error('Incompatible baseline environment, fixtures, measurement or thresholds')
  validateSamples(current.metricsSamples); validateSamples(baseline.metricsSamples)
  const out = {}
  for (const key of METRIC_KEYS) {
    const a = summarize(current.metricsSamples[key]), b = summarize(baseline.metricsSamples[key])
    out[key] = { p50DeltaMs: a.p50 - b.p50, p95DeltaMs: a.p95 - b.p95, p50Relative: b.p50 === 0 ? null : a.p50 / b.p50 - 1 }
  }
  return out
}
