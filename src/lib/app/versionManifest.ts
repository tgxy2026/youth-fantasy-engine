// ============ 版本清单（version.json）· 纯函数层 ============
//
// 【为什么要有自建清单】原来版本源只有 Gitee 公开 API 一条路：
//   ① 匿名调用有 403 限流（见 versionCheck.ts 顶部注释），密集调用就查不到；
//   ② 只能拿到「安装包直链」，没有体积与摘要 ⇒ 下载完无法验完整性
//      （`electron/updateDownload.cjs` 现在只比 content-length，注释里已如实写明）。
// 自建清单补的就是这两点：**可摘要校验**、**可换托管**，Gitee 原样保留做兜底。
//
// 【本文件只做解析，不联网】取数在 versionCheck.ts，便于这里全用纯函数钉住结构。
//
// 🔴 三条硬口径（改动前先读）：
//   ① **绝不抛**。清单是外部输入（可能被 CDN 改、被中间人截断、被手填错），
//      任何字段异常一律返回 null 或退回默认值，让上层静默回落到 Gitee —— 更新检查不能把 App 弄崩。
//   ② **未知 kind 忽略**。以后加新产物类型（如 Linux AppImage）时，旧客户端必须安静跳过，
//      而不是把整份清单判废、连带丢掉本来认识的 Setup.exe。
//   ③ **`sha256` 缺失是"未校验"，不是"清单坏了"**。发布脚本会强制生成摘要，
//      但客户端必须容忍缺失/格式非法 —— 否则一份手改过的清单会让作者连下载按钮都点不到。
//      缺失时如实标 `unverified`（界面文案见 UpdateDialog：「未校验（清单未提供摘要）」）。
import type { LatestRelease } from '@/lib/app/versionCheck'
import { GITEE_RELEASES_URL, WEB_APP_URL } from '@/lib/app/downloadLinks'

/**
 * 清单地址：随网页版一起部署（`scripts/release-version-manifest.mjs` 写 `dist/version.json`）。
 *
 * 🔴 与网页版同域有实际好处：桌面版/便携版读取时若被墙或断网，回落 Gitee 仍然有效；
 *    而网页版本身能打开就说明域名可达，清单几乎必定能取到。
 */
export const VERSION_MANIFEST_URL = `${WEB_APP_URL}/version.json`

/**
 * 认识的产物类型。**这份集合是"契约"，不是"清单能写什么"**：
 * 清单里写别的 kind 不会被报错，只会被这里忽略（口径②）。
 */
export type ManifestAssetKind = 'win-setup' | 'portable-win' | 'portable-unix'

const KNOWN_KINDS: readonly string[] = ['win-setup', 'portable-win', 'portable-unix'] satisfies ManifestAssetKind[]

/** 单个产物的字段上限：防止被塞进超长串（解析本身仍不会崩，只是别让它进内存放大） */
const MAX_NAME = 260
const MAX_URL = 2048
const MAX_SHA = 64

export interface ManifestAsset {
  kind: string
  /** 文件名（展示用；缺失为空串，不阻断） */
  name: string
  /** 字节数；未知为 0（0 只表示"没给"，不能当成"空文件"来判定） */
  size: number
  /** 小写 64 位十六进制；**空串 = 清单未提供摘要**（可下载，界面标"未校验"） */
  sha256: string
  /** 下载直链；缺失该产物会被丢弃（没有 url 的 asset 无意义） */
  url: string
}

export interface VersionManifest {
  /** 清单格式版本（必填正整数） */
  schema: number
  /** 三段式版本号（必填，`v` 前缀会被去掉） */
  version: string
  /** 发布时刻（ISO 字符串，原样保留；不参与判定，取不到为空串） */
  releasedAt: string
  /** 发布通道（`stable` 等；不校验取值，未知原样保留便于排障） */
  channel: string
  /**
   * 最低可支持版本。**当前不参与"是否提示更新"的判定**，只作为信息字段展示/预留；
   * 非法值一律视为未设置（空串），避免拿坏字符串去做比较。
   */
  minSupported: string
  /** 更新说明页（缺省回落 Gitee Release 页） */
  notesUrl: string
  /** 网页版构建标识（用于"有新版本，刷新以应用"；缺省空串） */
  webBuildId: string
  /** 已知产物；可为空数组（此时只能给下载页） */
  assets: ManifestAsset[]
}

/* ---------------- 小工具 ---------------- */

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s)

/** 版本标准化：与 `versionCheck.normalizeVersion` 同语义（这里不 import 它是为了不产生循环依赖） */
function normalizeVer(raw: unknown): string | null {
  const s = asString(raw).trim().replace(/^v/i, '')
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

/**
 * 摘要标准化：只认 64 位 hex（大小写皆可，统一转小写）。
 * 其它一律返回空串 = "未提供"。**不抛、不猜、不截断补零**。
 */
export function normalizeSha256(raw: unknown): string {
  const s = asString(raw).trim()
  if (s.length !== MAX_SHA) return ''
  if (!/^[0-9a-fA-F]{64}$/.test(s)) return ''
  return s.toLowerCase()
}

/* ---------------- 解析 ---------------- */

/**
 * 解析清单。**结构不符返回 null，绝不抛**（口径①）。
 *
 * 判定顺序刻意是"由外到内"：先看这是不是一份清单（schema / version / assets），
 * 再逐条筛产物；单个产物不合法只丢弃该条，不牵连整份清单 —— 否则
 * "某个便携包漏了 url" 会导致作者连 Setup 都下不了。
 */
export function parseVersionManifest(raw: unknown): VersionManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>

  const schema = typeof o.schema === 'number' ? o.schema : NaN
  if (!Number.isInteger(schema) || schema <= 0) return null

  const version = normalizeVer(o.version)
  if (!version) return null

  if (!Array.isArray(o.assets)) return null

  const assets: ManifestAsset[] = []
  const seen = new Set<string>()
  for (const item of o.assets) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const a = item as Record<string, unknown>
    const kind = asString(a.kind).trim()
    const url = clip(asString(a.url).trim(), MAX_URL)
    // 未知 kind 忽略（口径②）；没有直链的产物无法下载，一并丢掉
    if (!KNOWN_KINDS.includes(kind) || !url) continue
    // 重复 kind 取第一个：清单是人工/脚本生成的，重复多半是误贴，先到先得比"最后一个覆盖"更可预期
    if (seen.has(kind)) continue
    seen.add(kind)
    const size = typeof a.size === 'number' && Number.isFinite(a.size) && a.size >= 0 ? Math.floor(a.size) : 0
    assets.push({
      kind,
      name: clip(asString(a.name).trim(), MAX_NAME),
      size,
      sha256: normalizeSha256(a.sha256),
      url,
    })
  }

  return {
    schema,
    version,
    releasedAt: clip(asString(o.releasedAt).trim(), 64),
    channel: clip(asString(o.channel).trim(), 32),
    // minSupported 非法 → 视为未设置（不是把坏值往下传）
    minSupported: normalizeVer(o.minSupported) ?? '',
    notesUrl: clip(asString(o.notesUrl).trim(), MAX_URL),
    webBuildId: clip(asString(o.webBuildId).trim(), 128),
    assets,
  }
}

/** 按类型取产物；不认识/没有 → null */
export function pickAsset(m: VersionManifest, kind: ManifestAssetKind): ManifestAsset | null {
  return m.assets.find(a => a.kind === kind) ?? null
}

/**
 * 适配现有 `LatestRelease` 形状，**界面与调用方不用改**（W1 的兼容点）。
 *
 * 取舍：
 * - `body` 只能为空串 —— 清单不承载更新说明（那本来就在 Release 页里），
 *   弹窗遇到空说明会走它自己的"去 Release 页看"路径。
 * - `releaseUrl` 优先用清单的 `notesUrl`，缺省回落 Release 页。
 * - `downloadUrl` 只取 `win-setup`：桌面版能自己安装的只有安装包，
 *   便携包要作者自己解压，不能塞进"自动下载"按钮。
 */
export function manifestToLatestRelease(m: VersionManifest): LatestRelease {
  const setup = pickAsset(m, 'win-setup')
  return {
    version: m.version,
    name: `v${m.version}`,
    body: '',
    downloadUrl: setup?.url ?? '',
    releaseUrl: m.notesUrl || GITEE_RELEASES_URL,
    // 摘要缺失就是空串（未校验）；这里不做任何"猜一个"的补救
    sha256: setup?.sha256 ?? '',
    assetName: setup?.name ?? '',
  }
}
