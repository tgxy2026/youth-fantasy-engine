export interface Contract { id: string; stage: string; minAssertions: number }
export interface EvidenceResult { id: string; status: string; assertions: number; reason?: string }
export interface Verdict { code: number; reason?: string }
export interface Fingerprint { sha256: string; count: number; entries: { path: string; sha256: string }[] }
export function hashPaths(root: string, paths: string[]): Promise<Fingerprint>
export function captureInputs(root: string): Promise<{ source: Fingerprint; platform: Fingerprint; tools: Fingerprint; combined: string }>
export function scopeVerdict(contracts: Contract[], results: EvidenceResult[], stage?: string): Verdict
export function writeReports(runRoot: string, report: {
  stage: string; verdict: Verdict; localVerdict: Verdict; inputs: { combined: string }; results: EvidenceResult[]
}): Promise<void>
