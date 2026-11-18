// 3.6.1：stale-cache.mjs 的类型声明（测试直接 import 纯函数，避免把 CommonJS 依赖拖进来）
export declare const PROVIDERS: readonly { file: string; reason: string }[]
export interface StaleCacheFinding { rule: 'stale.cache'; file: string; line: number; message: string }
export declare function scanStaleCacheSource(file: string, text: string): StaleCacheFinding[]
export declare function scanStaleCache(root: string): { files: number; findings: StaleCacheFinding[]; stats: { findings: number } }
export declare function validateProviders(root: string): { ok: boolean; issues: string[] }
