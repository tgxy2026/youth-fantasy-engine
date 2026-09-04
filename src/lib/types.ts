// ============ 类型定义 ============

/** 表单字段 */
export interface FormField {
  name: string
  desc: string
  example: string
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
}

/** 页签类型 */
export type TabType =
  | 'dashboard'    // 工作面板
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
  genre: string        // 类型赛道
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
}

export type ChapterStatus = '构思' | '细纲' | '草稿' | '修改' | '完稿' | '已发布'

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
}

export interface CardRecord {
  id: string
  projectId: string
  tabId: string
  name: string
  data: Record<string, string>  // fieldPath -> value
  order: number
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
