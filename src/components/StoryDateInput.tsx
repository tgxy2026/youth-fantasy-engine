import { CalendarDays } from 'lucide-react'

interface Props {
  value: string
  onChange: (v: string) => void
}

/** 严格故事内日期格式：X年X月X日 */
const STRICT_RE = /^(\d+)年(\d{1,2})月(\d{1,2})日$/

/** 解析严格格式的故事内日期；解析失败返回 null */
function parseStoryDateParts(s: string | undefined | null): { y: number; m: number; d: number } | null {
  if (!s) return null
  const m = s.trim().match(STRICT_RE)
  if (!m) return null
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

/** 解析为可比较的排序键：年*10000 + 月*100 + 日（兼容旧自由文本格式） */
export function storyDateKey(s: string | undefined | null): number {
  const p = parseStoryDateParts(s)
  if (p) return p.y * 10000 + p.m * 100 + p.d
  if (!s) return Number.POSITIVE_INFINITY
  const raw = s.trim()
  // "800 年前" / "千年前" → 远古（负值）
  if (/前/.test(raw)) {
    const m = raw.match(/(\d+)/)
    return m ? -Number(m[1]) * 10000 : -99999999
  }
  // 兼容旧格式："1000 年" / "1000-03-15" 等取首个数字
  const m = raw.match(/(-?\d+)/)
  return m ? Number(m[1]) * 10000 : Number.POSITIVE_INFINITY
}

function isLeap(y: number) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

function daysInMonth(y: number, m: number): number {
  const base = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (m === 2 && isLeap(y)) return 29
  return base[m - 1] ?? 31
}

/**
 * 严格"某年某月某日"结构化日期输入：
 * - 年：数字输入框
 * - 月：1~12 下拉
 * - 日：按年月联动天数的下拉（自动处理大小月与闰年）
 * 三者齐全时才写入值，杜绝"三月末""灵历3024年春"这类导致时间轴排序错误的自由文本。
 */
export default function StoryDateInput({ value, onChange }: Props) {
  const parsed = parseStoryDateParts(value)
  const y = parsed?.y
  const m = parsed?.m
  const d = parsed?.d
  // 旧格式的自由文本（如"灵历3024年三月初九"），提示用户重新选择
  const legacy = value && !parsed ? value.trim() : ''

  const compose = (ny?: number, nm?: number, nd?: number) => {
    const yy = ny ?? y
    const mm = nm ?? m
    let dd = nd ?? d
    if (!yy || !mm || !dd) {
      onChange('')
      return
    }
    const maxD = daysInMonth(yy, mm)
    if (dd > maxD) dd = maxD
    onChange(`${yy}年${mm}月${dd}日`)
  }

  const selectCls = 'px-1.5 py-1 text-12 bg-ink-800/60 border border-ink-700 rounded text-ink-100 focus:border-amber/50 outline-none cursor-pointer'

  return (
    <div className="flex flex-col gap-0.5 min-w-[200px]">
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={1}
          placeholder="年"
          value={y ?? ''}
          onChange={e => {
            const raw = e.target.value.trim()
            if (raw === '') { compose(undefined) ; return }
            const v = Math.max(1, Math.floor(Number(raw)))
            if (!Number.isNaN(v)) compose(v)
          }}
          className="w-[4.5rem] px-1.5 py-1 text-12 bg-ink-800/60 border border-ink-700 rounded text-ink-100 focus:border-amber/50 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          title="年份数字，如 3024"
        />
        <span className="text-ink-400 text-11 shrink-0">年</span>
        <select
          value={m ?? ''}
          onChange={e => { const v = e.target.value; compose(undefined, v ? Number(v) : undefined) }}
          className={selectCls}
          title="月份（1~12）"
        >
          <option value="">月</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map(n => (
            <option key={n} value={n}>{n}月</option>
          ))}
        </select>
        <select
          value={d ?? ''}
          onChange={e => { const v = e.target.value; compose(undefined, undefined, v ? Number(v) : undefined) }}
          className={selectCls}
          disabled={!m}
          title="日期（按年月自动联动天数）"
        >
          <option value="">日</option>
          {(m ? Array.from({ length: daysInMonth(y ?? new Date().getFullYear(), m) }, (_, i) => i + 1) : []).map(n => (
            <option key={n} value={n}>{n}日</option>
          ))}
        </select>
      </div>
      {legacy ? (
        <span className="text-10 text-amber/70 flex items-center gap-0.5" title="此条记录仍是旧格式自由文本，重新选择年月日后将自动转为标准格式">
          <CalendarDays size={9} /> 旧格式：{legacy}
        </span>
      ) : null}
    </div>
  )
}
