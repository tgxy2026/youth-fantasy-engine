import { useMemo, useState } from 'react'
import type { TableRow, TabDef, CalendarDef, CalendarRule } from '../lib/types'
import { DEFAULT_CALENDAR_RULE, formatSpanDays, formatStoryRange, interpolateX, resolveCardOverlaps, spanBracketPath, storyDateKey, storySpanDays } from '../lib/storyDate'
import { Calendar, Users, X, AlarmClock } from 'lucide-react'
import { Modal } from './Modal'
import { Button } from './Button'

const COLORS = [
  { dot: 'bg-amber', ring: 'ring-amber/40', text: 'text-amber' },
  { dot: 'bg-sky-400', ring: 'ring-sky-400/40', text: 'text-sky-300' },
  { dot: 'bg-emerald-400', ring: 'ring-emerald-400/40', text: 'text-emerald-300' },
  { dot: 'bg-rose-400', ring: 'ring-rose-400/40', text: 'text-rose-300' },
  { dot: 'bg-violet-400', ring: 'ring-violet-400/40', text: 'text-violet-300' },
  { dot: 'bg-orange-400', ring: 'ring-orange-400/40', text: 'text-orange-300' },
]

interface Evt {
  id: string
  code: string
  title: string
  calName: string
  /** 发生时间（起点） */
  time: string
  /** 结束时间（终点；与起点相同 = 瞬时事件） */
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

// 单行水平轴布局常量（2026-09-24 · 主人哥哥定版：蛇形取消，全部水平）
const SLOT_W = 240      // 相邻事件点的间距（等距；区间端点在相邻两点间按时间比例插值）
const AXIS_Y = 44       // 水平轴的 y
const POINT_R = 9
const CARD_W = 210
const BRACKET_DEPTH = 18
/** 卡片最大高度估算（标题两行 + 区间 + 时长 + 人物 + 状态），用于画布总高 */
const CARD_MAX_H = 118

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
   * 括号方案（主人哥哥 2026-09-24 定版，替掉第一版"横条"）：
   * 持续事件的括号挂在轴下方，两端尖角向上分别指着起止在轴上的位置，
   * 详情卡片挂在括号底边下方、水平居中（空间不够时贪心往右收，不硬挤）。
   */
  const pointX = (i: number) => i * SLOT_W + SLOT_W / 2

  /** 插值基准点：只取**有可解析时间**的事件（无时间者 key=Infinity，不能当插值锚） */
  const dots = useMemo(
    () => data
      .map((d, i) => ({ key: d.key, x: pointX(i) }))
      .filter(p => Number.isFinite(p.key)),
    [data],
  )
  /** 末尾虚拟锚：结束时间晚于最后一个事件时，括号仍能往右延（按 10 万年 ≈ 一格的比例） */
  const dotsWithTail = useMemo(() => {
    if (dots.length === 0) return dots
    const last = dots[dots.length - 1]
    return [...dots, { key: last.key + 1e9, x: last.x + SLOT_W }]
  }, [dots])

  /** 每个事件的括号几何（无跨度 / 起止同日 → null，只画圆点） */
  const brackets = useMemo(() => {
    return data.map((d, i) => {
      if (d.span === null || d.span === 0) return null
      const x0 = pointX(i)
      // d.key = 历法权重*1e10 + tk(发生时间)，减去 tk(发生) 再加 tk(结束) ⇒ 同历法的结束键
      const endKey = d.key - storyDateKey(d.time) + storyDateKey(d.end)
      const rawEnd = interpolateX(dotsWithTail, endKey)
      if (rawEnd === null) return null
      // 负跨度（填反了）：括号照样画（min~max），颜色在渲染处标红
      const lo = Math.min(x0, rawEnd)
      const hi = Math.max(x0, rawEnd)
      const right = Math.max(hi, lo + 24)   // 太短看不清，给最小可视宽度
      const mid = (lo + right) / 2
      return { id: d.id, x0, path: spanBracketPath(x0, right, AXIS_Y, BRACKET_DEPTH), mid, neg: d.span < 0, span: d.span, label: `${formatStoryRange(d.time, d.end)}（持续 ${formatSpanDays(Math.abs(d.span))}）` }
    })
  }, [data, dotsWithTail])
  const bracketById = useMemo(
    () => new Map(brackets.filter(Boolean).map(b => [b!.id, b!])),
    [brackets],
  )

  /**
   * 卡片防重叠：期望位置 = 括号中点（无括号 = 圆点正下），
   * 同一行内贪心右移，不与前一卡重叠；再夹回画布范围。
   */
  const cardLefts = useMemo(() => {
    const wants = data.map((d, i) => {
      const b = bracketById.get(d.id)
      return ((b ? b.mid : pointX(i)) - CARD_W / 2)
    })
    const lefts = resolveCardOverlaps(wants, CARD_W)
    const maxLeft = Math.max(4, data.length * SLOT_W - CARD_W - 4)
    return lefts.map(l => Math.min(Math.max(l, 4), maxLeft))
  }, [data, bracketById])

  const calLegend = [...calendars].sort((a, b) => a.value - b.value)
    .map(c => `${c.name}(${c.value})`).join(' → ')

  if (data.length === 0) {
    return (
      <div className="p-10 text-center text-ink-400 text-sm">
        <Calendar size={32} className="mx-auto mb-2 text-ink-600" />
        暂无历史事件数据。请先在「表格视图」中录入事件（含「历法」与「发生时间」），切换回「时间轴视图」即可看到。
      </div>
    )
  }

  const n = data.length
  const totalW = Math.max(n, 1) * SLOT_W
  // 单行水平轴：轴 + 括号 + 卡片，全部在一条水平带上
  const totalH = AXIS_Y + BRACKET_DEPTH + CARD_MAX_H + 24

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
          （轴下的括号 = 持续时段，两端尖角指着起止在轴上的位置；起止同一天则是一个圆点。卡片挂在括号下方）
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

      {/* 时间轴画布（单行水平轴：横向滚动；点击括号 / 卡片 / 圆点弹窗看详情） */}
      <div className="relative overflow-auto" style={{ maxHeight: totalH + 40 }}>
        <div className="relative" style={{ width: totalW, height: totalH }}>
          {/* 水平主轴 + 时长括号 */}
          <svg className="absolute inset-0" width={totalW} height={totalH} style={{ zIndex: 0, overflow: 'visible' }}>
            <line x1={20} y1={AXIS_Y} x2={totalW - 20} y2={AXIS_Y} stroke="rgba(128,130,150,0.4)" strokeWidth={1.5} />
            {brackets.map(b => {
              if (!b) return null
              const on = hover === b.id || selected?.id === b.id
              return (
                <path
                  key={`bk-${b.id}`}
                  d={b.path}
                  fill="none"
                  className={b.neg ? 'stroke-rose-400' : 'stroke-amber'}
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

          {/* 节点卡片：挂在括号底边下方（居中），时间点事件挂在圆点正下；同行贪心防重叠 */}
          {data.map((d, i) => {
            const b = bracketById.get(d.id)
            const color = COLORS[i % COLORS.length]
            const active = hover === d.id || selected?.id === d.id
            const top = b ? AXIS_Y + BRACKET_DEPTH + 6 : AXIS_Y + 10
            return (
              <div
                key={d.id}
                className="absolute"
                style={{ left: cardLefts[i], top, width: CARD_W, zIndex: 10 }}
                onMouseEnter={() => setHover(d.id)}
                onMouseLeave={() => setHover(null)}
              >
                <div
                  onClick={() => setSelected(d)}
                  className={`bg-ink-850 border rounded-lg p-2.5 cursor-pointer transition-all
                    ${active ? `${color.ring} ring-2 border-amber/40` : 'border-ink-700 hover:border-ink-600'}`}
                >
                  <div className={`text-10 ${color.text} font-semibold mb-0.5 flex items-center gap-1`}>
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

          {/* 节点圆点（落在水平轴线上） */}
          {data.map((d, i) => {
            const x = pointX(i)
            const color = COLORS[i % COLORS.length]
            return (
              <div
                key={`dot-${d.id}`}
                className={`absolute rounded-full ${color.dot} ring-4 ring-ink-900 transition-all
                  ${hover === d.id || selected?.id === d.id ? 'scale-125' : ''}`}
                style={{ left: x - POINT_R, top: AXIS_Y - POINT_R, width: POINT_R * 2, height: POINT_R * 2, zIndex: 11 }}
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
