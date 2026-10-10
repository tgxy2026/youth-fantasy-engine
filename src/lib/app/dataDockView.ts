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
  /** 「本机存储」行渲染哪条 */
  storageBar: 'portable' | 'desktop'
  /** 是否显示「开发预览环境」提示条（仅「非桌面 且 dev」时） */
  showDevHint: boolean
}

/**
 * 判定「数据坞」怎么呈现。
 *
 * 🔴 判据（`DESKTOP` 与 `PORTABLE` 互斥，详见各自源码注释）：
 *   · 整块是否渲染 —— 桌面 / 便携 / dev 预览三者任一成立即渲染
 *     （dev 也渲染是为了能在浏览器里验界面；曾排查过一次「左下角同步设置消失」就是漏了它）；
 *     三者都不成立（未知运行环境）→ 不渲染，避免出现「点了没反应」的死控件。
 *   · 本机存储行渲染哪条 —— **便携优先**（便携版没有 electron 桥，走桌面条会失败）；
 *     否则桌面版数据条（含 dev 预览 —— 此时按钮会走 electron 分支失败，故顶部另有提示条）。
 *   · dev 提示 —— 仅在「非桌面 且 dev」时出现（便携 / 桌面都是正式形态，不需要提示）。
 */
export function decideDataDockView(flags: {
  desktop: boolean
  portable: boolean
  dev: boolean
}): DataDockView {
  const { desktop, portable, dev } = flags
  return {
    render: desktop || portable || dev,
    storageBar: portable ? 'portable' : 'desktop',
    showDevHint: !desktop && dev,
  }
}
