// db.ts 在 Node 测试环境下的 ./desktop 替身。
//
// ⚠️ 这里把 DESKTOP 设为 **true**：db.ts 的存储选择是 `DESKTOP ? desktopStore : idbOps`，
//    而 Node 里没有 IndexedDB，必须让它走 desktopStore —— 下面接到内存桩 memoryOps。
//    （网页版 / 便携版下线前，测试是靠 mocked 的 PORTABLE=true 拿到内存存储的；
//      那条路已随 portable.ts 一起删除，改由 DESKTOP 承担。）
export const DESKTOP = true
export { memoryOps as desktopStore } from './mock-memory'
export function initDesktopStore() { return Promise.resolve() }
export function flushDesktopSync() { return Promise.resolve(false) }
export function subscribeDesktop() { return () => {} }
export function getDesktopState() { return { ready: true, path: '', dirty: false } }

// 联网检索用的「主进程代发」：Node 测试环境里没有 Electron，固定为不可用。
// 也因此单测里 SearXNG 会被判成「会被跨域拦」。
// 真·主进程代发那一段由桌面版实机验证覆盖（node 里没有 window.electronNet）。
export const HAS_NET_BRIDGE = false
export function netFetch(): Promise<{ ok: false; error: string }> {
  return Promise.resolve({ ok: false, error: '测试环境没有主进程代发能力' })
}
