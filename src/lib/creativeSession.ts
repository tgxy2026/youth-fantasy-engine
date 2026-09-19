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
  type ChapterDraft,
  type ContinueStrategy,
  type DraftDecision,
} from './autoContinue'
import { runCreativeWriting, type CreativeResume, type CreativeWritingResult } from './aiWorkflow'
import * as db from './db'
import type { DraftBundle, DraftRow, FlowProgress } from './flow/types'
import type { OutlineResult } from './aiTasks'
import type { LedgerItem } from './settingLedger'

/** 创作起点：从一句话想法从零写 / 接着项目已有内容往下写 */
export type CreativeMode = 'scratch' | 'continue'

export interface CreativeInputs {
  mode: CreativeMode
  /** 从零创作：一句话想法 */
  seed: string
  /** 接着写：情节概要（可选；留空则严格承接上一章结尾） */
  intent: string
  /** 从零创作：分几卷 */
  volumes: number
  /** 连写多少章 */
  chapters: number
  /** 每章目标字数 */
  words: number
  /** 设定更新策略（连写时如何补登设定） */
  strategy: ContinueStrategy
  /** 生成后自动去 AI 味儿 */
  deAiOn: boolean
  deAiTpl: string
  deAiCustom: string
  /** 接着写：是否按已落库的《章节细纲》写 */
  useOutline: boolean
  /** 每章初稿先交作者确认（关掉＝全自动跑量） */
  reviewEach: boolean
}

export const DEFAULT_INPUTS: CreativeInputs = {
  mode: 'scratch',
  seed: '',
  intent: '',
  volumes: 1,
  chapters: 10,
  words: 2500,
  strategy: 'add-only',
  deAiOn: true,
  deAiTpl: 'natural',
  deAiCustom: '',
  useOutline: true,
  reviewEach: true,
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
}

const listeners = new Set<() => void>()
function emit() {
  for (const l of listeners) l()
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

// ============ 持久化（按项目分键 · 防抖 1s） ============

const KEY_PREFIX = 'creativeSession'
let persistTimer: ReturnType<typeof setTimeout> | null = null
/** 本次会话属于哪个项目 —— 切项目时要重置（结果与断点都属于上一个项目） */
let boundProjectId = ''

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

async function persistNow() {
  try {
    const pid = db.getCurrentProjectId()
    if (!pid) return
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
  } catch {
    /* 写盘失败不影响创作本身（切页签仍在内存里） */
  }
}

let hydrateStarted = false
/**
 * 首次挂载时调用：读回本项目的上次会话。
 * 只读一次（多组件挂载不会重复读）；`hydrated` 让界面知道"参数是否已就位"。
 */
export function hydrateCreativeSession() {
  if (hydrateStarted) return
  hydrateStarted = true
  void (async () => {
    let patch: Partial<CreativeSession> = { hydrated: true }
    try {
      const pid = db.getCurrentProjectId()
      boundProjectId = pid ?? ''
      const saved = await db.getMeta<{
        inputs?: Partial<CreativeInputs>
        log?: string[]
        resume?: CreativeResume | null
        result?: CreativeResultSummary | null
        progress?: FlowProgress | null
        summaries?: Record<string, string>
      } | null>(keyOf(pid ?? ''), null)
      if (saved) {
        patch = {
          hydrated: true,
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
          hydrated: true,
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
  })()
}

/**
 * 切项目检测：会话（结果 / 断点 / 日志）都属于某个项目，切了就得重置 ——
 * 否则会把上一个项目的断点显示在另一个项目里，续写接错章。
 * 有活任务时不动（那次运行自己认的是启动时的项目）。
 */
async function bindProject() {
  const pid = db.getCurrentProjectId() ?? ''
  if (boundProjectId && pid && pid !== boundProjectId) {
    boundProjectId = pid
    set({
      resume: null, result: null, log: [], progress: null, summaries: {},
      bibleGate: null, outlineGate: null, draftAsk: null, candidatesAsk: null, candidatesSelected: [],
    })
  } else if (!boundProjectId) {
    boundProjectId = pid
  }
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
  if (inp.mode === 'scratch' && !inp.seed.trim()) {
    notice('请先用一句话说清你想写什么', 'info')
    return
  }
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
      { mode: inp.mode, seed: inp.seed, intent: inp.intent },
      {
        chapters: inp.chapters,
        targetWords: inp.words,
        volumes: inp.volumes,
        strategy: inp.strategy,
        deAi: { enabled: inp.deAiOn, prompt: deAiPromptOf(inp) },
        useOutline: inp.useOutline,
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
          new Promise<boolean | 'outline-only'>(resolve => {
            gateResolve = resolve as (v: unknown) => void
            set({ outlineGate: outline })
          }),
        onChapterSaved: ch => appendLog(`✅ 第${ch.no}章 ${ch.title}`),
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
    notice(
      res.outlineOnly
        ? '大纲已保存 —— 按你的选择，没有写正文'
        : `创作完成：写了 ${res.chapters.length} 章`,
      'success',
    )
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
