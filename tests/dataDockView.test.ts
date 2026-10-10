// 3.0 · W3-3 · §11.1 L4 —— 左下角「数据坞」呈现判定四分支（数据安全组件补测）
//
// 🔴 为什么补这条（§11.1 L4 原文）：`DataDock` 是数据安全相关组件（本机存储 / 导出 / 导入入口），
//    却零组件级覆盖 —— 而它的判定内联在 JSX 里，依赖 `DESKTOP` / `PORTABLE`（运行时探测常量）
//    与 `DEV`（Vite 编译期常量），测试环境注入不了。
//
// 修法与 `DesktopWriteLockBanner`（`decideDataFileLoad`）同款：**不引入 React 测试工具**，
// 把判定抽成纯函数 `decideDataDockView`，组件照旧渲染，四分支逐条可断言。
//
// 判定要点（写错会「数据落到别处」或「看不到导入导出入口」）：
//   · 便携优先：*PORTABLE* 为真时必须用便携版数据条（便携版没有 electron 桥，走桌面条会失败）；
//   · dev 也渲染：否则界面改动无法在浏览器里验证（曾排查过一次「左下角同步设置消失」）；
//   · 两者皆非且非 dev ⇒ 不渲染（未知环境不摆死控件）。
import { decideDataDockView } from '../src/lib/app/dataDockView'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n—— dataDockView 用例开始 ——')

// ---------- ① 桌面版：渲染 + 桌面条 + 无 dev 提示 ----------
{
  const v = decideDataDockView({ desktop: true, portable: false, dev: false })
  ok('① 桌面版 ⇒ 渲染', v.render === true)
  ok('① 桌面版 ⇒ 桌面数据条', v.storageBar === 'desktop', v.storageBar)
  ok('① 桌面版 ⇒ 不显示 dev 提示', v.showDevHint === false)
}

// ---------- ② 便携版：渲染 + 便携条 + 无 dev 提示（即便同时是 dev） ----------
{
  const v = decideDataDockView({ desktop: false, portable: true, dev: false })
  ok('② 便携版 ⇒ 渲染', v.render === true)
  ok('② 便携版 ⇒ 便携数据条', v.storageBar === 'portable', v.storageBar)
  ok('② 便携版 ⇒ 不显示 dev 提示', v.showDevHint === false)
}

// ---------- ③ 便携优先：万一两标记同时为真（不该发生），必须走便携条 ----------
{
  const v = decideDataDockView({ desktop: true, portable: true, dev: false })
  ok('🔴 ③ 双真 ⇒ 便携优先（便携版没有 electron 桥）', v.storageBar === 'portable', v.storageBar)
}

// ---------- ④ dev 预览（非桌面、非便携）：仍渲染 + 桌面条兜底 + 显示 dev 提示 ----------
{
  const v = decideDataDockView({ desktop: false, portable: false, dev: true })
  ok('④ dev 预览 ⇒ 仍渲染（否则界面无法在浏览器验证）', v.render === true)
  ok('④ dev 预览 ⇒ 桌面条兜底（按钮会失败，故另给提示）', v.storageBar === 'desktop', v.storageBar)
  ok('🔴 ④ dev 预览 ⇒ 显示「开发预览环境」提示', v.showDevHint === true)
}

// ---------- ⑤ dev 提示只在「非桌面 且 dev」出现（与既有实现一致，勿擅自改口径） ----------
{
  // ⚠️ 便携 + dev 也显示提示：这与改动前的 `!DESKTOP && DEV` 口径**逐字一致** ——
  //    本抽取是「行为等价搬迁」，不是顺手改语义。若将来要收紧（便携是正式形态不必提示），
  //    须显式改 `decideDataDockView` 并把这条断言一起改掉，不允许测试与实现各走各的。
  const portableDev = decideDataDockView({ desktop: false, portable: true, dev: true })
  ok('⑤ 便携 + dev ⇒ 仍显示 dev 提示（沿用 `!DESKTOP && DEV` 口径）', portableDev.showDevHint === true)
  const desktopDev = decideDataDockView({ desktop: true, portable: false, dev: true })
  ok('⑤ 桌面 + dev ⇒ 不显示 dev 提示（桌面是正式形态）', desktopDev.showDevHint === false)
  const portableProd = decideDataDockView({ desktop: false, portable: true, dev: false })
  ok('⑤ 便携 + 非 dev ⇒ 不显示 dev 提示', portableProd.showDevHint === false)
}

// ---------- ⑥ 未知环境（三者皆非）⇒ 不渲染（不摆死控件） ----------
{
  const v = decideDataDockView({ desktop: false, portable: false, dev: false })
  ok('🔴 ⑥ 未知环境 ⇒ 不渲染', v.render === false)
}

console.log(`\n—— dataDockView 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
