import type { ContinueStrategy } from '@/lib/outline/autoContinue'
import type { CreativeResume, CreativeTarget } from '@/lib/ai/aiWorkflow'
export type { CreativeTarget }
import type { FlowProgress, DraftBundle } from '@/lib/flow/types'
import type { ChapterRewriteAction, OutlineResult } from '@/lib/ai/aiTasks'
import type { ChapterDraft } from '@/lib/outline/autoContinue'
import type { LedgerItem } from '@/lib/settings/settingLedger'
import type { ResumeClassification, ResumeTriState } from '@/lib/creative/resumeEvidence'

/** 创作起点：从一句话想法从零写 / 接着项目已有内容往下写 */
export type CreativeMode = 'scratch' | 'continue'

/**
 * 篇幅（老大 2026-09-20 要求）：决定「这一次要产出什么」有哪几档，以及参数的语义。
 * - `short` 短篇：只做大纲规划 / 大纲 + 正文（一次跑完，1 卷）
 * - `long`  中长篇：只做大纲规划 / 只生成正文（多卷、分批次反复执行）
 */
export type CreativeLength = 'short' | 'long'

export interface CreativeInputs {
  /** 篇幅（决定产出目标有哪几档 + 参数字义） */
  length: CreativeLength
  /** 一句话想法 —— 只在库里**还没有大纲**时用得上 */
  seed: string
  /** 情节概要（可选；只作用于正文生成，留空则严格承接上一章结尾） */
  intent: string
  /** **本批要排几卷**（大纲规划用；短篇固定 1） */
  volumes: number
  /** **每卷多少章**（硬指标；短篇时＝这一本共多少章） */
  chaptersPerVolume: number
  /** 这一次要产出什么 */
  target: CreativeTarget
  /** 本次写多少章正文（正文生成用） */
  chapters: number
  /** 每章目标字数 */
  words: number
  /** 设定更新策略（连写时如何补登设定） */
  strategy: ContinueStrategy
  /** 生成后自动去 AI 味儿 */
  deAiOn: boolean
  deAiTpl: string
  deAiCustom: string
  /** 本批选中的作者灵感（2.5.2 · A2，来自灵感夹的文本数组；空 = 不注入）。随会话输入持久化 */
  inspirations?: string[]
  /** 是否按已落库的《章节细纲》写 */
  useOutline: boolean
  /** 每章初稿先交作者确认（关掉＝全自动跑量） */
  reviewEach: boolean
  /**
   * 🔴 **先补完最后一章**（2026-09-20，默认开）：上一批若因模型收尾过早只写了半章，
   * 开写新章前先把它补到目标字数 —— 否则读到第 22 章会撞上情绪断层。
   * 只补最后一章（最新章可放开、历史章冻结），只动正文与字数。
   */
  topUpLast: boolean
  /**
   * 结构模板（2.5.0 · A1）：大纲规划时给 AI 的「全书结构参考」。
   * `''` = 不使用（默认，行为与旧版完全一致）；合法 id 见 `storyStructures.STORY_TEMPLATES`。
   * 🔴 仅在「从零排 / 续排」时注入；**缺口补齐模式不注入**（走向已被既有卷约束，全书尺度的
   * 节拍表对补几章没有意义，硬塞反而让模型两头为难）。
   */
  structureId: string
}

export const DEFAULT_INPUTS: CreativeInputs = {
  length: 'short',
  seed: '',
  intent: '',
  volumes: 1,
  chaptersPerVolume: 20,
  target: 'full',
  chapters: 10,
  words: 2500,
  strategy: 'add-only',
  deAiOn: true,
  deAiTpl: 'natural',
  deAiCustom: '',
  useOutline: true,
  reviewEach: true,
  topUpLast: true,
  structureId: '',
}

/** 结果摘要（落盘用；完整结果里的草稿行可达几十条，没必要存） */
export interface CreativeResultSummary {
  mode: CreativeMode
  /** 设定奠基产出（接着写模式无此阶段 → 0） */
  bibleTotal: number
  bibleCreated: number
  /** 大纲产出 */
  volumes: number
  outlineChapters: number
  /** 本次实际落库的正文章数 */
  wrote: number
  outlineOnly: boolean
}

/**
 * 「整章改写」的进行中状态。
 *
 * 🔴 结果只活在内存里 —— 作者点「替换该章正文」之前**绝不写库**。
 *    这是与「创作」不同的地方：创作产出的是新章，改写要覆盖旧正文，必须多一道人工确认。
 */
export interface RewriteState {
  chapterId: string
  title: string
  /** 全局叙事序号（0 = 不计入序号，如序章 / 番外） */
  no: number
  action: ChapterRewriteAction
  /** 改写结果（流式累积） */
  text: string
  running: boolean
  /** 原文字数 —— 界面用来显示「2200 → 3800 字」 */
  fromWords: number
  /**
   * 本次改写的**期望字数**（异常判定的基准，见 `expectedRewriteWords`）：
   * 润色＝原文长度；扩写 / 精简 / 改写＝面板上填的目标字数。
   */
  expectWords: number
  /**
   * 这一章是不是项目**最新章**（末章）。
   *   · 最新章：改写档可放开（历史章不可），落库后补跑设定同步；
   *   · 历史章：设定类内容一律冻结（提示词按动作分节硬约束），不跑设定同步 —— 它不是新信息源。
   * ⚠️ 「最新章」只解除**改写档**的束缚：润色 / 扩写 / 精简在最新章同样守各自的动作纪律。
   */
  isLatest: boolean
  /**
   * 结果与**期望字数**差距过大 —— 多半是模型被截断、抽风，或与所选动作不符。
   * 🔴 置位后**禁用「替换该章正文」**：那是覆盖作者正文的动作，不能在可疑结果上放开。
   */
  suspect?: boolean
  /**
   * 3.0 · W1-1 版本保护：**产出这份结果时**该章的指纹（`chapterFingerprint`）。
   * 采纳前与当前正文比对 —— 不符（正文被改过）则拒绝替换，见 `applyChapterRewrite`。
   */
  baseFingerprint: string
  /**
   * 3.2.0 · W3：这份产出登记到「候选审阅」后的候选 id。
   * 🔴 有了它，「替换该章正文」成功后才能把候选标成 `applied` ——
   *    不标的话候选列表会一直挂着已经生效的稿子，作者点第二次就再覆盖一遍正文。
   */
  candidateId?: string
  /**
   * 3.2.0 · W3：候选没存成的原因（配额满 / 超过 256 KiB）。
   * 🔴 **不影响改写结果**，只是这句提示让作者知道"这次找不回命令行式的候选"。
   */
  candidateError?: string
}

export interface CreativeNotice {
  /** 自增 id：同一条文案连发两次也能各弹一次 */
  id: number
  text: string
  kind: 'info' | 'success' | 'error'
}

/** 弹窗类交互（初稿裁决 / 设定补登）—— resolve 不进快照，放模块私有变量 */
export interface CreativeSession {
  hydrated: boolean
  inputs: CreativeInputs
  running: boolean
  progress: FlowProgress | null
  /** 阶段产物摘要（跑完保留，"事后能看到每步做了什么"） */
  summaries: Record<string, string>
  log: string[]
  /** 闸门①：设定草稿（非空＝正等作者确认） */
  bibleGate: DraftBundle | null
  /** 闸门②：分卷大纲 */
  outlineGate: OutlineResult | null
  /** 每章初稿裁决 */
  draftAsk: { d: ChapterDraft } | null
  /** 设定补登候选 */
  candidatesAsk: { cands: LedgerItem[] } | null
  candidatesSelected: string[]
  result: CreativeResultSummary | null
  resume: CreativeResume | null
  /** A restored legacy milestone lacks the evidence needed for safe automatic resume. */
  resumeNeedsReview: boolean
  /** 不能自动续跑的具体原因（缺章 / 正文被改 / 旧记录）；'' = 可续跑 */
  resumeBlockedReason: string
  /** 3.3.5 · A1 连写恢复三态判定分类：'resumable' | 'review-needed' | 'blocked' */
  resumeState: ResumeTriState
  /** 三态分类详细元数据与诊断信息 */
  resumeClassification: ResumeClassification | null
  notice: CreativeNotice | null
  /**
   * 最近一次**成功落盘**的时间戳（0 = 还没保存过）。
   *
   * 界面用它显示「已保存 · 08:23」，让作者对输入框里的想法有把握 ——
   * 这是老大 2026-09-20 提的：「一句话生成的输入窗口没办法保存」。
   *
   * 🔴 它由 `persistNow` 直接写快照（走 `emitOnly`，**不走 `set`**）：
   *    走 `set` 会再排一次写盘 → 「写盘 → 更新时间 → 再写盘」无限循环。
   */
  lastSavedAt: number
  /** 整章改写（null = 没在改写） */
  rewrite: RewriteState | null
}
