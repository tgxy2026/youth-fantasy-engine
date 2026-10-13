// 桌面版 · 云盘文件中转同步（#031 引入，#032 起选目录即用）
//
// 本模块**完全不依赖我们的服务器**：数据以加密文件落在用户选定的云盘同步目录
// （OneDrive / WPS 云盘 / 百度网盘 / 坚果云 等），由对应客户端负责跨设备搬运。
// 这是本项目唯一的跨设备同步途径（网页版服务器同步已于 2026-09-15 下线）。
//
// 传输层：选目录走原生对话框（preload 注入的 window.electronStore.chooseSyncDir），
// 文件读写经 IPC 桥（syncRead/syncWrite）到主进程 fs —— 渲染进程 nodeIntegration=false，无法 require('fs')。
//
// 加密 / 载荷 / rev 合并 / #030 空推防护 / 三路合并 全部复用 syncCore.createCloudStore。
import type { StoreOps } from '@/lib/storage/storeOps'
import {
  createCloudStore,
  type CloudStoreInstance,
  type SyncStatus,
  type SyncConflictInfo,
  type CloudBackupMeta,
  CloudAuthError,
  CONFLICT_KEY_PREFIX,
  isExcludedMetaKey,
  type SyncStores,
} from '@/lib/sync/syncCore'
import {
  createFileTransport,
  createIdleTransport,
  DEFAULT_CLOUD_KEY,
  CLOUD_FILE_NAME,
  type SyncDirHandle,
  type ElectronStoreBridge,
} from '@/lib/sync/syncTransport'
import { createWebdavTransport, type WebdavConfig } from '@/lib/sync/webdavTransport'
import { createS3Transport, type S3Config } from '@/lib/sync/s3Transport'
import { DESKTOP } from '@/lib/app/env'

// #032：常量已下沉到 syncTransport（网页版云盘模式也要用），此处 re-export 保持调用方不变。
export { DEFAULT_CLOUD_KEY, CLOUD_FILE_NAME }
export type { SyncDirHandle }
export type { WebdavConfig, S3Config }

/** 云盘文件同步门控开关（桌面版唯一形态；网页版服务器同步已下线）。 */
export const CLOUD_FILE_SYNC = DESKTOP

// ============ 传输模式（3.0.2 · 私人网盘 / NAS 同步）============
/**
 * 三档传输模式：
 *  - 'dir'    目录中转（原有形态）：加密 .yfe 落在本地同步目录，由网盘客户端搬运
 *  - 'webdav' WebDAV 直连（新增）：直接读写私人网盘 / NAS 上的一个文件
 *  - 's3'     S3 兼容直连（新增）：MinIO / R2 / OSS / COS 等对象存储
 */
export type SyncMode = 'dir' | 'webdav' | 's3'

const DIR_KEY = 'yfe-desktop-cloud-dir' // 桌面：目录路径字符串（mode='dir'）
const ENABLED_KEY = 'yfe-desktop-cloud-on' // 是否已开启云盘同步（布尔标记）
const MODE_KEY = 'yfe-desktop-cloud-mode' // 传输模式（缺省视为 'dir'，向后兼容旧用户）
// 🔴 私有网盘配置（含密码 / SecretKey）存 **localStorage**，与 DIR_KEY 同层：
//    ① 它天然「本机专属」——localStorage 从不进同步载荷（syncCore 只搬 IndexedDB/整库 JSON 的 store），
//       比「存 meta + 加排除表」更省事且更难漏（漏了排除列表就是把网盘密码传给所有同步端）。
//    ② 也避免了 db 层的循环依赖（曾用 db/meta 触发 core → desktopCloudSync → meta → core 成环）。
//    ③ 安全边界与 aiProviders（存整库 JSON 的明文）同级：都是本机明文，本就不比 localStorage 更安全。
const WEBDAV_KEY = 'yfe-sync-webdav' // JSON: { baseUrl, remotePath, username, password }
const S3_KEY = 'yfe-sync-s3' // JSON: { endpoint, bucket, objectKey, region, accessKey, secretKey, style }

function readJson<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key)
    return s ? (JSON.parse(s) as T) : null
  } catch {
    return null
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 忽略配额/隐私模式错误 */
  }
}

// 用一个占位 transport 创建实例（未开启同步前一切操作都按「不可用」上报），
// 真正的 FileTransport 在用户选目录后通过 setTransport 替换。
const cloud: CloudStoreInstance = createCloudStore(createIdleTransport())

/** 桌面/便携版云端同步 StoreOps（db/core.ts 的 desktopCloudFileStore 包装层会在此之上做本地回退）。 */
export const desktopCloudStore: StoreOps = cloud.store

export function getDesktopCloudStatus(): SyncStatus {
  return cloud.getStatus()
}
export function isDesktopCloudUnavailable(): boolean {
  return cloud.isCloudUnavailable()
}
export function getDesktopCloudBackupMeta(): CloudBackupMeta | null {
  return cloud.getCloudBackupMeta()
}
export async function restoreDesktopFromCloudBackup(): Promise<boolean> {
  return cloud.restoreFromCloudBackup()
}
export async function pullDesktopSnapshot() {
  return cloud.pullSnapshot()
}
export async function seedDesktopFromLocal(getAll: (store: string) => Promise<unknown[]>) {
  return cloud.seedFromLocal(getAll)
}
/**
 * 立即把云盘同步内存里**未推送的改动**推出去（不等防抖）。
 * 关闭同步前必须调用 —— 否则 `configure('')` 清空 cache，这批改动就没了。
 */
export async function flushDesktopCloud(): Promise<void> {
  return cloud.flushNow()
}
/**
 * 云盘同步内存 cache 的快照（store 名 → 行数组）。
 * 关闭同步前用它把云端数据镜像进本地库，避免切回后界面读到「启用同步之前的陈旧本地库」。
 */
export function snapshotDesktopCloudCache(): SyncStores {
  return cloud.getCacheSnapshot()
}
export function onDesktopSyncConflict(h: (info: SyncConflictInfo) => void) {
  cloud.onSyncConflict(h)
}

/**
 * 注册「云盘推不出去时的本地兜底」。由 db.ts 在初始化时接上：
 * 回调收到当前内存 cache（store 名 → 行数组），负责把它镜像进本地存储，避免关窗丢稿。
 */
export function onDesktopCloudFallback(h: (cache: SyncStores) => void) {
  cloud.onFallback(h)
}

/**
 * 注册「读本地库快照」。启动合并（`ensureInit`）需要它来判断
 * 「本机删掉了某记录」还是「本机还没见过它」—— 详见 syncCore 的 onLocalSnapshot。
 */
export function onDesktopLocalSnapshot(h: () => Promise<SyncStores>) {
  cloud.onLocalSnapshot(h)
}

/** 是否已启用（持久化过开启标记）。#032 起不再需要任何凭据，只认开启标记 + 目录。 */
export function isDesktopCloudEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

/** 当前传输模式（缺省 'dir'，向后兼容仅用过目录中转的旧用户）。 */
export function getDesktopCloudMode(): SyncMode {
  try {
    const m = localStorage.getItem(MODE_KEY)
    return m === 'webdav' || m === 's3' ? m : 'dir'
  } catch {
    return 'dir'
  }
}

// ============ 私有网盘配置（存 localStorage，本机专属、天然不进同步载荷）============
export async function getWebdavConfig(): Promise<WebdavConfig | null> {
  const c = readJson<WebdavConfig>(WEBDAV_KEY)
  return c && c.baseUrl ? c : null
}
export async function saveWebdavConfig(cfg: WebdavConfig): Promise<void> {
  writeJson(WEBDAV_KEY, cfg)
}
export async function getS3Config(): Promise<S3Config | null> {
  const c = readJson<S3Config>(S3_KEY)
  return c && c.endpoint && c.bucket ? c : null
}
export async function saveS3Config(cfg: S3Config): Promise<void> {
  writeJson(S3_KEY, cfg)
}
/** 清除私有网盘配置（关闭同步 / 更换模式时调用，避免凭据留在本地）。 */
export async function clearRemoteConfig(): Promise<void> {
  writeJson(WEBDAV_KEY, null)
  writeJson(S3_KEY, null)
}

/** 当前同步目标的展示名（供 UI 显示）。 */
export async function getDesktopCloudTargetName(): Promise<string | null> {
  const mode = getDesktopCloudMode()
  if (mode === 'webdav') {
    const c = await getWebdavConfig()
    if (!c) return null
    try {
      return 'WebDAV · ' + new URL(c.baseUrl).host
    } catch {
      return 'WebDAV'
    }
  }
  if (mode === 's3') {
    const c = await getS3Config()
    return c ? 'S3 · ' + c.bucket : null
  }
  return getDesktopCloudDirName()
}

/** 当前同步目录的展示名（取路径末段）。无则返回 null。 */
export async function getDesktopCloudDirName(): Promise<string | null> {
  try {
    const dir = localStorage.getItem(DIR_KEY)
    if (!dir) return null
    return dir.split(/[\\/]/).filter(Boolean).pop() || dir
  } catch {
    return null
  }
}

/**
 * 选择同步文件夹（桌面：原生对话框经 IPC 返回目录路径字符串）。
 * 返回 { handle, name }，handle 用于构造 FileTransport。
 */
export async function chooseDesktopCloudDir(): Promise<{ handle: SyncDirHandle; name: string } | null> {
  const path = await (window as { electronStore?: ElectronStoreBridge }).electronStore?.chooseSyncDir?.()
  if (typeof path === 'string' && path) {
    return { handle: path, name: path.split(/[\\/]/).filter(Boolean).pop() || path }
  }
  return null
}

/**
 * 开启云盘文件同步（#032：选目录即开；3.0.2：目录 / WebDAV / S3 三档共用）。
 * 传输层按 mode 指向不同后端，加密一律走内置默认密钥（DEFAULT_CLOUD_KEY），两端一致即可互通。
 * @param handle mode='dir' 时为目录句柄；其余模式传 null（传输层由配置构造）
 * @param mode 传输模式，默认 'dir'
 */
export async function enableDesktopCloud(handle: SyncDirHandle | null, mode: SyncMode = 'dir') {
  if (mode === 'webdav') {
    const cfg = await getWebdavConfig()
    if (!cfg) throw new Error('WebDAV 配置缺失，请先填写并测试连接')
    cloud.setTransport(createWebdavTransport(cfg))
  } else if (mode === 's3') {
    const cfg = await getS3Config()
    if (!cfg) throw new Error('S3 配置缺失，请先填写并测试连接')
    cloud.setTransport(createS3Transport(cfg))
  } else {
    if (!handle) throw new Error('同步目录未选择')
    cloud.setTransport(createFileTransport(handle, CLOUD_FILE_NAME))
  }
  cloud.configure(DEFAULT_CLOUD_KEY)
}

/**
 * 持久化「已开启」标记与同步目标 / 模式。
 *
 * 🔴 必须等**快照校验 + 播种全部成功之后**才调用（由 db/core.ts 的 enableDesktopCloudSync 负责）。
 *    原先这两行就写在 enableDesktopCloud 里，而它是在拉快照 / 播种**之前**执行的 ——
 *    后两步失败时标记已经落盘，下次启动 UI 仍显示「已开启」，实际却走本地存储。
 */
export function persistDesktopCloudEnabled(handle: SyncDirHandle | null, mode: SyncMode = 'dir') {
  try {
    if (DESKTOP && typeof handle === 'string' && handle) {
      localStorage.setItem(DIR_KEY, handle)
    }
    localStorage.setItem(MODE_KEY, mode)
    localStorage.setItem(ENABLED_KEY, '1')
  } catch {
    /* 持久化失败不阻断启用，仅下次启动需重选 */
  }
}

/**
 * 只清「已开启」标记（**保留**目录偏好）。
 *
 * 🔴 启动时若云端为空 / 拉不到快照，db.ts 会保持本地存储 —— 那时必须调它：
 *    否则 localStorage 里还留着「已开启」，界面显示「已开启（待命）」而 ops 其实是本地，
 *    用户以为在同步、实际一条都没传（网盘只在线、还没把 .yfe 下载下来时最常见）。
 */
export function clearDesktopCloudEnabledFlag() {
  try {
    localStorage.removeItem(ENABLED_KEY)
  } catch {
    /* 忽略 */
  }
}

/** 关闭云盘文件同步：清持久化 + 复位传输层。私有网盘模式一并清凭据（安全不留残留）。 */
export function disableDesktopCloud() {
  const mode = getDesktopCloudMode()
  try {
    localStorage.removeItem(ENABLED_KEY)
    localStorage.removeItem(DIR_KEY)
    localStorage.removeItem(MODE_KEY)
  } catch {
    /* 忽略 */
  }
  cloud.setTransport(createIdleTransport())
  cloud.configure('')
  // 🔴 私有网盘模式下必须清掉存本地的凭据（密码 / secretKey）—— 关闭同步后不该再留着。
  if (mode === 'webdav' || mode === 's3') void clearRemoteConfig()
}

/**
 * 启动时按持久化恢复传输层（3.0.2：目录 / WebDAV / S3 三档）。
 * 成功返回 true（db.ts 据此切到云端存储）。
 */
export async function applyDesktopCloudFromPersisted(): Promise<boolean> {
  if (!isDesktopCloudEnabled()) return false
  const mode = getDesktopCloudMode()
  if (mode === 'webdav') {
    const cfg = await getWebdavConfig()
    // 🔴 配置丢了（meta 被清 / 损坏）却还留着「已开启」标记时**必须清标记**：
    //    否则界面显示「已开启（待命）」而 ops 其实是本地库 —— 用户以为在同步、实际一条都没传。
    if (!cfg) { clearDesktopCloudEnabledFlag(); return false }
    cloud.setTransport(createWebdavTransport(cfg))
    cloud.configure(DEFAULT_CLOUD_KEY)
    return true
  }
  if (mode === 's3') {
    const cfg = await getS3Config()
    if (!cfg) { clearDesktopCloudEnabledFlag(); return false }
    cloud.setTransport(createS3Transport(cfg))
    cloud.configure(DEFAULT_CLOUD_KEY)
    return true
  }
  // mode === 'dir'（含旧用户缺省）
  let handle: SyncDirHandle | null = null
  if (DESKTOP) {
    try {
      const dir = localStorage.getItem(DIR_KEY)
      if (dir) handle = dir
    } catch {
      /* 忽略 */
    }
  }
  // 🔴 目录偏好丢了（localStorage 被部分清理 / 损坏）却还留着「已开启」标记时**必须清标记**：
  //    否则界面显示「已开启（待命）」而 ops 其实是本地库 —— 用户以为在同步、实际一条都没传。
  //    （审计 2026-09-17 P2-10）
  if (!handle) { clearDesktopCloudEnabledFlag(); return false }
  cloud.setTransport(createFileTransport(handle, CLOUD_FILE_NAME))
  cloud.configure(DEFAULT_CLOUD_KEY)
  return true
}

// —— 共享符号 re-export，便于 db.ts/UI 统一引用 ——
export { CONFLICT_KEY_PREFIX, isExcludedMetaKey, CloudAuthError }
export type { SyncStatus, SyncConflictInfo, CloudBackupMeta }
