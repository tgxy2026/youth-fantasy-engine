import { useMemo, useState } from 'react'
import type { TableRow, TabDef, CalendarDef } from '../lib/types'
import { storyDateKey } from './StoryDateInput'
import { Calendar, Users, X } from 'lucide-react'
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
  time: string
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
}

const STATUS_STYLE: Record<string, string> = {
  '已定稿': 'bg-emerald-500/15 text-emerald-300',
  '待补充': 'bg-amber/15 text-amber',
  '已变更': 'bg-rose-500/15 text-rose-300',
}

// 蛇形布局常量：3 条水平带上下穿梭，节点等距分布，相邻带之间用曲线过渡形成 S 形
const SLOT_W = 240
const BAND_H = 140
const BANDS = 3
const TOP = 30
const POINT_R = 9
const CARD_W = 210

export default function HistoryTimeline({ rows, calendars }: Props) {
  const [hover, setHover] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<'all' | '已定稿' | '待补充' | '已变更'>('all')
  const [selected, setSelected] = useState<Evt | null>(null)

  const calValueOf = (name: string) => {
    const c = calendars.find(x => x.name === name)
    return c ? c.value : 0
  }
  const yearOf = (t: string) => {
    const k = storyDateKey(t)
    return isFinite(k) ? Math.floor(k / 10000) : NaN
  }
  const dateLabel = (t: string, cal: string) => (cal ? `${cal} ${t}` : t)

  const data = useMemo(() => {
    const filtered = rows.filter(r => {
      if (filterStatus === 'all') return true
      return (r.data['状态'] ?? '') === filterStatus
    })
    return filtered
      .map(r => {
        const calName = r.data['历法'] ?? ''
        const time = r.data['故事内时间'] ?? ''
        const tk = storyDateKey(time)
        const key = calValueOf(calName) * 1e10 + (isFinite(tk) ? tk : Number.POSITIVE_INFINITY)
        return {
          id: r.id,
          code: r.data['编号'] ?? '',
          title: r.data['事件名称'] ?? '',
          calName,
          time,
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
  }, [rows, filterStatus, calendars])

  const calLegend = [...calendars].sort((a, b) => a.value - b.value)
    .map(c => `${c.name}(${c.value})`).join(' → ')

  if (data.length === 0) {
    return (
      <div className="p-10 text-center text-ink-400 text-sm">
        <Calendar size={32} className="mx-auto mb-2 text-ink-600" />
        暂无历史事件数据。请先在「表格视图」中录入事件（含「历法」与「故事内时间」），切换回「时间轴视图」即可看到。
      </div>
    )
  }

  const n = data.length
  const totalW = Math.max(n, 1) * SLOT_W
  const totalH = TOP * 2 + BANDS * BAND_H
  const pointX = (i: number) => i * SLOT_W + SLOT_W / 2
  const pointY = (i: number) => TOP + (i % BANDS) * BAND_H + BAND_H / 2

  const segments = data.slice(0, n - 1).map((d, i) => {
    const x0 = pointX(i), y0 = pointY(i)
    const x1 = pointX(i + 1), y1 = pointY(i + 1)
    const ya = yearOf(d.time), yb = yearOf(data[i + 1].time)
    const span = isFinite(ya) && isFinite(yb) ? Math.abs(ya - yb) : Infinity
    const dashed = span > 5
    const mx = x0 + (x1 - x0) / 2
    return { i, x0, y0, x1, y1, mx, dashed }
  })

  const detail = (e: Evt) =>
    ([
      e.code && ['编号', e.code],
      e.calName && ['历法', e.calName],
      e.time && ['故事内时间', e.time],
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
        <div className="text-[12px] text-ink-400">
          共 <span className="text-amber font-semibold">{data.length}</span> 个事件
          {calLegend && <>，历法顺序：<span className="text-ink-200">{calLegend}</span></>}
        </div>
        {calendars.length > 1 && (
          <span className="text-[10px] text-ink-500">（虚线段 = 相邻事件时间跨度超过 5 年）</span>
        )}
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-[11px] text-ink-500 mr-1">状态筛选：</span>
          {(['all', '已定稿', '待补充', '已变更'] as const).map(s => (
            <Button variant="bare"
              key={s}
              onClick={() => setFilterStatus(s)}
              className={`px-2.5 py-0.5 rounded-md text-[11px] border transition-colors
                ${filterStatus === s
                  ? 'bg-amber/15 text-amber border-amber/30'
                  : 'bg-ink-800 text-ink-400 border-ink-700 hover:text-ink-200'}`}
            >
              {s === 'all' ? '全部' : s}
            </Button>
          ))}
        </div>
      </div>

      {/* 时间轴画布（整页留给蛇形曲线，横向 / 纵向可滚动；点击节点弹窗看详情） */}
      <div className="relative overflow-auto" style={{ maxHeight: totalH + 60 }}>
        <div className="relative" style={{ width: totalW, height: totalH }}>
          {/* 主轴线（S 形蛇道） */}
          <svg className="absolute inset-0" width={totalW} height={totalH} style={{ zIndex: 0, overflow: 'visible' }}>
            {segments.map(seg => (
              <path
                key={seg.i}
                d={`M ${seg.x0} ${seg.y0} C ${seg.mx} ${seg.y0}, ${seg.mx} ${seg.y1}, ${seg.x1} ${seg.y1}`}
                fill="none"
                stroke={seg.dashed ? 'rgba(120,130,150,0.55)' : 'rgba(245,158,11,0.5)'}
                strokeWidth={2}
                strokeDasharray={seg.dashed ? '6 5' : undefined}
              />
            ))}
          </svg>

          {/* 节点卡片（摘要，点击弹窗看全部） */}
          {data.map((d, i) => {
            const x = pointX(i), y = pointY(i)
            const color = COLORS[i % COLORS.length]
            const active = hover === d.id || selected?.id === d.id
            return (
              <div
                key={d.id}
                className="absolute"
                style={{ left: x - CARD_W / 2, top: y + 16, width: CARD_W, zIndex: 10 }}
                onMouseEnter={() => setHover(d.id)}
                onMouseLeave={() => setHover(null)}
              >
                <div
                  onClick={() => setSelected(d)}
                  className={`bg-ink-850 border rounded-lg p-2.5 cursor-pointer transition-all
                    ${active ? `${color.ring} ring-2 border-amber/40` : 'border-ink-700 hover:border-ink-600'}`}
                >
                  <div className={`text-[10px] ${color.text} font-semibold mb-0.5 flex items-center gap-1`}>
                    <Calendar size={9} /> {d.time ? dateLabel(d.time, d.calName) : '时间未定'}
                  </div>
                  <div className="text-[12px] text-ink-100 font-semibold leading-snug line-clamp-2">
                    {d.title || '（未命名事件）'}
                  </div>
                  {d.who && (
                    <div className="mt-1.5 text-[10px] text-ink-400 flex items-center gap-1">
                      <Users size={9} /> <span className="truncate">{d.who}</span>
                    </div>
                  )}
                  {d.status && (
                    <div className="mt-1.5">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded ${STATUS_STYLE[d.status] ?? 'bg-ink-700 text-ink-300'}`}>{d.status}</span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {/* 节点圆点（落在轴线上） */}
          {data.map((d, i) => {
            const x = pointX(i), y = pointY(i)
            const color = COLORS[i % COLORS.length]
            return (
              <div
                key={`dot-${d.id}`}
                className={`absolute rounded-full ${color.dot} ring-4 ring-ink-900 transition-all
                  ${hover === d.id || selected?.id === d.id ? 'scale-125' : ''}`}
                style={{ left: x - POINT_R, top: y - POINT_R, width: POINT_R * 2, height: POINT_R * 2, zIndex: 11 }}
              />
            )
          })}
        </div>
      </div>

      {/* 事件详情弹窗 */}
      {selected && (
        <Modal open onClose={() => setSelected(null)} hideHeader width={480} maxHeight="85vh" bodyClassName="!p-0">
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-amber font-semibold mb-0.5">
                  {selected.time ? dateLabel(selected.time, selected.calName) : '时间未定'}
                  {selected.calName && <span className="text-ink-500"> · {selected.calName}</span>}
                </div>
                <h3 className="text-[16px] font-semibold text-ink-50 leading-snug">{selected.title || '（未命名事件）'}</h3>
              </div>
              <Button variant="bare"
                onClick={() => setSelected(null)}
                className="p-1.5 text-ink-500 hover:text-ink-200 hover:bg-ink-700 rounded-lg transition-colors shrink-0"
              ><X size={16} /></Button>
            <div className="p-4 space-y-2.5">
              {detail(selected).map(([label, value]) => (
                <div key={label} className="text-[12.5px] leading-relaxed">
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
