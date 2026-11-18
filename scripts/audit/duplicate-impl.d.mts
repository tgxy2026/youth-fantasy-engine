// 3.6.1：duplicate-impl.mjs 的类型声明（同上：只暴露纯函数，测试可静态 import）
export declare const MIN_BODY_CHARS: number
export declare function extractExportedFunctions(text: string): { name: string; body: string; line: number }[]
export declare function normalizeBody(body: string): string
export interface DuplicateFinding { rule: 'dup.impl'; file: string; line: number; message: string }
export declare function findDuplicateImpls(sources: readonly { file: string; text: string }[]): DuplicateFinding[]
export declare function scanDuplicateImpls(root: string): { files: number; findings: DuplicateFinding[]; stats: { findings: number } }
