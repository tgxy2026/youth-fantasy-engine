// ============ 应用内「检查更新」 ============
//
// 版本源 = Gitee 公开 API（**匿名可查、无需令牌、无需自建服务器**）：
//   GET https://gitee.com/api/v5/repos/tgxy2026/youth-fantasy-engine/releases/latest
//   返回 tag_name / name / body（更新说明 markdown）/ assets（含安装包直链）
//
// 🔴🔴 口径（2026-10-07 修订 · 主人拍板）—— **检查更新只查版本号，决定权永远在作者手上**：
//   ① **只发一个 GET、不带任何用户数据** —— 不上传项目名、机器信息、使用统计。
//   ② **自动检查绝不下载任何东西**（只比版本、只弹提示）。**下载必须由作者点按钮触发**，
//      且有进度、可取消、不静默安装（安装向导由作者自己点完）——
//      实现见 components/UpdateDialog.tsx 与 electron/updateDownload.cjs。
//   ③ **失败一律静默** —— 断网、限流、解析失败都不弹错误框骚扰作者；
//      只有「手动点检查更新」这一条路才允许回一句轻提示（见 checkUpdate 的 manual 参数）。
//
// 🔴 请求走 desktop.ts 的 fetch 桥（主进程 net.fetch，无 CORS 限制，且跟随用户配置的代理）；
//    浏览器 dev 环境没有桥 → 降级 window.fetch（Gitee 响应头带 Access-Control-Allow-Origin: *）。
import { APP_VERSION_LABEL } from '@/lib/app/env'
import { GITEE_RELEASES_URL } from '@/lib/app/downloadLinks'
import { HAS_NET_BRIDGE, netFetch } from '@/lib/app/desktop'
import { readBoolPref, readStringPref, writeBoolPref, writeStringPref } from '@/lib/settings/uiPrefs'

/** Gitee 最新 Release 查询（公开仓库，匿名可用） */
const LATEST_API = 'https://gitee.com/api/v5/repos/tgxy2026/youth-fantasy-engine/releases/latest'

export interface LatestRelease {
  /** 版本串（去 v 前缀），如 2.6.3 */
  version: string
  /** Release 标题 */
  name: string
  /** 更新说明（Gitee 上的 markdown 原文） */
  body: string
  /** 安装包直链（assets 里挑 Setup.exe）；找不到则为空串 */
  downloadUrl: string
  /** Release 页（直链打不开时的兜底） */
  releaseUrl: string
}

/* ---------------- 版本解析与比较 ---------------- */

/**
 * 解析版本串：`v2.6.3` / `2.6.3` / `2.6.3-beta` → `2.6.3`
 * 非法输入返回 null（调用方据此跳过，不猜）。
 */
export function normalizeVersion(raw: string): string | null {
  const s = (raw ?? '').trim().replace(/^v/i, '')
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

/**
 * 语义化比较：a > b → 1；a === b → 0；a < b → -1；任一侧非法 → null。
 * 🔴 必须逐段按数字比较：字符串比较会把 2.6.10 判成小于 2.6.2（"10" < "2"）。
 */
export function compareVersion(a: string, b: string): number | null {
  const pa = normalizeVersion(a)?.split('.').map(Number)
  const pb = normalizeVersion(b)?.split('.').map(Number)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

/* ---------------- 偏好：自动检查开关 / 跳过此版本 / 节流 ---------------- */

const KEY_AUTO = 'update-auto-check'
const KEY_SKIP = 'update-skip-version'
const KEY_LAST = 'update-last-check'

/** 自动检查开关：**默认开**（主人哥哥 2026-09-30 拍板） */
export function isAutoCheckOn(): boolean {
  return readBoolPref(KEY_AUTO, true)
}
export function setAutoCheck(on: boolean): void {
  writeBoolPref(KEY_AUTO, on)
}

/** 被「跳过此版本」点掉的版本（该版本不再提示） */
function getSkippedVersion(): string | null {
  return readStringPref(KEY_SKIP)
}
export function setSkippedVersion(v: string): void {
  writeStringPref(KEY_SKIP, v)
}

/** 今天是否已经自动检查过（节流：每天最多一次） */
function checkedToday(): boolean {
  return readStringPref(KEY_LAST) === new Date().toISOString().slice(0, 10)
}
function markChecked(): void {
  writeStringPref(KEY_LAST, new Date().toISOString().slice(0, 10))
}

/* ---------------- 拉取最新版本 ---------------- */

/**
 * 把主进程 `net:fetch` 桥的返回值解包成 **JSON 文本**。
 *
 * 🔴🔴 契约（见 `electron/main.cjs` 的 `net:fetch`）—— 桥返回的是**对象**，不是字符串：
 *      `{ ok: true, status, statusText, text }`  |  `{ ok: false, error }`
 *
 * 🔴 2026-10-07 修的真实事故：原先直接 `JSON.parse(await bridge.fetch(url))` ——
 *    对**对象**调 `JSON.parse` 实际解析的是 `"[object Object]"`，**必然抛错**，
 *    再被 catch 吞掉 ⇒ 恒返回 null ⇒ 界面永远显示「暂时查不到版本信息」，
 *    而且**请求成功也一样**（失败路径反而看不出来）。抽成这个纯函数是为了能被单测钉住。
 */
export function unwrapBridgeResult(r: unknown): string | null {
  if (!r || typeof r !== 'object') return null
  const o = r as { ok?: unknown; text?: unknown }
  if (o.ok !== true) return null
  return typeof o.text === 'string' ? o.text : null
}

/**
 * 拉一次 JSON。桌面版走主进程桥（绕开跨域、跟随系统代理），浏览器 dev 降级 window.fetch；
 * 失败一律返回 null（静默）。
 */
async function getJson(url: string): Promise<unknown | null> {
  try {
    if (HAS_NET_BRIDGE) {
      const r = await netFetch(url, { headers: { Accept: 'application/json' } })
      const text = unwrapBridgeResult(r)
      return text === null ? null : JSON.parse(text)
    }
    // 浏览器 dev 降级：Gitee 响应头带 Access-Control-Allow-Origin: *
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    return JSON.parse(await res.text())
  } catch {
    return null
  }
}

/** 从 assets 里挑 Windows 安装包直链（Setup.exe；源码 zip / tar.gz 不算） */
export function pickInstallerUrl(assets: unknown): string {
  if (!Array.isArray(assets)) return ''
  for (const a of assets) {
    const name = String((a as { name?: unknown })?.name ?? '')
    const url = String((a as { browser_download_url?: unknown })?.browser_download_url ?? '')
    if (name.endsWith('.exe') && url) return url
  }
  return ''
}

/**
 * 查 Gitee 上的最新 Release。
 * 🔴 失败（断网 / 限流 / 结构变了）一律返回 null —— 调用方据此什么都不做。
 */
async function fetchLatestRelease(): Promise<LatestRelease | null> {
  const raw = await getJson(LATEST_API)
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { tag_name?: unknown; name?: unknown; body?: unknown; assets?: unknown }
  const version = normalizeVersion(String(r.tag_name ?? ''))
  if (!version) return null
  return {
    version,
    name: String(r.name ?? '') || `v${version}`,
    body: String(r.body ?? ''),
    downloadUrl: pickInstallerUrl(r.assets),
    releaseUrl: GITEE_RELEASES_URL,
  }
}

/* ---------------- 对外主入口 ---------------- */

export interface CheckResult {
  /** 是否有更新（严格大于当前版本） */
  hasUpdate: boolean
  latest: LatestRelease | null
  /** 当前版本（dev 环境为「开发版」→ current 为 null） */
  current: string | null
  /** 该版本被作者点过「跳过此版本」（有更新但被跳过，不是「已是最新」） */
  skipped?: boolean
}

/**
 * 检查更新。
 * @param manual true = 用户手动点的（不受「每天一次」节流限制，且允许回提示）；
 *               false = 启动自动检查（节流 + 完全静默）
 */
export async function checkUpdate(manual: boolean): Promise<CheckResult> {
  // dev 环境 APP_VERSION_LABEL='开发版' → normalizeVersion 返回 null → 直接跳过（开发版不参与比较）
  const current = normalizeVersion(APP_VERSION_LABEL)
  if (!current) return { hasUpdate: false, latest: null, current: null }
  if (!manual && checkedToday()) return { hasUpdate: false, latest: null, current }

  const latest = await fetchLatestRelease()
  if (manual) markChecked()          // 手动查过也算查过（避免启动再查一次）
  else markChecked()
  if (!latest) return { hasUpdate: false, latest: null, current }

  const skipped = getSkippedVersion()
  if (skipped && compareVersion(latest.version, skipped) === 0) {
    return { hasUpdate: false, latest, current, skipped: true }
  }
  const cmp = compareVersion(latest.version, current)
  return { hasUpdate: cmp === 1, latest, current }
}
