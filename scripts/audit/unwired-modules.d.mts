// 与 registry-check.d.mts / dead-exports.d.mts 同例：给单测提供 .mjs 的类型声明。
export type UnwiredStatus = 'gap' | 'retained' | 'harness' | 'entry'

export interface UnwiredFinding {
  rule: 'wired.missing'
  confidence: 'review'
  file: string
  line: number
  /** 有多少个 tests/** 文件 import 它（区分「完全没人用」与「只为测试而活」） */
  testImporters: number
  message: string
}

export interface UnwiredStats {
  files: number
  wired: number
  unwired: number
  testOnly: number
}

export interface UnwiredLedgerEntry {
  file: string
  status: UnwiredStatus
  reason: string
}

export interface ScanUnwiredOptions {
  /** 注入源码文件（绝对路径或仓库相对路径；单测用） */
  files?: string[]
  /** 注入测试文件（同上） */
  testFiles?: string[]
  readFile?: (file: string) => string
}

export declare const ENTRY_FILES: string[]
export declare const LEDGER_STATUSES: UnwiredStatus[]

export declare function resolveImport(
  fromRel: string,
  spec: string,
  exists: (rel: string) => boolean,
): string | null

export declare function importSpecifiers(text: string): string[]

export declare function scanUnwiredModules(
  root: string,
  opts?: ScanUnwiredOptions,
): { findings: UnwiredFinding[]; stats: UnwiredStats }

export declare function validateUnwiredLedger(
  entries: unknown,
  exists?: (file: string) => boolean,
): { ok: boolean; issues: string[] }

export declare function reconcileUnwiredLedger(
  findings: UnwiredFinding[],
  entries: UnwiredLedgerEntry[] | null | undefined,
): { unregistered: string[]; stale: string[] }
