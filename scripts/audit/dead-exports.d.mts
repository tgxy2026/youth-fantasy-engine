// 与 registry-check.d.mts 同例：给单测提供 .mjs 的类型声明，避免 TS7016 / 隐式 any。
export interface DeadExportFinding {
  rule: 'dead.export' | 'dead.test-only'
  confidence: 'review'
  file: string
  line: number
  symbol: string
  kind: 'value' | 'type'
  message: string
}

export interface DeadExportStats {
  files: number
  exports: number
  used: number
  testOnly: number
  dead: number
  facadeOnly: number
}

export interface DeadReviewEntry {
  file: string
  symbol: string
  reason: string
}

export interface ScanDeadExportsOptions {
  /** 注入文件绝对路径列表（单测用；不传则按约定目录收集） */
  files?: string[]
  /** 注入读取函数（单测用） */
  readFile?: (file: string) => string
}

export declare function walkCode(dir: string, out?: string[]): string[]
export declare function scanDeadExports(
  root: string,
  opts?: ScanDeadExportsOptions,
): { findings: DeadExportFinding[]; stats: DeadExportStats }
export declare function validateDeadReviews(
  entries: unknown,
  opts?: { minReason?: number },
): { ok: boolean; issues: string[] }
export declare function staleDeadReviews(
  entries: DeadReviewEntry[] | null | undefined,
  root: string,
  opts?: { readFile?: (file: string) => string; exists?: (file: string) => boolean },
): Array<DeadReviewEntry & { why: string }>
