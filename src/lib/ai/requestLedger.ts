/**
 * 3.2.0 · WQ6 批次/步骤请求预算（纯函数，零 UI 依赖）
 *
 * 方案 §16.7 第 856 行：
 *   「在逻辑调用预算之外增加**批次/步骤总请求预算**，计入补字、压缩、自检、设定整理、降级与重试，
 *    明确显示预计范围和上限；**上限到达暂停而非嵌套追加**。不同任务仍真并行，不设全局强制排队。」
 *
 * 🔴 为什么必须有：`MAX_REQUESTS_PER_CALL`（`aiCore/chat.ts`）只管**一次逻辑调用**最多打几次。
 *    但真实失控发生在**外层循环**——补字最多 8 轮、每轮一次逻辑调用、每次逻辑调用又能打 3 次实际请求，
 *    一章最坏就是 24+ 次。作者只看得到界面一直转圈，完全不知道额度在往下掉。
 *
 * 🔴 口径（写死，别改）：
 *   · 这里的 `max` 数的是**逻辑调用**（不是 HTTP 请求）。实际请求上限 = `max × 每次调用上限`，
 *     `describe()` 会把这个乘出来的数一并说清 —— 只报一个含糊的"上限 N 次"等于没说。
 *   · 超预算只**暂停**，不回滚、不重试、不嵌套追加（方案明确要求）。
 *   · 消费只增不减（即使超出也如实累计），这样 `describe()` 报出来的才是真实花费。
 */

/** 一章的默认预算（逻辑调用次数）。 */
export const CHAPTER_ATTEMPT_BUDGET = 40

/** 一次逻辑调用最多能打几次实际请求（与 `aiCore/chat.ts` 的 `MAX_REQUESTS_PER_CALL` 同口径） */
export const MAX_REQUESTS_PER_LOGICAL_CALL = 3

export interface AttemptBudgetSnapshot {
  /** 可读标签（如「第 12 章」），出现在暂停提示里 */
  label: string
  /** 已用逻辑调用次数（可能 > max，如实累计） */
  used: number
  /** 上限（逻辑调用次数） */
  max: number
  remaining: number
  exhausted: boolean
  /** 预计范围（逻辑调用次数，[下限, 上限]） */
  estimatedRange: readonly [number, number]
}

export interface AttemptBudget {
  readonly label: string
  readonly max: number
  readonly estimatedRange: readonly [number, number]
  readonly used: number
  readonly remaining: number
  readonly exhausted: boolean
  /**
   * 消费 n 次逻辑调用。
   * @returns `true` ＝ 仍在预算内；`false` ＝ 已耗尽（调用方应**暂停**，不是继续硬打）
   */
  consume(n?: number): boolean
  snapshot(): AttemptBudgetSnapshot
  /** 一句人话（日志/界面提示用）：已用多少、上限多少、超了没有 */
  describe(): string
}

export interface AttemptBudgetOptions {
  label: string
  max: number
  /** 预计范围（逻辑调用次数）；缺省按 max 的 15%~60% 粗估 —— 只是给作者一个量级，不当承诺 */
  estimatedRange?: readonly [number, number]
}

/**
 * 建一个批次/步骤预算。
 *
 * 🔴 为什么不放进模块级单例：并行任务（创意写作 + 编辑器伴写）必须**各记各的**。
 *    单例会让一个任务的花费把另一个任务提前掐停 —— 这正是 WQ7 修掉的串账问题。
 */
export function createAttemptBudget(opts: AttemptBudgetOptions): AttemptBudget {
  const max = Math.max(1, Math.round(opts.max))
  const range: readonly [number, number] = opts.estimatedRange
    ?? [Math.max(1, Math.round(max * 0.15)), Math.round(max * 0.6)]
  let used = 0

  const snapshot = (): AttemptBudgetSnapshot => ({
    label: opts.label,
    used,
    max,
    remaining: Math.max(0, max - used),
    exhausted: used >= max,
    estimatedRange: range,
  })

  return {
    label: opts.label,
    max,
    estimatedRange: range,
    get used() { return used },
    get remaining() { return Math.max(0, max - used) },
    get exhausted() { return used >= max },
    consume(n = 1) {
      const step = Math.max(0, Math.round(n))
      used += step
      return used <= max
    },
    snapshot,
    describe() {
      const s = snapshot()
      const hard = max * MAX_REQUESTS_PER_LOGICAL_CALL
      return s.exhausted
        ? `${s.label}：已用 ${s.used} 次调用，超过上限 ${s.max}（预计 ${range[0]}~${range[1]} 次；`
          + `按每次最多 ${MAX_REQUESTS_PER_LOGICAL_CALL} 次请求计约 ${hard} 次实际请求），已暂停`
        : `${s.label}：已用 ${s.used}/${s.max} 次调用（预计 ${range[0]}~${range[1]} 次；实际请求上限约 ${hard} 次）`
    },
  }
}

/**
 * 预算耗尽（暂停）。
 *
 * 🔴 单独成类型：调用方要能把它和「模型报错」「用户取消」分开处置 ——
 *    预算耗尽是**我方主动停**，重试只会继续烧额度，必须由作者决定。
 */
export class AIRequestBudgetExhaustedError extends Error {
  constructor(readonly snapshot: AttemptBudgetSnapshot) {
    super(
      `${snapshot.label}的模型请求已达上限（${snapshot.used}/${snapshot.max} 次），已暂停。`
      + '继续只会消耗更多额度，请确认后手动再试。',
    )
    this.name = 'AIRequestBudgetExhaustedError'
  }
}

export function isRequestBudgetExhausted(e: unknown): boolean {
  return e instanceof Error && e.name === 'AIRequestBudgetExhaustedError'
}
