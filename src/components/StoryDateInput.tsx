import { CalendarDays } from 'lucide-react'
import type { CalendarRule } from '@/lib/types'
import {
  DEFAULT_CALENDAR_RULE,
  dayOptions, monthOptions, parseStoryDateParts,
} from '@/lib/storyDate'

// 🔴 NumberField 豁免声明（U-11 · 2.6.0 巡检留痕）：本组件的年/月/日三段 <input type="number">
//    **刻意不走 NumberField** —— 它是三段联动分段输入（年→月→日逐级补全、闰年联动、缺年整体清空），
//    NumberField 的单值 + 提交时钳制模型不适配；各段的 min/max 由历法规则动态决定且本就逐段即时约束。
//    没有此注释的话，每轮「type=number 违例」审计都会重复提案本文件。

interface Props {
  value: string
  onChange: (v: string) => void
  /**
   * 历法规则（一年几个月 / 每月几天）。**不传则按默认 12 月 × 30 天** ——
   * 这样「设定检索」这类拿不到项目配置的地方也能正常渲染，不会白屏。
   */
  rule?: CalendarRule
}

/**
 * 结构化故事内日期输入（年 / 月 / 日 三个联动控件）。
 *
 * 历史坑位（🔴 别退回去）：
 *  · #001（2026-09-21）：原实现「每敲一位就调 compose，而 compose 在三缺一时直接清空」⇒
 *    三个框互相锁死、完全录不进去。改成**层级化写回**（年是根基，无年即空）后修好；
 *  · 2.4.4：年份**允许负数与 0**（架空世界要写「公元前 N 年」），
 *    且月 / 日的候选值由 `CalendarRule` 生成（不再写死 12 个月 / 大小月 / 闰年）。
 *
 * ⚠️ 仍然不允许自由文本 —— 那会让排序键退化、时间轴排序失真，这是本组件存在的初衷。
 */
export default function StoryDateInput({ value, onChange, rule = DEFAULT_CALENDAR_RULE }: Props) {
  const parsed = parseStoryDateParts(value)
  const y = parsed?.y
  const m = parsed?.m
  const d = parsed?.d
  // 旧格式的自由文本（如"灵历3024年三月初九"），提示用户重新选择
  const legacy = value && !parsed ? value.trim() : ''

  /**
   * 层级化写回：年 → 月 → 日 逐级补全。
   * 改「年」时保留已选的月/日（超出新规则范围时夹到范围内）；
   * 缺「年」则整体清空（年是根基，没有年的月日无意义）。
   * 🔴 判空必须用 `Number.isFinite`，不能写 `if (!ny)` —— 那样会把**合法的 0 年**当成空值清掉。
   */
  const write = (ny: number | undefined, nm: number | undefined, nd: number | undefined) => {
    if (ny === undefined || !Number.isFinite(ny)) {
      onChange('')
      return
    }
    let out = `${ny}年`
    if (nm) {
      const mm = Math.min(Math.max(nm, 1), rule.monthsPerYear)
      out += `${mm}月`
      if (nd) out += `${Math.min(Math.max(nd, 1), rule.daysPerMonth)}日`
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
          placeholder="年"
          value={y ?? ''}
          onChange={e => {
            const raw = e.target.value.trim()
            if (raw === '') {
              write(undefined, undefined, undefined)
              return
            }
            // 🔴 刻意不设 min：负数（公元前）与 0 都是合法年份
            const v = Math.floor(Number(raw))
            if (Number.isFinite(v)) write(v, m, d)
          }}
          className="w-[4.5rem] px-1.5 py-1 text-12 bg-ink-800/60 border border-ink-700 rounded text-ink-100 focus:border-amber/50 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          title="年份数字，可填负数与 0（例：-300 表示「公元前 300 年」）。先填年份，再选月、日"
        />
        <span className="text-ink-400 text-11 shrink-0">年</span>
        <select
          value={m ?? ''}
          onChange={e => {
            const v = e.target.value
            write(y, v ? Number(v) : undefined, d)
          }}
          disabled={y === undefined}
          className={selectCls}
          title={y !== undefined ? `月份（1~${rule.monthsPerYear}）` : '请先填写年份'}
        >
          <option value="">月</option>
          {monthOptions(rule).map(n => (
            <option key={n} value={n}>{n}月</option>
          ))}
        </select>
        <select
          value={d ?? ''}
          onChange={e => {
            const v = e.target.value
            write(y, m, v ? Number(v) : undefined)
          }}
          disabled={m === undefined}
          className={selectCls}
          title={m !== undefined ? `日期（1~${rule.daysPerMonth}）` : '请先填写年份与月份'}
        >
          <option value="">日</option>
          {dayOptions(rule).map(n => (
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
