// ============ 手册构建标识（3.3.1 · P4 · 规划 §4.4） ============
//
// 规划原文：「手册目录、正文和索引使用同一构建版本；网页残留旧资源导致版本不一致时，
// 停止据此生成 AI 回答，给出重新加载帮助资源的入口，并保留可读的匹配版本文章。」
//
// 为什么需要独立标记：`isHelpContentConsistent()` 只能发现**同一次加载内**目录/正文/索引
// 被改动（它拿模块初始化时的快照比对）。而「网页缓存了旧 HTML、chunk 却换成新的」这种
// 情况发生在**模块之外** —— 两边各自内部都自洽，只有拿一个跨模块的标识才能发现。
//
// 判据：HTML 里由同一次构建写入的 `<meta name="yfe-help-build">`，与 JS 包里的常量比对。
//   相等 ⇒ 同一次构建；
//   不等 ⇒ 外壳与包不同版本（旧缓存 / CDN 边缘不一致），手册可能混版本；
//   读不到 meta ⇒ 不算不一致（桌面版 file:// 与老 HTML 没有该标记，不能凭缺失就判坏）。
//
// ⚠️ 改这里的标识时先看 `vite.config.ts` 的 `injectHelpBuildMeta`：
//   dev 下 `define` 不生效，靠 transform 插件文本替换，两处必须同时覆盖本文件。

declare const __HELP_BUILD__: string | undefined

/** 本 JS 包构建时写入的标识（`3.3.1+20261030073500`；dev 未注入时为 `dev`） */
export const HELP_BUILD_ID: string = typeof __HELP_BUILD__ === 'undefined' ? 'dev' : __HELP_BUILD__

/** HTML 里承载构建标识的 meta 名（与 vite 插件一致） */
export const HELP_BUILD_META = 'yfe-help-build'

/** 读外壳（index.html）里的构建标识；没有就返回 null —— 缺失不等于不一致 */
export function readShellBuildId(doc: Document | null = typeof document === 'undefined' ? null : document): string | null {
  if (!doc) return null
  const meta = doc.querySelector(`meta[name="${HELP_BUILD_META}"]`)
  const value = meta?.getAttribute('content')?.trim() ?? ''
  return value ? value : null
}

export interface HelpBuildState {
  /** 外壳与 JS 包是否同一次构建（读不到外壳标识时按「一致」处理，见文件头） */
  aligned: boolean
  /** JS 包的构建标识 */
  bundle: string
  /** HTML 外壳的构建标识（缺失为 null） */
  shell: string | null
}

/** 判断外壳与 JS 包是否同一次构建 */
export function checkHelpBuild(doc?: Document | null): HelpBuildState {
  const shell = readShellBuildId(doc ?? (typeof document === 'undefined' ? null : document))
  return {
    aligned: shell === null || shell === HELP_BUILD_ID,
    bundle: HELP_BUILD_ID,
    shell,
  }
}

/** 手册资源版本不一致时给作者看的话：讲清「为什么停下」和「怎么办」 */
export const HELP_BUILD_MISMATCH_NOTICE =
  '手册资源版本不一致（页面外壳与内容包不是同一次加载，常见于网页版更新后没有刷新）。' +
  '为避免按旧内容回答，已停止用 AI 生成回答；下面的手册片段仍可正常阅读。' +
  '请先保存手上的改动，再点「重新加载帮助资源」。'

/** 重新加载入口的文案（界面按钮与探针共用，避免两处写不一样） */
export const HELP_RELOAD_LABEL = '重新加载帮助资源'
