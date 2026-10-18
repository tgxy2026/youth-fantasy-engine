// 左下角「数据坞」呈现判定（3.0 · W3-3 · §11.1 L4）
//
// 🔴 为什么单独落 `lib` 而不是留在 `components/app/DataDock.tsx`：
//    `DataDock` 是数据安全相关组件（本机存储 / 导出 / 导入入口），却是零组件级覆盖 ——
//    它的判定内联在 JSX 里，依赖 `DESKTOP` / `PORTABLE`（运行时探测常量）与 `DEV`（Vite 编译期常量），
//    测试环境注入不了；而组件文件本身又拉进 `Desktop` / `CloudFileSyncBar` 等一整套依赖图，
//    想直接 import 它来测会连带把整棵组件树拖进 esbuild。
//    ⇒ 把**判定**抽成纯函数落在 lib（不 import 任何组件），组件照旧渲染 ——
//      与 `DesktopWriteLockBanner` 的 `decideDataFileLoad` 同一套手法。
//
// ✅ 组件从这里 import 判定，测试也从这里 import —— **单一真相源**，不会各写一份。

export interface DataDockView {
  /** 整块是否渲染 */
  render: boolean
  /** 「数据存储」行渲染哪条 */
  storageBar: 'portable' | 'desktop' | 'guest' | 'web'
  /** 是否显示「开发预览环境」提示条（仅「非桌面 且 dev」时） */
  showDevHint: boolean
}

/**
 * 判定「数据坞」怎么呈现。
 *
 * 🔴 判据（`DESKTOP` / `PORTABLE` / `WEB` 的关系见 `lib/app/platform.ts`）：
 *   · 整块是否渲染 —— 桌面 / 便携 / 网页 / dev 预览任一成立即渲染
 *     （dev 也渲染是为了能在浏览器里验界面；曾排查过一次「左下角同步设置消失」就是漏了它）；
 *     全不成立（未知运行环境）→ 不渲染，避免出现「点了没反应」的死控件。
 *   · 存储行渲染哪条 —— **网页优先**：网页版的云端模式同时具有 `PORTABLE`（复用它那套 HTTP StoreOps），
 *     若先判便携就会显示出「便携数据文件 ./data/xxx.json」这种在云端根本不存在的路径；
 *     其次便携（无 electron 桥，走桌面条会失败）；其次游客（数据在浏览器 IndexedDB）；否则桌面。
 *   · dev 提示 —— 仅在「非桌面 且 非网页 且 dev」时出现（网页/游客都是正式形态，不该被当成开发预览）。
 *
 * 🔴 2026-10-18 新增 `web` / `guest` 两个分支（网页版上线）：
 *    在此之前网页两种模式都会落进 `portable` 或「不渲染」——前者文案全错，后者没有导出入口。
 */
export function decideDataDockView(flags: {
  desktop: boolean
  portable: boolean
  /** 网页版（云端账号 或 游客），来自 `lib/app/platform` 的 `WEB` */
  web?: boolean
  /** 网页版游客模式（数据在 IndexedDB）。可选，缺省 false */
  guest?: boolean
  dev: boolean
}): DataDockView {
  const { desktop, portable, web = false, guest = false, dev } = flags
  return {
    render: desktop || portable || web || guest || dev,
    storageBar: web ? (guest ? 'guest' : 'web') : portable ? 'portable' : guest ? 'guest' : 'desktop',
    showDevHint: !desktop && !web && !guest && dev,
  }
}
