import { useMemo, useState } from 'react'
import type { TableRow, TabDef, CalendarDef, CalendarRule } from '../lib/types'
import { DEFAULT_CALENDAR_RULE, formatSpanDays, formatStoryRange, assignOverlapColors, interpolateX, spanLinePath, storyDateKey, storySpanDays } from '../lib/storyDate'
import { Calendar, Users, X, AlarmClock } from 'lucide-react'
import { Modal } from './Modal'
import { Button } from './Button'

/**
 * 事件配色（2.4.4 线条方案）：
 * · `dot/ring/text` 供圆点与卡片沿用；`stroke` 给 SVG 线条、`bar` 给卡片左缘色条。
 * 🔴 全部写成**字面量类名** —— Tailwind JIT 只认源码里出现的类，`'bg-' + x` 拼出来的
 *    类不会被生成（规则同 components 里"字号从 props 传"那条红线）。
 * `j` = 同一时间点组内的序号：同起点多条线条按 j 依次换色 + 下移，区分多个时段。
 */
const COLORS = [
  { dot: 'bg-amber', ring: 'ring-amber/40', text: 'text-amber', stroke: 'stroke-amber', bar: 'border-amber' },
  { dot: 'bg-sky-400', ring: 'ring-sky-400/40', text: 'text-sky-300', stroke: 'stroke-sky-400', bar: 'border-sky-400' },
  { dot: 'bg-emerald-400', ring: 'ring-emerald-400/40', text: 'text-emerald-300', stroke: 'stroke-emerald-400', bar: 'border-emerald-400' },
  { dot: 'bg-rose-400', ring: 'ring-rose-400/40', text: 'text-rose-300', stroke: 'stroke-rose-400', bar: 'border-rose-400' },
  { dot: 'bg-violet-400', ring: 'ring-violet-400/40', text: 'text-violet-300', stroke: 'stroke-violet-400', bar: 'border-violet-400' },
  { dot: 'bg-orange-400', ring: 'ring-orange-400/40', text: 'text-orange-300', stroke: 'stroke-orange-400', bar: 'border-orange-400' },
]

interface Evt {
  id: string
  code: string
  title: string
  calName: string
  /** 发生时间（起点） */
  time: string
  /** 结束时间（终点；与起点相同 = 时间点事件） */
  end: string
  /** 持续天数：0=同一天；null=填不全算不出；负数=填反了（要警示，不静默纠正） */
  span: number | null
  ago: string
  truth: string
  legend: string
  who: string
  impact: string
  status: string
  foreshadow: string
  mentioned: string
  remark: string
  key: number
}

interface Props {
  rows: TableRow[]
  tab: TabDef
  calendars: CalendarDef[]
  /** 一年几个月 / 每月几天 —— 持续天数按它换算（不给则按默认 12×30） */
  calendarRule?: CalendarRule
}

const STATUS_STYLE: Record<string, string> = {
  '已定稿': 'bg-emerald-500/15 text-emerald-300',
  '待补充': 'bg-amber/15 text-amber',
  '已变更': 'bg-rose-500/15 text-rose-300',
}

// 单行水平轴布局常量（2026-09-24 · 主人哥哥定版：蛇形取消，全部水平；
// 二次定版：持续线条移到**轴上方**、尖角向下指轴，卡片留在轴下，靠同色对应）
const SLOT_W = 240      // 相邻时间点组的间距（等距；区间端点在相邻组之间按时间比例插值）
const POINT_R = 9
const CARD_W = 210
const BRACKET_DEPTH = 18
/** 同一起点多条线条之间的深度间隔（第 j 条 = DEPTH + j*STEP，向轴上方依次外扩） */
const BRACKET_STEP = 12
/** 单张卡片估高（标题两行 + 区间 + 时长 + 人物 + 状态），用于竖排堆叠的画布总高 */
const CARD_MAX_H = 126

export default function HistoryTimeline({ rows, calendars, calendarRule = DEFAULT_CALENDAR_RULE }: Props) {
  const [hover, setHover] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<'all' | '已定稿' | '待补充' | '已变更'>('all')
  const [selected, setSelected] = useState<Evt | null>(null)

  /** 起止展示串：只填了起点就只显示起点，两端都有则显示区间 */
  const rangeLabel = (e: Pick<Evt, 'time' | 'end'>, cal: string) => {
    const s = formatStoryRange(e.time, e.end)
    return cal ? `${cal} ${s}` : s
  }

  const data = useMemo(() => {
    // 历法权重查表：只在 memo 内部使用，就地定义可让依赖收敛到实际读到的 calendars
    const calValueOf = (name: string) => {
      const c = calendars.find(x => x.name === name)
      return c ? c.value : 0
    }
    const filtered = rows.filter(r => {
      if (filterStatus === 'all') return true
      return (r.data['状态'] ?? '') === filterStatus
    })
    return filtered
      .map(r => {
        const calName = r.data['历法'] ?? ''
        const time = r.data['发生时间'] ?? ''
        const end = r.data['结束时间'] ?? ''
        const tk = storyDateKey(time)
        const key = calValueOf(calName) * 1e10 + (isFinite(tk) ? tk : Number.POSITIVE_INFINITY)
        return {
          id: r.id,
          code: r.data['编号'] ?? '',
          title: r.data['事件名称'] ?? '',
          calName,
          time,
          end,
          span: storySpanDays(calendarRule, time, end),
          ago: r.data['距今时长'] ?? '',
          truth: r.data['事件经过（真相）'] ?? '',
          legend: r.data['民间流传版本（vs真相）'] ?? '',
          who: r.data['参与者/关联者'] ?? '',
          impact: r.data['影响与后果'] ?? '',
          status: r.data['状态'] ?? '',
          foreshadow: r.data['对应伏笔编号'] ?? '',
          mentioned: r.data['已发布章节是否提及'] ?? '',
          remark: r.data['备注'] ?? '',
          key,
        } as Evt
      })
      .sort((a, b) => a.key - b.key)
  }, [rows, filterStatus, calendars, calendarRule])

  /**
   * 🔴 时间点分组（2.4.4 · 主人哥哥反馈"同一时间点多个卡片接续排列"的根治）：
   * **相同发生时间（同历法 + 同发生时间键）的事件共用轴上同一个点**，卡片在该点下竖向堆叠 ——
   * 之前每个事件各占一格，同一天的两个事件被画成两个前后相邻的点，看起来像时间上接续，纯属误导。
   * 分组依赖 data 已按 key 排序（相同 key 必然相邻）。
   */
  const groups = useMemo(() => {
    const gs: { key: number; items: Evt[] }[] = []
    for (const d of data) {
      const last = gs[gs.length - 1]
      if (last && last.key === d.key) last.items.push(d)
      else gs.push({ key: d.key, items: [d] })
    }
    return gs
  }, [data])

  const groupX = (gi: number) => gi * SLOT_W + SLOT_W / 2

  /** 插值锚 = 时间点组（组内共享 x）；只取时间可解析的组（key=Infinity 的不能当锚） */
  const dotsWithTail = useMemo(() => {
    const pts = groups
      .map((g, gi) => ({ key: g.key, x: groupX(gi) }))
      .filter(p => Number.isFinite(p.key))
    if (pts.length === 0) return pts
    const last = pts[pts.length - 1]
    // 末尾虚拟锚：结束时间晚于最后一个事件时，线条仍能往右延（按 10 万年 ≈ 一格的比例）
    return [...pts, { key: last.key + 1e9, x: last.x + SLOT_W }]
  }, [groups])

  /**
   * 持续时长线段（主人哥哥 2026-09-24 三次定版）：画在轴**上方**，
   * 两端小刻度指着起止在轴上的位置；分层深度按组内序 j（同起点的线依次外扩）。
   *
   * 🔴 颜色 = `assignOverlapColors`（区间图着色）：**相互重叠的线必然不同色**，
   *    互不重叠的线复用色板 —— 此前按组内序取色，示范数据里几根互不重叠的线
   *    全部落到第一色，看起来"颜色根本没区分"（主人哥哥验收指出的正是这个）。
   */
  const brackets = useMemo(() => {
    const geo: { id: string; gi: number; j: number; x0: number; right: number; neg: boolean; label: string }[] = []
    groups.forEach((g, gi) => {
      const x0 = groupX(gi)
      g.items.forEach((d, j) => {
        if (d.span === null || d.span === 0) return
        // d.key = 历法权重*1e10 + tk(发生时间)，减 tk(发生) 加 tk(结束) ⇒ 同历法的结束键
        const endKey = d.key - storyDateKey(d.time) + storyDateKey(d.end)
        const rawEnd = interpolateX(dotsWithTail, endKey)
        if (rawEnd === null) return
        const lo = Math.min(x0, rawEnd)
        const hi = Math.max(x0, rawEnd)
        const right = Math.max(hi, lo + 24)   // 太短看不清，给最小可视宽度
        geo.push({
          id: d.id, gi, j, x0, right,
          neg: d.span < 0,
          label: `${formatStoryRange(d.time, d.end)}（持续 ${formatSpanDays(Math.abs(d.span))}）`,
        })
      })
    })
    // 贪心着色：重叠线不同色（输入顺序与 geo 对齐）
    const colors = assignOverlapColors(geo.map(s => ({ x0: Math.min(s.x0, s.right), right: Math.max(s.x0, s.right) })))
    return geo.map((s, i) => ({ ...s, colorIdx: colors[i] }))
  }, [groups, dotsWithTail])
  const bracketById = useMemo(
    () => new Map(brackets.map(b => [b.id, b])),
    [brackets],
  )

  const calLegend = [...calendars].sort((a, b) => a.value - b.value)
    .map(c => `${c.name}(${c.value})`).join(' → ')

  /**
   * 轴的 y 位置：轴**上方**要给分层线条留出空间（第 j 条 = DEPTH + j*STEP），
   * 线移到轴上之后，卡片堆顶统一回到轴下 10px，不再按线条深度错开。
   */
  const maxJ = brackets.reduce((m, b) => Math.max(m, b.j), -1)
  const axisY = maxJ >= 0 ? BRACKET_DEPTH + maxJ * BRACKET_STEP + 12 : 14

  const totalW = Math.max(groups.length, 1) * SLOT_W
  const maxStack = groups.reduce((m, grp) => Math.max(m, grp.items.length), 1)
  const totalH = axisY + 10 + maxStack * CARD_MAX_H + 16

  const detail = (e: Evt) =>
    ([
      e.code && ['编号', e.code],
      e.calName && ['历法', e.calName],
      e.time && ['发生时间', e.time],
      e.end && ['结束时间', e.end],
      (e.span !== null && e.span !== 0) && ['持续时长', `${formatSpanDays(e.span)}${e.span < 0 ? '（结束早于开始，请核对）' : ''}`],
      e.ago && ['距今时长', e.ago],
      e.status && ['状态', e.status],
      e.truth && ['真相', e.truth],
      e.legend && ['民间流传（vs 真相）', e.legend],
      e.who && ['参与者 / 关联者', e.who],
      e.impact && ['影响与后果', e.impact],
      e.foreshadow && ['对应伏笔编号', e.foreshadow],
      e.mentioned && ['已发布章节是否提及', e.mentioned],
      e.remark && ['备注', e.remark],
    ].filter(Boolean) as [string, string][])

  return (
    <div className="page-enter">
      {/* 工具条 */}
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <div className="text-12 text-ink-400">
          共 <span className="text-amber font-semibold">{data.length}</span> 个事件
          {calLegend && <>，历法顺序：<span className="text-ink-200">{calLegend}</span></>}
        </div>
        {calendars.length > 1 && (
          <span className="text-10 text-ink-500">（历法顺序：按「历法」列数值排列）</span>
        )}
        <span className="text-10 text-ink-500">
          （同一时间点的事件共用一个圆点、卡片竖排；持续时段用彩色线条标在轴上方，线条颜色与卡片左缘色条对应）
        </span>
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-11 text-ink-500 mr-1">状态筛选：</span>
          {(['all', '已定稿', '待补充', '已变更'] as const).map(s => (
            <Button variant="toggle" selected={filterStatus === s}
              key={s}
              onClick={() => setFilterStatus(s)}
              className="px-2.5 py-0.5 rounded-md text-11 border hover:text-ink-200"
            >
              {s === 'all' ? '全部' : s}
            </Button>
          ))}
        </div>
      </div>

      {/* 时间轴画布（单行水平轴：横向滚动；点击线条 / 卡片 / 圆点弹窗看详情） */}
      <div className="relative overflow-auto" style={{ maxHeight: totalH + 40 }}>
        <div className="relative" style={{ width: totalW, height: totalH }}>
          {/* 水平主轴 + 时长线条（轴上方，分层换色） */}
          <svg className="absolute inset-0" width={totalW} height={totalH} style={{ zIndex: 0, overflow: 'visible' }}>
            <line x1={20} y1={axisY} x2={totalW - 20} y2={axisY} stroke="rgba(128,130,150,0.4)" strokeWidth={1.5} />
            {brackets.map(b => {
              const on = hover === b.id || selected?.id === b.id
              const color = COLORS[b.colorIdx % COLORS.length]
              const path = spanLinePath(b.x0, b.right, axisY, BRACKET_DEPTH + b.j * BRACKET_STEP, 'up')
              return (
                <path
                  key={`bk-${b.id}`}
                  d={path}
                  fill="none"
                  className={b.neg ? 'stroke-rose-400' : color.stroke}
                  strokeWidth={on ? 2.5 : 2}
                  strokeOpacity={on ? 0.95 : 0.6}
                  strokeLinecap="round"
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    const hit = data.find(x => x.id === b.id)
                    if (hit) setSelected(hit)
                  }}
                  onMouseEnter={() => setHover(b.id)}
                  onMouseLeave={() => setHover(null)}
                >
                  <title>{b.label}</title>
                </path>
              )
            })}
          </svg>

          {/* 事件卡片：同一时间点一组、竖向堆叠；有持续时段的卡片，左缘色条与它的轴上线条同色 */}
          {groups.map((g, gi) => (
            <div
              key={`grp-${gi}-${g.key}`}
              className="absolute flex flex-col gap-2"
              style={{
                left: Math.min(Math.max(groupX(gi) - CARD_W / 2, 4), Math.max(4, totalW - CARD_W - 4)),
                top: axisY + 10,
                width: CARD_W, zIndex: 10,
              }}
            >
              {g.items.map((d) => {
                const bk = bracketById.get(d.id)
                const color = bk ? COLORS[bk.colorIdx % COLORS.length] : null
                const barCls = color ? color.bar : 'border-ink-600'
                const textCls = color ? color.text : 'text-ink-300'
                const active = hover === d.id || selected?.id === d.id
                return (
                  <div
                    key={d.id}
                    className={`border-l-4 ${barCls}`}
                    onMouseEnter={() => setHover(d.id)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <div
                      onClick={() => setSelected(d)}
                      className={`bg-ink-850 border border-l-0 rounded-lg p-2.5 cursor-pointer transition-all
                        ${active && color ? `${color.ring} ring-2 border-amber/40` : 'border-ink-700 hover:border-ink-600'}`}
                    >
                      <div className={`text-10 ${textCls} font-semibold mb-0.5 flex items-center gap-1`}>
                        <Calendar size={9} /> {d.time ? rangeLabel(d, d.calName) : '时间未定'}
                      </div>
                      <div className="text-12 text-ink-100 font-semibold leading-snug line-clamp-2">
                        {d.title || '（未命名事件）'}
                      </div>
                      {/* 持续时长：填反了（负数）也照实显示并标红 —— 那是设定冲突，要让人看见 */}
                      {d.span !== null && d.span !== 0 && (
                        <div className={`mt-1 text-10 flex items-center gap-1 ${d.span < 0 ? 'text-rose-300' : 'text-ink-400'}`}>
                          <AlarmClock size={9} />
                          {d.span < 0 ? `结束早于开始 ${formatSpanDays(Math.abs(d.span))}（请核对）` : `持续 ${formatSpanDays(d.span)}`}
                        </div>
                      )}
                      {d.who && (
                        <div className="mt-1.5 text-10 text-ink-400 flex items-center gap-1">
                          <Users size={9} /> <span className="truncate">{d.who}</span>
                        </div>
                      )}
                      {d.status && (
                        <div className="mt-1.5">
                          <span className={`text-9 px-1.5 py-0.5 rounded ${STATUS_STYLE[d.status] ?? 'bg-ink-700 text-ink-300'}`}>{d.status}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}

          {/* 时间点圆点（每组一个，落在水平轴线上） */}
          {groups.map((g, gi) => {
            const active = g.items.some(d => hover === d.id || selected?.id === d.id)
            return (
              <div
                key={`dot-${gi}-${g.key}`}
                className={`absolute rounded-full bg-amber ring-4 ring-ink-900 transition-all ${active ? 'scale-125' : ''}`}
                style={{ left: groupX(gi) - POINT_R, top: axisY - POINT_R, width: POINT_R * 2, height: POINT_R * 2, zIndex: 11 }}
              />
            )
          })}
        </div>
      </div>

      {/* 事件详情弹窗 */}
      {selected && (
        <Modal open onClose={() => setSelected(null)} hideHeader width={480} maxHeight="85vh" bodyClassName="!p-0">
              <div className="flex-1 min-w-0">
                <div className="text-10 text-amber font-semibold mb-0.5">
                  {selected.time ? rangeLabel(selected, selected.calName) : '时间未定'}
                  {selected.calName && <span className="text-ink-500"> · {selected.calName}</span>}
                </div>
                <h3 className="text-16 font-semibold text-ink-50 leading-snug">{selected.title || '（未命名事件）'}</h3>
              </div>
              <Button variant="bare" iconOnly size="xs"
                title="关闭详情"
onClick={() => setSelected(null)}
                className="shrink-0 rounded-lg p-1 text-ink-500 hover:text-ink-200 hover:bg-ink-700 transition-colors"
              ><X size={16} /></Button>
            <div className="p-4 space-y-2.5">
              {detail(selected).map(([label, value]) => (
                <div key={label} className="text-12 leading-relaxed">
                  <span className="text-amber/80 font-semibold">{label}：</span>
                  <span className="text-ink-200">{value}</span>
                </div>
              ))}
            </div>
        </Modal>
      )}
    </div>
  )
}
