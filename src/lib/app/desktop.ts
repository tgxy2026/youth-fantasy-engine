// 桌面（Electron 安装版）存储引擎
// 数据以单个 JSON 文件保存在本机用户数据目录
// （Windows: C:\Users\<用户>\AppData\Roaming\youth-fantasy-engine\youth-fantasy-engine-data.json），
// 通过 preload 注入的 window.electronStore IPC 读写。
//
// 数据格式（`PortableData`，kind='portable-data'）沿用自便携版，**名字不要改**：
// 它是写进用户数据文件的字面量，改名会让老数据文件无法被识别。
// 桌面版「导出数据文件 / 导入数据文件」即基于该格式，可在设备间手工搬运。
import type { StoreOps, PortableData } from '@/lib/storage/storeOps'
import { invalidateStorageContext } from '@/lib/storage/contextEpoch'
import { normalizePortableData, isPortableDataFile, describeDataFileReject, describeFileVersionProblem, PORTABLE_FILE_VERSION } from '@/lib/storage/storeOps'
import type { SidecarApi, SidecarSpec } from '@/lib/storage/sidecar'
import { withSidecar, migrateSidecar, collectSidecarForExport, registerSidecarApi, type SidecarExportIssue } from '@/lib/storage/sidecar'
import { SAVE_DEBOUNCE_MS } from '@/lib/constants'
import { markDeleted, clearDeleted, resetTombs } from '@/lib/sync/syncTombstone'
// 导出数据文件前剥敏感 meta（AI 密钥 / 检索密钥）—— 叶子模块，不会与 sync 层成环
import { stripSensitiveMeta } from '@/lib/storage/sensitiveMeta'
import { recordError } from '@/lib/app/errorLog'

/** preload 注入的 IPC 接口结构（仅桌面版存在） */
export interface ElectronStoreAPI {
  /** missing=true 表示数据文件尚不存在（首次使用）；与"读取失败"必须区分，见 readDataFileSync */
  load(): Promise<{ text: string | null; path: string; missing?: boolean; error: string | null }>
  save(text: string): Promise<{ ok: boolean; error: string | null }>
  /** 同步写盘；失败时主进程返回 { ok:false } 而**不抛异常**，调用方必须查返回值 */
  saveSync(text: string): { ok: boolean; error: string | null } | undefined
  exportFile(text: string): Promise<string | null>
  /**
   * 把一段 HTML 渲染成 PDF 并保存到用户选择的位置。
   * 🔴 中文必须走这条通道（Chromium 打印引擎用系统字体）；前端 PDF 库会输出豆腐块。
   * @returns 保存后的绝对路径 / null（用户取消）；失败 reject（调用方走 {@link exportPdfDocument} 统一处理）
   */
  exportPdf(html: string, defaultName: string): Promise<string | null>
  importFile(): Promise<string | null>
  revealDataFile(): Promise<void>
  dataPath(): Promise<string>
  /** 数据文件是否已被改到自定义位置 */
  isCustomPath(): Promise<boolean>
  /** 选择数据文件的新存放位置，返回完整文件路径或 null（取消） */
  chooseDataDir(): Promise<string | null>
  /**
   * 迁移数据文件到新位置；adopted=目标已有数据文件、改用那份。
   * `copied` = 本次一并搬走的外置备份文件数（3.2.2 · 审计 C2；旧主进程不返回，按 0 处理）
   */
  setDataPath(target: string, text: string): Promise<{ ok: boolean; path: string; adopted: boolean; copied?: number; error: string | null }>
  /** 恢复默认存放位置（同样会搬外置文件，`copied` 含义同上） */
  resetDataPath(text: string): Promise<{ ok: boolean; path: string; adopted: boolean; copied?: number; error: string | null }>
  // ---- 外置大块数据（sidecar）：备份载荷存独立文件，主 JSON 只留元数据 ----
  /** 读一条外置记录；`missing:true` 表示还没有（不是错误） */
  payloadRead(store: string, id: string): Promise<{ ok: boolean; missing?: boolean; value?: unknown; error?: string }>
  /** 写一条外置记录（text = 该记录的 JSON 串） */
  payloadWrite(store: string, id: string, text: string): Promise<{ ok: boolean; error?: string }>
  /** 删一条外置记录（幂等：已不存在也算成功） */
  payloadDel(store: string, id: string): Promise<{ ok: boolean; error?: string }>
  /** 列该 store 当前全部外置 id */
  payloadList(store: string): Promise<{ ok: boolean; ids: string[]; error?: string }>
}

/** 主进程代发请求的结果（**永不抛**：失败走 ok:false，好让界面如实提示） */
export type NetFetchResult =
  | { ok: true; status: number; statusText: string; text: string }
  | { ok: false; error: string }

/**
 * preload 注入的「主进程代发 HTTP 请求」（联网检索用）。
 * ⚠️ 只有**桌面（Electron）版**有这一层 —— 便携版是单文件 HTML、跑在系统浏览器里，
 *   不存在主进程，因此仍然受同源策略限制（只能用自带 CORS 头的搜索接口）。
 */
export interface ElectronNetAPI {
  fetch(url: string, init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  }): Promise<NetFetchResult>
  /** 推送网络代理配置（2026-09-28 · 网络代理设置）：仅桌面版可用 */
  /** 用系统默认浏览器打开一个 http/https 链接（2.6.3 · 检查更新下载入口） */
  openExternal(url: string): Promise<{ ok: true } | { ok: false; error: string }>
  setProxy(cfg: {
    enabled: boolean
    /** 代理规则串（如 http://127.0.0.1:7890）；主进程白名单清洗 */
    rules?: string
    /** 直连名单（逗号分隔，如 localhost,127.0.0.1） */
    bypass?: string
  }): Promise<{ ok: true } | { ok: false; error: string }>
}

/**
 * preload 注入的「窗口控制」（2.5.1 · B2 真·全屏切换）。
 * 只有三个受控口子：设置 / 查询 / 状态推送；F11 与 ESC 的按键判定在渲染层（见 installFullscreenShortcuts）。
 */
export interface ElectronWindowAPI {
  /** 设置真全屏（无边框）；返回实际全屏态。命名随 Electron 官方 `win.setFullScreen`（大写 S） */
  setFullScreen(on: boolean): Promise<boolean>
  /** 查询当前全屏态 */
  isFullscreen(): Promise<boolean>
  /** 订阅全屏态变化（主进程推送，系统级全屏变化也会来）；返回退订函数 */
  onFullscreenChange(cb: (on: boolean) => void): () => void
}

/**
 * preload 注入的「应用内下载安装包」（2.9.0 · 检查更新 2.0）。
 * 🔴 口子收窄到 5 个 + 1 个进度订阅：下载到「下载」文件夹 / 取消 / 拉起安装器 /
 *   在资源管理器里定位 / 退出本程序。**目标目录与文件名清洗都在主进程**（渲染层给的是文件名，不是路径）。
 */
export interface UpdateDownloadProgress {
  received: number
  total: number
  /** 0–100；服务器没给 content-length 时为 0（界面改显示已下载字节数） */
  percent: number
}

export type UpdateDownloadResult =
  | { ok: true; path: string; size: number }
  | { ok: false; cancelled?: true; error: string }

export interface ElectronUpdateAPI {
  download(url: string, fileName: string): Promise<UpdateDownloadResult>
  /** 取消进行中的下载（没有在下载时返回 ok:false） */
  cancel(): Promise<{ ok: boolean }>
  /** 拉起刚下好的安装器；closeApp=true 则随后退出本程序（覆盖更新须旧文件不被占用） */
  launchInstaller(filePath: string, closeApp: boolean): Promise<{ ok: true } | { ok: false; error: string }>
  /** 在资源管理器里定位安装包（不想立刻装时用） */
  revealFile(filePath: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** 退出本程序（安装前腾出被占用的文件） */
  quitApp(): Promise<{ ok: true }>
  /** 订阅下载进度（主进程节流推送）；返回退订函数 */
  onProgress(cb: (p: UpdateDownloadProgress) => void): () => void
}

/** 3.1.2 · 应用图标（桌面快捷方式）切换：预设清单 / 当前生效 / 应用 / 还原 */
export interface AppIconPreset {
  key: string
  label: string
  /** 256 预览图（dataURL）；取不到时为 null（界面显示文字占位） */
  preview: string | null
}

export interface AppIconResult {
  ok: boolean
  /** 非 Windows 平台为 false —— 界面应隐藏入口而不是弹失败 */
  supported?: boolean
  key?: string
  iconPath?: string
  /** 实际写入成功的快捷方式文件名 */
  applied?: string[]
  /** 写失败的快捷方式（含原因）—— 部分成功时如实上报 */
  failed?: string[]
  error?: string
}

export interface ElectronAppIconAPI {
  supported(): Promise<boolean>
  presets(): Promise<AppIconPreset[]>
  current(): Promise<{ key: string | null; saved: string | null; shortcuts: { path: string; exists: boolean }[] }>
  apply(key: string): Promise<AppIconResult>
  reset(): Promise<AppIconResult>
}

declare global {
  interface Window {
    electronStore?: ElectronStoreAPI
    electronNet?: ElectronNetAPI
    electronWindow?: ElectronWindowAPI
    electronUpdate?: ElectronUpdateAPI
    electronAppIcon?: ElectronAppIconAPI
  }
}

/** 是否为桌面（Electron 安装）版本：由 preload 是否注入 electronStore 决定 */
export const DESKTOP: boolean =
  typeof window !== 'undefined' && typeof window.electronStore === 'object' && window.electronStore !== null

/**
 * 能否由主进程代发 HTTP 请求（联网检索绕开跨域靠它）。
 * 桌面版（含 dev 下用 electron 启动）为 true；便携版 / 纯浏览器 dev 为 false。
 */
export const HAS_NET_BRIDGE: boolean =
  typeof window !== 'undefined' && typeof window.electronNet === 'object' && window.electronNet !== null

/** 是否有窗口控制桥（B2 真·全屏）：桌面版 preload 注入；浏览器 / 便携版没有 */
export const HAS_WINDOW_BRIDGE: boolean =
  typeof window !== 'undefined' && typeof window.electronWindow === 'object' && window.electronWindow !== null

/** 运行时取窗口桥（供 helper 用 —— 不用模块级常量，测试里才能注入 mock window） */
function windowApi(): ElectronWindowAPI | null {
  if (typeof window === 'undefined') return null
  return window.electronWindow ?? null
}

/** 是否有应用图标桥（3.1.2）：桌面版 preload 注入，浏览器 / 便携版没有 */
export const HAS_APP_ICON_BRIDGE: boolean =
  typeof window !== 'undefined' && typeof window.electronAppIcon === 'object' && window.electronAppIcon !== null

/** 运行时取图标桥（同上，测试可注入 mock） */
function appIconApi(): ElectronAppIconAPI | null {
  if (typeof window === 'undefined') return null
  return window.electronAppIcon ?? null
}

/**
 * 本机能否切换桌面图标。
 * 🔴 两道门都要过：① 有桥（桌面版）② 主进程判平台为 Windows（`.lnk` 是 Windows 独有）。
 *    任一条不满足 ⇒ 界面**隐藏入口**，而不是点了才报错。
 */
export async function appIconSupported(): Promise<boolean> {
  const api = appIconApi()
  if (!api) return false
  try {
    return await api.supported()
  } catch {
    return false
  }
}

/** 内置预设清单（含预览图）；无桥返回空数组 */
export async function listAppIconPresets(): Promise<AppIconPreset[]> {
  const api = appIconApi()
  if (!api) return []
  try {
    return await api.presets()
  } catch {
    return []
  }
}

/** 当前生效的图标预设（由桌面快捷方式推断） */
export async function currentAppIcon(): Promise<{ key: string | null; shortcuts: { path: string; exists: boolean }[] }> {
  const api = appIconApi()
  if (!api) return { key: null, shortcuts: [] }
  try {
    const r = await api.current()
    return { key: r.key ?? null, shortcuts: r.shortcuts ?? [] }
  } catch {
    return { key: null, shortcuts: [] }
  }
}

/** 应用一个预设（桌面 + 开始菜单一起改） */
export async function applyAppIcon(key: string): Promise<AppIconResult> {
  const api = appIconApi()
  if (!api) return { ok: false, error: '当前版本不支持（仅桌面安装版可用）' }
  try {
    return await api.apply(key)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 还原为默认图标（指回主程序自身图标） */
export async function resetAppIcon(): Promise<AppIconResult> {
  const api = appIconApi()
  if (!api) return { ok: false, error: '当前版本不支持（仅桌面安装版可用）' }
  try {
    return await api.reset()
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 切换真·全屏；无窗口桥（浏览器 / 便携版）时返回 null（调用方应隐藏入口） */
export async function toggleFullscreen(): Promise<boolean | null> {
  const w = windowApi()
  if (!w) return null
  return w.setFullScreen(!(await w.isFullscreen()))
}

/** 安装 F11 / ESC 快捷键（仅桌面；浏览器有自己的 F11/ESC 语义，不接管）。返回卸载函数。 */
export function installFullscreenShortcuts(): () => void {
  const w = windowApi()
  if (!w) return () => {}
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'F11') {
      e.preventDefault() // 桌面版接管 F11，避免浏览器语义（webview 场景）叠加
      void toggleFullscreen()
    } else if (e.key === 'Escape') {
      // ESC 只在全屏时退出（与浏览器一致）；非全屏时不动它，免得干扰弹窗关闭等既有语义
      void w.isFullscreen().then(on => { if (on) void w.setFullScreen(false) })
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}

/**
 * 由主进程代发一次请求。**永不抛** —— 不可用时返回 ok:false，让调用方把原因如实报给作者，
 * 而不是静默降级成「模型瞎编」（那种失败最难排查）。
 */
export async function netFetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<NetFetchResult> {
  if (!HAS_NET_BRIDGE) {
    return { ok: false, error: '当前版本没有「主进程代发请求」能力（便携版跑在浏览器里，只能用自带跨域许可的接口）' }
  }
  try {
    return await (window.electronNet as ElectronNetAPI).fetch(url, init)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 用系统默认浏览器打开外部链接（2026-09-30 · 检查更新的「去下载」）。
 * 🔴 只接受 **http/https** —— 主进程侧还有一道校验，这里再挡一次，防止将来被拿去打开
 *    `file://` 或自定义协议。**永不抛**：不可用返回 ok:false，调用方降级 window.open。
 */
export async function openExternalUrl(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!HAS_NET_BRIDGE) {
    return { ok: false, error: '当前版本没有「打开外部链接」能力（浏览器里请手动复制地址）' }
  }
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: '只允许打开 http / https 链接' }
  }
  try {
    return await (window.electronNet as ElectronNetAPI).openExternal(url)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 是否有「应用内下载安装包」桥（桌面版才有；便携版 / 纯浏览器 dev 没有） */
export const HAS_UPDATE_BRIDGE: boolean =
  typeof window !== 'undefined' && typeof window.electronUpdate === 'object' && window.electronUpdate !== null

/** 运行时取更新桥（供 helper 用 —— 不用模块级常量，测试里才能注入 mock window） */
function updateApi(): ElectronUpdateAPI | null {
  if (typeof window === 'undefined') return null
  return window.electronUpdate ?? null
}

/**
 * 下载安装包到系统「下载」文件夹（2.9.0）。**永不抛** —— 与 netFetch 同口径：失败走 ok:false，
 * 由界面如实提示（含 cancelled、以及「大小不符已丢弃」这两种要分开说的情况）。
 */
export async function downloadInstallerPackage(url: string, fileName: string): Promise<UpdateDownloadResult> {
  const api = updateApi()
  if (!api) return { ok: false, error: '当前版本没有「应用内下载」能力（便携版 / 浏览器里请用夸克网盘）' }
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '只允许 http / https 链接' }
  try {
    return await api.download(url, fileName)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 取消进行中的下载；无桥、或当时并没有在下载 → false */
export async function cancelInstallerDownload(): Promise<boolean> {
  const api = updateApi()
  if (!api) return false
  try {
    return (await api.cancel()).ok
  } catch {
    return false
  }
}

/** 拉起安装器（closeApp=true 时主进程随后退出本程序）。**永不抛** */
export async function launchInstallerPackage(
  filePath: string,
  closeApp: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const api = updateApi()
  if (!api) return { ok: false, error: '当前版本没有「启动安装包」能力（请到「下载」文件夹手动双击）' }
  try {
    return await api.launchInstaller(filePath, closeApp)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 在资源管理器里定位安装包 */
export async function revealInstallerFile(filePath: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const api = updateApi()
  if (!api) return { ok: false, error: '当前版本没有「打开文件夹」能力' }
  try {
    return await api.revealFile(filePath)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 退出本程序（安装前腾出被占用的文件）；关不掉就算了，用户还能自己点窗口关闭 */
export async function quitAppForInstall(): Promise<void> {
  const api = updateApi()
  if (!api) return
  try {
    await api.quitApp()
  } catch {
    /* 忽略 */
  }
}

/** 订阅安装包下载进度；无桥时返回空退订函数（调用方不必判空） */
export function onUpdateDownloadProgress(cb: (p: UpdateDownloadProgress) => void): () => void {
  const api = updateApi()
  if (!api) return () => {}
  return api.onProgress(cb)
}

/**
 * 推送网络代理配置（2026-09-28 · 网络代理设置）。**永不抛** —— 与 netFetch 同口径：
 * 不可用（便携版 / 浏览器 dev）返回 ok:false，由调用方把原因如实告诉作者。
 */
export async function setNetProxy(cfg: {
  enabled: boolean
  rules?: string
  bypass?: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!HAS_NET_BRIDGE) {
    return { ok: false, error: '当前版本没有「设置代理」能力（便携版跑在浏览器里，配置仅在桌面版生效）' }
  }
  try {
    return await (window.electronNet as ElectronNetAPI).setProxy(cfg)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function api(): ElectronStoreAPI {
  return window.electronStore as ElectronStoreAPI
}

// ---- 主键映射（store 名 -> 记录主键字段名）----
// 🔬 导出供 db/core.ts 的「云端 cache → 本地库」镜像复用：那边要按主键判断「本地是否已有这条」
//    （闩锁期不能整体覆盖，见 db/core.ts 的 mirrorCloudCacheToLocal）。
// ⚠️ 这份映射还有**第二份副本**：`tests/mock-memory.ts` 的 KEY_PATHS（测试桩，靠 `?? 'id'` 兜底）。
//    增删 store 键时**两处都要改** —— 而且**目前没有任何测试钉住二者一致**
//    （2026-09-21 六维审计核实：原注释所称的 `tests/cloudStoreWrapper.test.ts` 比对并不存在，
//     已按事实更正注释，避免后人以为有护栏）。
export const KEY_PATHS: Record<string, string> = {
  projects: 'id', volumes: 'id', chapters: 'id', tableRows: 'id',
  cardRecords: 'id', snapshots: 'id', trash: 'id',
  // C2：备份元数据与载荷分开存（都是本地专属，不进同步）
  backups: 'id', backupPayloads: 'id',
  formData: 'tabId', meta: 'key', dailyStats: 'key', settingsKV: 'key',
  // 2.4.4 六维审计：与 syncCore.KEY_FIELD 对齐（后者有 tavernReports，这里漏了 ——
  // 虽有 ?? 'id' 兜底，但两份口径应逐项一致，避免下一个新表再漂移）
  tavernReports: 'id',
  // 3.0 · W1-1：AI 运行账本（务必与 syncCore.KEY_FIELD 同步）
  aiRuns: 'id',
  // 3.0 · 多世界（务必与 syncCore.KEY_FIELD 同步）
  // 🔴 2026-10-10 六维审计 P2：`worlds` 已经进了同步层的 KEY_FIELD，这份副本漏了 ——
  //    虽有 `?? 'id'` 兜底（worlds 主键恰好也是 id，行为上没炸），但两份口径必须逐项一致，
  //    否则下一个换主键的新表会在这里静默走错（正是本注释上一段要防的漂移）。
  worlds: 'id',
  // 3.2.0 · W2：修订任务（项目级，随项目落盘）。🔴 与 syncCore.KEY_FIELD 同步。
  revisionJobs: 'id',
  // 3.2.0 · W2：修订载荷（**本地专属**：不进云同步，但必须落本机盘 —— 漏了就是"重启即丢候选"）。
  revisionPayloads: 'id',
}

export interface DesktopState {
  connected: boolean
  fileName: string
  dirty: boolean
  saving: boolean
  lastSavedAt: number
  lastError: string
  dataPath: string
  /** 数据文件是否已改到自定义位置（区别于默认的 userData 目录） */
  isCustomPath: boolean
  /** 🔴 写盘已锁定：数据文件读取失败/损坏/为空，为免覆盖真实数据而暂停写入 */
  writeLocked: boolean
  /** 锁定的原因（给作者看的原话，界面据此常驻提示） */
  writeLockReason: string
}

let data: PortableData = { app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 1, savedAt: 0, stores: {} }
let inited = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving = false
let dirty = false
/**
 * 🔴 写入序号（2026-10-17 全量审计 P2）：
 *   `flushDesktop` 里 `await api().save(...)` 期间作者继续输入时，`scheduleSave` 会把 dirty 置真、
 *   但写成功后无条件 `dirty = false` 会把它**吞掉**（该次定时器触发时 `saving` 为真、直接返回且不重排）
 *   ⇒ 内存比磁盘新且无人知道。用序号判定：落盘只认「写入开始那一刻的版本」，
 *   成功后若序号又变了就保持 dirty 并续排下一次。
 */
let writeSeq = 0
let savedSeq = 0
let lastSavedAt = 0
let lastError = ''
let dataFilePath = ''
let isCustomPath = false
/**
 * 🔴 写盘锁定。数据文件"读不出来"时置位 —— 锁上之后一个字节都不许写。
 * 为什么必须有这一层：内存里此刻是一份**空库**（或残缺数据），而磁盘上可能躺着
 * 用户全部心血；只要有任何一次落盘，真实文件就被覆盖了，且不可逆。
 */
let writeLocked = false
/** 锁定的原因（界面常驻提示用） */
let writeLockReason = ''

const listeners = new Set<() => void>()

/** 订阅状态变化（保存完成 / 出错），返回取消订阅函数 */
export function subscribeDesktop(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function emit() { listeners.forEach(fn => fn()) }

export function getDesktopState(): DesktopState {
  return {
    connected: inited, fileName: '本地数据文件', dirty, saving,
    lastSavedAt, lastError, dataPath: dataFilePath, isCustomPath,
    writeLocked, writeLockReason,
  }
}

/**
 * 解锁并继续用当前（空/残缺）数据写盘。
 *
 * 🔴 **破坏性操作**：解锁后下一次落盘会用内存里的数据覆盖磁盘上的原文件。
 * 界面必须先把这个后果说清楚、并让作者二次确认，才可以调用它。
 */
export function unlockDesktopWrite(): void {
  writeLocked = false
  writeLockReason = ''
  lastError = ''
  emit()
}

/**
 * 应用启动时调用：从本地用户数据目录读取数据文件（首次使用时文件不存在，视作空库）。
 *
 * 🔴 读不出来时**必须锁写盘**。旧实现只在 lastError 里写了句"原文件不会被覆盖"，
 *   但没有任何代码实现这个承诺 —— 内存空库照样会在几百毫秒后覆盖真实文件。
 *   现在"锁"是真的锁：flushDesktop / flushDesktopSync 都会直接返回。
 */
/**
 * 「本地数据文件已加载完成」的等待口。
 *
 * 🔴 为什么需要它（2026-10-01 六维审计 P1）：`db/core.ts` 的云盘自动恢复块是在**模块求值期**
 *    就启动的，而数据文件是稍后由 `initDesktopStore()`（App 的 effect）读进来的。在它完成之前，
 *    本模块的 `data` 还是那份**空库** —— 于是两条红线同时被绕过：
 *      ① 云同步首次合并据此算出 `localHasContent=false` ⇒ **墓碑闸被短路**，
 *         「本机删掉的记录」被云端快照原样带回来（幽灵项目的启动路径）；
 *      ② `writeLocked` 恒为 false ⇒ 那道「读不出来就别切云同步」的守卫成了**死代码**。
 *    ⇒ 任何「依赖本地数据文件已就绪」的启动逻辑，都必须先 await 这个口子。
 *    ⚠️ 带超时兜底：万一哪天有入口没有调 `initDesktopStore`，也不能把启动流程永久挂住。
 */
const readyGate = (() => {
  let resolve!: () => void
  const p = new Promise<void>(r => { resolve = r })
  return { p, resolve }
})()
/**
 * 等本地数据文件加载完成（非桌面环境、或已加载完成时立即返回）。
 *
 * 🔴 2026-10-02 六维审计 P2：返回 **boolean** —— `false` ＝ 超时（**数据文件还没就绪**）。
 *    旧版超时后照样 resolve ⇒ 调用方以为「就绪了」，而那一刻 `writeLocked` 仍是 false、
 *    本地快照还是空库 ⇒ 首次合并算出 `localHasContent = false` ⇒ 墓碑闸被短路 ⇒
 *    「本机删掉的记录」被云端快照带回来（幽灵项目又一条启动路径）。
 *    ⚠️ 超时**不等于**就绪，调用方必须自己决定要不要放弃这次动作。
 */
export function desktopStoreReady(timeoutMs = 10000): Promise<boolean> {
  if (!DESKTOP || inited) return Promise.resolve(true)
  return Promise.race([
    readyGate.p.then(() => true),
    new Promise<boolean>(r => { setTimeout(() => r(false), timeoutMs) }),
  ])
}

/** `electronStore.load()` 的返回形状（字段全可选：旧 preload 可能没有 missing） */
export interface DataFileLoadResult {
  text?: string | null
  /** 读取失败原因；成功时为 null（与主进程 `sync:readFile` 的返回形状一致） */
  error?: string | null
  /** 文件是否确实不存在（undefined ＝ 旧 preload 没这个字段，无从判断） */
  missing?: boolean
}

/** 数据文件读取后的三种结局 */
export type DataFileOutcome =
  | { kind: 'empty' }                               // 首次使用（文件还不存在）：空库启动属正常，可以写
  | { kind: 'ready'; data: PortableData }           // 读到了本软件的数据文件
  | { kind: 'lock'; reason: string; error: string } // 一律锁写盘（reason 给作者看，error 进状态）

/**
 * 判定「这次读数据文件的结果该怎么处理」—— **纯函数**（3.0 · W3-3 · §11.1 L4）。
 *
 * 为什么抽出来：这段判定原先内联在 `initDesktopStore` 里，而 `initDesktopStore` 依赖
 * `DESKTOP`（模块级 const，读 preload 注入）与 IPC 桥 —— 测试环境注入不了，
 * 于是**桌面版最要命的一条红线（读不出来就别写盘，否则空库覆盖真实数据）一直没有测试**。
 * 抽成纯函数后六条分支逐条可断言，副作用（锁写盘 / 装载数据）留给调用方施加。
 *
 * 🔴 三条经验教训都落在这里（原注释原文保留）：
 *   ① **missing 未知时不能当「首次使用」放行**（2026-09-17 P2-11）：旧 preload 配新渲染层、
 *      而文件其实存在（text 有内容）时，若按「不存在」处理就会放行写盘 → 空库覆盖真实文件。
 *      故 missing 未知时以「有非空文本」为「文件存在」的判据，让文本解析那条路接管。
 *   ② **解析成功 ≠ 是本软件的数据文件**（2026-09-20 P1-2）：漏了 `isPortableDataFile` 这一步，
 *      后果不是「报错」而是**静默覆盖** —— 误放的文件被当空库放行、不锁写盘。
 *   ③ **任何「读不出来」都归为 lock**，绝不静默当空库。
 */
export function decideDataFileLoad(r: DataFileLoadResult): DataFileOutcome {
  if (r.error) {
    return {
      kind: 'lock',
      reason: `数据文件读取失败：${r.error}`,
      error: `读取本地数据文件失败：${r.error}。为免用空库覆盖原文件，已暂停写入。`,
    }
  }
  const hasText = !!(r.text && r.text.trim())
  const fileExists = r.missing === false || (r.missing === undefined && hasText)
  if (!fileExists) return { kind: 'empty' }
  if (!hasText) {
    return {
      kind: 'lock',
      reason: '数据文件存在但内容为空（可能云盘正在同步、或上次写入被中断）',
      error: '本地数据文件为空。为免覆盖原文件，已暂停写入。',
    }
  }
  try {
    const parsed: unknown = JSON.parse(String(r.text))
    if (!isPortableDataFile(parsed)) {
      return {
        kind: 'lock',
        reason: '数据文件缺少本软件的格式标识（kind="portable-data"）',
        error: '本地数据文件不是本软件写出的（缺少格式标识）。为免覆盖它，已暂停写入。',
      }
    }
    // 🔴 更新版本的库：放行写入 = 把本版本不认识的新字段整库抹平（不可逆）。
    //    所以照样读出来给人看，但**锁写盘**，并让人去升级。
    const versionProblem = describeFileVersionProblem(parsed)
    if (versionProblem) {
      return {
        kind: 'lock',
        reason: '数据文件格式版本高于本版本',
        error: `${versionProblem}。为免用旧格式覆盖它，已暂停写入，请升级软件后再打开。`,
      }
    }
    return { kind: 'ready', data: normalizePortableData(parsed) }
  } catch {
    return {
      kind: 'lock',
      reason: '数据文件内容不是有效的 JSON（可能被云盘客户端同步截断，或磁盘损坏）',
      error: '本地数据文件已损坏（JSON 解析失败）。为免覆盖原文件，已暂停写入。',
    }
  }
}

export async function initDesktopStore(): Promise<void> {
  if (!DESKTOP || inited) return
  const lock = (why: string, msg: string) => {
    writeLocked = true
    writeLockReason = why
    lastError = msg
  }
  let loaded = false
  try {
    const r = await api().load()
    dataFilePath = r.path
    try {
      isCustomPath = (await api().isCustomPath()) === true
    } catch {
      isCustomPath = false
    }
    // 🔴 判定收进纯函数 `decideDataFileLoad`（3.0 · W3-3 · §11.1 L4）：六条分支（读失败 /
    //    首次使用 / 空文件 / 非本软件格式 / JSON 损坏 / 正常）逐条可测，这里只施加副作用。
    //    三条经验教训（missing 未知的处置 / 解析成功≠本软件文件 / 读不出来一律锁）见该函数注释。
    const outcome = decideDataFileLoad(r)
    if (outcome.kind === 'lock') {
      lock(outcome.reason, outcome.error)
    } else if (outcome.kind === 'ready') {
      data = outcome.data
      lastSavedAt = data.savedAt || Date.now()
      loaded = true
    }
    // outcome.kind === 'empty'（首次使用，文件还不存在）：空库启动属正常，可以写
  } catch (e) {
    lock(
      '读取数据文件时发生异常',
      `读取数据文件异常：${e instanceof Error ? e.message : String(e)}。为免覆盖原文件，已暂停写入。`,
    )
  } finally {
    inited = true
    readyGate.resolve() // 放行所有「等数据文件就绪」的启动逻辑（见 desktopStoreReady）
    emit()
  }
  // 🔴 老库迁移必须放在 `inited = true` **之后**（2026-10-11 实机抓到，与便携版同病）：
  //    `flushDesktop` 开头有 `if (!inited || saving) return false` 的守卫，
  //    写在 try 块内时 inited 仍是 false ⇒ 载荷迁出去了、主 JSON 却原地不动。
  if (loaded && !writeLocked) await migrateDesktopSidecar()
}

/**
 * 把主 JSON 里残留的外置数据迁到独立文件（老库升级，**幂等**）。
 *
 * 🔴 锁写盘期间**绝不迁**：那时内存里是空库/残缺数据，迁出去的是空壳，
 *    而老的主 JSON 随后会被覆盖 —— 那就是真丢稿，比不迁移糟得多。
 */
export async function migrateDesktopSidecar(): Promise<void> {
  if (writeLocked) return
  try {
    const r = await migrateSidecar(data, desktopStore, DESKTOP_SIDECAR, async () => {
      data.fileVersion = PORTABLE_FILE_VERSION
      return flushDesktop()
    })
    const total = Object.values(r.moved).reduce((a, b) => a + b, 0)
    if (total > 0) console.log(`[desktop] 已把 ${total} 条大块数据迁出为独立文件：`, r.moved)
    if (r.failed.length) lastError = `部分大块数据迁移失败（下次启动会重试）：${r.failed.join('；')}`
  } catch (e) {
    lastError = '大块数据迁移失败：' + (e instanceof Error ? e.message : String(e))
  }
}

/** 数据变更后安排一次防抖写盘（SAVE_DEBOUNCE_MS 内的连续修改合并为一次写入） */
function scheduleSave() {
  writeSeq++
  dirty = true
  if (saveTimer != null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = null; void flushDesktop() }, SAVE_DEBOUNCE_MS)
  emit()
}

/**
 * 把底层文件错误翻成**作者能照着做**的说法（3.2.2 · 审计 D4）。
 *
 * 审计现场：只读文件时界面弹的是 `EPERM: operation not permitted, rename …` ——
 * 作者看不懂该干什么。这里先给动作，原始错误仍附在后面（排查要用）。
 * @returns 可操作说明；认不出的错误返回 ''（调用方回落到原始信息）
 */
export function explainWriteError(raw: string): string {
  const s = String(raw ?? '')
  if (/EROFS/i.test(s)) return '目标磁盘是只读的（只读 U 盘 / 网络盘）—— 请换到可写目录'
  if (/ENOSPC/i.test(s)) return '磁盘空间不足 —— 请清理磁盘后重试'
  if (/EPERM|EACCES/i.test(s)) return '文件只读或没有写入权限（被设为只读、或被杀软/同步盘占用）—— 请恢复写权限后重试'
  if (/EBUSY/i.test(s)) return '文件正被其它程序占用（同步盘 / 杀毒软件）—— 请稍后重试'
  return ''
}

/**
 * 写盘失败的完整提示文案：`写入本地数据文件失败：<能照做的说明>（原始错误：…）`。
 * 抽成一行函数是为了让两条写盘路径（异步 / 关窗前同步）口径完全一致。
 */
function writeFailureText(raw: string | null | undefined): string {
  const why = explainWriteError(raw ?? '')
  return '写入本地数据文件失败：'
    + (why || raw || '未知错误')
    + (why && raw ? `（原始错误：${raw}）` : '')
}

/** 立即写盘（手动保存 / 导入后调用） */export async function flushDesktop(): Promise<boolean> {
  if (!inited || saving) return false
  if (writeLocked) return false // 🔴 锁定期绝不落盘（见 writeLocked 说明）
  saving = true
  // 写盘开始时的版本号：await 期间若又发生修改（writeSeq 递增），成功后不能清 dirty
  const seqAtStart = writeSeq
  emit()
  try {
    data.savedAt = Date.now()
    const r = await api().save(JSON.stringify(data))
    if (!r.ok) {
      lastError = writeFailureText(r.error)
      return false
    }
    savedSeq = seqAtStart
    dirty = writeSeq !== savedSeq
    lastSavedAt = Date.now()
    lastError = ''
    return true
  } finally {
    saving = false
    emit()
    if (dirty) scheduleSave()
  }
}

/** 窗口关闭前同步写盘（beforeunload 中调用，阻塞式保证写入完成） */
/**
 * 解读一次「同步写盘」的返回值。
 *
 * 🔴 这是**三态**语义，不是两态：
 *    · `{ ok:true }`  → 写成功；
 *    · `{ ok:false }` → 主进程明确报失败（**返回而不抛异常**）；
 *    · `undefined`    → **IPC 根本没返回值**（主进程监听缺失 / `sendSync` 取不到 returnValue），
 *                       同样是没写成功。
 *    旧写法 `if (r && r.ok === false)` 会让 undefined 落进成功分支、顺手清掉 `dirty`
 *    ⇒ 关窗前的最后一次编辑被静默丢弃（2026-09-23 六维审计 P2）。
 *
 * 抽成独立函数只是为了**能单独测**：真正容易写错的是这条三态语义，
 * 而它原先埋在 `flushDesktopSync` 里，测一次要模拟整个 Electron 环境。
 */
export function interpretSaveSyncResult(
  r: { ok: boolean; error: string | null } | undefined,
): { ok: boolean; error?: string } {
  if (!r) return { ok: false, error: 'IPC 未返回值' }
  if (r.ok === false) return { ok: false, error: r.error ?? '未知错误' }
  return { ok: true }
}

export function flushDesktopSync(): void {
  if (!DESKTOP || !inited || (!dirty && !saving)) return
  if (writeLocked) return // 🔴 锁定期绝不落盘
  data.savedAt = Date.now()
  try {
    // 🔴 判定走 interpretSaveSyncResult（三态都算清）—— 失败时**必须保留 dirty**，
    //    否则关窗前的最后一次编辑就没了。
    const verdict = interpretSaveSyncResult(api().saveSync(JSON.stringify(data)))
    if (!verdict.ok) {
      /**
       * 🔴 失败分支必须是 `return`（保留 dirty，供下次启动补救），不能继续往下清 dirty。
       * 文案里带可操作说明（只读/无权限/磁盘满）—— 原先只把 EPERM 原样抛给作者，看不懂。
       */
      lastError = writeFailureText(verdict.error)
      emit() // 🔴 窗口随后就关了，不广播的话这次失败谁都看不到
      return
    }
    savedSeq = writeSeq
    dirty = writeSeq !== savedSeq
  } catch (e) {
    // 🔴 同样保留 dirty；但必须落一条痕 —— 关窗路径上的失败若完全静默，
    //    作者只会得到「我最后那几段到底存没存」的永久疑问。
    lastError = '关窗前写盘失败：' + (e instanceof Error ? e.message : String(e))
    recordError('window', e) // kind 只有 render / window / unhandled；关窗路径归 window
    emit()
  }
}

/**
 * 导出全部数据为便携版数据文件（保存到 U 盘等任意位置，便携版可直接打开使用）。
 *
 * 🔴 2026-10-13：导出的副本**不含** AI 密钥 / 检索密钥（`strippedSecrets` 是剥掉的键名，
 *    供 UI 如实告知）。换机导入后需要重填一次模型配置 —— 这是刻意的安全取舍。
 */
export async function exportDesktopData(): Promise<{
  ok: boolean
  path?: string
  cancelled?: boolean
  error?: string
  /** 被剥掉的敏感 meta 键名（空数组 = 本机没有需要剥的） */
  strippedSecrets?: string[]
  /**
   * 读不出来、因此**没被带进导出包**的外置数据（3.2.2 · 审计 C1）。
   * 有值就说明这次是「部分导出」—— 界面不许再写"完整副本"。
   */
  missingSidecar?: SidecarExportIssue[]
}> {
  if (!DESKTOP || !inited) return { ok: false, error: '当前版本不支持导出数据文件（仅桌面版可用）' }
  // 🔴 锁写盘期间内存里是空库/残缺数据 —— 导出会造出一个**看起来正常**的空备份，
  //    用户拿它当保险反而把真数据的位置占了（提示语说好了「原文件不会被改动」）。
  if (writeLocked) {
    const msg = '数据文件读取失败期间不导出（内存里是空库/残缺数据）：请先按顶部红条提示备份原文件，或解除锁定后再导出'
    lastError = msg
    emit()
    return { ok: false, error: msg }
  }
  // 🔴 外置数据必须**内联回来**：否则导出的文件会静默丢掉全部备份载荷
  //    （列表还在、看起来正常，等要恢复时才说"载荷缺失"—— 最危险的失败形态）。
  // 🔴 同时**不改动**内存里的 `data.savedAt`（与便携版同口径，2026-10-11）：
  //    导出是纯读操作，改了它，导出的文件会声称"保存于此刻"，而磁盘上并没有这一刻的写入
  //    ⇒ 作者据此以为「已经存好了」，实际那份数据只在导出位置。
  const collected = await collectSidecarForExport(desktopStore, DESKTOP_SIDECAR)
  const inline = collected.data
  // 🔴🔴 2026-10-13（社区反馈）：导出前**剥掉敏感 meta**（AI 密钥 / 检索密钥）。
  //    这份副本被文案引导为「留档 / 搬机」，作者会把它丢进云盘、发给别人 ——
  //    而它原本是整库原样倒出，`meta.aiProviders` 里的 apiKey 明文一起走。
  //    换机代价：AI 模型配置需要重填一次（与云同步同一取舍：密钥不离开本机）。
  //    ⚠️ stripSensitiveMeta **返回新对象**，不会动内存里的 data —— 见该函数注释。
  const { stores, removed } = stripSensitiveMeta({ ...data.stores, ...inline })
  const snapshot = { ...data, savedAt: Date.now(), stores }
  try {
    const p = await api().exportFile(JSON.stringify(snapshot))
    // 🔴 2026-10-07 六维审计 P2：取消与失败**必须分开返回** —— 混成一个 null 会让
    //    「用户点了取消」和「真的出错了」在界面上长得一模一样（口径与 exportPdfDocument 对齐）。
    if (!p) return { ok: false, cancelled: true }
    /**
     * 🔴 3.2.2（审计 C1 · P1）：**完整性必须回传**。
     *    以前只要写文件成功就报"已导出全部数据 / 这就是本机数据的完整副本"，
     *    哪怕某份历史备份读不出来（审计实测：2 份里坏 1 份 ⇒ 两份都没带走，界面照样说完整）。
     *    `missingSidecar` 非空时，界面必须改说"部分导出、缺了什么"，不能再用完整措辞。
     */
    return {
      ok: true, path: p, strippedSecrets: removed,
      ...(collected.complete ? {} : { missingSidecar: collected.issues }),
    }
  } catch (e) {
    const msg = '导出失败：' + (e instanceof Error ? e.message : String(e))
    lastError = msg
    emit()
    return { ok: false, error: msg }
  }
}

/**
 * 把一段 HTML 存成 PDF（**桌面版专属**；便携版是单文件 HTML、跑在浏览器里，没有主进程调不了）。
 *
 * 失败与取消**必须分开返回**：取消是正常操作，失败要说清原因 ——
 * 混成一个 null 会让「用户点了取消」和「真的出错了」在界面上长得一模一样。
 */
export async function exportPdfDocument(
  html: string, defaultName: string,
): Promise<{ ok: boolean; path?: string; cancelled?: boolean; error?: string }> {
  if (!DESKTOP || !window.electronStore?.exportPdf) {
    return { ok: false, error: '当前版本不支持直接存 PDF（仅桌面版可用）' }
  }
  try {
    const p = await window.electronStore.exportPdf(html, defaultName)
    if (!p) return { ok: false, cancelled: true }
    return { ok: true, path: p }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 从便携版数据文件导入：校验并替换本机全部数据。成功后应刷新页面重新加载 */
export async function importDesktopData(): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
  if (!DESKTOP || !inited) return { ok: false, error: '桌面存储未就绪' }
  let text: string | null = null
  try {
    text = await api().importFile()
  } catch (e) {
    return { ok: false, error: '读取所选文件失败：' + (e instanceof Error ? e.message : String(e)) }
  }
  if (text == null) return { ok: false, cancelled: true }
  if (!text.trim()) return { ok: false, error: '所选文件是空文件' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: '数据文件已损坏（JSON 解析失败）' }
  }
  const o = parsed as PortableData
  if (o.app !== 'youth-fantasy-engine' || o.kind !== 'portable-data') {
    // OPT-011：拿错文件时给指路（单本书备份 ⇒ 去项目中心导入），别只甩一句格式不对
    const guide = describeDataFileReject(parsed)
    return { ok: false, error: guide ?? '这不是有效的小说工坊数据文件（请选择便携版创建的 .json 数据文件）' }
  }
  // 🔴 格式版本闸必须在 `data = ...` 之前（理由同便携版：替换后再拒绝就晚了）
  const versionProblem = describeFileVersionProblem(parsed)
  if (versionProblem) return { ok: false, error: `${versionProblem}；已取消导入，本机数据未改动。` }
  data = normalizePortableData(parsed)
  invalidateStorageContext()
  dirty = true
  // 🔴 导入一个**校验通过**的数据文件正是「锁写盘」的恢复手段：锁着 flushDesktop 直接返回 false，
  //    导入的数据根本落不了盘（用户只会看到「写入本地数据失败」，莫名其妙）。
  //    用户是拿合法文件主动覆盖，这份数据就是他要的 —— 显式解锁。
  if (writeLocked) unlockDesktopWrite()
  // 🔴 导入 = 用这份文件**替换**本机全部数据 ⇒ 旧的删除记忆必须一并作废：
  //    否则「导入前删过、而这份文件里恰好又有同 id 的记录」会被旧墓碑挡住 —— 记录明明导进来了，
  //    却永远复活不了（删得掉、进不来的死记录）。与 `syncCore` 换云端时的 resetTombs 同口径。
  resetTombs()
  // 导入的文件里外置数据是**内联**的 ⇒ 拆开落盘（与老库升级同一条路径，幂等）
  await migrateDesktopSidecar()
  const ok = await flushDesktop()
  return ok ? { ok: true } : { ok: false, error: lastError || '写入本地数据失败' }
}

/** 在资源管理器中显示本地数据文件（手动备份用） */
export async function revealDesktopDataFile(): Promise<void> {
  if (DESKTOP) await api().revealDataFile()
}

/**
 * 本机数据文件的完整路径（拿不到返回 null）。
 * 用于「别把云盘同步目录选成数据文件所在目录」这类互斥校验：
 * 明文库（含 apiKey）与加密 .yfe 混在一个目录，会被网盘客户端一起传上去，两边还会互相覆盖。
 */
export async function getDesktopDataFilePath(): Promise<string | null> {
  if (!DESKTOP) return null
  try {
    const p = await api().dataPath()
    return typeof p === 'string' && p ? p : null
  } catch {
    return null
  }
}

/** 选择数据文件的新存放位置（返回完整文件路径，取消返回 null） */
export async function chooseDesktopDataDir(): Promise<string | null> {
  if (!DESKTOP) return null
  try {
    return await api().chooseDataDir()
  } catch {
    return null
  }
}

/**
 * 把数据文件迁到新位置并立即生效。
 *
 * 目标已存在数据文件时「改用那份」（adopted=true）——这正是第二台设备的标准用法：
 * 把位置指到同一个云盘目录，直接接管另一台设备同步过来的数据，而不是覆盖它。
 *
 * 调用方在成功后应重新加载应用（location.reload()）让新路径生效。
 */
export async function relocateDesktopDataFile(
  target: string,
): Promise<{ ok: boolean; path: string; adopted: boolean; copied: number; error?: string }> {
  if (!DESKTOP || !inited) return { ok: false, path: '', adopted: false, copied: 0, error: '桌面存储未就绪' }
  // 🔴 锁定期换位置＝把「空库/残缺数据」写成新位置的一份有效文件（原文件虽保留，
  //    但用户会以为数据搬过去了）。要换就先按顶部红条显式解除锁定。
  if (writeLocked) {
    return { ok: false, path: '', adopted: false, copied: 0, error: '数据文件读取失败期间不能更换存放位置：请先按顶部红条处理原文件，或解除锁定后再试' }
  }
  await flushDesktop() // 先把内存数据落盘，避免带着未保存改动换位置
  data.savedAt = Date.now()
  const r = await api().setDataPath(target, JSON.stringify(data))
  if (!r.ok) return { ok: false, path: '', adopted: false, copied: 0, error: r.error ?? '未知错误' }
  dataFilePath = r.path
  isCustomPath = true
  invalidateStorageContext()
  return { ok: true, path: r.path, adopted: r.adopted, copied: r.copied ?? 0 }
}

/** 恢复默认存放位置（userData 目录）。原位置的数据文件不会被删除。 */
export async function resetDesktopDataPath(): Promise<{ ok: boolean; path: string; adopted: boolean; copied: number; error?: string }> {
  if (!DESKTOP || !inited) return { ok: false, path: '', adopted: false, copied: 0, error: '桌面存储未就绪' }
  // 同 relocateDesktopDataFile：锁定期不落盘
  if (writeLocked) {
    return { ok: false, path: '', adopted: false, copied: 0, error: '数据文件读取失败期间不能恢复默认位置：请先按顶部红条处理原文件，或解除锁定后再试' }
  }
  await flushDesktop()
  data.savedAt = Date.now()
  const r = await api().resetDataPath(JSON.stringify(data))
  if (!r.ok) return { ok: false, path: '', adopted: false, copied: 0, error: r.error ?? '未知错误' }
  dataFilePath = r.path
  isCustomPath = false
  invalidateStorageContext()
  return { ok: true, path: r.path, adopted: r.adopted, copied: r.copied ?? 0 }
}

// ---------- 外置大块数据（sidecar）----------
//
// 🔴 桌面版**只外置 backupPayloads**，与便携版（还外置向量 / 知识库）**不同**，这是刻意的：
//    桌面端的语义向量与参考资料本来就在**两个独立 IndexedDB 库**里（`-vec` / `-kb`），
//    刻意不入整库 JSON（见 storage/portableVecKb.ts 头部的红线说明）⇒ 桌面端没有这个包袱。
//    便携版把那两库搬进整库 JSON 只是因为「IDB 不跟 U 盘走」，如今同样换成外置文件即可，
//    两端于是回到同一个语义：**大块数据都不进主 JSON**。
export const DESKTOP_SIDECAR: SidecarSpec = {
  backupPayloads: { layout: 'per-id', keyField: 'id' },
}

/** 外置通道的 IPC 实现（对应 main.cjs 的 `payload:*`） */
const ipcSidecarApi: SidecarApi = {
  async read(store, id) {
    const r = await api().payloadRead(store, id)
    if (r.missing) return undefined
    if (!r.ok) throw new Error('外置载荷读取失败')
    return r.value
  },
  async write(store, id, value) {
    try {
      const r = await api().payloadWrite(store, id, JSON.stringify(value))
      return r.ok
    } catch {
      return false
    }
  },
  async remove(store, id) {
    try {
      const r = await api().payloadDel(store, id)
      return r.ok
    } catch {
      return false
    }
  },
  async listIds(store) {
    const r = await api().payloadList(store)
    if (!r.ok || !Array.isArray(r.ids)) throw new Error('外置载荷目录读取失败')
    return r.ids
  },
}

let activeSidecarApi: SidecarApi = ipcSidecarApi
/** 测试注入点：换成内存实现（单测进程里没有主进程 IPC） */
export function setDesktopSidecarApi(a: SidecarApi): void { activeSidecarApi = a }
/** 复位回 IPC 实现（测试收尾用） */
export function resetDesktopSidecarApi(): void { activeSidecarApi = ipcSidecarApi }
/** 🔴 必须是代理：`withSidecar` 只在模块级调用一次，直接传会把实现固化进闭包 */
const sidecarProxy: SidecarApi = {
  read: (s, i) => activeSidecarApi.read(s, i),
  write: (s, i, v) => activeSidecarApi.write(s, i, v),
  remove: (s, i) => activeSidecarApi.remove(s, i),
  listIds: (s) => activeSidecarApi.listIds(s),
}

/** 原生的（未外置）桌面存储原语实现（内存数据 + 防抖写回本地数据文件） */
const baseDesktopStore: StoreOps = {
  async getAll<T>(store: string): Promise<T[]> {
    return Object.values((data.stores[store] ?? {}) as Record<string, T>)
  },
  async get<T>(store: string, key: string): Promise<T | undefined> {
    return (data.stores[store] ?? {})[key] as T | undefined
  },
  async put(store: string, value: unknown): Promise<void> {
    const kp = KEY_PATHS[store] ?? 'id'
    const key = String((value as Record<string, unknown>)[kp])
    const st = data.stores[store] ?? (data.stores[store] = {})
    st[key] = value
    // 🔴 写回同 key → 清墓碑（允许「删掉之后又重建」）
    clearDeleted(store, [key])
    scheduleSave()
  },
  async del(store: string, key: string): Promise<void> {
    const st = data.stores[store]
    const had = !!st && key in st
    if (had && st) delete st[key]
    // 🔴 记墓碑**不能以「本地此刻有这条记录」为前提**（2026-10-04 六维审计）：
    //    · 关闭同步期间（走本地库）的删除必须记住，否则重开同步后云端那份旧记录会在合并时
    //      被判成「另一端新增」而复活（幽灵项目，2026-09-19）；
    //    · 云端闩锁期（云端不可用，`db/core` 的 cloudOrLocal 把 del 回退到本地）删一条
    //      **只存在于云端、本地缓存里没有**的记录时，`key in st` 为假 —— 老写法整段跳过，
    //      这次删除被静默吞掉，下次合并又把云端那份带回来。
    //    meta 不记墓碑（它是配置载体、不是同步记录），但仍按是否真有改动决定落盘。
    if (store !== 'meta') { markDeleted(store, [key]); scheduleSave() }
    else if (had) scheduleSave()
  },
  async getAllByIndex<T>(store: string, indexName: string, value: unknown): Promise<T[]> {
    const all = Object.values((data.stores[store] ?? {}) as Record<string, Record<string, unknown>>)
    return all.filter(r => r[indexName] === value) as T[]
  },
  async bulkPut(store: string, values: unknown[]): Promise<void> {
    const kp = KEY_PATHS[store] ?? 'id'
    for (const v of values) {
      const key = String((v as Record<string, unknown>)[kp])
      const st = data.stores[store] ?? (data.stores[store] = {})
      st[key] = v
    }
    clearDeleted(store, values.map((v) => String((v as Record<string, unknown>)[kp])))
    scheduleSave()
  },
  async bulkDel(store: string, keys: (string | number)[]): Promise<void> {
    const st = data.stores[store]
    let changed = false
    if (st) {
      for (const k of keys) {
        if (k in st) { delete st[k]; changed = true }
      }
    }
    // 🔴 同 `del`：墓碑不以「本地真删到了东西」为前提 ——
    //    云端闩锁期批量删「只在云端的记录」同样要留痕，否则整批删除被静默吞掉。
    if (store !== 'meta') { markDeleted(store, keys); scheduleSave() }
    else if (changed) scheduleSave()
  },
}

/**
 * 桌面版 StoreOps = 原生后端 + 外置路由（backupPayloads 走独立文件）。
 * 🔴 外置写失败要**看得见**：静默失败会让「备份列表在、恢复时说载荷缺失」，
 *    作者无从判断是没存还是丢了 ⇒ 接到 lastError，与写盘失败同一条反馈通道。
 */
export const desktopStore: StoreOps = withSidecar(
  baseDesktopStore,
  sidecarProxy,
  DESKTOP_SIDECAR,
  (msg) => { lastError = msg; emit() },
)
// 登记通道：业务层要「列外置 id」做孤儿对账（与便携版互斥，故共用一个槽位无冲突）。
// 🔴 同样必须**只在桌面模式下登记**（见 fileBackend 同款注释：无条件登记会被后加载者顶掉）。
if (DESKTOP) registerSidecarApi(sidecarProxy)
