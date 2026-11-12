// 3.5.2 · 原子写的最小类型声明（真源是 atomic.mjs）
export function writeTextAtomicSync(abs: string, text: string): void
export function writeTextAtomic(abs: string, text: string): Promise<void>
export function readJSONOr(abs: string, reader: (abs: string) => string):
  | { ok: true; value: any }
  | { ok: false; missing: true }
  | { ok: false; error: string }
export function dirBytesSync(dir: string): number