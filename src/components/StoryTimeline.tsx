import { useMemo, useState } from 'react'
import type { TableRow, TabDef, CalendarDef } from '../lib/types'
import { storyDateKey } from './StoryDateInput'
import { createPortal } from 'react-dom'
import { Calendar, X, AlertTriangle, Layers } from 'lucide-react'

const COLORS = [
  { dot: 'bg-amber', ring: 'ring-amber/40', text: 'text-amber' },
  { dot: 'bg-sky-400', ring: 'ring-sky-400/40', text: 'text-sky-300' },
  { dot: 'bg-emerald-400', ring: 'ring-emerald-400/40', text: 'text-emerald-300' },
  { dot: 'bg-rose-400', ring: 'ring-rose-400/40', text: 'text-rose-300' },
  { dot: 'bg-violet-400', ring: 'ring-violet-400/40', text: 'text-violet-300' },
  { dot: 'bg-orange-400', ring: 'ring-orange-400/40', text: 'text-orange-300' },
  { dot: 'bg-cyan-400', ring: 'ring-cyan-400/40', text: 'text-cyan-300' },
  { dot: 'bg-pink-400', ring: 'ring-pink-400/40', text: 'text-pink-300' },
]

// 轨道固定顺序（与 schema 中「线/轨道」列选项一致）；未填字段归入「主线」
const TRACK_ORDER = ['主线', '支线', '暗线', '感情线', '身世线', '成长线', '复仇线', '其他']

interface Evt {
  id: string
  chapter: string
  title: string
  track: string
  calName: string
  time: string
  season: string
  days: string
  realm: string
  location: string
  event: string
  check: string
  remark: string
  key: number
}

interface Props {
  rows: TableRow[]
  tab: TabDef
  calendars: CalendarDef[]
}

const CHECK_STYLE: Record<string, string> = {
  '正常': 'bg-emerald-500/15 text-emerald-300',
  '已修正': 'bg-sky-500/15 text-sky-300',
  '待核对': 'bg-amber/15 text-amber',
}

// 多泳道布局常量
const SLOT_W = 240
const LANE_H = 150
const TOP = 24
const POINT_R = 9
const CARD_W = 210
const LANE_LABEL_W = 88

export default function StoryTimeline({ rows, calendars }: Props) {
  const [hover, setHover] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<'all' | '正常' | '已修正' | '待核对'>('all')
  const [hiddenTracks, setHiddenTracks] = useState<Set<string>>(new Set())
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

  const { data, regressed } = useMemo(() => {
    const filtered = rows.filter(r => {
      if (filterStatus === 'all') return true
      return (r.data['时间线检查'] ?? '') === filterStatus
    })
    const raw = filtered.map(r => {
      const calName = r.data['历法'] ?? ''
      const time = r.data['故事内时间'] ?? ''
      const tk = storyDateKey(time)
      const key = calValueOf(calName) * 1e10 + (isFinite(tk) ? tk : Number.POSITIVE_INFINITY)
      return {
        id: r.id,
        chapter: r.data['章节号'] ?? '',
        title: r.data['章节标题'] ?? '',
        track: (r.data['线/轨道'] as string) || '主线',
        calName,
        time,
        season: r.data['时节/季节'] ?? '',
        days: r.data['经过天数'] ?? '',
        realm: r.data['主角当前境界/年龄'] ?? '',
        location: r.data['重要人物位置与状态'] ?? '',
        event: r.data['本章关键事件'] ?? '',
        check: r.data['时间线检查'] ?? '',
        remark: r.data['备注'] ?? '',
        key,
      } as Evt
    })
    // v1.3 无环校验：在「叙事顺序」（原始录入顺序）上逐事件比对故事内时间。
    // 若某事件的故事内时间早于其前序事件，则形成「时间倒流」（逻辑上的环 / 倒叙），
    // 可能是有意倒叙，也可能是连续性漏洞，标出供作者在表格视图核对。
    const reg = new Set<string>()
    // 按历法分组，只在同一历法内比对故事内时间：跨历法事件的时间不可直接比较，
    // 否则高历法事件之后若出现低历法/未填历法事件会误报「时间倒流」。
    const lastByCal = new Map<string, number>()
    for (const e of raw) {
      if (!e.calName) continue // 历法未填的事件无法定位到具体历法轴，不参与倒流判定
      if (Number.isFinite(e.key)) {
        const prev = lastByCal.get(e.calName)
        if (prev !== undefined && e.key < prev) reg.add(e.id)
        lastByCal.set(e.calName, e.key)
      }
    }
    const data = [...raw].sort((a, b) => a.key - b.key)
    return { data, regressed: [...reg] }
  }, [rows, filterStatus, calendars])

  // 出现的轨道（按固定顺序排列）
  const allTracks = useMemo(
    () => TRACK_ORDER.filter(t => data.some(d => d.track === t)),
    [data]
  )
  const visibleTracks = allTracks.filter(t => !hiddenTracks.has(t))
  const laneIndex = (t: string) => visibleTracks.indexOf(t)
  const laneY = (idx: number) => TOP + idx * LANE_H + LANE_H / 2

  const calLegend = [...calendars].sort((a, b) => a.value - b.value)
    .map(c => `${c.name}(${c.value})`).join(' → ')

  if (data.length === 0) {
    return (
      <div className="p-10 text-center text-ink-400 text-sm">
        <Calendar size={32} className="mx-auto mb-2 text-ink-600" />
        暂无时间线数据。请先在「表格视图」中逐章登记（含「历法」与「故事内时间」），切换回「时间轴视图」即可看到。
      </div>
    )
  }

  const n = data.length
  const totalW = Math.max(n, 1) * SLOT_W
  const numLanes = Math.max(visibleTracks.length, 1)
  const totalH = TOP * 2 + numLanes * LANE_H
  const giOf = new Map(data.map((d, i) => [d.id, i]))
  const xOf = (d: Evt) => (giOf.get(d.id) ?? 0) * SLOT_W + SLOT_W / 2

  // 每条轨道内，按全局故事时间顺序连线
  const laneSegments: { x0: number; y0: number; x1: number; y1: number; dashed: boolean }[] = []
  visibleTracks.forEach((t, idx) => {
    const arr = data.filter(d => d.track === t)
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i], b = arr[i + 1]
      const ya = yearOf(a.time), yb = yearOf(b.time)
      const span = isFinite(ya) && isFinite(yb) ? Math.abs(ya - yb) : Infinity
      laneSegments.push({ x0: xOf(a), y0: laneY(idx), x1: xOf(b), y1: laneY(idx), dashed: span > 5 })
    }
  })

  const detail = (e: Evt) =>
    ([
      e.chapter && ['章节号', e.chapter],
      e.track && ['线 / 轨道', e.track],
      e.calName && ['历法', e.calName],
      e.time && ['故事内时间', e.time],
      e.season && ['时节 / 季节', e.season],
      e.days && ['经过天数', e.days],
      e.realm && ['主角当前境界 / 年龄', e.realm],
      e.location && ['重要人物位置与状态', e.location],
      e.event && ['本章关键事件', e.event],
      e.check && ['时间线检查', e.check],
      e.remark && ['备注', e.remark],
    ].filter(Boolean) as [string, string][])

  return (
    <div className="page-enter">
      {/* 无环校验提示：检测到时间倒流时给出非阻断告警 */}
      {regressed.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">时间线无环校验：</span>
            检测到 <span className="text-rose-200 font-semibold">{regressed.length}</span> 处「时间倒流」（本章故事内时间早于其前序事件）。
            可能是有意倒叙，也可能是连续性漏洞，建议在「表格视图」核对相关章节的「故事内时间」与「时间线检查」。
          </div>
        </div>
      )}
      {/* 工具条 */}
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <div className="text-[12px] text-ink-400">
          共 <span className="text-amber font-semibold">{data.length}</span> 章
          {calLegend && <>，历法顺序：<span className="text-ink-200">{calLegend}</span></>}
        </div>
        <div className="flex items-center gap-1.5 ml-auto flex-wrap">
          <span className="text-[11px] text-ink-500 mr-1 inline-flex items-center gap-1">
            <Layers size={11} /> 轨道：
          </span>
          {allTracks.map(t => {
            const idx = allTracks.indexOf(t)
            const color = COLORS[idx % COLORS.length]
            const hidden = hiddenTracks.has(t)
            return (
              <button
                key={t}
                onClick={() => setHiddenTracks(prev => {
                  const next = new Set(prev)
                  if (next.has(t)) next.delete(t); else next.add(t)
                  return next
                })}
                className={`px-2.5 py-0.5 rounded-md text-[11px] border transition-colors inline-flex items-center gap-1
                  ${hidden ? 'bg-ink-800 text-ink-600 border-ink-700 line-through'
                    : `bg-ink-800 ${color.text} border-ink-700 hover:border-ink-600`}`}
              >
                <span className={`w-2 h-2 rounded-full ${color.dot}`} /> {t}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-ink-500 mr-1">核对状态：</span>
          {(['all', '正常', '已修正', '待核对'] as const).map(s => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={`px-2.5 py-0.5 rounded-md text-[11px] border transition-colors
                ${filterStatus === s
                  ? 'bg-amber/15 text-amber border-amber/30'
                  : 'bg-ink-800 text-ink-400 border-ink-700 hover:text-ink-200'}`}
            >
              {s === 'all' ? '全部' : s}
            </button>
          ))}
        </div>
      </div>

      {visibleTracks.length === 0 ? (
        <div className="p-8 text-center text-ink-400 text-sm">已隐藏全部轨道，请点击上方轨道名恢复显示。</div>
      ) : (
        /* 多泳道：左列固定轨道标签（不横向滚动），右侧画布按故事时间顺序轴横滚 */
        <div className="flex overflow-auto rounded-xl border border-ink-800 bg-ink-900/40" style={{ maxHeight: totalH + 60 }}>
          {/* 左：泳道标签列 */}
          <div className="shrink-0 bg-ink-900/80 border-r border-ink-800" style={{ width: LANE_LABEL_W }}>
            <div style={{ height: TOP }} />
            {visibleTracks.map((t, idx) => {
              const color = COLORS[idx % COLORS.length]
              return (
                <div key={t} className="flex items-start px-2 pt-2" style={{ height: LANE_H }}>
                  <span className={`text-[11px] font-semibold ${color.text} leading-tight`}>{t}</span>
                </div>
              )
            })}
          </div>
          {/* 右：可横向滚动的时间轴画布 */}
          <div className="relative flex-1 overflow-x-auto">
            <div className="relative" style={{ width: totalW, height: totalH }}>
              {/* 泳道背景分隔 */}
              {visibleTracks.map((t, idx) => (
                <div
                  key={`lane-${t}`}
                  className="absolute left-0 right-0 border-b border-ink-800/60"
                  style={{ top: TOP + idx * LANE_H, height: LANE_H }}
                />
              ))}
              {/* 轨道内连线（共享横向故事时间轴） */}
              <svg className="absolute inset-0" width={totalW} height={totalH} style={{ zIndex: 0, overflow: 'visible', pointerEvents: 'none' }}>
                {laneSegments.map((seg, i) => (
                  <path
                    key={i}
                    d={`M ${seg.x0} ${seg.y0} L ${seg.x1} ${seg.y1}`}
                    fill="none"
                    stroke={seg.dashed ? 'rgba(120,130,150,0.5)' : 'rgba(245,158,11,0.45)'}
                    strokeWidth={2}
                    strokeDasharray={seg.dashed ? '6 5' : undefined}
                  />
                ))}
              </svg>

              {/* 节点卡片（摘要，点击弹窗看全部） */}
              {data.filter(d => !hiddenTracks.has(d.track)).map(d => {
                const idx = laneIndex(d.track)
                if (idx < 0) return null
                const x = xOf(d), y = laneY(idx)
                const color = COLORS[idx % COLORS.length]
                const active = hover === d.id || selected?.id === d.id
                return (
                  <div
                    key={d.id}
                    className="absolute"
                    style={{ left: x - CARD_W / 2, top: y + 14, width: CARD_W, zIndex: 10 }}
                    onMouseEnter={() => setHover(d.id)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <div
                      onClick={() => setSelected(d)}
                      className={`bg-ink-850 border rounded-lg p-2.5 cursor-pointer transition-all relative
                        ${regressed.includes(d.id) ? 'border-rose-500/60 ring-2 ring-rose-500/30'
                          : active ? `${color.ring} ring-2 border-amber/40` : 'border-ink-700 hover:border-ink-600'}`}
                    >
                      {regressed.includes(d.id) && (
                        <span className="absolute -top-1.5 -right-1.5 flex items-center gap-0.5 px-1 py-0.5 rounded-full bg-rose-500 text-white text-[8px] font-bold shadow" title="时间倒流：故事内时间早于前序事件">
                          <AlertTriangle size={8} /> 倒流
                        </span>
                      )}
                      <div className={`text-[10px] ${color.text} font-semibold mb-0.5 flex items-center gap-1`}>
                        <Calendar size={9} /> {d.time ? dateLabel(d.time, d.calName) : '时间未定'}
                      </div>
                      <div className="text-[12px] text-ink-100 font-semibold leading-snug line-clamp-2">
                        {d.chapter ? `${d.chapter} ` : ''}{d.title || '（未命名章节）'}
                      </div>
                      {d.event && (
                        <div className="mt-1 text-[10px] text-ink-400 line-clamp-2">{d.event}</div>
                      )}
                      {d.check && (
                        <div className="mt-1.5">
                          <span className={`text-[9px] px-1.5 py-0.5 rounded ${CHECK_STYLE[d.check] ?? 'bg-ink-700 text-ink-300'}`}>{d.check}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}

              {/* 节点圆点（落在轴线上） */}
              {data.filter(d => !hiddenTracks.has(d.track)).map(d => {
                const idx = laneIndex(d.track)
                if (idx < 0) return null
                const x = xOf(d), y = laneY(idx)
                const color = COLORS[idx % COLORS.length]
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
        </div>
      )}

      {/* 章节详情弹窗 */}
      {selected && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" onMouseDown={() => setSelected(null)}>
          <div
            className="bg-ink-850 border border-ink-600 rounded-2xl w-[30rem] max-w-full max-h-[85vh] overflow-y-auto shadow-2xl"
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-2 p-4 border-b border-ink-700 sticky top-0 bg-ink-850">
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-amber font-semibold mb-0.5">
                  {selected.time ? dateLabel(selected.time, selected.calName) : '时间未定'}
                  {selected.calName && <span className="text-ink-500"> · {selected.calName}</span>}
                </div>
                <h3 className="text-[16px] font-semibold text-ink-50 leading-snug">
                  {selected.chapter ? `${selected.chapter} ` : ''}{selected.title || '（未命名章节）'}
                </h3>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="p-1.5 text-ink-500 hover:text-ink-200 hover:bg-ink-700 rounded-lg transition-colors shrink-0"
              ><X size={16} /></button>
            </div>
            <div className="p-4 space-y-2.5">
              {regressed.includes(selected.id) && (
                <div className="flex items-center gap-1.5 text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md px-2 py-1.5">
                  <AlertTriangle size={11} /> 时间倒流：本章故事内时间早于其前序事件，请核对是否为有意倒叙。
                </div>
              )}
              {detail(selected).map(([label, value]) => (
                <div key={label} className="text-[12.5px] leading-relaxed">
                  <span className="text-amber/80 font-semibold">{label}：</span>
                  <span className="text-ink-200">{value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
