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
 * 🔴 v4（2026-10-25 17:50）：**滚动指标的定义错了，重做**。旧口径是「每步推进 1/40 全表」——
 *    medium 一步 300px、large 一步 1000px（约 25 行），既不是真实滚轮步长，又把
 *    「新挂 20 行 vs 0 行」混成了同一个数字（诊断：800px/20 行 = 125ms，1px/0 行 = 19ms）。
 *    现在改成**固定 120px/步、60 步、在页面内计时**（去掉 Playwright 往返开销），并给出阈值。
 * 🔴 v5（2026-10-25 18:20）：**save 的计时也被探针自己污染了**。原来每 25ms 轮询一次
 *    `readStores()`（开库 + getAll(tableRows) + getAll(projects) + 关库），large 一次约 40ms，
 *    连产品本身只要 13~45ms 的保存被量成 450ms。现在轮询改成「按主键读单条」（约 2~5ms），
 *    整表回读仍然做 —— 但只做**一次**、且**不计时**，作为持久化断言（`complete persisted records`）。
 */
export const MEASUREMENT_VERSION = 5
export const SAMPLE_PLAN = Object.freeze({ warmup: 1, open: 5, input: 30, save: 10, filter: 5, clear: 5, scroll: 60 })
/** 滚动步长（CSS 像素，≈ 一次滚轮/触控板的一次推进量）。每步新挂 1~3 行，才是作者真实的手感 */
export const SCROLL_STEP_PX = 120
/** 全部计时指标。新增指标必须同时进 SAMPLE_PLAN / THRESHOLDS / validateSamples / compareBaseline */
export const METRIC_KEYS = Object.freeze(['open', 'input', 'save', 'filter', 'clear', 'scroll'])
export const THRESHOLDS = Object.freeze({
  medium: { openP50: 1000, openMax: 2000, inputP95: 100, saveP95: 1000, filterP95: 500, clearP95: 500, scrollP95: 50 },
  large: { openP50: 2000, openMax: 3000, inputP95: 120, saveP95: 1500, filterP95: 800, clearP95: 800, scrollP95: 60 },
// 🔴 scroll 阈值 = 60fps 预算内（50/60ms）：120px 一步只新挂 1~3 行，若这一步都超过 50ms，
//    说明挂着的那 15 行本身太贵，该回头查单行成本，而不是调阈值。
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
