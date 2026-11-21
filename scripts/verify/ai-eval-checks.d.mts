/** `ai-eval-checks.mjs` 的类型声明（供 TS 测试 import 时拿到类型） */
export declare function stripFences(text: unknown): string
export declare function tryParseJson(text: unknown): Record<string, unknown> | null
export declare function countSentences(text: unknown): number
export declare const UNCERTAINTY_MARKS: readonly string[]

export interface EvalCheck {
  kind: string
  why?: string
  fields?: string[]
  field?: string
  limit?: number
  any?: string[]
  knownChapter?: number
}

export interface CheckResult {
  check: EvalCheck
  ok: boolean
  detail: string
}

export declare function runCheck(check: EvalCheck, text: unknown): { ok: boolean; detail: string }
export declare function runScenarioChecks(
  checks: readonly EvalCheck[] | undefined,
  text: unknown,
): { results: CheckResult[]; failed: CheckResult[] }
