// 桌面（Electron 安装版）存储引擎
// 数据以单个 JSON 文件保存在本机用户数据目录
// （Windows: C:\Users\<用户>\AppData\Roaming\青春幻想引擎\novel-studio-data.json），
// 通过 preload 注入的 window.electronStore IPC 读写。
//
// 数据格式（`PortableData`，kind='portable-data'）沿用自便携版，**名字不要改**：
// 它是写进用户数据文件的字面量，改名会让老数据文件无法被识别。
// 桌面版「导出数据文件 / 导入数据文件」即基于该格式，可在设备间手工搬运。
import type { StoreOps, PortableData } from './storeOps'
import { normalizePortableData, isPortableDataFile } from './storeOps'
import { SAVE_DEBOUNCE_MS } from './constants'
import { markDeleted, clearDeleted } from './syncTombstone'

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
  /** 迁移数据文件到新位置；adopted=目标已有数据文件、改用那份 */
  setDataPath(target: string, text: string): Promise<{ ok: boolean; path: string; adopted: boolean; error: string | null }>
  /** 恢复默认存放位置 */
  resetDataPath(text: string): Promise<{ ok: boolean; path: string; adopted: boolean; error: string | null }>
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

declare global {
  interface Window {
    electronStore?: ElectronStoreAPI
    electronNet?: ElectronNetAPI
    electronWindow?: ElectronWindowAPI
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

let data: PortableData = { app: 'novel-studio', kind: 'portable-data', fileVersion: 1, savedAt: 0, stores: {} }
let inited = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving = false
let dirty = false
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
export async function initDesktopStore(): Promise<void> {
  if (!DESKTOP || inited) return
  const lock = (why: string, msg: string) => {
    writeLocked = true
    writeLockReason = why
    lastError = msg
  }
  try {
    const r = await api().load()
    dataFilePath = r.path
    try {
      isCustomPath = (await api().isCustomPath()) === true
    } catch {
      isCustomPath = false
    }
    // 只有明确知道"文件在"时才做危险判定（旧 preload 无此字段 → missing 为 undefined）。
    // 🔴 审计 2026-09-17（P2-11）：missing 未知时**不能直接当「首次使用」放行写盘** ——
    //    旧 preload 配新渲染层、而文件其实存在（r.text 有内容）时，`!fileExists` 分支会先于
    //    下面的文本解析命中 → 内存空库被允许写盘 → 覆盖真实文件。故 missing 未知时以「有非空文本」
    //    为「文件存在」的判据，让文本解析那条路接管。
    const hasText = !!(r.text && r.text.trim())
    const fileExists = r.missing === false || (r.missing === undefined && hasText)
    if (r.error) {
      lock(
        `数据文件读取失败：${r.error}`,
        `读取本地数据文件失败：${r.error}。为免用空库覆盖原文件，已暂停写入。`,
      )
    } else if (!fileExists) {
      // 首次使用（文件还不存在）：空库启动属正常，可以写
    } else if (r.text && r.text.trim()) {
      try {
        const parsed: unknown = JSON.parse(r.text)
        // 🔴 解析成功 ≠ 是本软件的数据文件（2026-09-20 六维审计 P1-2）：见 isPortableDataFile 的说明。
        //    漏这一步的后果不是"报错"，而是**静默覆盖** —— 误放的文件被当空库放行、不锁写盘，
        //    随后第一次防抖写盘就把真实数据文件写没了。
        if (!isPortableDataFile(parsed)) {
          lock(
            '数据文件缺少本软件的格式标识（kind="portable-data"）',
            '本地数据文件不是本软件写出的（缺少格式标识）。为免覆盖它，已暂停写入。',
          )
        } else {
          data = normalizePortableData(parsed)
          lastSavedAt = data.savedAt || Date.now()
        }
      } catch {
        lock(
          '数据文件内容不是有效的 JSON（可能被云盘客户端同步截断，或磁盘损坏）',
          '本地数据文件已损坏（JSON 解析失败）。为免覆盖原文件，已暂停写入。',
        )
      }
    } else {
      lock(
        '数据文件存在但内容为空（可能云盘正在同步、或上次写入被中断）',
        '本地数据文件为空。为免覆盖原文件，已暂停写入。',
      )
    }
  } catch (e) {
    lock(
      '读取数据文件时发生异常',
      `读取数据文件异常：${e instanceof Error ? e.message : String(e)}。为免覆盖原文件，已暂停写入。`,
    )
  } finally {
    inited = true
    emit()
  }
}

/** 数据变更后安排一次防抖写盘（SAVE_DEBOUNCE_MS 内的连续修改合并为一次写入） */
function scheduleSave() {
  dirty = true
  if (saveTimer != null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = null; void flushDesktop() }, SAVE_DEBOUNCE_MS)
  emit()
}

/** 立即写盘（手动保存 / 导入后调用） */
export async function flushDesktop(): Promise<boolean> {
  if (!inited || saving) return false
  if (writeLocked) return false // 🔴 锁定期绝不落盘（见 writeLocked 说明）
  saving = true
  emit()
  try {
    data.savedAt = Date.now()
    const r = await api().save(JSON.stringify(data))
    if (!r.ok) {
      lastError = '写入本地数据文件失败：' + (r.error ?? '未知错误')
      return false
    }
    dirty = false
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
      lastError = '写入本地数据文件失败：' + verdict.error
      return // 保留 dirty，供下次启动补救
    }
    dirty = false
  } catch {
    /* IPC 层抛异常：同样保留 dirty */
  }
}

/** 导出全部数据为便携版数据文件（保存到 U 盘等任意位置，便携版可直接打开使用） */
export async function exportDesktopData(): Promise<string | null> {
  if (!DESKTOP || !inited) return null
  // 🔴 锁写盘期间内存里是空库/残缺数据 —— 导出会造出一个**看起来正常**的空备份，
  //    用户拿它当保险反而把真数据的位置占了（提示语说好了「原文件不会被改动」）。
  if (writeLocked) {
    lastError = '数据文件读取失败期间不导出（内存里是空库/残缺数据）：请先按顶部红条提示备份原文件，或解除锁定后再导出'
    emit()
    return null
  }
  data.savedAt = Date.now()
  try {
    return await api().exportFile(JSON.stringify(data))
  } catch (e) {
    lastError = '导出失败：' + (e instanceof Error ? e.message : String(e))
    emit()
    return null
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
  if (o.app !== 'novel-studio' || o.kind !== 'portable-data') {
    return { ok: false, error: '这不是有效的小说工坊数据文件（请选择便携版创建的 .json 数据文件）' }
  }
  data = normalizePortableData(parsed)
  dirty = true
  // 🔴 导入一个**校验通过**的数据文件正是「锁写盘」的恢复手段：锁着 flushDesktop 直接返回 false，
  //    导入的数据根本落不了盘（用户只会看到「写入本地数据失败」，莫名其妙）。
  //    用户是拿合法文件主动覆盖，这份数据就是他要的 —— 显式解锁。
  if (writeLocked) unlockDesktopWrite()
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
): Promise<{ ok: boolean; path: string; adopted: boolean; error?: string }> {
  if (!DESKTOP || !inited) return { ok: false, path: '', adopted: false, error: '桌面存储未就绪' }
  // 🔴 锁定期换位置＝把「空库/残缺数据」写成新位置的一份有效文件（原文件虽保留，
  //    但用户会以为数据搬过去了）。要换就先按顶部红条显式解除锁定。
  if (writeLocked) {
    return { ok: false, path: '', adopted: false, error: '数据文件读取失败期间不能更换存放位置：请先按顶部红条处理原文件，或解除锁定后再试' }
  }
  await flushDesktop() // 先把内存数据落盘，避免带着未保存改动换位置
  data.savedAt = Date.now()
  const r = await api().setDataPath(target, JSON.stringify(data))
  if (!r.ok) return { ok: false, path: '', adopted: false, error: r.error ?? '未知错误' }
  dataFilePath = r.path
  isCustomPath = true
  return { ok: true, path: r.path, adopted: r.adopted }
}

/** 恢复默认存放位置（userData 目录）。原位置的数据文件不会被删除。 */
export async function resetDesktopDataPath(): Promise<{ ok: boolean; path: string; adopted: boolean; error?: string }> {
  if (!DESKTOP || !inited) return { ok: false, path: '', adopted: false, error: '桌面存储未就绪' }
  // 同 relocateDesktopDataFile：锁定期不落盘
  if (writeLocked) {
    return { ok: false, path: '', adopted: false, error: '数据文件读取失败期间不能恢复默认位置：请先按顶部红条处理原文件，或解除锁定后再试' }
  }
  await flushDesktop()
  data.savedAt = Date.now()
  const r = await api().resetDataPath(JSON.stringify(data))
  if (!r.ok) return { ok: false, path: '', adopted: false, error: r.error ?? '未知错误' }
  dataFilePath = r.path
  isCustomPath = false
  return { ok: true, path: r.path, adopted: r.adopted }
}

/** 桌面模式下的存储原语实现（内存数据 + 防抖写回本地数据文件） */
export const desktopStore: StoreOps = {
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
    if (st && key in st) {
      delete st[key]
      // 🔴 记墓碑：关闭同步期间（走本地库）的删除同样要记住，否则重开同步后
      //    云端那份旧记录会在合并时被判成「另一端新增」而复活（幽灵项目，2026-09-19）。
      if (store !== 'meta') markDeleted(store, [key])
      scheduleSave()
    }
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
    if (!st) return
    let changed = false
    for (const k of keys) {
      if (k in st) { delete st[k]; changed = true }
    }
    if (changed) {
      if (store !== 'meta') markDeleted(store, keys)
      scheduleSave()
    }
  },
}
