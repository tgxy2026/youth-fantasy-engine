/**
 * 「创意写作」会话状态 —— **模块级单例**，让长任务跨页签存活。
 *
 * 为什么需要它（实测反馈）：面板原先把状态全放在组件 `useState` 里，而 App 是
 * 「切页签即卸载组件」的渲染方式 —— 跑到一半切去「正文编辑」看两眼，回来闸门没了、
 * 断点没了、日志没了，长任务等于白跑。会话状态因此上提到模块级：
 * 组件只订阅与展示，**任务本身跑在 store 里**，与组件是否挂载无关。
 *
 * 三条设计边界：
 * - **内存全量**：闸门 Promise、运行中的 AbortController、可续跑的 bag 都在内存；
 * - **落盘轻量**：只存可序列化的部分（输入参数 / 日志 / 断点里程 / 结果摘要），
 *   写盘防抖 1s、按项目分键 —— 关软件再打开仍能看到「上次写到第 N 章」；
 *   🔴 bag（含设定草稿，可能很大）**不落盘**：续跑时前序阶段的产物本来就已经落库，
 *   跳过它们是对的（设定奠基 / 分卷大纲那两阶段的成果在数据库里，不在 bag 里）；
 * - **不反向依赖**：本文件在 lib 层，**不得 import components**（会被 importCycles 闸拦）。
 *   需要弹提示时写进 `notice`，由组件订阅后取走并 toast。
 */
import { useSyncExternalStore } from 'react'
import {
  DEAI_TEMPLATES,
  extractAndCommitSettings,
  type ChapterDraft,
  type ContinueStrategy,
  type DraftDecision,
} from './autoContinue'
import {
  runCreativeWriting,
  type CreativeResume,
  type CreativeTarget,
  type CreativeWritingResult,
} from './aiWorkflow'
import * as db from './db'
import type { DraftBundle, DraftRow, FlowProgress } from './flow/types'
import {
  aiRewriteChapter,
  CHAPTER_REWRITE_META,
  type ChapterRewriteAction,
  type OutlineResult,
} from './aiTasks'
import {
  applyChapterRewrite,
  expectedRewriteWords,
  isSuspectRewrite,
  listRewriteCandidates,
} from './chapterRewrite'
import { countWords } from './textStats'
import type { LedgerItem } from './settingLedger'

/** 创作起点：从一句话想法从零写 / 接着项目已有内容往下写 */
export type CreativeMode = 'scratch' | 'continue'

/**
 * 产出目标 —— 定义在编排器侧（`aiWorkflow` 的 `CreativeTarget`），这里**再导出**给界面用。
 *   `'outline'` 只做大纲规划 / `'full'` 大纲 + 正文 / `'draft'` 只生成正文
 * 🔴 单一真理源：三个档位的语义与编排器的分支是同一处定义，别再本地抄一份（会漂）。
 */
export type { CreativeTarget }

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

let snap: CreativeSession = {
  hydrated: false,
  inputs: { ...DEFAULT_INPUTS },
  running: false,
  progress: null,
  summaries: {},
  log: [],
  bibleGate: null,
  outlineGate: null,
  draftAsk: null,
  candidatesAsk: null,
  candidatesSelected: [],
  result: null,
  resume: null,
  notice: null,
  lastSavedAt: 0,
  rewrite: null,
}

const listeners = new Set<() => void>()
function emit() {
  for (const l of listeners) l()
}
/**
 * 只更新快照并通知界面，**不排写盘**。
 *
 * 专供 `persistNow` 回写「已保存时间」用：那里若走 `set`，就会
 * 「写盘成功 → 更新 lastSavedAt → 再次排程写盘」**无限循环**（每 1 秒写一次盘）。
 */
function emitOnly(patch: Partial<CreativeSession>) {
  snap = { ...snap, ...patch }
  emit()
}
function set(patch: Partial<CreativeSession>) {
  snap = { ...snap, ...patch }
  emit()
  schedulePersist()
}

export function subscribeCreative(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
export function creativeSnapshot(): CreativeSession {
  return snap
}
/** 组件订阅点：切页签重挂载后拿到的就是原样状态（任务还在跑） */
export function useCreativeSession(): CreativeSession {
  return useSyncExternalStore(subscribeCreative, creativeSnapshot, creativeSnapshot)
}

// ============ 派生工具 ============

/** 当前输入对应的去 AI 味儿提示词（自定义模板取输入框，其余取内置） */
export function deAiPromptOf(inp: CreativeInputs): string {
  if (inp.deAiTpl === 'custom') return inp.deAiCustom.trim()
  return DEAI_TEMPLATES.find(t => t.id === inp.deAiTpl)?.prompt ?? ''
}

function notice(text: string, kind: CreativeNotice['kind'] = 'info') {
  set({ notice: { id: ++noticeSeq, text, kind } })
}
let noticeSeq = 0

/** 组件 toast 完把它清掉（避免同一条在切页签后被重复消费） */
export function consumeNotice() {
  if (snap.notice) set({ notice: null })
}

export function updateInputs(patch: Partial<CreativeInputs>) {
  set({ inputs: { ...snap.inputs, ...patch } })
}

/**
 * 「保存」按钮：把当前输入（含一句话想法）**立即**落盘，不等那 1 秒防抖。
 *
 * 为什么需要它（老大 2026-09-20 要求）：输入框原先只有"自动防抖落盘"这一条路，
 * 作者既看不到到底存没存，也没有一个能主动确认的动作 —— 于是反馈"这个窗口没办法保存"。
 * 现在把它变成显式动作：点一下，立刻写下去，并如实回一句结果。
 */
export async function saveInputsNow() {
  const ok = await flushPersist()
  notice(ok ? '已保存' : '保存失败：当前没有打开的项目', ok ? 'success' : 'error')
}

/**
 * 「清空」按钮：清空一句话想法，并立刻落盘。
 *
 * 🔴 清空后必须**立刻写盘**：若仍走 1 秒防抖，作者清完马上刷新/切页签，
 *    读回来的还是清空前的内容 —— 看起来就是"清空失效"。
 * ⚠️ 破坏性动作的二次确认在**组件层**做（store 在 lib 层，不得 import 组件里的 `confirmDialog`）。
 */
export async function clearSeed() {
  updateInputs({ seed: '' })
  await flushPersist()
  notice('想法已清空', 'info')
}

// ============ 持久化（按项目分键 · 防抖 1s） ============

const KEY_PREFIX = 'creativeSession'
let persistTimer: ReturnType<typeof setTimeout> | null = null
// ⚠️ 「当前会话属于哪个项目」由下面的 `hydratedFor` 唯一表达（2026-09-20）。
//    原先另有一个 `boundProjectId` 与它重复，且只写不读 —— 已删除，避免两套"当前项目"打架。

function keyOf(pid: string) {
  return `${KEY_PREFIX}:${pid}`
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistNow()
  }, 1000)
}

async function persistNow(): Promise<boolean> {
  try {
    const pid = db.getCurrentProjectId()
    if (!pid) return false
    // 断点只存里程，不存 bag（bag 里的产物本就已落库，续跑跳过前序阶段是对的）
    const resume = snap.resume
      ? {
          from: snap.resume.from,
          doneChapters: snap.resume.doneChapters,
          totalChapters: snap.resume.totalChapters,
          label: snap.resume.label,
        }
      : null
    await db.setMeta(keyOf(pid), {
      inputs: snap.inputs,
      log: snap.log.slice(-60),
      resume,
      result: snap.result,
      progress: snap.progress
        ? {
            status: snap.progress.status,
            ratio: snap.progress.ratio,
            message: snap.progress.message,
            stages: snap.progress.stages.map(s => ({
              id: s.id, label: s.label, status: s.status, ratio: s.ratio, detail: s.detail,
            })),
          }
        : null,
      summaries: snap.summaries,
    })
    // 回写「已保存」时间 —— 🔴 必须走 emitOnly：走 set 会再排一次写盘，形成无限循环
    emitOnly({ lastSavedAt: Date.now() })
    return true
  } catch {
    /* 写盘失败不影响创作本身（切页签仍在内存里） */
    return false
  }
}

/**
 * 立即落盘，不等那 1 秒防抖。
 *
 * 「保存」按钮、「清空」都用它 —— 作者点了按钮就应当立刻写下去；
 * 若仍走防抖，那 1 秒里关软件 / 切项目，这次点击就等于没发生。
 */
export async function flushPersist(): Promise<boolean> {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  return persistNow()
}

/** 切项目必须清掉的**运行态**：闸门 / 弹窗 / 改写 —— 它们都属于上一个项目，留着会串味 */
const RUNTIME_RESET: Partial<CreativeSession> = {
  bibleGate: null, outlineGate: null, draftAsk: null, candidatesAsk: null, candidatesSelected: [],
  rewrite: null,
}

/** 结果类字段的"空"值（读不到会话时用它，而不是留着上一个项目的数据） */
const SESSION_BLANK: Partial<CreativeSession> = {
  log: [], resume: null, result: null, progress: null, summaries: {},
}

/**
 * 已经读完会话的**项目 id**（`null` = 还没读过任何项目）。
 *
 * 🔴 为什么记 id 而不是一个布尔量：原先用 `hydrateStarted: boolean`「只读一次」，
 *    于是**切项目后不会重读** —— 面板显示的还是上一个项目的想法、断点与日志，
 *    而且下一次写盘会把它原样写进**新项目**的键里（跨项目串味）。
 *    这是老大 2026-09-20 反馈「输入窗口没办法保存」的真实成因链之一：
 *    在 A 项目写的想法会在 B 项目被写回，A 那边反而看不到自己刚写的东西。
 *    记住 id 之后，切项目（面板重新挂载）会自动换成新项目的会话。
 */
let hydratedFor: string | null = null

/**
 * 面板挂载时调用：读回**当前项目**的上次会话。
 * 同一个项目重复调用会被跳过（多组件挂载不会重复读）。
 */
export function hydrateCreativeSession() {
  void loadSession(db.getCurrentProjectId() ?? '')
}

async function loadSession(pid: string) {
  if (hydratedFor === pid) return
  hydratedFor = pid
  let patch: Partial<CreativeSession> = { ...RUNTIME_RESET, ...SESSION_BLANK, hydrated: true }
  try {
    const saved = await db.getMeta<{
      inputs?: Partial<CreativeInputs>
      log?: string[]
      resume?: CreativeResume | null
      result?: CreativeResultSummary | null
      progress?: FlowProgress | null
      summaries?: Record<string, string>
    } | null>(keyOf(pid), null)
    if (saved) {
      patch = {
        ...patch,
        inputs: { ...DEFAULT_INPUTS, ...(saved.inputs ?? {}) },
        log: saved.log ?? [],
        // 落盘的 resume 没有 bag（见阶段说明）—— 作为"里程"显示，续跑照常可用
        resume: (saved.resume as CreativeResume | null) ?? null,
        result: saved.result ?? null,
        progress: saved.progress ?? null,
        summaries: saved.summaries ?? {},
      }
    } else {
      // 老库兼容：一键续写的去 AI 味儿偏好单独存过 key，迁进来
      const legacy: { enabled?: boolean; template?: string; custom?: string } = await db
        .getMeta<{ enabled?: boolean; template?: string; custom?: string }>('deAiPrefs', {})
        .catch(() => ({}))
      patch = {
        ...patch,
        inputs: {
          ...DEFAULT_INPUTS,
          ...(typeof legacy.enabled === 'boolean' ? { deAiOn: legacy.enabled } : {}),
          ...(legacy.template ? { deAiTpl: legacy.template } : {}),
          ...(typeof legacy.custom === 'string' ? { deAiCustom: legacy.custom } : {}),
        },
      }
    }
  } catch {
    /* 读不到就用默认值 */
  }
  set(patch)
}

/**
 * 切项目检测：会话（输入参数 / 结果 / 断点 / 日志）都属于某个项目，切了就得**换成新项目的**。
 *
 * 🔴 2026-09-20 修正：原来只把结果类字段清零，**不动 `inputs`** ——
 *    于是切到项目 B 后面板上仍是项目 A 的想法与参数，接着一写盘就把 A 的输入
 *    写进了 B 的键（A 那边反而"丢"了）。现在改为重读新项目的会话，与「打开面板」走同一条路径。
 * 有活任务时不动（那次运行自己认的是启动时的项目）。
 */
async function bindProject() {
  await loadSession(db.getCurrentProjectId() ?? '')
}

// ============ 运行控制（任务跑在这里，不在组件里） ============

let abortCtl: AbortController | null = null
let gateResolve: ((v: unknown) => void) | null = null
let draftResolve: ((v: DraftDecision) => void) | null = null
let candsResolve: ((v: LedgerItem[] | null) => void) | null = null
let summariesAcc: Record<string, string> = {}

function appendLog(line: string) {
  set({ log: [...snap.log, line] })
}

/** 抓「刚完成那一刻」的阶段 detail 当产物摘要（下一阶段一开跑就会把它覆盖掉） */
function captureSummaries(p: FlowProgress) {
  let changed = false
  for (const s of p.stages) {
    if (s.status === 'done' && s.detail && !summariesAcc[s.id]) {
      summariesAcc = { ...summariesAcc, [s.id]: s.detail.replace(/…$/, '') }
      changed = true
    }
  }
  return changed ? { ...summariesAcc } : null
}

export async function startCreativeRun(opts: { fromScratch?: boolean } = {}) {
  if (snap.running) return
  await bindProject()
  const inp = snap.inputs
  // ⚠️ 「库里还没有大纲时必须先写一句话想法」这条校验放在**面板**做（它读得到项目现状，
  //    能把按钮直接禁用并写明原因）。这里不拦：编排器会给出同样的中文提示，
  //    而在 store 里凭一个静态开关拦，容易和自动判定的真实起点不一致。
  const useResume = opts.fromScratch ? null : snap.resume
  if (opts.fromScratch) set({ resume: null })
  /** 本次是否交回了续跑信息（用局部变量判定：setState 异步，闭包里的 resume 还是旧值） */
  let gotResume: CreativeResume | null = null
  const ctl = new AbortController()
  abortCtl = ctl
  summariesAcc = {}
  set({
    running: true, result: null, log: [], progress: null, summaries: {},
    bibleGate: null, outlineGate: null, draftAsk: null, candidatesAsk: null, candidatesSelected: [],
  })
  try {
    const res = await runCreativeWriting(
      // 🔴 不再传起点：编排器读项目库自己判定（有卷大纲/细纲 → 接着写，否则从零）
      { seed: inp.seed, intent: inp.intent },
      {
        target: inp.target,
        volumes: inp.volumes,
        chaptersPerVolume: inp.chaptersPerVolume,
        chapters: inp.chapters,
        targetWords: inp.words,
        strategy: inp.strategy,
        deAi: { enabled: inp.deAiOn, prompt: deAiPromptOf(inp) },
        useOutline: inp.useOutline,
        topUpLast: inp.topUpLast,
        structureId: inp.structureId,
        signal: ctl.signal,
        ...(useResume ? { resume: useResume } : {}),
        onResume: r => {
          gotResume = r
          set({ resume: r })
        },
        onProgress: p => {
          const next = captureSummaries(p)
          set(next ? { progress: p, summaries: next } : { progress: p })
        },
        // 闸门：把 Promise 挂在这里等 —— 组件只负责显示与 resolve，切页签不影响它
        onBibleGate: (bundle: DraftBundle) =>
          new Promise<DraftRow[] | null>(resolve => {
            gateResolve = resolve as (v: unknown) => void
            set({ bibleGate: bundle })
          }),
        onOutlineGate: (outline: OutlineResult) =>
          new Promise<boolean>(resolve => {
            gateResolve = resolve as (v: unknown) => void
            set({ outlineGate: outline })
          }),
        onChapterSaved: ch => appendLog(`✅ 第${ch.no}章 ${ch.title}`),
        /**
         * 🔴 逐章日志必须接出来（2026-09-19 复现用例抓到）：`runAutoContinue` 把**失败原因**
         *    全部交给这个回调，原先没接 ⇒ 「一章都没写出来」时，界面上只有一句绿色的
         *    「创作完成：写了 0 章」，模型为什么失败一个字都看不到。老大真实数据里那条
         *    会话的 `log` 是空数组，罪魁就是这个黑洞。
         */
        onRunLog: line => appendLog(line),
        ...(inp.reviewEach
          ? {
              onChapterDraft: (d: ChapterDraft) =>
                new Promise<DraftDecision>(resolve => {
                  draftResolve = resolve
                  set({ draftAsk: { d } })
                }),
            }
          : {}),
        // strategy='confirm' 时才会被调用（见 autoContinue 的 extractAndCommitSettings）
        onSettingsCandidates: (cands: LedgerItem[]) =>
          new Promise<LedgerItem[] | null>(resolve => {
            candsResolve = resolve
            set({
              candidatesAsk: { cands },
              candidatesSelected: cands.filter(c => c.status === 'new').map(c => c.key),
            })
          }),
      },
    )
    if (!res) {
      // 有续跑信息 = 被中止（可以接着写）；没有 = 在闸门处主动放弃，别再劝他继续
      notice(
        gotResume
          ? '已中止 —— 可点「继续写作」接着写，已写完的章不会重写'
          : '已中止，未留下半成品',
        'info',
      )
      return
    }
    set({ result: summarizeResult(res), resume: null })
    // 🔴 「一章都没写出来」不能再报成功（2026-09-19）：原先无论写了几章都弹绿色
    //    「创作完成：写了 N 章」，N=0 时作者会以为"跑完了、就是没内容"，而真正的原因
    //    （模型超时 / 未配置）就躺在日志里没人看。分开报，并把「去看日志」写进文案。
    if (res.outlineOnly) {
      notice('大纲已保存 —— 按你的选择，没有写正文', 'success')
    } else if (res.chapters.length === 0) {
      notice('一章都没写出来 —— 请看下方「运行日志」里的失败原因（常见：模型超时 / 返回异常）', 'error')
    } else {
      notice(`创作完成：写了 ${res.chapters.length} 章`, 'success')
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/放弃/.test(msg)) notice('已放弃本次创作（未写入任何数据）', 'info')
    else notice('创作失败：' + msg, 'error')
  } finally {
    abortCtl = null
    gateResolve = null
    draftResolve = null
    candsResolve = null
    set({ running: false, bibleGate: null, outlineGate: null, draftAsk: null, candidatesAsk: null })
  }
}

/** 中止：同时**解除所有挂起的弹窗 Promise**，否则编排器会永远 await、按钮一直转圈 */
export function stopCreativeRun() {
  abortCtl?.abort()
  if (draftResolve) {
    draftResolve('abort')
    draftResolve = null
    set({ draftAsk: null })
  }
  if (candsResolve) {
    candsResolve(null)
    candsResolve = null
    set({ candidatesAsk: null, candidatesSelected: [] })
  }
  if (gateResolve) {
    gateResolve(null)
    gateResolve = null
    set({ bibleGate: null, outlineGate: null })
  }
}

/** 闸门决策：把作者的选择交回编排器 */
export function resolveGate(v: unknown) {
  const r = gateResolve
  gateResolve = null
  set({ bibleGate: null, outlineGate: null })
  r?.(v)
}

export function decideDraft(v: DraftDecision) {
  const r = draftResolve
  draftResolve = null
  set({ draftAsk: null })
  r?.(v)
}

export function toggleCandidate(key: string, on: boolean) {
  const cur = new Set(snap.candidatesSelected)
  if (on) cur.add(key)
  else cur.delete(key)
  set({ candidatesSelected: [...cur] })
}

export function applyCandidates(list: LedgerItem[] | null) {
  const r = candsResolve
  candsResolve = null
  set({ candidatesAsk: null, candidatesSelected: [] })
  r?.(list)
}

// ============ 整章改写（对已有章节做整章级的润色 / 扩写 / 精简 / 改写） ============

let rewriteCtl: AbortController | null = null

/**
 * 对已有某一章跑整章改写。
 *
 * 与「创作」互斥（同一时刻只跑一个长任务）—— 两者都在花额度，同时跑只会互相抢模型。
 */
export async function startChapterRewrite(p: {
  chapterId: string
  action: ChapterRewriteAction
  requirement: string
  words: number
}) {
  if (snap.running || snap.rewrite?.running) return
  await bindProject()
  let cands: Awaited<ReturnType<typeof listRewriteCandidates>>
  try {
    cands = await listRewriteCandidates()
  } catch (e) {
    notice('读不到章节列表：' + (e instanceof Error ? e.message : String(e)), 'error')
    return
  }
  const idx = cands.findIndex(c => c.chapter.id === p.chapterId)
  if (idx < 0) { notice('这一章已经不在项目里了', 'error'); return }
  const hit = cands[idx]
  if (!hit.chapter.content.trim()) { notice('这一章还没有正文，没什么可改的', 'info'); return }
  // 🔴 候选列表是按真实叙事顺序排的，所以**最后一个**就是最新章。
  //    最新章 vs 历史章的改写纪律完全不同（见 aiTasks 的两条 RULE）：历史章冻结设定，最新章放开、
  //    但落库后要补跑设定同步。
  const isLatest = idx === cands.length - 1
  // 期望字数（异常判定的基准）：润色＝原文长度；扩写 / 精简 / 改写＝面板上填的目标字数。
  // 🔴 不能用"原文的固定占比"当基准 —— 精简本来就是要压字数，那样会把正常结果判成异常（见 expectedRewriteWords）。
  const fromWords = countWords(hit.chapter.content) || hit.chapter.wordCount
  const expectWords = expectedRewriteWords(p.action, fromWords, p.words)

  const ctl = new AbortController()
  rewriteCtl = ctl
  set({
    rewrite: {
      chapterId: hit.chapter.id, title: hit.chapter.title, no: hit.no,
      action: p.action, text: '', running: true, fromWords, expectWords, isLatest,
    },
  })
  // 上一章结尾当衔接样本（改写后仍要接得上）；改的是首章就没有
  const prevTail = idx > 0 ? (cands[idx - 1].chapter.content ?? '').trim() : ''
  // 流式累积 + 节流刷新：每个 token 都 set 会让组件逐字重渲染
  let buf = ''
  let lastFlush = 0
  const flush = (force = false) => {
    const now = Date.now()
    if (!force && now - lastFlush < 120) return
    lastFlush = now
    const cur = snap.rewrite
    if (cur) set({ rewrite: { ...cur, text: buf } })
  }
  try {
    const text = await aiRewriteChapter({
      title: hit.chapter.title,
      body: hit.chapter.content,
      action: p.action,
      requirement: p.requirement,
      isLatest,
      ...(CHAPTER_REWRITE_META[p.action].needWords ? { targetWords: p.words } : {}),
      ...(prevTail ? { contextTail: prevTail } : {}),
      signal: ctl.signal,
      onToken: d => { buf += d; flush() },
      // 🔴 字数校准**没生效**时如实提示（模型失败 / 被截断）——
      //    否则作者只看到「2202 → 2202 字」，分不清是"模型没干活"还是"本来就不用补"。
      onLog: msg => notice(msg, 'info'),
    })
    buf = text
    if (!text.trim()) {
      notice('模型没有返回可用正文，可以再试一次', 'error')
      set({ rewrite: null })
      return
    }
    // 🔴 必须在这里把 running 置回 false。flush() 只更新 text —— 漏了这步，界面会永远停在
    //    「正在改写…」，预览与「替换该章正文」永远不出来（2026-09-19 实机验证抓到：
    //    AI 层 86 秒就跑完了，界面却等了 12 分钟还没动静）。
    //
    // 🔴 结果异常保护：实测遇到模型只返回 1 个字的偶发情况（同一 prompt 前后三次实测
    //    分别返回 3494 / 4271 / 4563 字，说明不是 prompt 问题）。「替换该章正文」是**覆盖**
    //    作者正文的破坏性动作，一旦点下去就只剩快照能救 —— 所以可疑结果必须锁住它。
    // 🔴 判据是「与**期望字数**的差距」，不是「相对原文的固定占比」（见 chapterRewrite 的两个纯函数）：
    //    后者会把正常精简判成异常（压到目标字数必然远低于原文），又漏掉扩写方向的严重缩水。
    const outWords = countWords(text)
    const suspect = isSuspectRewrite(fromWords, outWords, expectWords)
    if (suspect) {
      notice(`模型返回 ${outWords} 字，与期望的约 ${expectWords} 字相差过大 —— 已锁住替换，请重新生成`, 'error')
    }
    const cur = snap.rewrite
    if (cur) set({ rewrite: { ...cur, text: buf, running: false, suspect } })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const aborted = /取消|abort/i.test(msg)
    notice(aborted ? '已中止改写（没有写入任何内容）' : '改写失败：' + msg, aborted ? 'info' : 'error')
    set({ rewrite: null })
  } finally {
    rewriteCtl = null
  }
}

/** 中止改写（已收到的部分不写库） */
export function stopChapterRewrite() {
  rewriteCtl?.abort()
}

/**
 * 把改写结果写回该章 —— **全项目唯一会覆盖正文的动作**。
 * 写前由 `applyChapterRewrite` 自动存一份旧稿快照（可在「时光机 · 本章版本历史」恢复）。
 */
export async function applyRewrite() {
  const r = snap.rewrite
  if (!r || r.running) return
  try {
    // 🔴 B3：这是**创意写作**（从无到有产出正文），来源记 `generated` 而不是默认的 `rewritten`
    const { words } = await applyChapterRewrite(r.chapterId, r.text, 'generated')
    // 🔴 最新章改完要补跑一轮设定同步（老大 2026-09-19 要求）：它后面还没有正文，
    //    这一章的新信息必须进设定表，否则下一次「接着写」会读到旧设定。
    //    历史章**不跑** —— 纪律上它就不该产生新设定（那会污染设定表）。
    //    `confirm` 策略需要弹候选勾选，改写场景没有这个交互 → 降级为 `add-only`（只新增，最稳）。
    let extra = ''
    if (r.isLatest) {
      const strategy = snap.inputs.strategy === 'confirm' ? 'add-only' : snap.inputs.strategy
      try {
        const res = await extractAndCommitSettings(r.text, r.title, strategy, undefined)
        extra = res.created > 0 ? `；已同步设定 +${res.created} 条` : '；没有需要新增的设定'
      } catch {
        extra = '；设定同步未能完成（不影响正文，可到表格页用「AI 整理」补）'
      }
    } else {
      // 历史章的四种动作（含扩写 / 精简）都不产生设定变化：提示词已按动作分节冻结了设定类内容
      // （扩写不得新增设定、精简不得删设定交代），所以这一轮无需同步。
      extra = '；这是历史章，设定类内容已冻结，未改动设定表'
    }
    notice(
      `已替换《${r.title}》正文：${r.fromWords} → ${words} 字${extra}。` +
      '旧稿已存进「时光机 · 本章版本历史」（正文编辑里可随时恢复）。',
      'success',
    )
    set({ rewrite: null })
  } catch (e) {
    notice('写入失败：' + (e instanceof Error ? e.message : String(e)), 'error')
  }
}

/** 丢弃改写结果（不写库） */
export function discardRewrite() {
  if (snap.rewrite?.running) return
  set({ rewrite: null })
}

/** 清掉结果卡片与日志（作者想重开一轮时用；不影响已落库的数据） */
export function clearCreativeSession() {
  set({ result: null, log: [], progress: null, summaries: {}, resume: null })
}

function summarizeResult(res: CreativeWritingResult): CreativeResultSummary {
  return {
    mode: res.mode,
    bibleTotal: res.bible?.stats.total ?? 0,
    bibleCreated: res.bibleCommit?.created ?? 0,
    volumes: res.outline?.volumes.length ?? 0,
    outlineChapters: res.outline?.chapters.length ?? 0,
    wrote: res.chapters.length,
    outlineOnly: res.outlineOnly,
  }
}
