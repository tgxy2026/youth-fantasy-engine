// 与 scripts/verify/*.d.mts 同例：给单测提供 .mjs 的类型声明，避免 TS7016 / 隐式 any。
export interface RegistryCheck {
  name: string
  status: 'passed' | 'failed'
  detail: string
}

export interface RegistryResult {
  ok: boolean
  checks: RegistryCheck[]
  issues: string[]
}

export interface RegistryContracts {
  required?: Array<{ id: string }>
  charts?: string[]
  nonChartMono?: Array<{ file: string; reason?: string }>
  [key: string]: unknown
}

export interface RegistryPolicy {
  schemaVersion?: number
  flagSources?: Record<string, string>
  bridgeAdapters?: string[]
  rawFlagAdapters?: string[]
  httpStoreAdapters?: string[]
  agentAuditPaths?: string[]
  sidecars?: Array<{ file: string; symbol?: string; expected?: string[]; reason?: string }>
  [key: string]: unknown
}

export interface RegistryInput {
  contracts: RegistryContracts
  policy: RegistryPolicy
  exists: (file: string) => boolean
  srcFileCount: number
  staticFiles: number
}

export declare const HARDCODED_FILES: string[]
export declare function registeredPaths(
  contracts: RegistryContracts,
  policy: RegistryPolicy,
): Array<{ label: string; file: string }>
export declare function validateRegistry(input: RegistryInput): RegistryResult
export declare function countSourceFiles(dir: string): number
export declare function toolFingerprint(root: string): string
export declare function staleToolHints(root: string): Array<{ file: string; line: number; target: string }>
