// db.ts 在 Node 测试环境下的 ./desktop 替身。
//
// ⚠️ 这里把 DESKTOP 设为 **true**：db.ts 的存储选择是 `DESKTOP ? desktopStore : idbOps`，
//    而 Node 里没有 IndexedDB，必须让它走 desktopStore —— 下面接到内存桩 memoryOps。
//    （网页版 / 便携版下线前，测试是靠 mocked 的 PORTABLE=true 拿到内存存储的；
//      那条路已随 portable.ts 一起删除，改由 DESKTOP 承担。）
export const DESKTOP = true
export { memoryOps as desktopStore } from './mock-memory'
export function initDesktopStore() { return Promise.resolve() }
// 与 src/lib/app/desktop.ts 同形：db/core.ts 的云盘自动恢复块要先 await 它再判 writeLocked。
// 桩里「数据文件」是现成的内存库，没有加载窗口 ⇒ 立即就绪。
export function desktopStoreReady() { return Promise.resolve() }
export function flushDesktopSync() { return Promise.resolve(false) }
// db.ts 关闭云盘同步时会 await flushDesktop() 再切存储（内存桩无需真落盘，直接成功）
export function flushDesktop() { return Promise.resolve(true) }
export function subscribeDesktop() { return () => {} }
// 与 src/lib/app/desktop.ts 的 DesktopState 同形：db.ts 的云同步入口会读 writeLocked
// （测试环境从不锁写盘，固定 false；将来要测「锁定期行为」就在这里放开）
export function getDesktopState() {
  return { ready: true, path: '', dirty: false, writeLocked: false, writeLockReason: '' }
}
// 与 src/lib/app/desktop.ts 同名同形：db.ts 的「云端 cache → 本地库」镜像会 import 它判「本地是否已有这条」。
// 直接复用 mock-memory 那一份，**不要在这里另写一份** —— 两份日期久了对不上就是下次事故。
export { KEY_PATHS } from './mock-memory'

// 联网检索用的「主进程代发」：Node 测试环境里没有 Electron，固定为不可用。
// 也因此单测里 SearXNG 会被判成「会被跨域拦」。
// 真·主进程代发那一段由桌面版实机验证覆盖（node 里没有 window.electronNet）。
export const HAS_NET_BRIDGE = false
/** 代理设置的桌面端落库：测试桩没有真实会话，按「无桥接」口径返回（与 desktop.ts 同形） */
export function setNetProxy(_cfg: { enabled: boolean; rules?: string; bypass?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  return Promise.resolve({ ok: false, error: '测试桩没有「设置代理」能力' })
}
export function netFetch(): Promise<{ ok: false; error: string }> {
  return Promise.resolve({ ok: false, error: '测试环境没有主进程代发能力' })
}
