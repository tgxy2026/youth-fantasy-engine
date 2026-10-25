export const MEASUREMENT_VERSION: number
export const SAMPLE_PLAN: { warmup: number; open: number; input: number; save: number; filter: number; clear: number; scroll: number }
/** 滚动步长（CSS 像素）：滚动指标定义的一部分，改动即口径变化 */
export const SCROLL_STEP_PX: number
/** 全部计时指标键（validateSamples / compareBaseline 按它遍历） */
export const METRIC_KEYS: readonly string[]
export const THRESHOLDS: Record<string, Record<string, number>>
export function summarize(samples: number[], minimum?: number): { count: number; p50: number; p95: number; worst: number }
export function validateSamples(metrics: Record<string, number[]>, plan?: typeof SAMPLE_PLAN): Record<string, ReturnType<typeof summarize>>
export function comparisonKey(report: Record<string, unknown>): string
export function compareBaseline(current: Record<string, unknown>, baseline: Record<string, unknown>): Record<string, unknown>
