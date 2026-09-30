/**
 * 「跨页签任务中心」—— 模块级单例，让长任务**跨页签存活**。
 *
 * 为什么需要它（社区反馈，2026-09-30）：
 *   `App.tsx` 是「切页签即卸载旧组件」的条件渲染（`renderContent()` 同一时刻只挂一个页签）。
 *   长任务若把状态放在组件 `useState` 里，切走就两种情况——要么被卸载清理里的 `abort()`
 *   当场杀掉、要么请求在后台跑完却把结果写进**已卸载组件**的 `setState`（no-op）→ 额度白烧、
 *   结果蒸发。本模块把任务状态与执行**都搬到模块级**：组件只订阅与展示，
 *   **任务本身跑在 store 里，与组件是否挂载无关**。
 *
 * 与 `creativeSession.ts` 的关系：那是「创意写作」专用的会话 store，是这条路的第一个样板；
 *   本模块是把它**一般化**后的**通用容器**，供所有长任务（拆书 / 表格整理 / 校对 / 审计…）共用。
 *
 * 三条设计边界（沿用既有约定，别破）：
 * - 🔴 **真并行**（主人哥哥 2026-09-30 拍板）：**不做全局队列**，每个任务自带 `AbortController`，
 *   互不排队、各自烧各自的额度。本模块是「登记簿」，不是「调度器」。
 * - 🔴 **lib 层禁 import components**（importCycles 闸拦）。需要弹提示时写进 `notice`，
 *   由组件订阅后取走并 toast。
 * - 🔴 **中止只由用户显式触发**（面板按钮 / 退出项目）——切页签**绝不**中止任何任务。
 *
 * ⚠️ 阶段一（2.6.3）**只做内存态**：跨页签存活已完整解决（同一 JS 运行时）。
 *    跨「关软件再打开」的产物 / 断点持久化**刻意留待后续**——拆书的 `resume.bag` 与结果
 *    `DraftBundle` 体积都可能很大（整本原文 / 几十条草稿），贸然落进 meta 会拖垮存储；
 *    要落盘得先定「存什么、存多大、放哪」，这是一件需要单独设计的事（见方案文档）。
 */
import { useSyncExternalStore } from 'react'
import { uid } from './id'

export type AiTaskStatus = 'running' | 'done' | 'failed' | 'aborted'

export interface AiTask<TResult = unknown, TProgress = unknown> {
  /** 任务 id（不透明主键） */
  id: string
  /** 发起它的页签 id —— 结果回填与「点回去看」都靠它 */
  ownerTab: string
  /** 界面显示名，如「一键拆书」 */
  title: string
  /** 任务类别（同一页签可发起多类，如 'bookbreak'） */
  kind: string
  status: AiTaskStatus
  /** 最近一次进度快照（由调用方定义形状，如 `FlowProgress`） */
  progress: TProgress | null
  /** 完成后的结果（**只活在内存**，可能很大） */
  result: TResult | null
  /** 失败原因（`status === 'failed'` 时非空） */
  error: string
  startedAt: number
  finishedAt: number
  /** 完成但作者还没看过（界面据此显示「已完成未查看」） */
  unread: boolean
  /**
   * 是否已经提示过「切页签后仍在后台运行」。
   * 🔴 同一任务**只提示一次**：每次切页签都弹会让作者烦到关掉提示，反而更糟。
   */
  notified: boolean
  /** 中止时拿到的续跑断点（形状由调用方定义，如 `BookBreakResume`） */
  resume: unknown
}

/** 交给 `run` 的执行上下文：进度上报 / 断点回传 / 中止探测 */
export interface AiTaskCtx<TProgress = unknown> {
  id: string
  /** 中止信号 —— 直接传给底层 fetch / 编排器 */
  signal: AbortSignal
  /** 上报进度（各阶段调多次） */
  progress: (p: TProgress | null) => void
  /** 回传续跑断点（中止后界面据此显示「继续」） */
  setResume: (r: unknown) => void
  /** 任务是否已被中止（编排器内部循环里自查） */
  isAborted: () => boolean
}

export interface StartTaskDef<TResult = unknown, TProgress = unknown> {
  ownerTab: string
  title: string
  kind: string
  /** 任务本体：在 store 里执行，生命周期与组件无关 */
  run: (ctx: AiTaskCtx<TProgress>) => Promise<TResult>
  /**
   * 自定义「结束提示」文案（缺省用通用文案）。
   * 返回 `null` 表示这次不提示。用于把「正文写了 3 卷 12 章 · 设定草稿 42 条」这类
   * **具体交代**换成通用的一句话 —— 提示只会弹一次，所以文案归任务自己写最准确。
   */
  notify?: (info: { status: Exclude<AiTaskStatus, 'running'>; result: TResult | null; error: string }) =>
    { text: string; kind: AiTaskNotice['kind'] } | null
}

export interface AiTaskNotice {
  /** 自增 id：同一条文案连发两次也能各弹一次 */
  id: number
  text: string
  kind: 'info' | 'success' | 'error'
}

interface Snap {
  tasks: AiTask[]
  notice: AiTaskNotice | null
}

let snap: Snap = { tasks: [], notice: null }
const listeners = new Set<() => void>()
/** 运行中的中止控制器（不进快照 —— AbortController 不可序列化也不必给界面） */
const ctls = new Map<string, AbortController>()
let noticeSeq = 0

function emit() {
  for (const l of listeners) l()
}
function set(patch: Partial<Snap>) {
  snap = { ...snap, ...patch }
  emit()
}

export function subscribeTasks(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
export function tasksSnapshot(): AiTask[] {
  return snap.tasks
}
export function noticeSnapshot(): AiTaskNotice | null {
  return snap.notice
}
/** 组件订阅点：切页签重挂载后拿到的就是原样列表（运行中的任务还在） */
export function useAiTasks(): AiTask[] {
  return useSyncExternalStore(subscribeTasks, tasksSnapshot, tasksSnapshot)
}
/** 订阅「一次性提示」（完成任务 / 失败），组件取走后必须调 `consumeTaskNotice()` */
export function useAiTaskNotice(): AiTaskNotice | null {
  return useSyncExternalStore(subscribeTasks, noticeSnapshot, noticeSnapshot)
}

/**
 * 找某页签发起的**最近一条**任务（可限定 kind）并订阅它 —— 面板的取值入口。
 * 每次渲染都从快照现取，不在组件里缓存引用（避免与 store 漂移）。
 */
export function useAiTask<TResult = unknown, TProgress = unknown>(ownerTab: string, kind?: string): AiTask<TResult, TProgress> | null {
  const tasks = useSyncExternalStore(subscribeTasks, tasksSnapshot, tasksSnapshot)
  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i]
    if (t.ownerTab === ownerTab && (!kind || t.kind === kind)) {
      return t as unknown as AiTask<TResult, TProgress>
    }
  }
  return null
}

function notice(text: string, kind: AiTaskNotice['kind'] = 'info') {
  set({ notice: { id: ++noticeSeq, text, kind } })
}
/** 组件 toast 完把它清掉（避免同一条在切页签后被重复消费） */
export function consumeTaskNotice() {
  if (snap.notice) set({ notice: null })
}

/** 局部更新一条任务（id 不存在则原样返回 —— 任务已被清掉时晚到的回调不该复活它） */
function patchTask(id: string, patch: Partial<AiTask>) {
  let hit = false
  const next = snap.tasks.map(t => {
    if (t.id !== id) return t
    hit = true
    return { ...t, ...patch }
  })
  if (hit) set({ tasks: next })
}

export function runningTaskCount(): number {
  return snap.tasks.filter(t => t.status === 'running').length
}
export function unreadTaskCount(): number {
  return snap.tasks.filter(t => t.status !== 'running' && t.unread).length
}

/**
 * 起一个任务。
 *
 * 🔴 同一页签同一 `kind` **同时只允许一个**在跑（面板的按钮也会禁用，这里是兜底）：
 *    重复发起只会白烧一次额度。冲突时返回 `null`，调用方应忽略。
 *
 * 另：发起新任务时会**顺手清掉同一页签同一 kind 的旧记录**（已完成/失败/中止的）——
 * 否则每跑一次就多一条历史行，指示器会被同名条目刷屏；而断点也随之清掉，
 * 避免「上次的 resume 被这次误用」。
 */
export function startTask<TResult = unknown, TProgress = unknown>(def: StartTaskDef<TResult, TProgress>): string | null {
  if (snap.tasks.some(t => t.ownerTab === def.ownerTab && t.kind === def.kind && t.status === 'running')) {
    console.warn(`[aiTaskCenter] 「${def.title}」已在运行，忽略重复发起`)
    return null
  }
  const id = uid()
  const ctl = new AbortController()
  ctls.set(id, ctl)
  const task: AiTask = {
    id,
    ownerTab: def.ownerTab,
    title: def.title,
    kind: def.kind,
    status: 'running',
    progress: null,
    result: null,
    error: '',
    startedAt: Date.now(),
    finishedAt: 0,
    unread: false,
    notified: false,
    resume: null,
  }
  const kept = snap.tasks.filter(
    t => !(t.ownerTab === def.ownerTab && t.kind === def.kind && t.status !== 'running'),
  )
  set({ tasks: [...kept, task] })

  const ctx: AiTaskCtx<TProgress> = {
    id,
    signal: ctl.signal,
    progress: p => patchTask(id, { progress: p }),
    setResume: r => patchTask(id, { resume: r }),
    isAborted: () => ctl.signal.aborted,
  }

  void (async () => {
    let status: Exclude<AiTaskStatus, 'running'> = 'done'
    let result: TResult | null = null
    let error = ''
    try {
      result = await def.run(ctx)
      // 编排器可能"优雅"返回 null / 正常 resolve，但信号已中止 —— 一律如实记为已中止
      if (ctl.signal.aborted) {
        status = 'aborted'
        result = null
      }
    } catch (e) {
      if (ctl.signal.aborted || (!!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError')) {
        status = 'aborted'
      } else {
        status = 'failed'
        error = e instanceof Error ? e.message : String(e)
      }
    } finally {
      ctls.delete(id)
      patchTask(id, {
        status,
        result,
        error,
        finishedAt: Date.now(),
        // 完成了但作者还在别的页签 → 标「未查看」，由任务指示器提醒
        unread: status === 'done',
        // 🔴 进度**不清空**：界面（如拆书的 WorkflowTimeline）跑完后仍要显示"每一步做了什么、
        //    花了多久" —— 清掉就只剩一片空白，作者事后没法复盘。下次发起的是一条新记录，自然从空开始。
      })
      // 🔴 完成/失败的提示必须由**store**发，而不是面板：作者很可能已经切到别的页签，
      //    面板此刻根本没挂载 —— 它自己 toast 等于没人 toast。由 `Sidebar` 的指示器订阅后弹出。
      //    文案优先用任务自定义的（能说清"写了多少章、抽了多少条"），缺省才用通用文案。
      const custom = def.notify?.({ status, result, error })
      if (custom) notice(custom.text, custom.kind)
      else if (status === 'done') notice(`「${def.title}」已完成 —— 结果保存在该页签，切回去即可查看`, 'success')
      else if (status === 'failed') notice(`「${def.title}」失败：${error || '未知原因'}`, 'error')
      /* 已中止不提示：是作者自己按的「中止」，他清楚 */
    }
  })()

  return id
}

/** 显式中止一个任务（**只有用户动作才会调它** —— 切页签绝不中止） */
export function abortTask(id: string): void {
  ctls.get(id)?.abort()
}

/** 中止全部运行中的任务（退出项目 / 关闭项目时用） */
export function abortAllTasks(): void {
  for (const c of ctls.values()) c.abort()
  ctls.clear()
}

/** 作者已看过结果 → 清掉「未查看」标记 */
export function markTaskSeen(id: string): void {
  const t = snap.tasks.find(x => x.id === id)
  if (t && t.unread) patchTask(id, { unread: false })
}

/** 移除一条**已结束**的任务（运行中的不允许移除；返回是否移除成功） */
export function dismissTask(id: string): boolean {
  const t = snap.tasks.find(x => x.id === id)
  if (!t || t.status === 'running') return false
  set({ tasks: snap.tasks.filter(x => x.id !== id) })
  return true
}

/** 清掉所有已结束的任务记录 */
export function clearFinishedTasks(): void {
  set({ tasks: snap.tasks.filter(t => t.status === 'running') })
}

/**
 * 取出「还没提示过切页签」的运行中任务，并就地打上已提示标记。
 *
 * 由 `App.tsx` 在 `navigate()` 里调用：切页签时若还有任务在跑，轻提示一次。
 * 🔴 返回的这批**本次已标记**，同一任务不会提示第二次。
 */
export function takeUnnotifiedRunning(): AiTask[] {
  const need = snap.tasks.filter(t => t.status === 'running' && !t.notified)
  if (!need.length) return []
  const ids = new Set(need.map(t => t.id))
  set({ tasks: snap.tasks.map(t => (ids.has(t.id) ? { ...t, notified: true } : t)) })
  return need
}

/** 退出项目：中止全部运行中任务并清空内存态（断点由各面板自行决定是否展示） */
export function resetTaskCenter(): void {
  abortAllTasks()
  set({ tasks: [], notice: null })
}
