// ============ C2 · 浏览器全屏（3.3.4）============
//
// 规划 §4.1：桌面走窗口桥（`desktop.ts` 已有），浏览器走 **Fullscreen API**；
// **运行时可探测**，不按 Safari / iOS 名字一刀切；只有用户点击才请求；
// 状态一律由 `fullscreenchange` / `fullscreenElement` 校准，不乐观显示"已全屏"。
//
// 🔴 三条不可省的现实：
//   ① `document.fullscreenEnabled === true` 只说明"允许请求"，**不保证本次获准**
//      （iframe、权限策略、用户激活都可能拒），所以要接 Promise 的 reject 与 `fullscreenerror`；
//   ② 没有 API 的手机仍可用现有的「专注布局」，但界面必须称**专注模式**，不能假称全屏，
//      也不承诺地址栏被隐藏；
//   ③ iOS Safari 的 `Element.requestFullscreen` 长期只对 `<video>` 生效 —— 本模块不特判平台，
//      靠运行时结果说话：调用失败就是 `denied`/`unsupported`，界面如实降级。
//
// 依据（2026-11-01 查阅）：MDN requestFullscreen / fullscreenEnabled / Fullscreen API Guide。

export type FullscreenOutcome = 'ok' | 'denied' | 'unsupported'

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitFullscreenEnabled?: boolean
  webkitExitFullscreen?: () => Promise<void> | void
}

type FsElement = Element & {
  webkitRequestFullscreen?: () => Promise<void> | void
}

function doc(): FsDocument | undefined {
  return typeof document === 'undefined' ? undefined : document as FsDocument
}

/** 运行时是否具备全屏能力（API 存在且文档允许请求）。**不代表本次一定获准**。 */
export function browserFullscreenSupported(): boolean {
  const d = doc()
  if (!d) return false
  const enabled = d.fullscreenEnabled === true || d.webkitFullscreenEnabled === true
  const el = d.documentElement as FsElement | null
  return enabled && !!el && (typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function')
}

/** 当前是否处于全屏（以 `fullscreenElement` 为准，不看我们自己记的布尔） */
export function browserFullscreenActive(): boolean {
  const d = doc()
  if (!d) return false
  return !!(d.fullscreenElement ?? d.webkitFullscreenElement)
}

/**
 * 请求全屏。`target` 必须包含所有浮层（规划 §10.1：菜单、确认、下拉、toast 的挂载节点）。
 * 默认取 `document.documentElement` —— 项目所有 Portal 都挂在 body 下的祖先里，
 * 全屏根 = html 时浮层仍可见；改成某个编辑区会让菜单消失。
 */
export async function enterBrowserFullscreen(target?: Element | null): Promise<FullscreenOutcome> {
  if (!browserFullscreenSupported()) return 'unsupported'
  const el = (target ?? doc()?.documentElement) as FsElement | null
  if (!el) return 'unsupported'
  try {
    if (typeof el.requestFullscreen === 'function') await el.requestFullscreen({ navigationUI: 'hide' })
    else await el.webkitRequestFullscreen?.()
    return 'ok'
  } catch {
    // 用户拒绝 / 权限策略 / 非用户激活 —— 一律如实报"没进成功"，由界面给反馈
    return 'denied'
  }
}

export async function exitBrowserFullscreen(): Promise<FullscreenOutcome> {
  const d = doc()
  if (!d) return 'unsupported'
  if (!browserFullscreenActive()) return 'ok'
  try {
    if (typeof d.exitFullscreen === 'function') await d.exitFullscreen()
    else await d.webkitExitFullscreen?.()
    return 'ok'
  } catch {
    return 'denied'
  }
}

/**
 * 订阅全屏状态。**状态只认事件**：用户按 Esc、切标签页被系统退出、别的脚本改 DOM，
 * 都会走 `fullscreenchange`；`fullscreenerror` 表示本次请求被拒。
 * 返回退订函数（组件卸载必须调用，规划 §10.1「不能遗留监听器」）。
 */
export function onBrowserFullscreenChange(cb: (active: boolean) => void, onError?: () => void): () => void {
  const d = doc()
  if (!d) return () => {}
  const change = () => cb(browserFullscreenActive())
  const error = () => onError?.()
  d.addEventListener('fullscreenchange', change)
  d.addEventListener('webkitfullscreenchange', change)
  d.addEventListener('fullscreenerror', error)
  d.addEventListener('webkitfullscreenerror', error)
  return () => {
    d.removeEventListener('fullscreenchange', change)
    d.removeEventListener('webkitfullscreenchange', change)
    d.removeEventListener('fullscreenerror', error)
    d.removeEventListener('webkitfullscreenerror', error)
  }
}