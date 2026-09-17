// 运行环境识别与版本号 —— 全应用统一出口。
//
// 本项目自 2026-09-15 起**只发布桌面版**（Electron 安装版），网页版与便携版已下线。
// - DESKTOP：运行时探测 `window.electronStore` 是否被 preload 注入。
//
// 🔴 关于 DESKTOP 是「运行时探测」而非构建期常量这件事，务必记住：
//    它在 dev 浏览器里**恒为 false**，于是所有「只在桌面版显示」的 UI 在 dev 预览里
//    都不会出现。这是预期行为，不是 bug（排查过一次"左下角同步设置消失"就是它）。
//
// ⚠️ 历史教训（虽然 WEB 已删，判定原则仍适用）：曾经的 WEB 绝不能写成
//    `!PORTABLE && !DESKTOP` —— dev 在纯浏览器里跑时两者同为 false，会被误判成
//    网页体验版，连带三处受害：① 邀请码门禁拦住开发入口；② AI 请求被改写到 dev 上
//    不存在的 /api/ai；③ 误触发云端同步去连服务器。**平台判定永远靠显式标志，不能靠取反猜。**
import { DESKTOP } from './desktop'

declare const __APP_VERSION__: string | undefined

/** 应用版本号，由构建时 define 注入（取自 package.json）；dev / 未注入时回退到「开发版」 */
const APP_VERSION: string = typeof __APP_VERSION__ === 'undefined' ? '开发版' : __APP_VERSION__

/**
 * 版本号展示文本：正式版为 `v2.1.4`，回退态为「开发版」（**不带 v 前缀**）。
 * 各 UI（关于页 / 侧栏 / 项目中心）一律用它，避免各自 `v{APP_VERSION}` 拼出「v开发版」。
 */
export const APP_VERSION_LABEL: string = APP_VERSION === '开发版' ? '开发版' : `v${APP_VERSION}`

export { DESKTOP }
