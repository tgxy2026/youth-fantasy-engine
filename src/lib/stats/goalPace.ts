/**
 * 3.3.3 · B4：写作目标的「近 7 日日均」与完稿预估（纯函数，界面与测试共用一份）。
 *
 * 原先这两段算在 `WritingGoals` 组件里，测试只能靠读代码 —— 而这里最容易错的正是口径：
 *   · 「近 7 日」是**7 个自然日**，不是"最近 7 条有记录的天"（断更时后者会系统性高估）；
 *   · 缺字数的日子按 0 计入分母（否则日均被抬高）；
 *   · 没有产量记录 / 日均为零 / 没设全书目标 ⇒ **不编预计日期**（返回 null，界面说"暂无法预估"）；
 *   · 已达标 ⇒ 剩余为 0，不再给"还需 0 天"这种废话日期。
 * 🔴 只吃**自动码字记录**（`dailyStats`）。「写作进度」表的手工登记不进这里 ——
 *    两套数字相加会重复计算，同一面板出现两个互相矛盾的「近 7 日」也是这么来的。
 */
import type { DailyStat } from '@/lib/db'
import { todayKey } from '@/lib/app/date'

export const GOAL_PACE_DAYS = 7

export interface GoalProjection {
  /** 近 7 个自然日日均（四舍五入，含零值日） */
  pace: number
  /** 距全书目标还差多少字（已达标为 0） */
  remaining: number
  /** 按当前节奏还需几天；无法预估时为 0 */
  daysNeeded: number
  /** 预计完稿日（本地时间）；无法预估时为 null */
  estDate: Date | null
  /** 为什么估不出来（界面可直接展示；能估时为 ''） */
  reason: '' | 'no-daily-record' | 'no-goal' | 'reached'
}

/** 近 N 个自然日的日均：按日期键回填，缺日按 0 计（分母恒为 days） */
export function recentDailyAverage(
  stats: readonly Pick<DailyStat, 'date' | 'words'>[],
  now: Date = new Date(),
  days: number = GOAL_PACE_DAYS,
): number {
  const n = Math.max(1, Math.floor(days))
  const byDate = new Map(stats.map(s => [s.date, s.words]))
  let sum = 0
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    sum += byDate.get(todayKey(dt)) ?? 0
  }
  return Math.round(sum / n)
}

/**
 * 预估完稿：`now` 显式传入（测试可钉日期）。
 * 🔴 预估按"今天起算"的整天数，返回的是**日期**而非毫秒 —— 界面直接展示，测试也稳定。
 */
export function projectGoal(input: {
  totalWords: number
  /** 全书目标字数；0 / 负数 = 没设 */
  goalTotal: number
  stats: readonly Pick<DailyStat, 'date' | 'words'>[]
  now?: Date
}): GoalProjection {
  const now = input.now ?? new Date()
  const total = Number(input.goalTotal) || 0
  const written = Math.max(0, Number(input.totalWords) || 0)
  const pace = recentDailyAverage(input.stats, now)
  const remaining = total > 0 ? Math.max(0, total - written) : 0
  if (total <= 0) return { pace, remaining: 0, daysNeeded: 0, estDate: null, reason: 'no-goal' }
  if (remaining === 0) return { pace, remaining: 0, daysNeeded: 0, estDate: null, reason: 'reached' }
  if (pace <= 0) return { pace, remaining, daysNeeded: 0, estDate: null, reason: 'no-daily-record' }
  const daysNeeded = Math.ceil(remaining / pace)
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysNeeded)
  return { pace, remaining, daysNeeded, estDate: d, reason: '' }
}