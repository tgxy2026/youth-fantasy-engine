// db.ts 在 Node 测试环境下的 ./portable 替身：强制走 portableStore（即内存版）
export const PORTABLE = true
export const APP_VERSION = 'test'
export { memoryOps as portableStore } from './mock-memory'
export function isFSASupported() { return false }
export function scheduleSave() {}
export async function flush() { return true }
export function subscribe() { return () => {} }
export function getState() { return { ready: true, path: '', dirty: false } }
export function normalizePortableData(p: unknown) { return p as never }
