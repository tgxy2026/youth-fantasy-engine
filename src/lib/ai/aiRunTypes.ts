import type { MaterialManifest } from '@/lib/ai/requestBudget'
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

/**
 * 单次调用的请求上下文快照（3.2.0 · WQ7）。
 * 🔴 存下来的是**当时自报的**归属依据；事后复盘据此判断「这条账到底属于谁」，
 *    而不是靠「谁启动得晚就是谁」。
 */
export interface AiRunCallRequest {
  /** 调用 ID（同一次逻辑调用的失败/成功共用） */
  callId?: string
  projectId?: string | null
  taskId?: string
  stepId?: string
  taskType?: string
}

/** 单次模型调用账（供 §10.3 #6 消耗统计 + §14 拒答感知共用） */
export interface AiRunCall {
  model: string
  /** 本次调用耗时（毫秒） */
  ms: number
  promptTokens?: number
  completionTokens?: number
  /** token 是估算值（拿不到厂商真实用量时置 true） */
  tokensEstimated?: boolean
  /** 首字耗时（毫秒，流式才有） */
  firstByteMs?: number
  /** 结束原因（如 `stop` / `length` / `content_filter` / `eof`＝对端直接收掉、原因未知） */
  finishReason?: string
  /** 这次逻辑调用实际发了几次请求（>1 才写） */
  attempts?: number
  /** 请求上下文（WQ7）：这次调用自报属于谁 */
  request?: AiRunCallRequest
  /**
   * 输出协议与降级（3.2.0 · WQ5）：这一次实际按什么形态请求、哪条声明没被满足。
   * 🔴 与「当前设置」不是一回事 —— 设置会变，这条记录不会。
   */
  protocol?: { output: string; reasoning: string; wireFormat?: string; limitations?: string[] }
  /**
   * 归属判定途径（WQ7）：
   *  · `task-id` —— 调用方显式带了 taskId，**可作审阅依据**；
   *  · `legacy-single-run` —— 当时只有一个任务在跑，按兼容路径归属。
   *    🔴 统计可用，**不得**作为「候选该归谁」这类审阅依据（方案 §11 第 118 行）。
   */
  attributedBy?: 'task-id' | 'legacy-single-run'
  at: number
}

/** 验收回执 —— 采纳阶段的实际结果（与 `CommitOutcome` 同形，便于直接落账） */
export interface AiRunOutcome {
  created: number
  updated: number
  skipped: number
  failed: string[]
}

/**
 * 上下文装配快照（§10.3 #2「上下文查看」）。
 * 记「本次任务实际带了哪些段落、哪些因预算没带、占多少字」—— 作者可据此判断
 * 「模型有没有看到我刚写的那段设定」。
 */
export interface AiContextSnapshot {
  /** 实际带上的段落标题（按装配顺序） */
  sections: string[]
  /** 因预算被丢弃的段落标题（如实声明，非空即说明「模型没看到这些」） */
  dropped: string[]
  /**
   * 因预算**只带了一部分**的段落（形如「地理风物（11/22 行）」）。
   * 🔴 与 `dropped` 分开：一个「完全没给」，一个「给了一半」，对模型和作者是两件事。
   */
  trimmed?: string[]
  /** 装配后的字符数 */
  chars: number
  /** 本次预算 */
  budget: number
  /** 装配时刻（用于判断这份快照属于哪次任务） */
  at: number
  /**
   * 发送材料清单（3.2.0 · WQ4）：逐段「进了多少 / 裁剪还是丢弃 / 为什么」，
   * 连同预算与实际窗口。🔴 记的是**当时**发出去的东西，不要事后回读资料重算。
   */
  manifest?: MaterialManifest
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
  /** 本次实际装配的上下文摘要（可取不到 —— 非装配型任务 / 老数据没有这个字段） */
  context?: AiContextSnapshot | null
  /**
   * 本任务运行期间发生、但**不属于本任务**的其他调用（3.2.0 · WQ7）。
   *
   * 🔴 为什么要记：并行时（创意写作 + 编辑器伴写 / 酒馆 / 另一个项目），旧实现把
   *    **所有**调用都算给「最近创建的那个任务」，用量与重试次数全错。现在改为如实排除，
   *    并把「被排除了几次、为什么」摆在作者面前 —— 少算要说明白，不能悄悄少算。
   */
  excludedCalls?: { count: number; reasons: string[] }
  /** 按「唯一在跑任务」兼容路径归属的调用数（调用方补上显式 taskId 后会降为 0） */
  legacyAttributedCalls?: number
}
