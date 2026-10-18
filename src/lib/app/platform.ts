// ============ 运行平台判定（三形态分开管理） ============
//
// 本应用现在有三种**正式**运行形态，界面文案必须各说各话：
//   · 桌面版（DESKTOP）—— Electron 安装版，数据在本机 JSON 文件，有安装器与自动更新
//   · 便携版（PORTABLE）—— U 盘自包含目录，数据在同目录 ./data，无安装器
//   · 网页版（WEB）—— 服务器托管，数据在云端账号（WEB_CLOUD）或浏览器本地（WEB_GUEST）
//
// 🔴 硬约束：**三者互不干扰**。改网页版文案时，桌面版与便携版的呈现必须逐字不变。
//    所以这里的约定是「默认走原文案，只有 WEB 为真时才替换」——
//    而不是反过来把原文案改成通用措辞（那样会悄悄改变另外两端的口径）。
//
// 🔴 判定来源（全部由服务端 / preload 在**模块求值前**注入，晚一步就永远读到 false）：
//    · `__YFE_WEB__`      —— 网页版（服务端注入，两种模式都注入）
//    · `__YFE_PORTABLE__` —— 便携版（便携服务注入）/ 网页版的**云端模式**（服务端注入，复用其 HTTP StoreOps）
//    · `__YFE_GUEST__`    —— 网页版的**游客模式**（数据在浏览器 IndexedDB，不写服务器）

interface WebFlags {
  __YFE_WEB__?: boolean
  __YFE_GUEST__?: boolean
}

const flags = (typeof window !== 'undefined' ? window : {}) as unknown as WebFlags

/** 是否运行在网页版（云端账号模式或游客模式，两者都为真） */
export const WEB: boolean = !!flags.__YFE_WEB__

/** 是否运行在网页版的游客模式（数据只在浏览器本地） */
export const WEB_GUEST: boolean = !!flags.__YFE_GUEST__

/**
 * 是否运行在网页版的**云端账号**模式（数据在服务器，按账号隔离）。
 * ⚠️ 此时 `PORTABLE` 也为真（服务端注入了 `__YFE_PORTABLE__` 以复用便携版的 HTTP StoreOps），
 *    所以任何 `PORTABLE ? ... : ...` 的分支在网页版里都必须**先判 WEB**，否则会显示成便携版。
 */
export const WEB_CLOUD: boolean = !!flags.__YFE_WEB__ && !flags.__YFE_GUEST__

/**
 * 取当前平台的称呼，用于文案里的「某某版」。
 * @example `${platformLabel()}不提供在线更新`
 */
export function platformLabel(): string {
  if (WEB) return '网页版'
  return '便携版'
}
