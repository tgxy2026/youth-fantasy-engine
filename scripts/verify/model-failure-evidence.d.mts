/** 契约 model.failure 必需场景 */
export const MODEL_FAILURE_CASES: readonly string[]
/** 断言条数下限 */
export const MODEL_FAILURE_MIN_ASSERTS: number
export function validateModelFailureEvidence(
  root: string,
  file: string,
  opts: { expectedSourceFingerprint: string; buildDir: string },
): Promise<{ assertions: number; sha256: string; result: Record<string, unknown> }>
