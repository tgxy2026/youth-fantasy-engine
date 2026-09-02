// 运行环境识别：三端（网页 / 便携 / 桌面）由构建期 define + 运行时探测共同决定。
// - PORTABLE：构建期 __PORTABLE__ 注入（便携单文件版）
// - DESKTOP：运行时探测 window.electronStore 是否被 preload 注入（Electron 安装版）
// - WEB：构建期 __WEB__ 注入，仅 vite.config.web.ts 为 true
//
// ⚠️ WEB 绝不可写成 `!PORTABLE && !DESKTOP`：
//    dev 在纯浏览器里跑时 PORTABLE / DESKTOP 同为 false，会被误判成网页体验版，
//    连带三处受害 —— ① 邀请码门禁拦住开发入口；② AI 请求被改写到 dev 上不存在的
//    /api/ai 反代导致 AI 功能失效；③ 误触发云端同步自动初始化去连服务器。
//    三端必须靠显式标志区分，不能靠取反猜。
import { PORTABLE, APP_VERSION, APP_VERSION_LABEL } from './portable'
import { DESKTOP } from './desktop'

declare const __WEB__: boolean | undefined

/** 是否为网页体验版（邀请制 + AI 反代 + 云端同步）：dev / 桌面 / 便携 恒为 false */
export const WEB: boolean = typeof __WEB__ === 'undefined' ? false : __WEB__

export { PORTABLE, DESKTOP, APP_VERSION, APP_VERSION_LABEL }
