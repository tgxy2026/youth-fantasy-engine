// 桌面版 · 云盘文件中转同步（#031 引入，#032 去掉同步码）
//
// 本模块**完全不依赖我们的服务器**：数据以加密文件落在用户选定的云盘同步目录
// （OneDrive / WPS 云盘 / 百度网盘 / 坚果云 等），由对应客户端负责跨设备搬运。
// 这是本项目唯一的跨设备同步途径（网页版服务器同步已于 2026-09-15 下线）。
//
// 传输层：选目录走原生对话框（preload 注入的 window.electronStore.chooseSyncDir），
// 文件读写经 IPC 桥（syncRead/syncWrite）到主进程 fs —— 渲染进程 nodeIntegration=false，无法 require('fs')。
//
// 加密 / 载荷 / rev 合并 / #030 空推防护 / 三路合并 全部复用 syncCore.createCloudStore。
import type { StoreOps } from './storeOps'
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
  DEFAULT_CLOUD_KEY,
  CLOUD_FILE_NAME,
} from './syncTransport'
import { DESKTOP } from './env'

// #032：常量已下沉到 syncTransport（网页版云盘模式也要用），此处 re-export 保持调用方不变。
export { DEFAULT_CLOUD_KEY, CLOUD_FILE_NAME }

/** 云盘文件同步门控开关（桌面版唯一形态；网页版服务器同步已下线）。 */
export const CLOUD_FILE_SYNC = DESKTOP

const DIR_KEY = 'yfe-desktop-cloud-dir' // 桌面：目录路径字符串
const ENABLED_KEY = 'yfe-desktop-cloud-on' // 是否已开启云盘同步（布尔标记）

// 用一个占位 transport 创建实例，真正的 FileTransport 在用户选目录后通过 setTransport 替换。
const cloud: CloudStoreInstance = createCloudStore(createHttpTransport())

/** 桌面/便携版云端同步 StoreOps（db.ts 的 desktopCloudFileStore 包装层会在此之上做本地回退）。 */
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
export async function seedDesktopFromLocal(getAll: (store: string) => Promise<any[]>) {
  return cloud.seedFromLocal(getAll)
}
export function onDesktopSyncConflict(h: (info: SyncConflictInfo) => void) {
  cloud.onSyncConflict(h)
}

/**
 * 注册「云盘推不出去时的本地兜底」。由 db.ts 在初始化时接上：
 * 回调收到当前内存 cache（store 名 → 行数组），负责把它镜像进本地存储，避免关窗丢稿。
 */
export function onDesktopCloudFallback(h: (cache: Record<string, any[]>) => void) {
  cloud.onFallback(h)
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
export async function chooseDesktopCloudDir(): Promise<{ handle: any; name: string } | null> {
  const path = await (window as any).electronStore?.chooseSyncDir?.()
  if (typeof path === 'string' && path) {
    return { handle: path, name: path.split(/[\\/]/).filter(Boolean).pop() || path }
  }
  return null
}

/**
 * 开启云盘文件同步（#032：无需同步码，选目录即开）。
 * 传输层指向所选目录，加密走内置默认密钥（DEFAULT_CLOUD_KEY），两端一致即可互通。
 */
export async function enableDesktopCloud(handle: any) {
  cloud.setTransport(createFileTransport(handle, CLOUD_FILE_NAME))
  cloud.configure(DEFAULT_CLOUD_KEY)
}

/**
 * 持久化「已开启」标记与同步目录。
 *
 * 🔴 必须等**快照校验 + 播种全部成功之后**才调用（由 db.ts 的 enableDesktopCloudSync 负责）。
 *    原先这两行就写在 enableDesktopCloud 里，而它是在拉快照 / 播种**之前**执行的 ——
 *    后两步失败时标记已经落盘，下次启动 UI 仍显示「已开启」，实际却走本地存储。
 */
export function persistDesktopCloudEnabled(handle: any) {
  try {
    if (DESKTOP && isStringHandle(handle)) {
      localStorage.setItem(DIR_KEY, handle)
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
  cloud.setTransport(createHttpTransport())
  cloud.configure('')
}

/**
 * 启动时按持久化恢复传输层（#032：不再需要同步码，内置默认密钥即可）。
 * 成功返回 true（db.ts 据此切到云端存储）。
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
