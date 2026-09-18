/**
 * 通用流程状态机（域中立，零业务依赖）。
 *
 * 为什么单独抽一层：「一键拆书」与「创意写作」共用同一种「多阶段长任务」形状 ——
 * 都要 ① 顺序推进若干阶段 ② 每阶段汇报进度 ③ 随时可中止 ④ 中断后能续跑。
 * 既有的 `autoContinue` 是「逐章 for 循环 + 回调」，形状不同、复不了，故另起一层。
 *
 * 设计取舍（照做，别随手改）：
 * - **只管调度，不碰业务**：阶段做什么、进度怎么算，由调用方在 executor 里 `report()`。
 * - **中止走 AbortSignal**（与项目其它 AI 调用同一套）；中止后已完成的阶段产物**保留在 bag 里**，
 *   由调用方决定「续跑」还是「丢弃」—— 状态机不替它做这个决定。
 * - **不做自动重试**：长任务里重试语义因阶段而异（抽取可重试、写库绝不能重试），留给 executor 自己。
 * - **不做暂停**：人机闸门（等用户确认）在 executor 内用 `await` 表达即可，状态机无需感知。
 */
import type { FlowProgress, FlowStage, FlowStageId, FlowStatus, StageState } from './types'

/** 阶段执行体。返回值作为该阶段的产物存进 bag。 */
export type StageExecutor = (ctx: StageCtx) => Promise<unknown>

export interface StageCtx {
  readonly signal: AbortSignal
  /** 上报本阶段进度（0..1）与一行说明。detail 省略时保留上一次的说明。 */
  report(ratio: number, detail?: string): void
  /**
   * 提前结束**剩余阶段**：本阶段照常算完成（产物照常进 bag），其后所有阶段记为 skipped。
   *
   * 存在的理由＝**条件分支**：创意写作里用户在闸门②选「只生成大纲」，连写阶段就根本不该跑。
   * 为什么不干脆不登记那个阶段：决策发生在闸门②**运行到一半**的时候，那时 stages 早已定好；
   * 而把它标成 done 也不行 —— 界面会显示"逐章连写 ●"，作者以为正文写了，实际一个字没有。
   * skipped + 一行原因，才是这件事的诚实表达。
   */
  skipRest(reason?: string): void
  /**
   * 各阶段产物，按阶段 id 取。
   * 「续跑」场景：把上次跑出的产物预先放进来（见 createFlow 的 bag 选项），
   * 再从中间某阶段 `run(from)` 即可，前序阶段不必重跑。
   */
  readonly bag: Record<string, unknown>
}

export interface FlowResult {
  status: FlowStatus
  progress: FlowProgress
  /** 各阶段产物。**即使中止或失败，已完成阶段的产物仍在这里**（这是能续跑的前提）。 */
  bag: Record<string, unknown>
  error?: string
}

export interface FlowRunner {
  /** 登记阶段执行体（可链式调用）。未登记的阶段运行时记 skipped。 */
  on(id: FlowStageId, exec: StageExecutor): FlowRunner
  /** 顺序执行全部阶段。`from` 指定时跳过它之前的阶段（视为已跳过）。 */
  run(from?: FlowStageId): Promise<FlowResult>
  /** 请求中止。已挂起的 AI 调用会抛 AbortError，被本层捕获并归为 cancelled。 */
  abort(): void
  /** 当前进度快照 */
  snapshot(): FlowProgress
  /** 是否已请求中止 */
  readonly aborted: boolean
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** 中止类错误的判定：DOMException('AbortError') 或本项目自造的取消错误 */
function isAbortLike(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const name = (e as { name?: unknown }).name
  return name === 'AbortError' || name === 'CanceledError' || name === 'FlowAbortError'
}

function msgOf(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  return String(e)
}

function idleMessage(status: FlowStatus): string {
  switch (status) {
    case 'idle': return '尚未开始'
    case 'running': return '进行中'
    case 'done': return '已完成'
    case 'cancelled': return '已中止'
    case 'error': return '出错'
  }
}

/**
 * 新建一个流程运行器。
 * @param stages 阶段声明，数组顺序即执行顺序
 * @param opts.onProgress 进度回调（每次状态变化都会调用一次快照）
 * @param opts.bag 预置产物（续跑时把上次的产物放进来）
 * @param opts.signal 外部中止信号（界面上的「中止」按钮接它）—— 与内部 controller 联动
 */
export function createFlow(
  stages: FlowStage[],
  opts: { onProgress?: (p: FlowProgress) => void; bag?: Record<string, unknown>; signal?: AbortSignal } = {},
): FlowRunner {
  const declared = stages.map(s => ({ ...s, weight: s.weight && s.weight > 0 ? s.weight : 1 }))
  const execs = new Map<FlowStageId, StageExecutor>()
  const states = new Map<FlowStageId, StageState>()
  const bag: Record<string, unknown> = { ...(opts.bag ?? {}) }
  const ctl = new AbortController()
  const totalWeight = declared.reduce((n, s) => n + (s.weight ?? 1), 0)
  let status: FlowStatus = 'idle'
  let aborted = false
  /** skipRest 请求：从 fromIdx 起（含）的阶段一律记为 skipped */
  let skipReq: { fromIdx: number; reason: string } | null = null

  // 外部 signal → 内部 controller（executor 拿到的一律是内部 signal，调用方只需管自己那一个）
  const markAbort = () => { aborted = true; ctl.abort() }
  if (opts.signal) {
    if (opts.signal.aborted) markAbort()
    else opts.signal.addEventListener('abort', markAbort, { once: true })
  }

  for (const s of declared) {
    states.set(s.id, { id: s.id, label: s.label, status: 'pending', ratio: 0, detail: '' })
  }

  const stateOf = (id: FlowStageId): StageState => states.get(id) as StageState

  function snapshot(): FlowProgress {
    let acc = 0
    for (const s of declared) {
      const st = stateOf(s.id)
      const w = s.weight ?? 1
      // 🔴 skipped 也要计入分子（＝"这一阶段已经不需要跑了"）。
      //    否则跳过一旦发生，进度条会永远停在跳过之前的比例上：创意写作选「只保存大纲」时
      //    连写阶段占 12/17 权重，界面会显示「已完成 26%」，看着像跑到一半断了。
      //    续跑场景同理 —— 起点之前的阶段标 skipped，本就意味着"这部分已完成"。
      if (st.status === 'done' || st.status === 'skipped') acc += w
      else if (st.status === 'running') acc += w * clamp01(st.ratio)
    }
    const running = declared.find(s => stateOf(s.id).status === 'running')
    const cur = running ? stateOf(running.id) : null
    return {
      status,
      ratio: totalWeight > 0 ? clamp01(acc / totalWeight) : 0,
      stages: declared.map(s => ({ ...stateOf(s.id) })),
      current: running?.id ?? null,
      message: cur ? (cur.detail || cur.label) : idleMessage(status),
    }
  }

  const emit = () => { opts.onProgress?.(snapshot()) }

  async function run(from?: FlowStageId): Promise<FlowResult> {
    const startIdx = from ? Math.max(0, declared.findIndex(s => s.id === from)) : 0
    status = 'running'
    // 续跑：起点之前的阶段标为 skipped，但**它们的产物已在 bag 里**，不重跑
    for (let i = 0; i < startIdx; i++) {
      const st = stateOf(declared[i].id)
      if (st.status === 'pending') { st.status = 'skipped'; st.detail = '（续跑跳过）' }
    }
    emit()

    for (let i = startIdx; i < declared.length; i++) {
      const stage = declared[i]
      const st = stateOf(stage.id)

      // 上一阶段喊了 skipRest → 从这里开始全部跳过（含尚未轮到的、也含续跑时本会重跑的阶段）
      if (skipReq && i >= skipReq.fromIdx) {
        if (st.status === 'pending') { st.status = 'skipped'; st.detail = skipReq.reason }
        emit()
        continue
      }

      if (aborted) {
        if (st.status === 'pending' || st.status === 'running') { st.status = 'cancelled' }
        continue
      }

      const exec = execs.get(stage.id)
      if (!exec) { st.status = 'skipped'; emit(); continue }

      st.status = 'running'; st.startedAt = Date.now(); st.ratio = 0; st.detail = ''
      emit()

      try {
        const out = await exec({
          signal: ctl.signal,
          bag,
          report: (ratio, detail) => {
            st.ratio = clamp01(ratio)
            if (detail !== undefined) st.detail = detail
            emit()
          },
          skipRest: reason => {
            // 只管"当前阶段之后"的：已经跑完的、以及正在跑的这个，都不该被这条请求改写状态
            skipReq = { fromIdx: i + 1, reason: (reason ?? '').trim() || '（已跳过）' }
          },
        })
        bag[stage.id] = out
        st.status = aborted ? 'cancelled' : 'done'
        st.ratio = 1
        st.endedAt = Date.now()
        emit()
      } catch (e) {
        st.endedAt = Date.now()
        if (aborted || isAbortLike(e)) {
          st.status = 'cancelled'
          status = 'cancelled'
          emit()
          return { status, progress: snapshot(), bag }
        }
        st.status = 'failed'
        st.error = msgOf(e)
        status = 'error'
        emit()
        return { status, progress: snapshot(), bag, error: st.error }
      }
    }

    status = aborted ? 'cancelled' : 'done'
    // 中止时把还挂着的阶段一并标掉，免得界面停在「待执行」造成误解
    if (aborted) for (const s of declared) if (stateOf(s.id).status === 'pending') stateOf(s.id).status = 'cancelled'
    emit()
    return { status, progress: snapshot(), bag }
  }

  return {
    on(id, exec) { execs.set(id, exec); return this },
    run,
    abort() { aborted = true; ctl.abort() },
    snapshot,
    get aborted() { return aborted },
  }
}
