/**
 * 3.0 · W1-4 AI 消耗统计 —— 汇总（**纯函数**，好测）
 *
 * §10.3 #6：每次调用记模型 / token / 耗时，**按日 · 按项目**汇总。
 * 🔴 数据来源 ＝ 运行账本 `AiRun.calls`（与 §14 拒答感知**共用同一份调用结果账本**，一处记录多处消费）。
 * 「按项目」由调用方传入某项目的 runs 实现（`db.listProjectAiRuns`）；本函数只管「按日 / 按模型」聚合。
 */
import type { AiRun } from './aiRunTypes'

export interface UsageModelRow {
  model: string
  calls: number
  ms: number
}

export interface UsageDayRow {
  day: string
  calls: number
  ms: number
}

export interface UsageSummary {
  /** 调用总数 */
  calls: number
  /** 累计耗时（毫秒） */
  totalMs: number
  /** 被内容政策拒绝的调用数（`finishReason === 'content_filter'`） */
  refusalCalls: number
  /** 按模型聚合（调用数降序） */
  byModel: UsageModelRow[]
  /** 按自然日聚合（日期升序） */
  byDay: UsageDayRow[]
  /** 有调用记录的运行条数（用于判断「有没有数据」） */
  runsWithCalls: number
}

/** 本地时区的 `YYYY-MM-DD`（按自然日聚合用） */
export function localDayOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function summarizeUsage(runs: readonly AiRun[]): UsageSummary {
  const modelMap = new Map<string, UsageModelRow>()
  const dayMap = new Map<string, UsageDayRow>()
  let calls = 0
  let totalMs = 0
  let refusalCalls = 0
  let runsWithCalls = 0

  for (const run of runs) {
    // 老数据可能没有 calls 字段（3.0 之前无账本）
    const list = run.calls ?? []
    if (!list.length) continue
    runsWithCalls++
    for (const c of list) {
      const ms = Number.isFinite(c.ms) && c.ms > 0 ? c.ms : 0
      calls++
      totalMs += ms
      if (c.finishReason === 'content_filter') refusalCalls++

      const model = c.model || '（未记录模型）'
      const m = modelMap.get(model) ?? { model, calls: 0, ms: 0 }
      m.calls++
      m.ms += ms
      modelMap.set(model, m)

      const day = localDayOf(c.at)
      const d = dayMap.get(day) ?? { day, calls: 0, ms: 0 }
      d.calls++
      d.ms += ms
      dayMap.set(day, d)
    }
  }

  return {
    calls,
    totalMs,
    refusalCalls,
    runsWithCalls,
    byModel: [...modelMap.values()].sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model)),
    byDay: [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
  }
}
