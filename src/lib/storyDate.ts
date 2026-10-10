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
import type { CalendarRule } from '@/lib/types'
import { DEFAULT_CALENDAR_RULE } from '@/lib/types'
import { getSetting, setSetting } from '@/lib/db'

/** 默认规则从 types.ts 转出（理由见那里：底层工具也要用，不能挂上 db 这条依赖链） */
export { DEFAULT_CALENDAR_RULE }

/** 取值上下限（同时也是排序键不串位的保证，见文件头） */
const MONTHS_PER_YEAR_MIN = 1
export const MONTHS_PER_YEAR_MAX = 60
const DAYS_PER_MONTH_MIN = 1
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
function absDay(rule: CalendarRule, p: StoryDateParts): number {
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

/**
 * 重叠区间的**贪心着色**：相互重叠的线段拿到不同的颜色索引。
 *
 * 为什么不是"每条线按全局序轮流取色"：不重叠的两条线用同色完全无碍（视觉上分离），
 * 轮流取色反而把颜色稀释掉；真正要区分的是**重叠**的那几条 —— 这正是区间图着色，
 * 区间图是完美图，按左端点排序贪心即可得到最优解。
 *
 * 算法：按左端点扫；新线出现时，右端点 ≤ 新线左端点的活跃线全部释放（共端点不算重叠），
 * 新线取「未被当前活跃线占用」的最小颜色索引。
 * 返回与入参同序的 colorIdx 数组（调用方取 `COLORS[idx % 色板长]`）。
 */
export function assignOverlapColors(spans: { x0: number; right: number }[]): number[] {
  const order = spans
    .map((s, i) => ({ x0: s.x0, right: s.right, i }))
    .sort((a, b) => a.x0 - b.x0 || a.right - b.right)
  const out = new Array<number>(spans.length).fill(0)
  const active: { right: number; color: number }[] = []
  for (const s of order) {
    for (let k = active.length - 1; k >= 0; k--) {
      if (active[k].right <= s.x0) active.splice(k, 1)
    }
    const used = new Set(active.map(a => a.color))
    let c = 0
    while (used.has(c)) c++
    out[s.i] = c
    active.push({ right: s.right, color: c })
  }
  return out
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
 * 持续时长**线段**的 SVG 路径（2.4.4 三次定版：主人哥哥「不要尖角了」）：
 * 一条水平线画在轴的一侧，两端各带一小段**界线刻度**标出起止位置；
 * 多条重叠时由调用方按 j 递增 depth 分层（向各自方向越伸越远）并换色。
 *
 * · `dir: 'down'`（默认）＝线画在轴**下方**；
 * · `dir: 'up'` ＝线画在轴**上方**（当前定版：持续线条放轴上边，卡片留在轴下，靠同色对应）。
 */
export function spanLinePath(
  x0: number, x1: number, axisY: number, depth = 18,
  dir: 'up' | 'down' = 'down',
): string {
  const a = Math.min(x0, x1)
  const b = Math.max(x0, x1)
  const s = dir === 'up' ? -1 : 1
  const yEdge = axisY + depth * s      // 水平线
  const t = 5                           // 端点刻度长（朝轴方向）
  return `M ${a} ${yEdge} L ${b} ${yEdge}`
    + ` M ${a} ${yEdge} L ${a} ${yEdge - t * s}`
    + ` M ${b} ${yEdge} L ${b} ${yEdge - t * s}`
}

/**
 * 把一段时长写成人话（比 `formatSpanDays` 更粗粒度）：≥ 一年说「约 N 年」，≥ 一月说「约 N 个月」。
 * 用于「等比时间轴」上被压缩的超长空档标注（三千年的空档写「1095000 天」没人看得下去）。
 */
export function formatDurationHuman(days: number, rule: CalendarRule): string {
  const d = Math.abs(days)
  const perYear = daysPerYear(rule)
  const perMonth = Math.max(1, rule.daysPerMonth)
  if (d >= perYear) return `约 ${Math.round(d / perYear)} 年`
  if (d >= perMonth) return `约 ${Math.round(d / perMonth)} 个月`
  return `约 ${d} 天`
}

export interface CappedScaleOpts {
  /** 基准格宽：中位间隔占多少 px —— 与等距轴的 `SLOT_W` 对齐，切换模式时密度手感一致 */
  slot?: number
  /** 空档封顶：单个间隔的渲染宽度 ≤ 中位间隔 × capFactor（其余被压缩） */
  capFactor?: number
  /** 间隔宽度下限：中位间隔 × minFactor（防止紧密簇挤成一点、卡片叠死） */
  minFactor?: number
}

export interface CappedScaleResult {
  /** 与入参等长的 x 坐标（组中心） */
  x: number[]
  /** 被压缩的空档：`[i]` 表示第 i 组与第 i+1 组之间的间隔超长、已封顶（用于画断裂符） */
  breaks: number[]
}

/**
 * 「等比（按真实时间差）+ 空档封顶」的横轴定位 —— **纯函数，可单测**。
 *
 * 背景（2.7.2）：纯等比轴一旦遇到超长空档（主线密集在 1 年、中间夹一段「三千年前」的传说），
 * 整条轴被这**一个**空档撑到几十倍长，密集段挤成一坨 —— 正是 `interpolateX` 注释里担心的
 * 「三千年 vs 三天」。统计制图的标准解是 **axis break**：密集段保持等比，超长空档**压缩**并在
 * 轴上画断裂符、标注真实跨度（诚实，不撒谎）。
 *
 * 算法：
 *  ① 取相邻键的间隔，算**中位数**（对极端值稳健）；
 *  ② `unit = slot / median`（每「键单位」多少 px）⇒ 中位间隔恰好占 `slot` px；
 *  ③ 每个间隔的渲染宽度 = `clamp(gap, median×minFactor, median×capFactor) × unit`；
 *  ④ 超过封顶的间隔记进 `breaks`（真实跨度由调用方按事件日期换算并标注）。
 *
 * @param keys 已按**升序**排好的时间键（调用方负责过滤掉无法解析的键）
 */
export function cappedPositions(keys: number[], opts: CappedScaleOpts = {}): CappedScaleResult {
  const slot = opts.slot ?? 240
  const capFactor = opts.capFactor ?? 6
  const minFactor = opts.minFactor ?? 0.18
  const n = keys.length
  if (n === 0) return { x: [], breaks: [] }
  if (n === 1) return { x: [slot / 2], breaks: [] }

  const gaps: number[] = []
  for (let i = 0; i < n - 1; i++) gaps.push(Math.max(0, keys[i + 1] - keys[i]))
  const positive = gaps.filter(g => g > 0).sort((a, b) => a - b)
  const median = positive.length ? positive[Math.floor(positive.length / 2)] : 1
  const unit = median > 0 ? slot / median : slot
  const capUnits = median * capFactor
  const minUnits = median * minFactor

  const x: number[] = [slot / 2]
  const breaks: number[] = []
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i]
    if (g === 0) { x.push(x[i] + minUnits * unit); continue }
    const clamped = Math.min(Math.max(g, minUnits), capUnits)
    if (g > capUnits) breaks.push(i)
    x.push(x[i] + clamped * unit)
  }
  return { x, breaks }
}
