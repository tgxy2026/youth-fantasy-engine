/**
 * 创作复盘（2.4.1 · B1）—— 从「每日字数」里提炼**回顾视角**的指标
 *
 * 【为什么要有这个模块，而不是再加几个 Dashboard 图表】
 * 写作面板已经有热力图、连续打卡、近 7 日柱状图 —— 那些回答的是「**现在**怎么样」。
 * 复盘回答的是另一个问题：「**跟之前比**，我这段时间写得如何」。
 * 故这里全是**对比与记录类**指标：本周 vs 上周、历史最长连续、最高产的一天、本月占比。
 * 重复已有图表只会让面板更挤，不会让人更清楚。
 *
 * 【数据来源】只有 `dailyStats`（`{ date: 'YYYY-MM-DD', words }`）—— 纯本地、纯函数、可单测。
 *
 * ⚠️ 口径：`words` 是**净增量**（增删都记，可能为负）。故所有"产量"都按**原值累加**，
 *    不做 `Math.max(0, …)` 的裁剪 —— 裁剪会让"今天删了 500 字"看起来像"今天写了 0 字"，
 *    反而失真。展示端若需要非负，自行处理。
 */
import { todayKey } from '@/lib/date'

export interface DailyLike { date: string; words: number }

/** 取某天的 key（本地时区），i 天前 */
function dayKeyAgo(i: number, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() - i)
  return todayKey(d)
}

/** 累加 [fromAgo, toAgo] 天区间（含端点）的字数 */
function sumRange(byDate: Map<string, number>, fromAgo: number, toAgo: number, now?: Date): number {
  let sum = 0
  for (let i = fromAgo; i >= toAgo; i--) sum += byDate.get(dayKeyAgo(i, now)) ?? 0
  return sum
}

export type WeekTrend = 'up' | 'down' | 'flat' | 'new' | 'none'

export interface WritingReview {
  /** 近 7 天（含今天）总字数 */
  thisWeek: number
  /** 前 7 天（第 8~14 天前）总字数 */
  lastWeek: number
  /** 环比变化百分比；上周为 0 而有本周有产出时为 null（不编造"增长 ∞%"） */
  weekDeltaPct: number | null
  weekTrend: WeekTrend
  /** 历史最长连续写作天数 */
  longestStreak: number
  /** 当前连续写作天数（含今天；今天没写则为 0） */
  currentStreak: number
  /** 历史最长连续区间的起止（便于展示"X月X日 ~ X月X日"） */
  longestStreakRange: { from: string; to: string } | null
  /** 产量最高的一天 */
  bestDay: { date: string; words: number } | null
  /** 本月（自然月）产量 */
  thisMonth: number
  /** 有产出的总天数 */
  activeDays: number
  /** 首次动笔日 */
  firstDay: string | null
  /** 最近一次动笔日 */
  lastDay: string | null
  /** 给作者看的一句话洞察（可为空） */
  insights: string[]
}

export function buildWritingReview(stats: DailyLike[], now: Date = new Date()): WritingReview {
  const byDate = new Map<string, number>()
  for (const s of stats ?? []) {
    if (!s?.date) continue
    byDate.set(s.date, (byDate.get(s.date) ?? 0) + (Number(s.words) || 0))
  }

  const thisWeek = sumRange(byDate, 6, 0, now)
  const lastWeek = sumRange(byDate, 13, 7, now)

  let weekTrend: WeekTrend = 'none'
  let weekDeltaPct: number | null = null
  if (thisWeek !== 0 || lastWeek !== 0) {
    if (lastWeek === 0) weekTrend = thisWeek > 0 ? 'new' : 'none'
    else {
      weekDeltaPct = Math.round(((thisWeek - lastWeek) / Math.abs(lastWeek)) * 1000) / 10
      weekTrend = thisWeek > lastWeek ? 'up' : thisWeek < lastWeek ? 'down' : 'flat'
    }
  }

  // 最长 / 当前连续：把有产出的日期排序后扫一遍
  const active = [...byDate.entries()].filter(([, w]) => w !== 0)
    .map(([d]) => d).sort()
  let longestStreak = 0
  let longestStreakRange: { from: string; to: string } | null = null
  {
    let run = 0
    let start = ''
    for (let i = 0; i < active.length; i++) {
      const prev = i > 0 ? active[i - 1] : ''
      const isConsecutive = i > 0 && dayDiff(prev, active[i]) === 1
      if (isConsecutive) run++
      else { run = 1; start = active[i] }
      if (run > longestStreak) { longestStreak = run; longestStreakRange = { from: start, to: active[i] } }
    }
  }

  // 当前连续（从今天往回数）
  let currentStreak = 0
  for (let i = 0; i < 3650; i++) {
    const k = dayKeyAgo(i, now)
    if ((byDate.get(k) ?? 0) !== 0) currentStreak++
    else if (i === 0) continue   // 今天还没写不算断（允许今天还没开始）
    else break
  }

  let bestDay: { date: string; words: number } | null = null
  for (const [date, words] of byDate) {
    if (words <= 0) continue
    if (!bestDay || words > bestDay.words) bestDay = { date, words }
  }

  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  let thisMonth = 0
  for (const [date, words] of byDate) if (date.startsWith(monthPrefix)) thisMonth += words

  const insights: string[] = []
  if (weekTrend === 'new') insights.push('这一段开始有产出了 —— 前一周还是零。')
  else if (weekTrend === 'up' && weekDeltaPct !== null) insights.push(`比上周多写了 ${weekDeltaPct}%，节奏在往上走。`)
  else if (weekTrend === 'down' && weekDeltaPct !== null) insights.push(`比上周少了 ${Math.abs(weekDeltaPct)}%。写得少不一定是坏事，回看这几章是不是需要重排。`)
  else if (weekTrend === 'flat') insights.push('和上周基本持平，很稳。')
  if (currentStreak >= 3) insights.push(`已经连续写了 ${currentStreak} 天。`)
  else if (longestStreak >= 7) insights.push(`你最长连续写过 ${longestStreak} 天，那次的状态值得回想一下。`)
  if (bestDay && bestDay.words >= 3000) insights.push(`最高产的一天写了 ${bestDay.words.toLocaleString('zh-CN')} 字（${bestDay.date}）。`)

  return {
    thisWeek, lastWeek, weekDeltaPct, weekTrend,
    longestStreak, currentStreak, longestStreakRange,
    bestDay, thisMonth,
    activeDays: active.length,
    firstDay: active[0] ?? null,
    lastDay: active[active.length - 1] ?? null,
    insights,
  }
}

/** 两个 YYYY-MM-DD 相隔几天（用于连续性判定） */
export function dayDiff(a: string, b: string): number {
  const pa = a.split('-').map(Number)
  const pb = b.split('-').map(Number)
  if (pa.length !== 3 || pb.length !== 3) return Number.NaN
  const da = Date.UTC(pa[0], pa[1] - 1, pa[2])
  const db = Date.UTC(pb[0], pb[1] - 1, pb[2])
  return Math.round((db - da) / 86400000)
}
