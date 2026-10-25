export const LAYOUT_MIN_CASES: number
export const LAYOUT_MIN_ZOOMS: number
export function validateLayoutEvidence(
  root: string,
  file: string,
  opts: { expectedSourceFingerprint: string; minCases?: number },
): Promise<{ assertions: number; sha256: string; result: Record<string, unknown> }>
