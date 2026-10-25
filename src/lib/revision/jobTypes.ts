/**
 * 3.2.0 · W2 修订任务与载荷的**形状**（纯类型 + 容量常量）
 *
 * 🔴 为什么不写进 `revisionTypes.ts`：
 *    那个文件是 MQ0 **冻结的共用契约**（`docs/归档/3.2/3.2.0-MQ0-共用协议契约-2026-10-19.md`），
 *    规则是「只增可选字段 / 只增枚举值」，而且它承载的是**跨包共用**的状态域
 *    （AttemptEndReason / StepResultState / TaskRunState / Coverage / CommitReceipt…）。
 *    修订任务是 W2/W3 自己的领域模型，放进去会把"共用契约"变成"谁都能往里塞"的抽屉。
 *    （2026-10-20 曾发生整文件覆盖契约的事故，详见当日日志。）
 *
 * 🔴 本文件仍保持**零 import**：store、编排、测试都可以安全引用，不成环。
 *    store 层（`db/revisionJobs.ts`）只认这里的形状，不认 UI。
 */

// ────────────────────────── 任务状态与种类 ──────────────────────────

/**
 * 任务状态。
 *
 * 🔴 与 MQ0 的 `TaskRunState`（契约层：running / paused / cancelled…）**不是同一件事**：
 *    那边描述"一次模型执行"，这里描述"一条修订任务的生命周期"。
 *    两者不要互相赋值 —— 映射写在编排层，类型层不混。
 */
export type RevisionJobStatus =
  | 'queued'          // 排队中
  | 'running'         // 执行中
  | 'awaiting-review' // 等待审阅
  | 'completed'       // 已完成
  | 'paused'          // 暂停
  | 'failed'          // 失败
  | 'cancelled'       // 已取消
  | 'interrupted'     // 中断（启动后恢复）

export type RevisionJobKind =
  | 'chapter-review'   // 章节审读
  | 'chapter-rewrite'  // 章节改写
  | 'outline-sync'     // 细纲同步
  | 'setting-audit'    // 设定审计
  | 'continuity-check' // 连续性检查
  | 'proofread'        // 校对
  | 'custom'           // 自定义

export interface RevisionStep {
  id: string
  /** 步骤名（如「抽取」「生成候选」「应用」） */
  name: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  startedAt?: number
  finishedAt?: number
  error?: string
}

// ────────────────────────── 基准与提交 ──────────────────────────

/**
 * 任务创建时的基准快照。
 *
 * 🔴 摘要是"当时"的：应用候选前必须重新比对，不一致就判过期（`checkBaseline`），
 *    不能拿任务启动时的摘要当"现在还没变"的证据。
 */
export interface RevisionBaseline {
  /** 任务创建时的正文摘要（恢复时校验正文是否变化） */
  bodyDigest: string
  /** 任务创建时的细纲摘要 */
  outlineDigest?: string
  /** 任务创建时的依赖设定摘要 */
  settingsDigest?: string
  /** 章序（用于判断章序变化） */
  chapterOrder?: number
  createdAt: number
}

/** 提交意图：**先写意图、再写正文**，崩溃后据此核对（方案 §9.3） */
export interface RevisionSubmitIntent {
  /** 意图 ID（崩溃恢复时核对用） */
  operationId: string
  /**
   * 所属任务 ID。
   * 🔴 崩溃恢复要靠它把"半截提交"对回具体任务 —— 只靠候选 ID 的话，
   *    候选被清理后就再也找不到是谁写的意图。
   */
  jobId?: string
  submittedAt: number
  beforeBodyDigest: string
  beforeOutlineDigest?: string
  candidateId: string
}

/** 提交回执：正文写完之后才写，成对出现才算成功 */
export interface RevisionSubmitReceipt {
  /** 与 `intent.operationId` 对应 */
  operationId: string
  receivedAt: number
  afterBodyDigest: string
  afterOutlineDigest?: string
  ok: boolean
  error?: string
}

// ────────────────────────── 任务与载荷 ──────────────────────────

export interface RevisionJob {
  id: string
  projectId: string
  kind: RevisionJobKind
  /** 范围（章节 ID / 检查项 ID 等） */
  scope: {
    chapterId?: string
    checkIds?: string[]
    [key: string]: unknown
  }
  params: Record<string, unknown>
  status: RevisionJobStatus
  stepCount: number
  currentStep: number
  steps: RevisionStep[]
  baseline: RevisionBaseline
  /** 报告 / 候选载荷引用 */
  payloadId?: string
  intent?: RevisionSubmitIntent
  receipt?: RevisionSubmitReceipt
  createdAt: number
  updatedAt: number
  finishedAt?: number
}

/**
 * 载荷：报告 / 候选全文 / 暂停草稿 / 快照。
 *
 * 🔴 `bytes` 是**写入时算一次**的 UTF-8 字节数：列表页据此判容量，
 *    不允许每次渲染都 `JSON.stringify` 一遍（长候选 2000 行会把列表拖死）。
 */
export interface RevisionPayload {
  id: string
  projectId: string
  kind: 'report' | 'candidate' | 'draft' | 'snapshot'
  jobId: string
  /** 不可变报告（JSON 可序列化） */
  report?: unknown
  /** 改前文本 */
  beforeText?: string
  /** 候选全文 */
  candidateText?: string
  /** Q1 暂停草稿 */
  draft?: string
  /** 摘要（列表展示用，不预读全文） */
  summary: string
  bytes: number
  createdAt: number
}

// ────────────────────────── 容量常量（方案 §9.2） ──────────────────────────

export const MAX_BATCH_CHAPTERS = 20
/** 单份载荷上限 256 KiB */
export const MAX_PAYLOAD_BYTES = 256 * 1024
/** 单项目载荷条数上限 */
export const MAX_PAYLOADS_PER_PROJECT = 200
/** 单项目载荷总量上限 32 MiB */
export const MAX_PAYLOAD_TOTAL_BYTES = 32 * 1024 * 1024
/** 同时进行的批次上限 */
export const MAX_ACTIVE_BATCHES = 5
/** 孤儿载荷保留天数（清理器据此回收） */
export const ORPHAN_PAYLOAD_RETENTION_DAYS = 30
