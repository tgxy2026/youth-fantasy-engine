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
import { useCallback, useSyncExternalStore } from 'react'
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
  /**
   * 本任务会写入的资源标识（如 `chapters` / `table:characters` / `meta:sessions`）。
   * 用于**并发冲突轻提示**：两个 running 任务写了同一份资源时提醒作者别互相覆盖。
   * 只读任务留空数组即可。
   */
  writes: string[]
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
  /**
   * 本任务会写哪些资源（见 `AiTask.writes`）。与另一个 running 任务有交集时**轻提示**，不阻断。
   * 🔴 真并行是拍板决策（不做全局队列），这是它必须付的代价：写同一处要提醒，不许静默互相覆盖。
   */
  writes?: string[]
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
  // 🔴 真并行的必然代价：与另一个 running 任务写同一处资源 → **轻提示**（绝不阻断、不排队）
  const writes = def.writes ?? []
  if (writes.length) {
    const clash = snap.tasks.find(t => t.status === 'running' && t.writes.some(w => writes.includes(w)))
    if (clash) notice(`注意：「${def.title}」与正在进行中的「${clash.title}」会写到同一处内容，建议错开写入以免互相覆盖`, 'info')
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
    writes,
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

// ─────────────────────────────────────────────────────────────────────────────
// 面板侧的**统一接线**：`useTaskRunner` 把一个「弹窗 / 面板内的 AI 任务」接到任务中心，
// 让面板从「自己拿 useState 存 loading/result」退化为「提交 + 订阅 + 展示」。
//
// 为什么抽出来：B 类面板（AIOrganize / AuditModals / 校对…）形态高度相似——都是
// 「按钮起一次请求 → 期间显示进度 → 成功后渲染结果」。若每处各写一遍
// `useAiTask` + `startTask` + 结果同步，既啰嗦又容易漂移（有的忘了把结果写回、
// 有的把 error 吞了）。这里把口径收成一处。
//
// ⚠️ **结果回填的时机**：`result` 直接读 `task.result`，因此**面板重新挂载**（切页签回来、
//    弹窗重开）时，只要任务中心还留着那条记录，结果就是现成的 —— 这是「切走不丢」的关键。
//    组件若要把它同步进本地 state（如勾选集要跟着结果重置），用 `useEffect` 监听 `result` 即可。
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskRunnerOpts {
  /** 发起它的页签 id（结果回填 / 指示器「点回去看」都靠它） */
  ownerTab: string
  /** 任务类别 —— 同一页签可并有多类（如编辑器里的 diagnosis / proofread / review…） */
  kind: string
  /** 界面显示名（指示器与完成提示里用） */
  title: string
  /** 本任务最终会写哪些资源（见 `AiTask.writes`）；只读任务不传 */
  writes?: string[]
}

export interface TaskRunner<TResult = unknown, TProgress = unknown> {
  /** 当前任务（含 status / progress / resume），组件订阅它即可 */
  task: AiTask<TResult, TProgress> | null
  /** 结果（`task.result` 的便捷取用；未完成 / 失败 / 中止时为 null） */
  result: TResult | null
  /** 失败原因（非空即展示；中止与正常结束都是空串） */
  error: string
  /** 是否在跑（按钮禁用 / 显示「进行中」用） */
  running: boolean
  /** 起任务：同名同 kind 已在跑则**忽略**（`startTask` 内兜底，避免白烧一次额度） */
  run: (
    fn: (ctx: AiTaskCtx<TProgress>) => Promise<TResult>,
    /** 可选：自定义完成提示文案（缺省用通用文案） */
    notify?: StartTaskDef<TResult, TProgress>['notify'],
  ) => void
  /** 显式中止（**只有用户点「停止」才调它** —— 切页签绝不中止） */
  stop: () => void
  /** 清掉这条**已结束**的记录（「重新整理」等按钮用，让结果区回到初始态）；运行中无效 */
  clear: () => void
}

/**
 * 把面板内的 AI 请求接到任务中心的最小钩子。
 *
 * ```tsx
 * const t = useTaskRunner<MyResult>({ ownerTab: tab.id, kind: 'organize', title: 'AI 整理' })
 * // 发起：
 * t.run(ctx => doAiWork({ signal: ctx.signal, onProgress: ctx.progress }))
 * // 展示：
 * if (t.running) …  else if (t.error) …  else if (t.result) …
 * ```
 */
export function useTaskRunner<TResult = unknown, TProgress = unknown>(
  opts: TaskRunnerOpts,
): TaskRunner<TResult, TProgress> {
  const { ownerTab, kind, title, writes } = opts
  const task = useAiTask<TResult, TProgress>(ownerTab, kind)

  const run = useCallback(
    (
      fn: (ctx: AiTaskCtx<TProgress>) => Promise<TResult>,
      notify?: StartTaskDef<TResult, TProgress>['notify'],
    ) => {
      startTask<TResult, TProgress>({ ownerTab, kind, title, run: fn, notify, writes })
    },
    [ownerTab, kind, title, writes],
  )

  const taskId = task?.id
  const stop = useCallback(() => {
    if (taskId) abortTask(taskId)
  }, [taskId])
  const clear = useCallback(() => {
    if (taskId) dismissTask(taskId)
  }, [taskId])

  return {
    task,
    result: task?.result ?? null,
    error: task?.error ?? '',
    running: task?.status === 'running',
    run,
    stop,
    clear,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 章节归属（2026-10-01 六维审计 P1）
//
// 🔴🔴 为什么必须有：`useTaskRunner` 按 `(ownerTab, kind)` 取**最近一条**任务
//    （见 `useAiTask`）——任务中心**不支持按业务键取历史**。于是同一个面板
//    「A 章跑完 → 关掉/切页签 → 换到 B 章再打开」时，会把 A 章那一份当成 B 章的
//    （跨章串报告：拿 A 章的诊断看 B 章）。
//    对策只有一条：**发起时把章节戳盖进 progress / result**，取值时只放行
//    「归属 == 当前章」的那一份，其余一律当作「没跑过」。
//
// ⚠️ 章节戳必须写进 `progress`（且放在 `run` 的**第一行**）：只要任务起得来就一定盖得上，
//    成功 / 失败 / 中止三种结局都能据此判归属（失败时没有 result 可查）。
//    `progress` 在跑完后**不清空**（见 `startTask` 的说明），所以判据一直有效。
//    ⚠️ 若 `run` 里要中途上报进度，**必须把 `ch` 带上**（`job.progress({ ch, ... })`），
//       否则会把章节戳冲掉 —— 这一刻起该任务就不再被认作本章的了。
// ─────────────────────────────────────────────────────────────────────────────

/** 带章节归属的任务结果：`ch` = 发起时的章节 id，`v` = 真正的载荷 */
export interface ChOwned<T> { ch: string; v: T }
/** 带章节戳的任务进度（发起时第一时间写入） */
export interface ChProgress { ch: string }

/** 读一条任务的「发起章节」。没有章节戳（旧记录 / 非章节级任务）返回空串 */
export function taskChapter(task: { progress?: unknown } | null | undefined): string {
  return (task?.progress as ChProgress | null | undefined)?.ch ?? ''
}

/**
 * 把「章节级 runner」收成**本章视图** —— 直接喂给面板的 `{ loading, data?, error? }`。
 * 非本章的结果 / 进度一律当没跑过；单章场景（`ch` 恒定）零变化。
 */
export function chapterOwned<T>(
  tk: TaskRunner<ChOwned<T>, ChProgress>,
  ch: string,
): { loading: boolean; data?: T; error?: string } {
  const task = tk.task
  const owned = taskChapter(task) === ch
  const r = tk.result
  return {
    loading: tk.running && owned,
    data: task?.status === 'done' && r?.ch === ch ? r.v : undefined,
    error: task?.status === 'failed' && owned ? (tk.error || undefined) : undefined,
  }
}
