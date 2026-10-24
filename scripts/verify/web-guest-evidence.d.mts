export const GUEST_CASE_IDS: string[]
export interface GuestRuntimeResult {
  profile: string
  runRoot: string
  sourceFingerprint: string
  buildManifest: { sha256: string }
  failed: number
  passed: number
  error: string | null
  pageErrors: string[]
  checks: { id: string; passed: boolean }[]
  artifacts: { path: string; sha256: string }[]
}
export function validateGuestEvidence(root: string, file: string, expected: {
  expectedBuildHash: string; expectedSourceFingerprint: string
}): Promise<{ assertions: number; result: GuestRuntimeResult }>
