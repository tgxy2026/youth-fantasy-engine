// 网页体验版 · 云端同步存储适配层（#003 云端同步特权）
// ⚠️ 本模块仅网页版（WEB）使用，且保持「WEB 门控」不变：db.ts 仅在 WEB 下挂载 serverStore。
// 实际的加密 / 载荷 / rev 合并 / #030 空推防护 / 三路合并 / 状态机已抽到 syncCore.ts（传输层无关），
// 由 createCloudStore(transport) 产出实例。本文件只是「HTTP 服务器传输」的一个薄封装层：
//   · 默认/HTTP 传输 = createHttpTransport()
//   · 云盘中转模式 = createFileTransport(handle)（由 syncTransport.applyTransportFromPersisted 切换）
// 桌面/便携版的同款能力在 desktopCloudSync.ts，走独立门控（DESKTOP || PORTABLE），不依赖本模块。
import type { StoreOps } from './portable'
import {
  createCloudStore,
  type CloudStoreInstance,
  type SyncStatus,
  type SyncConflictInfo,
  type CloudBackupMeta,
  RateLimitError,
  CloudAuthError,
  EXCLUDED_META_KEYS,
  CONFLICT_KEY_PREFIX,
  isExcludedMetaKey,
  SYNC_STORES,
  KEY_FIELD,
} from './syncCore'
import {
  createHttpTransport,
  createFileTransport,
  getSyncMode,
  loadSyncFolderHandle,
  saveSyncFolderHandle,
  clearSyncFolderHandle,
  DEFAULT_CLOUD_KEY,
  CLOUD_FILE_NAME,
  type SyncTransport,
  type RawSyncResponse,
} from './syncTransport'

// 网页版默认走现有 HTTP 服务器；createCloudStore 的 initialTransport 仅作占位，
// 真正的传输由 configureServerStore / applyTransportFromPersisted 决定。
const cloud: CloudStoreInstance = createCloudStore(createHttpTransport())

/** 网页版云端同步 StoreOps（db.ts 的 cloudStore 包装层会在此之上做本地回退）。 */
export const serverStore: StoreOps = cloud.store

/** 用专属同步邀请码登录（#003）。仅在 WEB 下由 db.ts 调用。 */
export function configureServerStore(c: string) {
  cloud.configure(c)
}

/** 拉取当前快照；码失效时抛 CloudAuthError。 */
export async function pullSnapshot() {
  return cloud.pullSnapshot()
}

/** 用本地数据播种（仅当远端为空）。 */
export async function seedFromLocal(getAll: (store: string) => Promise<any[]>) {
  return cloud.seedFromLocal(getAll)
}

/** 云端鉴权是否已失效（401）。 */
export function isCloudAuthFailed(): boolean {
  return cloud.isCloudAuthFailed()
}

/** 云端当前是否不可用（401 / 429 / 网络异常）。 */
export function isCloudUnavailable(): boolean {
  return cloud.isCloudUnavailable()
}

/** 同步状态（#008：失败必须有可见指示）。 */
export function getSyncStatus(): SyncStatus {
  return cloud.getStatus()
}

/** 云端每日备份元信息。 */
export function getCloudBackupMeta(): CloudBackupMeta | null {
  return cloud.getCloudBackupMeta()
}

/** 从云端每日备份恢复。 */
export async function restoreFromCloudBackup(): Promise<boolean> {
  return cloud.restoreFromCloudBackup()
}

/** 注册冲突处理器（两端都改同一条记录时把云端那版另存副本）。 */
export function onSyncConflict(h: (info: SyncConflictInfo) => void) {
  cloud.onSyncConflict(h)
}

/** 切换传输层（云盘文件中转 / 服务器）。 */
export function setSyncTransport(t: SyncTransport) {
  cloud.setTransport(t)
}

/** 轮询发现远端更新时主动拉取并三路合并（文件模式跨设备同步核心）。 */
export async function backgroundPull() {
  return cloud.backgroundPull()
}

/**
 * 按持久化的同步方式恢复传输层：云盘模式且存在已选目录句柄 → FileTransport，否则 HTTP。
 * #031：网页版「云盘文件中转」与「服务器」共用同一套加密/合并逻辑，仅传输层不同。
 * #032：文件模式统一用固定文件名 CLOUD_FILE_NAME（不再按码派生哈希名），用户在网盘里能认出。
 */
export async function applyTransportFromPersisted() {
  if (getSyncMode() === 'file') {
    try {
      const handle: any = await loadSyncFolderHandle()
      if (handle) {
        cloud.setTransport(createFileTransport(handle, CLOUD_FILE_NAME))
        return
      }
    } catch {
      /* 句柄读取失败 → 回退服务器 */
    }
  }
  cloud.setTransport(createHttpTransport())
}

// ============ 网页版 · 云盘文件模式（#032：无需同步码）============
// 与「服务器模式」的区别只有两点：①传输层是本地文件而非 HTTP；②密钥用内置常量而非用户输入的码。
// 因此这里不需要任何鉴权，选目录即开启。
const WEB_FILE_ON_KEY = 'yfe-web-file-sync-on'

/** 网页版云盘文件同步是否已开启。 */
export function isWebFileSyncOn(): boolean {
  try {
    return localStorage.getItem(WEB_FILE_ON_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 开启网页版云盘文件同步（选目录即开，无需同步码）。
 * 仅装配传输层与密钥；拉取/播种由 db.ts 的 enableWebCloudFileSync 负责。
 */
export async function enableWebFileCloud(handle: any) {
  cloud.setTransport(createFileTransport(handle, CLOUD_FILE_NAME))
  cloud.configure(DEFAULT_CLOUD_KEY)
  try {
    await saveSyncFolderHandle(handle)
    localStorage.setItem(WEB_FILE_ON_KEY, '1')
  } catch {
    /* 持久化失败不阻断启用，仅下次启动需重选 */
  }
}

/** 关闭网页版云盘文件同步：清持久化 + 复位为 HTTP 传输层。 */
export function disableWebFileCloud() {
  try {
    localStorage.removeItem(WEB_FILE_ON_KEY)
  } catch {
    /* 忽略 */
  }
  void clearSyncFolderHandle().catch(() => {})
  cloud.setTransport(createHttpTransport())
  cloud.configure('')
}

/**
 * 启动时恢复网页版云盘文件同步（#032：不再需要同步码）。
 * 成功返回 true（db.ts 据此切到云端存储）。
 */
export async function applyWebFileSyncFromPersisted(): Promise<boolean> {
  if (!isWebFileSyncOn()) return false
  if (getSyncMode() !== 'file') return false
  try {
    const handle = await loadSyncFolderHandle()
    if (!handle) return false
    cloud.setTransport(createFileTransport(handle, CLOUD_FILE_NAME))
    cloud.configure(DEFAULT_CLOUD_KEY)
    return true
  } catch {
    return false
  }
}

// —— 以下为共享符号，原样 re-export，保证 db.ts / WebTools 等下游 import 不变 ——
export { EXCLUDED_META_KEYS, CONFLICT_KEY_PREFIX, isExcludedMetaKey, SYNC_STORES, KEY_FIELD }
export type { SyncStatus, SyncConflictInfo, CloudBackupMeta }
export { RateLimitError, CloudAuthError }
// 类型兼容占位：RawSyncResponse 经由 syncTransport 导出，serverStore 不重新声明
export type { RawSyncResponse }
