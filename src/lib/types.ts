// ============ 类型定义 ============

/** 表单字段 */
export interface FormField {
  name: string
  desc: string
  example: string
  /**
   * 字段类型标记（2.7.1 · 题材模板化）。
   *
   * 目前只有 `'numeric'`：**数值型字段** —— AI 补全时锁死，不让模型凭空编数字。
   * 改造前这一步靠「字段名包含 境界/等级/战力…」的关键字猜（见 schema.POWER_NUMERIC_HINTS），
   * 模板化后新题材的字段未必含这些字（如「段位」「品级与阶序」）⇒ 会失锁。故升级为
   * **显式声明**，关键字判据退化为兜底。两条判据并存，见 components/FormSheet.tsx。
   */
  kind?: 'numeric'
}

/** 表单模块（分组） */
export interface FormModule {
  name: string
  fields: FormField[]
}

/** 历法定义：多历法体系下，每个历法有名称与数值（数值用于跨历法先后顺序/延续性判断，默认 0，可为负） */
export interface CalendarDef {
  name: string
  value: number
}

/**
 * **历法规则**：一年几个月、一个月几天（2.4.4 · 社区反馈）。
 *
 * 为什么要有它：此前「故事内时间」被硬编码成地球公历（12 月、大小月、闰年）——
 * 写架空世界的作者根本套不上（"这个历法一年 18 个月、每月 40 天"是家常便饭），
 * 只能乱填一个数，时间轴排序随即失效。改成规则驱动后，月 / 日的下拉按它生成。
 *
 * 口径：**项目级统一**（不是每个历法各一套）—— 一个故事里换历法通常只是换纪元起点，
 * 一年几个月不会跟着变；做成两套还得在排序时处理"跨历法的天数怎么比"，复杂且没收益。
 */
export interface CalendarRule {
  /** 一年有多少个月（1~60，默认 12） */
  monthsPerYear: number
  /** 一个月有多少天（1~99，默认 30） */
  daysPerMonth: number
}

/**
 * 默认历法规则：一年 12 个月、每月 30 天（一年 360 天）。
 *
 * ⚠️ 刻意**放在 types.ts**（本文件不依赖任何模块）：`audit.ts` 这类底层工具也要用它当默认值，
 *     而 `storyDate.ts` 依赖 db —— 让 audit 去 import 它，等于给底层工具挂上一整条存储依赖链。
 */
export const DEFAULT_CALENDAR_RULE: CalendarRule = { monthsPerYear: 12, daysPerMonth: 30 }

/** 表格列 */
export interface TableColumn {
  name: string
  type?: 'text' | 'select' | 'date' | 'number' | 'textarea' | 'calendar' | 'character' | 'characters' | 'tableRef'
  options?: string[]
  width?: string
  tip?: string
  /** 标记为历法列：选项来自项目级历法配置（多历法数值体系），而非 schema 静态 options */
  calendar?: boolean
  /** tableRef 类型：选项来自另一张设定表的指定列（跨表引用，禁止手动输入）。refTab=来源表 tabId，refCol=取名列名 */
  refTab?: string
  refCol?: string
  /** 隐藏列：在表格视图中不显示，但数据仍保留（例如地图 X/Y 坐标只由地图编辑维护，地理表里隐藏） */
  hidden?: boolean
  /**
   * 选项固定：不提供增 / 改 / 删 / 移除入口（保密等级这类被机器逻辑读取的封闭枚举）。
   * 由 schema 的 `cFixed()` 设置，理由见那里。
   */
  fixedOptions?: boolean
}

/** 页签类型 */
export type TabType =
  | 'dashboard'    // 工作面板
  | 'model-settings' // 模型设置（模型配置 / 正文写作额度 / 联网检索 / AI 提示词）
  | 'guide'        // 使用说明
  | 'editor'       // 正文编辑
  | 'form'         // 表单型（单份）
  | 'table'        // 表格型（多行）
  | 'card'         // 卡片型（角色卡，多条记录）
  | 'about'        // 关于/打赏页（自定义布局）
  | 'map'          // 地图编辑（架在地理风物之上，SVG 画布可视化）
  | 'canvas'       // 画布型（情节推演画布，结构化卡片 + 连线）
  | 'inspire'      // 灵感启发（随机取名生成器 + AI 辅助规划）
  | 'check'        // 检查工具（敏感词检测 + AI 一致性深度自查 + 数据体检）
  | 'material'     // 素材资料（内置只读写作参考库）
  | 'trajectory'   // 创作轨迹（按章回看创作过程 + 导出证据包）
  | 'tavern-plot'   // 酒馆模式 · 剧情推演（角色扮演诊断台）
  | 'tavern-report' // 酒馆模式 · 推演报告（合理性报告列表与详情）
  | 'tavern-card'   // 酒馆模式 · 角色卡（自由模式角色卡管理）
  | 'tavern-free'   // 酒馆模式 · 自由对话（自由模式会话）
  | 'tavern-control' // 酒馆模式 · 控制面板（AI 参数与提示词集中调节）
  | 'tavern-script'  // 酒馆模式 · 剧本编辑（故事 / 剧本 / 角色三层，2026-09-16 起已实现）
  | 'bookbreak'         // 一键拆书（外部文本 → 项目设定表：抽取、判重、草稿审阅、勾选落库）
  | 'creative-writing'  // 创意写作（全自动创作工作流：想法 → 设定 → 大纲 → 逐章成稿）
  | 'tavern-world'   // 酒馆模式 · 背景设定（提炼过的世界资料，按关键词注入）
  | 'worlds'         // 世界库（世界引擎：抽取 / 封存版本 / 跨作品引用，3.0 · W4-1）

/** 页签定义 */
export interface TabDef {
  id: string
  name: string
  group: string
  type: TabType
  description: string
  modules?: FormModule[]    // form / card 用
  columns?: TableColumn[]   // table 用
  tips?: string[]           // 底部提示
  /** 设定检索的主显示列名（表格/卡片用），留空则取第 1 个非空列 */
  displayCol?: string
  /** 设定检索的副标题列名（可选） */
  subtitleCol?: string
  /** 编号规则说明（有「编号」列的表格页签在顶部展示，防止编号混乱） */
  codeRule?: string
  /** 自定义项目（projectType==='custom'）按 features 集合控制页签可见性，详见 schema.ts 的 tabVisible */
  /** 是否按创建时间倒序排列（越新创建的行越靠上）：true = 启用。用于章节总表等"后写的在最前面"的场景 */
  newestFirst?: boolean
}

// ============ 数据模型 ============

/** 小说项目（一本书 = 一个项目） */
export interface Project {
  id: string
  name: string
  genre: string        // 作品题材：2.7.1 起存「题材包名」（GenrePack，10 选 1，决定世界设定/力量体系/制度页签的模板与默认显隐）；2.7.0 前是自由文本「类型赛道」，老数据靠 schemaTemplates.PACK_ALIASES 归位。
  intro: string        // 一句话简介
  cover?: string       // 封面（dataURL）
  createdAt: number
  updatedAt: number
  /** 项目形态：'full' 完整项目（长篇，全功能）/ 'custom' 自定义项目（仅启用用户勾选的功能，见 features）。新建项目只提供「完整 / 自定义」两类，旧版精简/极简类型已移除。 */
  projectType?: 'full' | 'custom'
  /** 自定义项目启用的功能全集（tab id + 编辑器/基础设施伪 id）。仅 projectType==='custom' 时使用；其余形态忽略。 */
  features?: string[]
}

export interface Volume {
  id: string
  projectId: string
  order: number
  title: string
  description: string
  createdAt: number
  /** 2.6.4：系统保留的「自由卷」标记 —— 托管未归类的自由章节，不参与卷计数、不可删除。判定只认本字段、不认标题（见 `lib/freeVolume.ts`） */
  isFree?: boolean
}

export type ChapterStatus = '构思' | '细纲' | '草稿' | '修改' | '完稿' | '已发布'

/**
 * AI 辅助统计（2.4.1 · B3）—— **纯类型定义放这里**（`types.ts` 不依赖任何业务模块，
 * 放 `aiAssist.ts` 会与之循环依赖：那边要 import `Chapter`）。
 * 口径说明、记账与统计函数都在 `lib/aiAssist.ts`。
 *
 * 只记「过程量」：每次 AI 产出把字数累加进来；改过的字无法反推，故不做"当前有多少 AI 字"的判断。
 */
export interface AiAssistStat {
  /** 各类来源的累计产出字数 */
  chars: { generated: number; rewritten: number; continued: number; polished: number }
  /** 各类来源被触发次数 */
  times: { generated: number; rewritten: number; continued: number; polished: number }
  /** 最近一次记录时间 */
  updatedAt: number
}

export interface Chapter {
  id: string
  projectId: string
  volumeId: string
  order: number
  title: string
  content: string
  summary: string
  status: ChapterStatus
  wordCount: number
  createdAt: number
  updatedAt: number
  /** 不计入序号（1.9.2）：序章 / 番外 / 后记等不占正文号，但仍按真实位置参与叙事排序 */
  excludeFromNumbering?: boolean
  /**
   * AI 辅助统计（2.4.1 · B3）—— **可选**：老数据没有这个字段，语义上就是「没记录到 AI 产出」，
   * 因此**不需要迁移**（`undefined` 与"全 0"等价，`normalizeAiAssist()` 会归一）。
   * 🔴 只由 `lib/aiAssist.ts` 的 `withAiAssist()` 写入，别在别处手搓。
   */
  aiAssist?: AiAssistStat
}

export interface CardRecord {
  id: string
  projectId: string
  tabId: string
  name: string
  data: Record<string, string>  // fieldPath -> value
  order: number
  /**
   * 卡片创建时间（2.4.0 · A4 遗留补全）。**可选** —— 老库里的卡没有这个字段。
   *
   * 用途：让「创作轨迹」的细纲节点能显示真实时间（此前细纲卡不记时间，时间线上只能当起点内容）。
   * 🔴 刻意**不做迁移补值**：给老卡补一个"当前时间"就是编造历史，界面显示「时间未知」即可。
   */
  createdAt?: number
  /**
   * 角色立绘（2.4.1 · B7）—— **可选**：老卡没有这个字段，语义就是「还没传立绘」。
   *
   * 🔴 存的是**已压缩的 dataURL**（由 `lib/imagePortrait.ts` 处理：等比缩放**不裁切**、
   *    WebP q0.9、超过 200KB 才逐档降质量）。**别把原图直接塞进来** ——
   *    桌面版整库就是一个 JSON、云同步载荷也是整库，几张几 MB 的原图就能让同步明显变沉。
   * 🔴 因为可选，所以**不需要迁移**（`undefined` 与「没传」同义）。
   * ⚠️ 与酒馆头像（`imageAvatar.ts` 的 256×256 方形）是**两条管线**，别混用。
   */
  portrait?: string
  /** 第二张立绘（可选；2026-09-22 起右侧上下两格）—— 可选字段 ⇒ 老数据无需迁移 */
  portrait2?: string
}

export interface TableRow {
  id: string
  projectId: string
  tabId: string
  data: Record<string, string>
  order: number
  updatedAt?: number  // 最后编辑时间（保存时自动写入，用于无编号表格的降序排列）
  createdAt?: number  // 创建时间（用于 newestFirst 表格按创建时间倒序；旧数据缺省时回落 order）
}

export interface FormData {
  tabId: string
  data: Record<string, string>  // fieldPath -> value
}
