/**
 * 通用流程域 · 类型定义（域中立）
 *
 * ⚠️ `src/lib/flow/` 是「多阶段长任务 + 草稿审阅」的**通用层**，不含任何具体业务。
 *    「一键拆书」与「创意写作」是它的两个调用方。
 *    刻意不放进 `bookbreak/` 的原因：工作流去 import「拆书」的模块在语义上说不通，
 *    而这两套东西（状态机 / 草稿审阅 / 字段映射）两处共用，放中立域才不产生怪引用。
 */

// ==================== 状态机 ====================

/** 阶段标识（由调用方定义，如 'split' / 'extract' / 'draft'） */
export type FlowStageId = string

export type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled'

/** 阶段声明。数组顺序即执行顺序。 */
export interface FlowStage {
  id: FlowStageId
  /** 界面显示名 */
  label: string
  /**
   * 进度权重（默认 1）。
   * 各阶段耗时差异大时用它加权，否则总进度条会「卡在 5% 很久然后突然跳到 90%」。
   */
  weight?: number
}

/** 阶段运行态 */
export interface StageState {
  id: FlowStageId
  label: string
  status: StageStatus
  /** 本阶段进度 0..1 */
  ratio: number
  /** 一行说明（如「第 3/12 章」） */
  detail: string
  startedAt?: number
  endedAt?: number
  error?: string
}

export type FlowStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error'

/** 提交给界面的进度快照（每次新建对象，便于 React 按引用比较） */
export interface FlowProgress {
  status: FlowStatus
  /** 总进度 0..1（按阶段权重加权：已完成记满分，进行中记其已报比例） */
  ratio: number
  stages: StageState[]
  current: FlowStageId | null
  /** 一行总体说明（取当前阶段的 detail，缺省用阶段名） */
  message: string
}

// ==================== 草稿管线 ====================

/** 草稿行与已有设定的比对结果 */
export type DraftStatus = 'new' | 'duplicate' | 'conflict'

/** 冲突明细：同一字段，已有值 vs 本次新值 */
export interface DraftConflict {
  field: string
  existing: string
  incoming: string
}

/** 草稿行的一个字段。`key` 是目标表的真实存储键，`label` 只用于界面显示。 */
export interface DraftField {
  /** 目标表的真实键：表格型=列名；卡片型=`模块::字段` */
  key: string
  /** 界面显示名（如「身份定位」） */
  label: string
  value: string
}

/**
 * 一条待审阅的草稿行 —— **尚未落库**。
 *
 * 两个调用方共用它：拆书产出「角色 / 地理 / 势力 / 关系 / 世界 / 力量」草稿，
 * 工作流的「设定奠基」「大纲生成」产出同一形状，界面用同一套审阅组件消费。
 */
export interface DraftRow {
  /** 列表 key（稳定，不随勾选变化） */
  key: string
  /** 目标页签 id + 显示名（界面按它分组） */
  tabId: string
  tabName: string
  /** 业务分类标签（如「人物」「地理」），仅用于显示与统计 */
  kindLabel: string
  /** 主名称 */
  name: string
  /** 别称（会写进目标表的「别称」列 / 角色卡「别称」字段） */
  aliases: string[]
  /**
   * 字段值。键由 fieldMap 解析自 schema，保证是**目标表真实存在的键**（不手写）。
   * 有序：主名在最前，随后是别称 / 描述 / 首次出场。
   */
  fields: DraftField[]
  /** 主名在 fields 里的键（界面改名称时必须同步改它，否则落库写的还是旧名） */
  nameKey: string
  /** 一句话描述在 fields 里的键（没有描述落点时缺省） */
  descKey?: string
  status: DraftStatus
  /** 命中的已有条目（duplicate / conflict 时给出，供界面跳转核对） */
  matched?: { name: string; tabId: string; id: string }
  /** 冲突明细（conflict 时非空） */
  conflicts?: DraftConflict[]
  /** 置信度 0..1（低于阈值默认不勾选，但用户可手动勾） */
  confidence: number
  /** 原文引用（可追溯；空数组表示无证据 —— 界面应标红提示） */
  quotes: string[]
  /** 来源章节序号（1 起） */
  chapters: number[]
  /**
   * 被「同物多写法」规则**并入**本行的其他写法（如 `吞天诀` 并入 `混沌吞天诀`）。
   * 这些名字同时进了 `aliases`；单独留一份是为了让界面**如实告诉作者「并了什么进来」**。
   */
  foldedNames?: string[]
  /**
   * 疑似与另一条是**同一对象**（名称是同一核心词的另一种限定写法），值为那条的名字。
   * 🔴 这类**既不合并也不隐藏**：只默认不勾 + 行内标注，由作者取舍。
   *    判定规则见 `draft.foldNameVariants`（确定性字符串规则，不调模型）。
   */
  variantOf?: string
  /**
   * **这张表按哪几列组合判重** —— 只给「没有『名称』列的表格」用（如人物关系是
   * 人物A + 人物B + 关系类型、势力关系是 势力A + 势力B + 关系类型）。
   *
   * 🔴 为什么必须有它：`commit` 默认那套判重是「按名称列找同名条目」，而这类表**压根没有
   *    「名称」列**（关系不是条目，它没有名字）—— 于是判重静默失效，后果是**作者在草稿页
   *    点两次「写入项目」就登记两条同样的关系**（图谱里随即多一条重复边）。
   *    声明了它，落库与「写入前预览」都会按这些列的值组合比对已有行。
   * 🔴 2.7.2：`aiScope.isDirectedPairTab` 为真的表（人物关系 / 势力关系）按**有向对**比较
   *    （A→B 与 B→A 是两条），且判重键含「关系类型」⇒ 同一对可并存多种关系。
   */
  dedupKeys?: string[]
}

export interface DraftBundle {
  rows: DraftRow[]
  /** 按目标页签分组，保持首次出现顺序（不是字典序，便于稳定渲染） */
  groups: { tabId: string; tabName: string; rows: DraftRow[] }[]
  stats: {
    total: number
    byStatus: Record<DraftStatus, number>
    /** 按分类标签统计，如 { 人物: 12, 地点: 5 } */
    byKind: Record<string, number>
    /** 被「同物多写法」规则并入其他条目的条数（界面用来交代「已归并 N 条」） */
    folded: number
    /** 标为「疑似同一对象、默认不勾」的条数 */
    variants: number
  }
}

/** 落库结果 */
export interface CommitOutcome {
  /** 新建条数 */
  created: number
  /** 更新了已有条目的条数（冲突解决为「采用新 / 合并」时 > 0） */
  updated: number
  /** 失败的条目名（界面据此提示，不静默吞掉） */
  failed: string[]
}
