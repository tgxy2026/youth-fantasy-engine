/**
 * 故事内时间的**规则与算法**（2.4.4 · 社区反馈）。
 *
 * 这里只放「是什么 / 怎么算」；界面（下拉框）在 `components/StoryDateInput.tsx`，
 * 存盘在本文件末尾那两个函数（项目级 settingsKV）。
 *
 * ## 三条改动的由来
 * ① **年份可为负、可为 0** —— 架空世界用「公元前 N 年」是常态（灵历前 300 年 = -300），
 *    原先 `min={1}` 把它们全挡在外面，作者只能乱填一个正数，时间轴排序随即失真。
 * ② **一年几个月 / 一个月几天可配置**（`CalendarRule`）—— 不再硬编码地球公历
 *    （12 月 + 大小月 + 闰年）。默认 12 月 × 30 天（一年 360 天，写小说够用且好算）。
 * ③ **时区是「故事内时间」而不是真实日期**：真实日期走 `CalendarPicker`，两者别混。
 *
 * ## 🔴 排序键的口径（改这里前先读完）
 * `storyDateKey = 年 * 10000 + 月 * 100 + 日`。
 * 月 ≤ 60、日 ≤ 99（见 `clampCalendarRule`）⇒ `月*100+日 ≤ 6099 < 10000`，
 * 于是**跨月跨年都不会进位串位**，比较结果与字典序一致。
 * 负数年份同样成立：-5年12月(-48800) < -4年1月(-39999)，
 * 即「年份越大越晚」在负数区间依然成立（这正是公元前纪年需要的语义）。
 */
import type { CalendarRule } from './types'
import { DEFAULT_CALENDAR_RULE } from './types'
import { getSetting, setSetting } from './db'

/** 默认规则从 types.ts 转出（理由见那里：底层工具也要用，不能挂上 db 这条依赖链） */
export { DEFAULT_CALENDAR_RULE }

/** 取值上下限（同时也是排序键不串位的保证，见文件头） */
export const MONTHS_PER_YEAR_MIN = 1
export const MONTHS_PER_YEAR_MAX = 60
export const DAYS_PER_MONTH_MIN = 1
export const DAYS_PER_MONTH_MAX = 99

const CALENDAR_RULE_KEY = 'calendarRule'

/** 把任意输入夹回合法区间并取整（老数据 / 手改存储 / 模型返回都先过它） */
export function clampCalendarRule(r: Partial<CalendarRule> | null | undefined): CalendarRule {
  const m = Math.floor(Number(r?.monthsPerYear))
  const d = Math.floor(Number(r?.daysPerMonth))
  return {
    monthsPerYear: Number.isFinite(m)
      ? Math.min(MONTHS_PER_YEAR_MAX, Math.max(MONTHS_PER_YEAR_MIN, m))
      : DEFAULT_CALENDAR_RULE.monthsPerYear,
    daysPerMonth: Number.isFinite(d)
      ? Math.min(DAYS_PER_MONTH_MAX, Math.max(DAYS_PER_MONTH_MIN, d))
      : DEFAULT_CALENDAR_RULE.daysPerMonth,
  }
}

export async function loadCalendarRule(): Promise<CalendarRule> {
  try {
    return clampCalendarRule(await getSetting<CalendarRule>(CALENDAR_RULE_KEY, DEFAULT_CALENDAR_RULE))
  } catch {
    return DEFAULT_CALENDAR_RULE
  }
}

export async function saveCalendarRule(rule: CalendarRule): Promise<void> {
  await setSetting(CALENDAR_RULE_KEY, clampCalendarRule(rule))
}

/** 一年总天数（用于"持续时长"换算与提示文案） */
export function daysPerYear(rule: CalendarRule): number {
  return rule.monthsPerYear * rule.daysPerMonth
}

/**
 * 故事内日期格式（渐进式，三种形态都合法）：
 *   X年 / X年X月 / X年X月X日
 * X 为**任意整数**（可负、可为 0） —— 负年即「公元前」语义。
 * 仍然**不允许自由文本**（如「灵历3024年三月初九」），否则排序键退化、时间轴失真。
 */
const DATE_RE = /^(-?\d+)\s*年(?:\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?)?$/

export interface StoryDateParts {
  y: number
  m?: number
  d?: number
}

/** 解析故事内日期；解析失败（含空）返回 null。月 / 日可缺省（渐进填写中） */
export function parseStoryDateParts(s: string | undefined | null): StoryDateParts | null {
  if (!s) return null
  const m = s.trim().match(DATE_RE)
  if (!m) return null
  return { y: Number(m[1]), m: m[2] ? Number(m[2]) : undefined, d: m[3] ? Number(m[3]) : undefined }
}

/** 只取年份（时间轴的"跨度几年"用）；解析不出返回 null */
export function storyDateYear(s: string | undefined | null): number | null {
  return parseStoryDateParts(s)?.y ?? null
}

/**
 * 解析为可比较的排序键（见文件头口径）。
 * 兼容旧格式的自由文本（"800 年前" → 远古负值；"1000-03-15" → 取首个数字），
 * 这类拿不到结构的老数据，宁可给个近似值也别排到最后。
 */
export function storyDateKey(s: string | undefined | null): number {
  const p = parseStoryDateParts(s)
  if (p) return p.y * 10000 + (p.m ?? 0) * 100 + (p.d ?? 0)
  if (!s) return Number.POSITIVE_INFINITY
  const raw = s.trim()
  // "800 年前" / "千年前" → 远古（负值）
  if (/前/.test(raw)) {
    const m = raw.match(/(\d+)/)
    return m ? -Number(m[1]) * 10000 : -99999999
  }
  const m = raw.match(/(-?\d+)/)
  return m ? Number(m[1]) * 10000 : Number.POSITIVE_INFINITY
}

/** 当月天数（自定义历法下就是「每月天数」，不再有大小月与闰年） */
export function daysInMonth(rule: CalendarRule, _m: number): number {
  return rule.daysPerMonth
}

/** 月序号取值范围：1 ~ monthsPerYear */
export function monthOptions(rule: CalendarRule): number[] {
  return Array.from({ length: rule.monthsPerYear }, (_, i) => i + 1)
}

/** 日序号取值范围：1 ~ daysPerMonth */
export function dayOptions(rule: CalendarRule): number[] {
  return Array.from({ length: rule.daysPerMonth }, (_, i) => i + 1)
}

/**
 * 把「某年某月某日」换算成**从 0 年 1 月 1 日 起的绝对天数**（可为负）。
 * 缺月按 1 月、缺日按 1 日（渐进填写中也要能算，只是精度低一些）。
 */
export function absDay(rule: CalendarRule, p: StoryDateParts): number {
  const m = Math.min(Math.max(p.m ?? 1, 1), rule.monthsPerYear)
  const d = Math.min(Math.max(p.d ?? 1, 1), rule.daysPerMonth)
  return p.y * daysPerYear(rule) + (m - 1) * rule.daysPerMonth + (d - 1)
}

/**
 * 两个故事内日期之间的**持续天数**（结束 − 开始）。
 *
 * · 同日起止 ⇒ 0（这就是「开始时间与结束时间允许填同一天」的落点）；
 * · 任一端解析不出（空 / 自由文本）⇒ `null`，调用方按"无时长"处理（画圆点，不画横条）；
 * · 结束早于开始 ⇒ 负数 —— **不在这里取绝对值**：填反了是要让作者看见的（时间轴会给出警示），
 *   静默纠正等于替他掩盖一处设定冲突。
 */
export function storySpanDays(rule: CalendarRule, start?: string, end?: string): number | null {
  const a = parseStoryDateParts(start)
  const b = parseStoryDateParts(end)
  if (!a || !b) return null
  return absDay(rule, b) - absDay(rule, a)
}

/** 把持续天数写成人话（用于卡片角标与提示） */
export function formatSpanDays(n: number): string {
  if (n === 0) return '同一天'
  return `${n} 天`
}

/** 起止时间的展示串：只填了开始就只显示开始；两端都有则显示区间 */
export function formatStoryRange(start?: string, end?: string): string {
  const s = (start ?? '').trim()
  const e = (end ?? '').trim()
  if (!s) return e
  if (!e || e === s) return s
  return `${s} → ${e}`
}

/**
 * 在「等距排布的时间点序列」上，把任意时间键映射为 x 坐标（相邻两点间线性插值）。
 *
 * 为什么用它而不是把整条轴改成时间比例：跨度悬殊的数据（三千年 vs 三天）在纯比例轴上
 * 会把晚近的事件挤成一团；等距轴保住可读性，**相邻两点之间**仍按时间比例插值 ——
 * 「整轴一年、事件在 3~5 月」这类局部区间依然标得准（社区反馈 2.4.4 的括号方案靠它定位）。
 *
 * `dots` 必须按 key 升序；key 相同（同一天多条）时返回靠右那个的 x（除零防御）。
 */
export function interpolateX(dots: { key: number; x: number }[], key: number): number | null {
  if (dots.length === 0) return null
  if (key <= dots[0].key) return dots[0].x
  const last = dots[dots.length - 1]
  if (key >= last.key) return last.x
  for (let i = 1; i < dots.length; i++) {
    if (key <= dots[i].key) {
      const a = dots[i - 1]
      const b = dots[i]
      if (b.key <= a.key) return b.x
      const t = (key - a.key) / (b.key - a.key)
      return a.x + (b.x - a.x) * t
    }
  }
  return last.x
}

/**
 * 时长括号的 SVG 路径：挂在轴线下方、两端尖角**向上兜起**（指向轴上的起点/终点），
 * 底边水平 —— 卡片就挂在这条底边下面（主人哥哥 2026-09-24 定的样式，
 * 替掉第一版"圆点后横着一条"的时长横条）。
 */
export function spanBracketPath(x0: number, x1: number, axisY: number, depth = 18): string {
  const a = Math.min(x0, x1)
  const b = Math.max(x0, x1)
  const y0 = axisY + 3          // 尖角顶：贴着轴（圆点下缘）
  const y1 = axisY + depth      // 底边
  const r = 4                   // 底角小圆弧（纯直角太硬）
  return `M ${a} ${y0}`
    + ` L ${a} ${y1 - r} Q ${a} ${y1} ${a + r} ${y1}`
    + ` L ${b - r} ${y1} Q ${b} ${y1} ${b} ${y1 - r}`
    + ` L ${b} ${y0}`
}

/**
 * 卡片防重叠的**贪心排布**：按期望左边界排序，逐张把重叠的往右推。
 *
 * 为什么是贪心而不是整体最优：时间轴卡片一行可能有几十张，整体最优是区间调度难题；
 * 贪心在这里足够 —— 卡片宽度一致、期望位置只被括号中点轻微偏移。
 * 返回值与入参同序：`lefts[i]` 是第 i 张卡的最终左边界。
 */
export function resolveCardOverlaps(wants: number[], cardWidth: number, gap = 8): number[] {
  const order = wants.map((w, i) => ({ w, i })).sort((a, b) => a.w - b.w)
  const out = new Array<number>(wants.length).fill(0)
  let prevRight = Number.NEGATIVE_INFINITY
  for (const { w, i } of order) {
    const left = Math.max(w, prevRight + gap)
    out[i] = left
    prevRight = left + cardWidth
  }
  return out
}
