// db.ts 在 Node 测试环境下的 ./desktop 替身：DESKTOP=false，永不启用
export const DESKTOP = false
export { memoryOps as desktopStore } from './mock-memory'
export function initDesktopStore() { return Promise.resolve() }
export function flushDesktopSync() { return Promise.resolve(false) }
export function subscribeDesktop() { return () => {} }
export function getDesktopState() { return { ready: true, path: '', dirty: false } }
