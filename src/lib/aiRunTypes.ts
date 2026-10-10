/**
 * AI 运行账本 · 类型定义（3.0 · W1-1）· 纯类型模块，无任何 import。
 *
 * 🔴 为什么单独成文件：`db/aiRuns.ts`（数据层）与 `aiRunLedger.ts`（账本编排）都要用它，
 *    而这个类型文件谁都不依赖 —— 放在数据层会让编排层反向依赖 db，形成环。
 *    （同 `schema.ts` 的三段禁互相 import 是同一个道理。）
 */

/** 运行状态（与 aiTaskCenter.AiTaskStatus 对齐，便于界面统一渲染） */
export type AiRunStatus = 'running' | 'done' | 'failed' | 'aborted'

/** 任务类别 —— 账本口径的「这是哪一类 AI 动作」 */
export type AiRunKind =
  | 'creative'      // 创意写作（设定奠基 / 分卷大纲 / 逐章连写）
  | 'rewrite'       // 整章改写
  | 'continue'      // 续写 / 补字数
  | 'ghost'         // 编辑器伴写（只记账、不落库）
  | 'tavern-free'   // 酒馆自由对话
  | 'other'

/**
 * 版本基准 —— 「候选产出时，它基于的正文 / 上游设定长什么样」。
 *
 * 版本保护的核心：采纳前用 `isBasisStale()` 把这份基准与**当前**状态比对，
 * 任一指纹不符 ⇒ 候选已过期，**不得静默覆盖作者的编辑**。
 */
export interface AiRunBasis {
  /** 章级基准：候选涉及哪些章 + 产出时的正文指纹 */
  chapters?: { chapterId: string; fingerprint: string }[]
  /** 上游设定基准：设定最后一次变更的版本戳（拿不到则 null） */
  settingsRev?: number | null
  /** 基准采集时刻 */
  at: number
}

/** 候选引用 —— 只存「落点 / 条数 / 指纹 / 状态」，**不存候选全文**（避免账本膨胀） */
export interface AiRunCandidateRef {
  /** 落点标识：如 `chapter:<id>` / `table:characters` / `outline` / `settings` */
  target: string
  /** 候选条数 */
  count: number
  /** 候选内容指纹（用于判重 / 恢复时比对） */
  fingerprint: string
  /** 采纳状态 */
  state: 'pending' | 'adopted' | 'stale' | 'discarded'
}

/** 单次模型调用账（供 §10.3 #6 消耗统计 + §14 拒答感知共用） */
export interface AiRunCall {
  model: string
  /** 本次调用耗时（毫秒） */
  ms: number
  promptTokens?: number
  completionTokens?: number
  /** 结束原因（如 `stop` / `length` / `content_filter`）—— 拒答感知的判据来源 */
  finishReason?: string
  at: number
}

/** 验收回执 —— 采纳阶段的实际结果（与 `CommitOutcome` 同形，便于直接落账） */
export interface AiRunOutcome {
  created: number
  updated: number
  skipped: number
  failed: string[]
}

/** 一次 AI 任务 = 一条运行记录（持久化，重启不丢） */
export interface AiRun {
  id: string
  projectId: string
  kind: AiRunKind
  /** 界面显示名，如「创意写作」「第 12 章 整章改写」 */
  title: string
  status: AiRunStatus
  startedAt: number
  finishedAt: number
  /** 🔴 版本基准（版本保护核心） */
  basis: AiRunBasis
  /** 候选摘要（只存引用/指纹/条数） */
  candidates: AiRunCandidateRef[]
  /** 调用账（#6 消耗统计 + §14 拒答感知共用） */
  calls: AiRunCall[]
  /** 验收回执（采纳阶段写入） */
  outcome: AiRunOutcome | null
  /** 失败原因（`status === 'failed'` 时非空） */
  error: string
}
