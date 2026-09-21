import { CalendarDays } from 'lucide-react'

interface Props {
  value: string
  onChange: (v: string) => void
}

/**
 * 故事内日期格式，**渐进式**（#001 修复后支持三种形态）：
 *   X年  /  X年X月  /  X年X月X日
 * 注意：仍然**不允许自由文本**（如「灵历3024年三月初九」「三月末」）——
 * 那会让 `storyDateKey` 退化，进而导致时间轴排序错误，这是本组件存在的初衷。
 */
const DATE_RE = /^(\d+)\s*年(?:\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?)?$/

/** 解析故事内日期；解析失败返回 null。月/日可缺省（渐进填写中） */
function parseStoryDateParts(s: string | undefined | null): { y: number; m?: number; d?: number } | null {
  if (!s) return null
  const m = s.trim().match(DATE_RE)
  if (!m) return null
  return { y: Number(m[1]), m: m[2] ? Number(m[2]) : undefined, d: m[3] ? Number(m[3]) : undefined }
}

/** 解析为可比较的排序键：年*10000 + 月*100 + 日（月/日缺省按 0 计，兼容旧自由文本格式） */
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
 * - 年：数字输入框（**最优先**，先填年才能选月）
 * - 月：1~12 下拉
 * - 日：按年月联动天数的下拉（自动处理大小月与闰年）
 *
 * 🔴 #001 修复（2026-09-21）：原实现是「每敲一位就调 compose()，而 compose 在三缺一时直接
 * `onChange('')`」—— 于是年份刚输入就被清空、月份选了也不显示、日子因 `disabled={!m}` 恒点不动，
 * 三个框互相锁死，用户完全无法录入（社区反馈）。
 * 新实现改为**层级化写回**：年份是根基，缺年即清空；有年则写「X年」，有月则续写「X月」，
 * 有日才续写「X日」。既让每一步输入都能立即落定，又保住了「不允许自由文本」的格式约束。
 */
export default function StoryDateInput({ value, onChange }: Props) {
  const parsed = parseStoryDateParts(value)
  const y = parsed?.y
  const m = parsed?.m
  const d = parsed?.d
  // 旧格式的自由文本（如"灵历3024年三月初九"），提示用户重新选择
  const legacy = value && !parsed ? value.trim() : ''

  /**
   * 层级化写回：年 → 月 → 日 逐级补全。
   * 改「年」时保留已选的月/日（若新年份下该月天数不够，按 `Math.min` 自动钳到当月最后一天）；
   * 缺「年」则整体清空（年是根基，没有年的月日无意义）。
   */
  const write = (ny: number | undefined, nm: number | undefined, nd: number | undefined) => {
    if (!ny) {
      onChange('')
      return
    }
    let out = `${ny}年`
    if (nm) {
      out += `${nm}月`
      if (nd) out += `${Math.min(nd, daysInMonth(ny, nm))}日`
    }
    onChange(out)
  }

  const selectCls =
    'px-1.5 py-1 text-12 bg-ink-800/60 border border-ink-700 rounded text-ink-100 focus:border-amber/50 outline-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed'

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
            if (raw === '') {
              write(undefined, undefined, undefined)
              return
            }
            const v = Math.floor(Number(raw))
            if (Number.isFinite(v) && v >= 1) write(v, m, d)
          }}
          className="w-[4.5rem] px-1.5 py-1 text-12 bg-ink-800/60 border border-ink-700 rounded text-ink-100 focus:border-amber/50 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          title="年份数字，如 3024（先填年份，再选月、日）"
        />
        <span className="text-ink-400 text-11 shrink-0">年</span>
        <select
          value={m ?? ''}
          onChange={e => {
            const v = e.target.value
            write(y, v ? Number(v) : undefined, d)
          }}
          disabled={!y}
          className={selectCls}
          title={y ? '月份（1~12）' : '请先填写年份'}
        >
          <option value="">月</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map(n => (
            <option key={n} value={n}>{n}月</option>
          ))}
        </select>
        <select
          value={d ?? ''}
          onChange={e => {
            const v = e.target.value
            write(y, m, v ? Number(v) : undefined)
          }}
          disabled={!m}
          className={selectCls}
          title={m ? '日期（按年月自动联动天数）' : '请先填写年份与月份'}
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
