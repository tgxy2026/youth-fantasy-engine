// db.ts 在 Node 测试环境下的 ./desktop 替身：DESKTOP=false，永不启用
export const DESKTOP = false
export { memoryOps as desktopStore } from './mock-memory'
export function initDesktopStore() { return Promise.resolve() }
export function flushDesktopSync() { return Promise.resolve(false) }
export function subscribeDesktop() { return () => {} }
export function getDesktopState() { return { ready: true, path: '', dirty: false } }

// 联网检索用的「主进程代发」：Node 测试环境里没有 Electron，固定为不可用。
// 这也正好等价于「便携版 / 纯浏览器」—— 因此单测里 SearXNG 会被判成「会被跨域拦」。
// 真·主进程代发那一段由桌面版实机验证覆盖（node 里没有 window.electronNet）。
export const HAS_NET_BRIDGE = false
export function netFetch(): Promise<{ ok: false; error: string }> {
  return Promise.resolve({ ok: false, error: '测试环境没有主进程代发能力' })
}
