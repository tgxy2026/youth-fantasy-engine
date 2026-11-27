// 3.7.5：coverage-checks.mjs 的类型声明
export interface HotUncoveredFile {
  file: string
  lines: number
}

export interface ScanHotUncoveredOptions {
  srcFiles?: string[]
  testFiles?: string[]
  readFile?: (file: string) => string
}

export declare const HOT_COVERAGE_RE: RegExp
export declare function collectCoverageTestFiles(root: string): string[]
export declare function scanHotUncoveredFiles(
  root: string,
  opts?: ScanHotUncoveredOptions,
): { files: number; hotUncovered: HotUncoveredFile[] }
export declare function reconcileHotCoverage(
  hotUncovered: HotUncoveredFile[],
  ledgerEntries: { file: string }[] | null | undefined,
): { unregistered: HotUncoveredFile[] }
