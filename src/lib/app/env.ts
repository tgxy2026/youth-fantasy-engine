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
import { DESKTOP } from '@/lib/app/desktop'

declare const __APP_VERSION__: string | undefined
declare const __BUILD_TIME__: string | undefined
declare const __BUILD_ID__: string | undefined

/** 应用版本号，由构建时 define 注入（取自 package.json）；dev / 未注入时回退到「开发版」 */
const APP_VERSION: string = typeof __APP_VERSION__ === 'undefined' ? '开发版' : __APP_VERSION__

/**
 * 版本号展示文本：正式版为 `v3.0.1`，回退态为「开发版」（**不带 v 前缀**）。
 * 各 UI（关于页 / 侧栏 / 项目中心）一律用它，避免各自 `v{APP_VERSION}` 拼出「v开发版」。
 */
export const APP_VERSION_LABEL: string = APP_VERSION === '开发版' ? '开发版' : `v${APP_VERSION}`

/**
 * 构建时间（ISO 串，3.6.2 起注入）。未注入时为空串 —— **不要回退成 `new Date()`**，
 * 那会让"构建于"变成"打开于"，排障时反而误导。
 */
export const APP_BUILD_TIME: string = typeof __BUILD_TIME__ === 'undefined' ? '' : __BUILD_TIME__

/**
 * 构建标识（可选，发版脚本经 `YFE_BUILD_ID` 注入）。空串 = 未知。
 * ⚠️ 与线上 `/BUILD_ID` 不是一回事（后者是部署核对凭据，不对外），别拿来判断"有没有新版"。
 */
export const APP_BUILD_ID: string = typeof __BUILD_ID__ === 'undefined' ? '' : __BUILD_ID__

/**
 * 把 ISO 构建时间格式化成 `2026-12-05 20:00`（本地时区）。
 * 非法/空值返回「未知」——关于页宁可写"未知"也不显示 `Invalid Date`。
 *
 * 🔴 纯函数，单独导出是为了能单测：关于页那行文案是**用户排障时唯一能提供的构建信息**，
 *    它显示错了等于把人往错误方向带。
 */
export function formatBuildTime(raw: string): string {
  const s = (raw || '').trim()
  if (!s) return '未知'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return '未知'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export { DESKTOP }
