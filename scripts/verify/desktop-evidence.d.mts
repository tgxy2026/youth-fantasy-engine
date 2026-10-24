import type { GuestRuntimeResult } from './web-guest-evidence.mjs'
export const DESKTOP_CASE_IDS: string[]
export const DESKTOP_ARTIFACTS: string[]
export function validateDesktopEvidence(root: string, file: string, expected: {
  expectedBuildHash: string; expectedSourceFingerprint: string
}): Promise<{ assertions: number; result: GuestRuntimeResult }>
