export const MEASUREMENT_VERSION: number
export const SAMPLE_PLAN: { warmup: number; open: number; input: number; save: number }
export const THRESHOLDS: Record<string, Record<string, number>>
export function summarize(samples: number[], minimum?: number): { count: number; p50: number; p95: number; worst: number }
export function validateSamples(metrics: Record<string, number[]>, plan?: typeof SAMPLE_PLAN): Record<string, ReturnType<typeof summarize>>
export function comparisonKey(report: Record<string, unknown>): string
export function compareBaseline(current: Record<string, unknown>, baseline: Record<string, unknown>): Record<string, unknown>
