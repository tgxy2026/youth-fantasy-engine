import { hash } from './fixtures/table-fixtures.mjs'

export const MEASUREMENT_VERSION = 1
export const SAMPLE_PLAN = Object.freeze({ warmup: 1, open: 5, input: 30, save: 10 })
export const THRESHOLDS = Object.freeze({
  medium: { openP50: 1000, openMax: 2000, inputP95: 100, saveP95: 1000 },
  large: { openP50: 2000, openMax: 3000, inputP95: 120, saveP95: 1500 },
})
export function summarize(samples, minimum = 1) {
  if (samples.length < minimum || samples.some(n => !Number.isFinite(n) || n < 0)) throw new Error('Invalid or insufficient timing samples')
  const ordered = [...samples].sort((a, b) => a - b)
  // Nearest-rank quantile, including P50; raw order is retained separately in reports.
  return { count: samples.length, p50: ordered[Math.ceil(ordered.length * .5) - 1], p95: ordered[Math.ceil(ordered.length * .95) - 1], worst: ordered.at(-1) }
}
export function validateSamples(metrics, plan = SAMPLE_PLAN) {
  return Object.fromEntries(['open', 'input', 'save'].map(key => [key, summarize(metrics[key], plan[key])]))
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
  for (const key of ['open', 'input', 'save']) {
    const a = summarize(current.metricsSamples[key]), b = summarize(baseline.metricsSamples[key])
    out[key] = { p50DeltaMs: a.p50 - b.p50, p95DeltaMs: a.p95 - b.p95, p50Relative: b.p50 === 0 ? null : a.p50 / b.p50 - 1 }
  }
  return out
}
