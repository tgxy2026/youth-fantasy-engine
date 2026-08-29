// 运行环境识别：三端（网页 / 便携 / 桌面）由构建期 define + 运行时探测共同决定。
// - PORTABLE：构建期 __PORTABLE__ 注入（便携单文件版）
// - DESKTOP：运行时探测 window.electronStore 是否被 preload 注入（Electron 安装版）
// - WEB：既非便携也非桌面 —— 即纯网页体验版，数据存浏览器 IndexedDB，零服务端持久化
import { PORTABLE, APP_VERSION } from './portable'
import { DESKTOP } from './desktop'

export const WEB = !PORTABLE && !DESKTOP

export { PORTABLE, DESKTOP, APP_VERSION }
