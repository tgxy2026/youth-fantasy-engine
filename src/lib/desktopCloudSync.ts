// 桌面 / 便携版 · 云盘文件中转同步（#031 的桌面延伸）
//
// ⚠️ 独立门控：仅 DESKTOP || PORTABLE 激活，与网页版 serverStore（HTTP 服务器、WEB 门控）互不耦合。
//   本模块完全不依赖我们的服务器：数据以加密文件落在用户选定的云盘同步目录
//   （OneDrive / WPS 云盘 / 百度网盘 / 坚果云 等），由对应客户端负责跨设备搬运。
//
// 传输层：
//   · 桌面（Electron）：选目录走原生对话框（preload 注入的 window.electronStore.chooseSyncDir），
//     文件读写经 IPC 桥（syncRead/syncWrite）到主进程 fs，因为渲染进程 nodeIntegration=false 无法 require('fs')。
//   · 便携（单文件 HTML）：选目录走浏览器 File System Access API（showDirectoryPicker），句柄存 IndexedDB。
//
// 加密 / 载荷 / rev 合并 / #030 空推防护 / 三路合并 全部复用 syncCore.createCloudStore，
// 与网页版共用同一套逻辑——只是把「发 HTTP」换成了「读写本地文件」。
import type { StoreOps } from './portable'
import {
  createCloudStore,
  type CloudStoreInstance,
  type SyncStatus,
  type SyncConflictInfo,
  type CloudBackupMeta,
  CloudAuthError,
  CONFLICT_KEY_PREFIX,
  isExcludedMetaKey,
} from './syncCore'
import {
  createFileTransport,
  createHttpTransport,
  loadSyncFolderHandle,
  saveSyncFolderHandle,
  clearSyncFolderHandle,
} from './syncTransport'
import { DESKTOP, PORTABLE } from './env'

/** 桌面 / 便携版独立的云同步门控开关（与 serverStore 的 WEB 门控互不干扰）。 */
export const CLOUD_FILE_SYNC = DESKTOP || PORTABLE

const DIR_KEY = 'yfe-desktop-cloud-dir' // 桌面：目录路径字符串
const ENABLED_KEY = 'yfe-desktop-cloud-on' // 是否已开启云盘同步（布尔标记）

/**
 * 内置默认加密密钥（#032：桌面 / 便携版砍掉「同步码」）。
 *
 * 为什么可以砍：同步码在网页版身兼两职——①HTTP 鉴权（换服务器槽位）、②AES 密钥。
 * 云盘文件中转走的是用户自己的网盘，没有我们的服务器，①根本不存在；
 * ②只需要两端一致即可，故改用内置常量：所有设备同一密钥 → 指向同一目录就能互通。
 *
 * 安全边界（必须如实告知用户）：此密钥是公开的源码常量，加密强度等同于「混淆」，
 * 仅防云盘明文扫描与误看，**不足以对抗蓄意破解**。机密稿件请放在私人目录、不要共享。
 */
export const DEFAULT_CLOUD_KEY = 'YFE-CLOUD-FILE-SYNC-V1'

/** 云盘同步文件名（固定，便于用户在云盘目录里认出它）。 */
export const CLOUD_FILE_NAME = '青春幻想引擎-同步数据.yfe'

// 用一个占位 transport 创建实例，真正的 FileTransport 在用户选目录后通过 setTransport 替换。
const cloud: CloudStoreInstance = createCloudStore(createHttpTransport())

/** 桌面/便携版云端同步 StoreOps（db.ts 的 desktopCloudFileStore 包装层会在此之上做本地回退）。 */
export const desktopCloudStore: StoreOps = cloud.store

export function configureDesktopCloud(c: string) {
  cloud.configure(c)
}
export function getDesktopCloudStatus(): SyncStatus {
  return cloud.getStatus()
}
export function isDesktopCloudUnavailable(): boolean {
  return cloud.isCloudUnavailable()
}
export function isDesktopCloudAuthFailed(): boolean {
  return cloud.isCloudAuthFailed()
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
export async function seedDesktopFromLocal(getAll: (store: string) => Promise<any[]>) {
  return cloud.seedFromLocal(getAll)
}
export function onDesktopSyncConflict(h: (info: SyncConflictInfo) => void) {
  cloud.onSyncConflict(h)
}
export async function desktopBackgroundPull() {
  return cloud.backgroundPull()
}

function isStringHandle(h: unknown): h is string {
  return typeof h === 'string'
}

/** 是否已启用（持久化过开启标记）。#032 起不再需要同步码，只认开启标记 + 目录。 */
export function isDesktopCloudEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

/** 当前同步目录的展示名（桌面取路径末段；便携取句柄名）。无则返回 null。 */
export async function getDesktopCloudDirName(): Promise<string | null> {
  try {
    if (DESKTOP) {
      const dir = localStorage.getItem(DIR_KEY)
      if (!dir) return null
      return dir.split(/[\\/]/).filter(Boolean).pop() || dir
    }
    const h = await loadSyncFolderHandle()
    return h && h.name ? h.name : null
  } catch {
    return null
  }
}

/**
 * 选择同步文件夹。
 *   · 桌面：原生对话框（IPC）返回目录路径字符串。
 *   · 便携：浏览器 showDirectoryPicker 返回目录句柄。
 * 返回 [handle, displayName]，handle 用于构造 FileTransport。
 */
export async function chooseDesktopCloudDir(): Promise<{ handle: any; name: string } | null> {
  if (DESKTOP) {
    const path = await (window as any).electronStore?.chooseSyncDir?.()
    if (typeof path === 'string' && path) {
      return { handle: path, name: path.split(/[\\/]/).filter(Boolean).pop() || path }
    }
    return null
  }
  // 便携：File System Access API
  const picker = (window as any).showDirectoryPicker
  if (typeof picker !== 'function') return null
  const h = await picker({ mode: 'readwrite' })
  await saveSyncFolderHandle(h)
  return { handle: h, name: h.name }
}

/**
 * 开启云盘文件同步（#032：无需同步码，选目录即开）。
 * 传输层指向所选目录，加密走内置默认密钥（DEFAULT_CLOUD_KEY），两端一致即可互通。
 */
export async function enableDesktopCloud(handle: any) {
  cloud.setTransport(createFileTransport(handle, CLOUD_FILE_NAME))
  cloud.configure(DEFAULT_CLOUD_KEY)
  try {
    if (DESKTOP && isStringHandle(handle)) {
      localStorage.setItem(DIR_KEY, handle)
    } else if (PORTABLE && !isStringHandle(handle)) {
      await saveSyncFolderHandle(handle)
    }
    localStorage.setItem(ENABLED_KEY, '1')
  } catch {
    /* 持久化失败不阻断启用，仅下次启动需重选 */
  }
}

/** 关闭云盘文件同步：清持久化 + 复位传输层。 */
export function disableDesktopCloud() {
  try {
    localStorage.removeItem(ENABLED_KEY)
    localStorage.removeItem(DIR_KEY)
  } catch {
    /* 忽略 */
  }
  if (PORTABLE) void clearSyncFolderHandle().catch(() => {})
  cloud.setTransport(createHttpTransport())
  cloud.configure('')
}

/**
 * 启动时按持久化恢复传输层（#032：不再需要同步码，内置默认密钥即可）。
 * 成功返回 true（db.ts 据此切到云端存储）。桌面读目录路径字符串；便携读 IndexedDB 句柄。
 */
export async function applyDesktopCloudFromPersisted(): Promise<boolean> {
  let handle: any = null
  if (DESKTOP) {
    try {
      const dir = localStorage.getItem(DIR_KEY)
      if (dir) handle = dir
    } catch {
      /* 忽略 */
    }
  } else if (PORTABLE) {
    try {
      handle = await loadSyncFolderHandle()
    } catch {
      /* 忽略 */
    }
  }
  if (!handle) return false
  if (!isDesktopCloudEnabled()) return false
  cloud.setTransport(createFileTransport(handle, CLOUD_FILE_NAME))
  cloud.configure(DEFAULT_CLOUD_KEY)
  return true
}

// —— 共享符号 re-export，便于 db.ts/UI 统一引用 ——
export { CONFLICT_KEY_PREFIX, isExcludedMetaKey, CloudAuthError }
export type { SyncStatus, SyncConflictInfo, CloudBackupMeta }
