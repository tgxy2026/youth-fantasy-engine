// ============ WCP 网页资料包 · 类型与常量（3.7.3 · W0）============
//
// WCP（Web Context Pack）是 API / MCP / ACP 之外的**第 4 种离线接力模式**：
// 不占宿主运行态租约，把引擎里的结构化资料打包成 .md / .txt（或剪贴板文本），
// 交给 Gemini / Claude 等网页版长上下文模型接续创作，再把结果双段式粘回来。
//
// 🔴 本文件只放**类型与常量**（零 IO、零依赖）：
//   · 全局偏好（跨项目）走 `meta`，键名 `wcpGlobalConfig`；
//   · 单项目状态（底包勾选 / 过期指纹）走 `settingsKV`，键名 `wcpProjectState`。
//   读写实现在 `wcpSettings.ts`。
//
// 🔴 为什么必须分两层：`getMeta/setMeta` 是全局配置，`getSetting/setSetting` 按
//   `projectId` 隔离。底包勾选与指纹若塞进全局，A 书导出的底包会显示 B 书的
//   「已过期」状态 —— 跨书串状态，极难定位（规划 §0.1 R2）。

/** 资料包形态：常驻底包 / 轻量增量包 / 完整独立包 */
export type WcpPackKind = 'base' | 'delta' | 'full'

/** 第二部分变动摘要的格式：JSON（默认，支持勾选入库）/ 固定 Markdown 清单 */
export type WcpSummaryFormat = 'json' | 'markdown'

/** 导出文件扩展名（.md 默认；.txt 供只收纯文本的网页模型） */
export type WcpFileExt = 'md' | 'txt'

/** 首版 5 大创作场景（规划 D8） */
export type WcpSceneId =
  | 'chapter-continue'
  | 'chapter-polish'
  | 'outline-expand'
  | 'continuity-audit'
  | 'bio-organize'

/** 全局偏好：跨项目共用（桌面 / 便携 / 网页三形态同一份） */
export interface WcpGlobalConfig {
  /** 默认下载后缀 */
  defaultFileExt: WcpFileExt
  /** 就近入口默认推荐形态（增量 / 完整）；底包始终从管理页单独导出 */
  defaultPackKind: 'delta' | 'full'
  /** 默认摘要格式（出厂 JSON） */
  summaryFormat: WcpSummaryFormat
  /** 增量包默认带入的前文章节数（正文末尾衔接段） */
  prevChapterCount: number
  /** 增量包默认带入的章节摘要数（含本章） */
  prevSummaryCount: number
  /** 是否在资料包中附带作者备注（写作意图 / 本章固定说明） */
  includeWriterNotes: boolean
  /** 单包字符预算上限（网页长上下文给宽裕值，可调） */
  maxPackBudgetChars: number
}

/** 单项目状态：按项目隔离（切书不串底包过期状态） */
export interface WcpProjectState {
  /** 勾选进常驻底包的模块 id（见 `WCP_BASE_MODULES`） */
  baseModules: string[]
  /** 上次导出底包的时间（毫秒）；从未导出为 null */
  lastBaseExportAt: number | null
  /** 上次导出底包时的源数据指纹（用于判定「设定已更新，建议重导」） */
  lastBaseFingerprint: string
}

export const WCP_GLOBAL_CONFIG_KEY = 'wcpGlobalConfig'
export const WCP_PROJECT_STATE_KEY = 'wcpProjectState'

/** 预算下限/上限：低于 8000 连底包都装不下；上限防手滑填出天文数字 */
export const WCP_BUDGET_MIN = 8_000
export const WCP_BUDGET_MAX = 2_000_000
/** 前文章数上限（正文很吃预算，超过 10 章基本只会挤掉设定） */
export const WCP_PREV_CHAPTER_MAX = 10
/** 摘要章数上限 */
export const WCP_PREV_SUMMARY_MAX = 20
/** 单段裁剪后至少保留的字符数：不足就整段省略，别留半句误导模型 */
export const WCP_MIN_SECTION_CHARS = 240

export const DEFAULT_WCP_GLOBAL_CONFIG: Readonly<WcpGlobalConfig> = {
  defaultFileExt: 'md',
  defaultPackKind: 'delta',
  summaryFormat: 'json',
  prevChapterCount: 1,
  prevSummaryCount: 3,
  includeWriterNotes: true,
  maxPackBudgetChars: 120_000,
}

/** 底包模块：`tabIds` 直接交给 `buildProjectContext({ onlyTabIds })` 取材 */
export interface WcpBaseModule {
  id: string
  label: string
  /** 一句话说明（勾选区显示，避免作者猜「这一项到底装了什么」） */
  hint: string
  /** 对应的设定页签 id；空数组表示由 WCP 自己另行取数（如人物小传） */
  tabIds: readonly string[]
}

/**
 * 常驻底包的模块清单。
 *
 * 🔴 顺序 = 管理页勾选区顺序，也是导出时区块的默认顺序。
 * 🔴 只列**长期稳定**的世界观 / 角色资料：章节细纲、前文正文属于增量包，
 *    放进底包会让「常驻上下文」每天都要重传一遍。
 */
export const WCP_BASE_MODULES: readonly WcpBaseModule[] = [
  { id: 'overview', label: '作品概览', hint: '书名、简介与开书定位', tabIds: ['positioning'] },
  { id: 'world', label: '世界设定', hint: '世界规则、力量体系与制度', tabIds: ['worldbase', 'power', 'politics', 'economy', 'belief', 'justice'] },
  { id: 'factions', label: '势力与地理', hint: '国家势力、势力关系、地理与种族', tabIds: ['nations', 'faction-rels', 'geography', 'races'] },
  { id: 'characters', label: '核心角色', hint: '主要与次要角色卡', tabIds: ['char-main', 'char-secondary'] },
  { id: 'relations', label: '人物关系', hint: '关系类型与按卷演变轨迹', tabIds: ['relations'] },
  { id: 'bios', label: '人物小传', hint: '角色生平小传与重要节点（单独读取）', tabIds: [] },
  { id: 'style', label: '写作规范', hint: '人称、时态、标点等硬约束', tabIds: ['style'] },
  { id: 'terms', label: '名词术语', hint: '专名与译名统一', tabIds: ['terms'] },
]

/** 出厂默认勾选：覆盖「一开书就要喂给网页模型」的最小自洽集合 */
export const DEFAULT_WCP_BASE_MODULES: readonly string[] = [
  'overview', 'world', 'characters', 'bios', 'style',
]

/**
 * 从未导出过底包的初始状态。
 * 🔴 `baseModules` 用**出厂默认勾选**而不是空数组：首次打开管理页时作者看到的是
 *    「已勾好一套可用的底包」，而不是一片空白（空数组仍可由作者主动保存，代表「全不勾」）。
 */
export const DEFAULT_WCP_PROJECT_STATE: Readonly<WcpProjectState> = {
  baseModules: [...DEFAULT_WCP_BASE_MODULES],
  lastBaseExportAt: null,
  lastBaseFingerprint: '',
}

export const WCP_PACK_KIND_LABEL: Record<WcpPackKind, string> = {
  base: '常驻底包',
  delta: '轻量增量包',
  full: '完整独立包',
}

/** 所有已知模块 id（归一化时用于丢弃历史脏数据） */
export const WCP_BASE_MODULE_IDS: readonly string[] = WCP_BASE_MODULES.map(m => m.id)

/** 指纹计算的输入片段（底包模块 id + 实际装入的源文本） */
export interface WcpFingerprintPart {
  id: string
  content: string
}