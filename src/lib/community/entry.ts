// 投稿广场 · 全局入口事件（3.5.0）
//
// 【为什么用事件而不是 prop】广场要在**三种位置**都能打开：
// 项目中心（ProjectHub）、项目内左下角工具栏（Sidebar）、以及未来的任何页头。
// 把 `onOpenCommunity` 一层层穿过 WorkspaceSidebar → Sidebar 会改动 3 个组件的 props 契约，
// 而事件只影响 App 一处监听 —— 对既有组件的侵入最小。
//
// 🔴 事件名带 `yfe:` 前缀，与项目里既有的 `yfe:zoom-changed` / `yfe:tabs-changed` 同一命名空间。

export const OPEN_COMMUNITY_EVENT = 'yfe:open-community'

export function openCommunity(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(OPEN_COMMUNITY_EVENT))
}