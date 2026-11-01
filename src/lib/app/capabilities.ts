// ============ C4 · 端能力契约（3.3.4）============
//
// 一份矩阵回答三件事：**这项能力在当前形态能不能用、为什么不能用、能用走哪条通道**。
// 界面入口、设置页与手册的环境说明都消费**同一份解析结果** —— 不许各自写一套平台判断
// （规划 §6，且本项目已经吃过一次「三处各写一版撤销文案」的教训）。
//
// 🔴 两条口径必须分开（规划 §6）：
//   ① `policy-blocked` —— 平台其实做得到，但**本产品不给**（例：P9 网页版本机模型）；
//   ② `platform-missing` —— 环境本身没有这条通道（例：浏览器没有 electronBoss 桥）。
//   把 ② 说成 ① 会让作者以为「换个浏览器就行了」，把 ① 说成 ② 会被当成 bug 反复报。
//   判序固定「先策略、后能力」：策略禁用时不再讨论平台能不能做（条件可达不能越过 P9）。
//
// 🔴 本模块是**纯解析**：不读 window、不碰网络、不 import 任何 UI 或存储模块。
//   运行时的布尔值由 `capabilitySignals.ts` 从既有判定取来填 —— 平台判断表只能有一张。

export type CapabilityId =
  | 'boss-key'
  | 'fullscreen'
  | 'pdf-export'
  | 'file-download'
  | 'local-model'
  | 'offline-edit'
  | 'offline-cold-start'
  | 'durable-save'
  | 'cloud-sync'

/** 四态：supported 可用 · conditional 有条件可用 · unsupported 不可用 · unknown 待确认（探测不出） */
export type CapabilityStatus = 'supported' | 'conditional' | 'unsupported' | 'unknown'

/** 原因码。界面与手册共用这些码，不各写一句话（规划 §6 末段） */
export type CapabilityReason =
  | 'ok'
  /** 产品策略禁用：平台做得到，本产品明确不给 */
  | 'policy-blocked'
  /** 平台不具备：环境里没有这条通道（缺桥 / 缺 API） */
  | 'platform-missing'
  /** 平台具备、本版尚未接入口（P3 待补，不是「做不到」） */
  | 'not-implemented'
  /** 需要联网 */
  | 'needs-online'
  /** 需要账号（游客模式没有） */
  | 'needs-account'
  /** 权限/用户拒绝（全屏被拒、系统权限未授予） */
  | 'permission-denied'
  /** 探测不出，待确认 —— 只能标待验，不能当通过 */
  | 'unverified'

/** 运行通道 */
export type CapabilityChannel =
  | 'electron-ipc'
  | 'browser-api'
  | 'browser-print'
  | 'local-store'
  | 'server-http'
  | 'file-share'
  | 'none'

export interface CapabilitySignals {
  /** platform.ts 的 WEB / WEB_GUEST / WEB_CLOUD */
  web: boolean
  guest: boolean
  cloud: boolean
  /** env.ts 的 DESKTOP / fileBackend 的 PORTABLE */
  desktop: boolean
  portable: boolean
  /** bossKey.ts 的 bossKeyMode() 结果 —— 已有判定，直接复用，不在这里重算 */
  bossMode: 'desktop' | 'overlay' | 'unsupported'
  /** preload 注入的桥（逐个探，缺一个就是那种能力没有，不能互相当证据） */
  bridgeStore: boolean
  bridgeNet: boolean
  bridgePdf: boolean
  /** document.fullscreenEnabled 与元素 requestFullscreen 是否都在 */
  fullscreenApi: boolean
  /** a[download] + URL.createObjectURL 是否可用 */
  downloadApi: boolean
  /** navigator.onLine（只作输入之一，不单独决定任何能力） */
  online: boolean
  /** 跨设备同步通道：云盘文件 / WebDAV / S3 / 服务器 */
  syncChannel: 'file' | 'webdav' | 's3' | 'server' | 'none'
}

export interface Capability {
  id: CapabilityId
  status: CapabilityStatus
  reason: CapabilityReason
  channel: CapabilityChannel
  /** 可用动作（键），界面据此决定按钮与说明 */
  actions: readonly string[]
  /** 不可用时的回退键；null = 没有回退 */
  fallback: string | null
  /** 面向作者的一句话（含「为什么」）。界面与手册都直接用它，避免两处措辞不一致 */
  detail: string
}

export type CapabilityMap = Record<CapabilityId, Capability>

/** 能力显示名（设置页、手册环境说明共用） */
export const CAPABILITY_LABEL: Record<CapabilityId, string> = {
  'boss-key': '老板键',
  fullscreen: '全屏',
  'pdf-export': '导出 PDF',
  'file-download': '文件下载',
  'local-model': '本机 / 局域网模型',
  'offline-edit': '离线继续编辑',
  'offline-cold-start': '断网冷启动',
  'durable-save': '保存落盘',
  'cloud-sync': '跨设备同步',
}

/** 状态显示名（不是「支持/不支持」两分，条件与待确认各说各话） */
export const STATUS_LABEL: Record<CapabilityStatus, string> = {
  supported: '支持',
  conditional: '有条件支持',
  unsupported: '不支持',
  unknown: '待确认',
}

/** 原因显示名 —— 尤其把「策略不给」与「平台没有」在界面上分开 */
export const REASON_LABEL: Record<CapabilityReason, string> = {
  ok: '',
  'policy-blocked': '产品策略暂不提供',
  'platform-missing': '当前运行环境不支持',
  'not-implemented': '本版尚未接入',
  'needs-online': '需要联网',
  'needs-account': '需要登录账号',
  'permission-denied': '权限被拒绝',
  unverified: '尚未验证',
}

/** 是否是「没做到」而不是「办不到」—— 用于给作者的建议措辞 */
export function isFixableGap(reason: CapabilityReason): boolean {
  return reason === 'needs-online' || reason === 'needs-account' || reason === 'permission-denied' || reason === 'not-implemented'
}

const cap = (
  id: CapabilityId, status: CapabilityStatus, reason: CapabilityReason,
  channel: CapabilityChannel, actions: readonly string[], fallback: string | null, detail: string,
): Capability => ({ id, status, reason, channel, actions, fallback, detail })

/**
 * 解析矩阵。**顺序即判序**：先看产品策略，再看平台通道，最后看外部条件（联网/账号/权限）。
 * 新增能力时同步改这里与 `CAPABILITY_LABEL`，并在 `ATLAS` 之外别再开第二份清单。
 */
export function resolveCapabilities(s: CapabilitySignals): CapabilityMap {
  const browserish = !s.desktop && !s.portable

  // —— 老板键：桌面有窗口隐藏，其余形态只有页内遮挡（这是产品能力差异，不是策略禁用）
  const bossKey = s.bossMode === 'desktop'
    ? cap('boss-key', 'supported', 'ok', 'electron-ipc', ['hide-window', 'restore-window'], null,
      '按快捷键立即隐藏本应用窗口（含任务栏按钮），再按同一组合恢复。隐藏不是密码锁：任务管理器、系统历史与录屏仍可能看到。')
    : s.bossMode === 'overlay'
      ? cap('boss-key', 'conditional', 'platform-missing', 'browser-api', ['cover-page'], 'focus-page',
        '当前形态只能用一块遮挡屏盖住页面：浏览器标签名称、窗口与任务栏图标仍可见，页面没有焦点时快捷键不生效。')
      : cap('boss-key', 'unsupported', 'platform-missing', 'none', [], null,
        s.desktop
          ? '这个安装包的桌面壳没有窗口隐藏能力（旧版 preload），更新到较新版本才可用。'
          : '当前形态不支持老板键。')

  // —— 全屏：桌面走窗口桥（C2 待接），浏览器走 Fullscreen API；有 API 不等于本次获准
  const fullscreen = s.desktop
    ? cap('fullscreen', 'unknown', 'not-implemented', 'electron-ipc', ['enter-fullscreen', 'exit-fullscreen'], 'focus-mode',
      '桌面版的全屏入口将在本版接入（C2）；在此之前可使用现有的专注布局。')
    : s.fullscreenApi
      ? cap('fullscreen', 'conditional', 'ok', 'browser-api', ['enter-fullscreen', 'exit-fullscreen'], 'focus-mode',
        '按运行时接口进入全屏；能否真正进入取决于本页权限与浏览器策略，被拒绝时会给出提示。没有全屏时用「专注模式」，它不会隐藏地址栏。')
      : cap('fullscreen', 'unsupported', 'platform-missing', 'none', [], 'focus-mode',
        '当前浏览器不提供全屏接口，可用「专注模式」代替（它不隐藏地址栏，也不等于全屏）。')

  // —— 导出 PDF：桌面有直接落盘的 PDF 通道；浏览器打印入口尚未接入（C2）
  const pdfExport = s.bridgePdf
    ? cap('pdf-export', 'supported', 'ok', 'electron-ipc', ['export-pdf'], null,
      '直接生成 PDF 并由你选择保存位置；中文走系统字体，不会出现方块字。')
    : browserish
      ? cap('pdf-export', 'unknown', 'not-implemented', 'browser-print', ['open-print-page'], 'export-html',
        '网页版尚未接入打印入口；现在可以先导出 HTML（同一份证据快照），再用浏览器打印 / 另存为 PDF。')
      : cap('pdf-export', 'unsupported', 'platform-missing', 'none', [], 'export-html',
        '当前形态没有 PDF 通道，可导出 HTML 后自行打印。')

  const fileDownload = s.downloadApi
    ? cap('file-download', 'supported', 'ok', 'browser-api', ['download'], null,
      '下载到本机，保存位置由浏览器设置决定（手机端可能进入「文件」或分享面板）。')
    : cap('file-download', 'unsupported', 'platform-missing', 'none', [], null,
      '当前环境不支持浏览器下载，导出功能不可用。')

  // —— 本机模型：P9 是**产品策略**，不是平台做不到（规划 §5 明确要求这个区分）
  const localModel = (s.web)
    ? cap('local-model', 'unsupported', 'policy-blocked', 'none', [], 'use-remote-model',
      '网页版不提供本机 / 局域网模型连接（产品策略）：浏览器无法稳定访问本机服务。请改用联网模型，或使用桌面版 / 便携版。手机上的 localhost 指手机自己，不要填电脑的模型地址。')
    : cap('local-model', 'supported', 'ok', s.portable ? 'browser-api' : 'browser-api', ['test', 'use-for-generation', 'use-for-embedding'], null,
      s.portable
        ? '可用本机 / 局域网模型；便携版跑在系统浏览器里，仍受同源策略约束，地址不可达时按网络错误提示。'
        : '可用本机 / 局域网模型（Ollama、LM Studio、LocalAI 等）。')

  // —— 离线写作三段要分开（规划 §6：不能由 local-first 推出离线冷启动一定可用）
  const offlineEdit = cap('offline-edit', 'supported', 'ok', 'local-store', ['edit-loaded-page'], null,
    '页面已加载时断网仍可继续编辑；保存能否落盘见「保存落盘」一项。')

  const offlineColdStart = s.cloud
    ? cap('offline-cold-start', 'conditional', 'needs-online', 'server-http', [], 'use-guest-or-desktop',
      '云端账号模式首次打开需要联网拉取项目；断网冷启动不可用（本版不做离线冷启动）。')
    : cap('offline-cold-start', 'supported', 'ok', s.guest ? 'local-store' : 'local-store', ['open-without-network'], null,
      s.guest ? '游客模式数据在浏览器本地，断网也能打开。' : '数据在本机文件，断网也能打开。')

  const durableSave = s.cloud
    ? (s.online
      ? cap('durable-save', 'supported', 'ok', 'server-http', ['save'], null,
        '保存写入账号云端，界面显示已保存后才算落盘。')
      : cap('durable-save', 'conditional', 'needs-online', 'server-http', [], 'retry-when-online',
        '云端账号模式保存需要联网：断网时草稿保留在本机并显示未保存，恢复联网后重试；已显示保存成功的内容才保证重开存在。'))
    : cap('durable-save', 'supported', 'ok', 'local-store', ['save'], null,
      '保存写入本机数据，界面显示已保存后才算落盘。')

  // —— 跨设备同步：游客没有账号；桌面/便携走云盘文件；云端走服务器
  const cloudSync = s.cloud
    ? (s.syncChannel === 'server'
      ? cap('cloud-sync', 'supported', 'ok', 'server-http', ['sync-up', 'sync-down'], null,
        '同步到账号云端，可在其他设备登录同一账号取回。')
      : cap('cloud-sync', 'unsupported', 'platform-missing', 'none', [], null,
        '当前部署没有开启服务器同步通道，跨设备同步不可用。'))
    : s.guest
      ? cap('cloud-sync', 'unsupported', 'needs-account', 'none', [], 'login',
        '游客模式的数据只在当前浏览器，不能跨设备同步；登录账号后可使用云端同步。')
      : s.syncChannel === 'none'
        ? cap('cloud-sync', 'unknown', 'unverified', 'none', [], 'choose-sync-dir',
          '还未选择同步目录：选一次后即可用云盘客户端跨设备搬运（本项目不经过自家服务器）。')
        : cap('cloud-sync', 'supported', 'ok', s.syncChannel === 'file' ? 'file-share' : 'browser-api',
          ['sync-up', 'sync-down'], null,
          `通过${s.syncChannel === 'file' ? '你选择的云盘同步目录' : s.syncChannel === 'webdav' ? ' WebDAV ' : ' S3 '}跨设备同步（不经过本项目服务器）。`)

  return {
    'boss-key': bossKey,
    fullscreen,
    'pdf-export': pdfExport,
    'file-download': fileDownload,
    'local-model': localModel,
    'offline-edit': offlineEdit,
    'offline-cold-start': offlineColdStart,
    'durable-save': durableSave,
    'cloud-sync': cloudSync,
  }
}

/** 单查一项（消费者最常用） */
export function capabilityOf(id: CapabilityId, signals: CapabilitySignals): Capability {
  return resolveCapabilities(signals)[id]
}

/** 是否允许执行该动作 —— 入口与请求侧共用，避免「按钮灰了但代码还能跑」 */
export function canDo(capability: Capability, action: string): boolean {
  if (capability.status === 'unsupported' || capability.status === 'unknown') return false
  return capability.actions.includes(action)
}
