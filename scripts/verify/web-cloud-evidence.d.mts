export declare const WEB_CLOUD_CASE_IDS: string[]
export declare const WEB_CLOUD_ARTIFACTS: string[]
export declare function validateWebCloudEvidence(
  root: string,
  file: string,
  options: { expectedBuildHash: string; expectedSourceFingerprint: string },
): Promise<{ assertions: number; result: WebCloudRuntimeResult }>

export interface WebCloudRuntimeResult {
  schemaVersion: number
  profile: string
  scope: string
  runRoot: string
  sourceFingerprint: string
  build: string
  buildManifest: { sha256: string }
  at: string
  passed: number
  failed: number
  checks: { id: string; passed: boolean; detail?: unknown }[]
  artifacts: { path: string; sha256: string }[]
  pageErrors: string[]
  error: string | null
}
