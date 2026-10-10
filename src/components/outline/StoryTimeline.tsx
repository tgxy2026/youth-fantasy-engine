import { useMemo, useState } from 'react'
import type { TableRow, TabDef, CalendarDef, CalendarRule } from '@/lib/types'
import { DEFAULT_CALENDAR_RULE, formatSpanDays, formatStoryRange, assignOverlapColors, interpolateX, spanLinePath, storyDateKey, storySpanDays, cappedPositions, formatDurationHuman } from '@/lib/app/storyDate'
import { Calendar, X, AlertTriangle, Layers, AlarmClock } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'

/**
 * 轨道配色（2.4.4 线条方案）：`dot/ring/text` 供圆点与卡片沿用；
 * `stroke` 给 SVG 线条、`bar` 给卡片左缘色条。
 * 🔴 全部写成**字面量类名** —— Tailwind JIT 只认源码里出现的类，运行时拼接的类不会被生成。
 * `j`（同时间点组内序）决定线条颜色：同起点多条线条换色 + 下移，与竖排卡片一一对应。
 */
const COLORS = [
  { dot: 'bg-amber', ring: 'ring-amber/40', text: 'text-amber', stroke: 'stroke-amber', bar: 'border-amber' },
  { dot: 'bg-sky-400', ring: 'ring-info/40', text: 'text-info', stroke: 'stroke-sky-400', bar: 'border-sky-400' },
  { dot: 'bg-emerald-400', ring: 'ring-success/40', text: 'text-success', stroke: 'stroke-emerald-400', bar: 'border-emerald-400' },
  { dot: 'bg-rose-400', ring: 'ring-rose-400/40', text: 'text-rose-300', stroke: 'stroke-rose-400', bar: 'border-rose-400' },
  { dot: 'bg-violet-400', ring: 'ring-violet-400/40', text: 'text-violet-300', stroke: 'stroke-violet-400', bar: 'border-violet-400' },
  { dot: 'bg-orange-400', ring: 'ring-orange-400/40', text: 'text-orange-300', stroke: 'stroke-orange-400', bar: 'border-orange-400' },
  { dot: 'bg-cyan-400', ring: 'ring-cyan-400/40', text: 'text-cyan-300', stroke: 'stroke-cyan-400', bar: 'border-cyan-400' },
  { dot: 'bg-pink-400', ring: 'ring-pink-400/40', text: 'text-pink-300', stroke: 'stroke-pink-400', bar: 'border-pink-400' },
]

// 轨道固定顺序（与 schema 中「线/轨道」列选项一致）；未填字段归入「主线」
const TRACK_ORDER = ['主线', '支线', '暗线', '感情线', '身世线', '成长线', '复仇线', '其他']

interface Evt {
  id: string
  chapter: string
  title: string
  track: string
  calName: string
  /** 发生时间（起点） */
  time: string
  /** 结束时间（终点；与起点相同 = 本章发生在一天内） */
  end: string
  /** 持续天数：0=同一天；null=填不全；负数=填反了 */
  span: number | null
  season: string
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
  /** 一年几个月 / 每月几天 —— 持续天数按它换算（不给则按默认 12×30） */
  calendarRule?: CalendarRule
}

const CHECK_STYLE: Record<string, string> = {
  '正常': 'bg-success/15 text-success',
  '已修正': 'bg-info/15 text-info',
  '待核对': 'bg-amber/15 text-amber',
}

// 多泳道布局常量（2026-09-24 · 线条方案：泳道线即水平轴，置于泳道顶部，
// 线条与卡片挂轴下方 —— 主人哥哥定版，与历史事件轴同一套视觉）
const SLOT_W = 240
const TOP = 24
const POINT_R = 9
const CARD_W = 210
const LANE_LABEL_W = 88
const BRACKET_DEPTH = 18
/** 同一起点多条线条之间的深度间隔（第 j 条 = DEPTH + j*STEP） */
const BRACKET_STEP = 12
/** 泳道轴在泳道内的 y 偏移 */
const LANE_AXIS_OFFSET = 16
/** 单张卡片估高（章节号标题 + 区间 + 时长 + 事件两行 + 状态徽章） */
// 🔴 2.4.4 六维审计：估高要**保守**（实卡含历法名+区间行可换行）——估小了卡片底部被裁（同 HistoryTimeline）
const CARD_MAX_H = 156
/** 泳道最小高度（只有一两张卡时也别太扁） */
const LANE_MIN_H = 150

export default function StoryTimeline({ rows, calendars, calendarRule = DEFAULT_CALENDAR_RULE }: Props) {
  const [hover, setHover] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<'all' | '正常' | '已修正' | '待核对'>('all')
  const [hiddenTracks, setHiddenTracks] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Evt | null>(null)
  /** 横轴间距模式（2.7.2）：等距（默认，零回归）/ 等比（按真实时间差 + 超长空档封顶） */
  const [scale, setScale] = useState<'even' | 'proportional'>('even')

  /** 起止展示串：只填了起点就只显示起点，两端都有则显示区间 */
  const rangeLabel = (e: Pick<Evt, 'time' | 'end'>, cal: string) => {
    const s = formatStoryRange(e.time, e.end)
    return cal ? `${cal} ${s}` : s
  }

  const { data, regressed } = useMemo(() => {
    // 历法权重查表：只在 memo 内部使用，就地定义可让依赖收敛到实际读到的 calendars
    const calValueOf = (name: string) => {
      const c = calendars.find(x => x.name === name)
      return c ? c.value : 0
    }
    const filtered = rows.filter(r => {
      if (filterStatus === 'all') return true
      return (r.data['时间线检查'] ?? '') === filterStatus
    })
    const raw = filtered.map(r => {
      const calName = r.data['历法'] ?? ''
      const time = r.data['发生时间'] ?? ''
      const end = r.data['结束时间'] ?? ''
      const tk = storyDateKey(time)
      const key = calValueOf(calName) * 1e10 + (isFinite(tk) ? tk : Number.POSITIVE_INFINITY)
      return {
        id: r.id,
        chapter: r.data['章节号'] ?? '',
        title: r.data['章节标题'] ?? '',
        track: (r.data['线/轨道'] as string) || '主线',
        calName,
        time,
        end,
        span: storySpanDays(calendarRule, time, end),
        season: r.data['时节/季节'] ?? '',
        realm: r.data['主角当前境界/年龄'] ?? '',
        location: r.data['重要人物位置与状态'] ?? '',
        event: r.data['本章关键事件'] ?? '',
        check: r.data['时间线检查'] ?? '',
        remark: r.data['备注'] ?? '',
        key,
      } as Evt
    })
    // v1.3 无环校验：在「叙事顺序」（原始录入顺序）上逐事件比对发生时间。
    // 若某事件的发生时间早于其前序事件，则形成「时间倒流」（逻辑上的环 / 倒叙），
    // 可能是有意倒叙，也可能是连续性漏洞，标出供作者在表格视图核对。
    const reg = new Set<string>()
    // 按历法分组，只在同一历法内比对发生时间：跨历法事件的时间不可直接比较，
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
  }, [rows, filterStatus, calendars, calendarRule])

  // 出现的轨道（按固定顺序排列）
  const allTracks = useMemo(
    () => TRACK_ORDER.filter(t => data.some(d => d.track === t)),
    [data]
  )
  const visibleTracks = allTracks.filter(t => !hiddenTracks.has(t))

  /**
   * 🔴 时间点分组（与 HistoryTimeline 同口径，2.4.4）：
   * **相同发生时间（同历法 + 同发生时间键）的事件共用轴上同一个点** —— 且跨轨道合并：
   * 主线和暗线同一天发生，就该在轴上同一个位置（各在自己的泳道竖排卡片）。
   * 之前每事件占一格，同一天的章节被画成前后相邻的"假时间点"。
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

  /**
   * 横轴定位（2.7.2 「等比」模式，与历史事件轴同口径）：
   * · `even`（默认，零回归）= 等距槽位；`proportional` = 按真实时间差 + 超长空档封顶；
   *   无法解析时间的组（key=Infinity）排在末尾、按等距兜底。
   */
  const { groupPositions, breakIdx } = useMemo(() => {
    const n = groups.length
    const even = () => ({ groupPositions: groups.map((_, gi) => gi * SLOT_W + SLOT_W / 2), breakIdx: [] as number[] })
    if (scale === 'even' || n === 0) return even()
    const keys: number[] = []
    const back: number[] = []
    groups.forEach((g, gi) => { if (Number.isFinite(g.key)) { keys.push(g.key); back.push(gi) } })
    if (keys.length === 0) return even()
    const { x, breaks } = cappedPositions(keys, { slot: SLOT_W })
    const pos = new Array<number>(n).fill(0)
    back.forEach((gi, j) => { pos[gi] = x[j] })
    let cursor = x[x.length - 1]
    for (let gi = 0; gi < n; gi++) if (!Number.isFinite(groups[gi].key)) { cursor += SLOT_W; pos[gi] = cursor }
    return { groupPositions: pos, breakIdx: breaks.map(i => back[i]) }
  }, [groups, scale])

  const groupX = (gi: number) => groupPositions[gi] ?? 0

  /** 被压缩空档的真实跨度（用两端事件的日期算） */
  const breakTooltip = (bi: number): string => {
    const a = groups[bi]?.items[groups[bi].items.length - 1]
    const b = groups[bi + 1]?.items[0]
    if (!a || !b) return '此处空档已压缩'
    const days = a.calName === b.calName ? storySpanDays(calendarRule, a.time, b.time) : null
    if (days !== null && days > 0) return `此处空档约 ${formatDurationHuman(days, calendarRule)}（已压缩，非按比例）`
    return `此处空档跨度较大（${a.calName ? a.calName + ' ' : ''}${a.time || '时间未定'} → ${b.calName ? b.calName + ' ' : ''}${b.time || '时间未定'}），已压缩`
  }
  const breakText = (bi: number): string => {
    const a = groups[bi]?.items[groups[bi].items.length - 1]
    const b = groups[bi + 1]?.items[0]
    if (!a || !b) return '⟋⟋'
    const days = a.calName === b.calName ? storySpanDays(calendarRule, a.time, b.time) : null
    return days !== null && days > 0 ? `⟋⟋ ${formatDurationHuman(days, calendarRule)}` : '⟋⟋ 跨度较大'
  }

  const dotsWithTail = useMemo(() => {
    const pts = groups
      .map((g, gi) => ({ key: g.key, x: groupPositions[gi] ?? 0 }))
      .filter(p => Number.isFinite(p.key))
    if (pts.length === 0) return pts
    const last = pts[pts.length - 1]
    return [...pts, { key: last.key + 1e9, x: last.x + SLOT_W }]
  }, [groups, groupPositions])

  /**
   * 时段（线条几何，不含 y —— y 依赖泳道高，泳道高依赖本表，解掉这个环在渲染处落 y）：
   * 同起点多条线条按**全局组内序 j** 换色 + 下移（同一天、结束不同的多张卡各有自己的线条）。
   */
  const spans = useMemo(() => {
    const out: { id: string; gi: number; j: number; x0: number; right: number; neg: boolean; label: string; track: string }[] = []
    groups.forEach((g, gi) => {
      const x0 = groupPositions[gi] ?? 0
      g.items.forEach((d, j) => {
        if (d.span === null || d.span === 0) return
        const endKey = d.key - storyDateKey(d.time) + storyDateKey(d.end)
        const rawEnd = interpolateX(dotsWithTail, endKey)
        if (rawEnd === null) return
        const lo = Math.min(x0, rawEnd)
        const hi = Math.max(x0, rawEnd)
        const right = Math.max(hi, lo + 24)
        out.push({
          id: d.id, gi, j, x0, right,
          neg: d.span < 0,
          label: `${formatStoryRange(d.time, d.end)}（持续 ${formatSpanDays(Math.abs(d.span))}）`,
          track: d.track,
        })
      })
    })
    // 贪心着色：**按泳道独立** —— 不同泳道的线条本来就分行，无需互相区分；
    // 同一泳道内相互重叠的线段拿到不同颜色（同时间点跨轨道的多条线各自在自己的泳道，色号允许重置）
    const colors = new Map<string, number>()
    for (const t of TRACK_ORDER) {
      const laneGeo = out.filter(x => x.track === t)
      const idxs = assignOverlapColors(laneGeo.map(x => ({ x0: Math.min(x.x0, x.right), right: Math.max(x.x0, x.right) })))
      laneGeo.forEach((x, i) => { colors.set(x.id, idxs[i] ?? 0) })
    }
    return out.map(x => ({ ...x, colorIdx: colors.get(x.id) ?? 0 }))
  }, [groups, dotsWithTail, groupPositions])

  /**
   * 泳道**动态高度**（2.4.4 三次定版：持续线条画在轴**上方**）：
   * 每条泳道 = 上部线条区（最深分层线）+ 轴 + 下部卡片竖堆。
   * 之前固定 LANE_H，同一天三章竖排就直接溢出到下一条泳道了。
   */
  const laneBracketSpace = useMemo(() => visibleTracks.map(t => {
    const laneSpans = spans.filter(s => s.track === t)
    const maxJ = laneSpans.length ? Math.max(...laneSpans.map(s => s.j)) : -1
    return maxJ >= 0 ? BRACKET_DEPTH + maxJ * BRACKET_STEP + 8 : 8
  }), [visibleTracks, spans])
  const laneHeights = useMemo(() => visibleTracks.map((t, idx) => {
    let stack = 1
    for (const g of groups) {
      const cnt = g.items.filter(d => d.track === t).length
      if (cnt > stack) stack = cnt
    }
    return Math.max(LANE_MIN_H, laneBracketSpace[idx] + LANE_AXIS_OFFSET + stack * CARD_MAX_H + 12)
  }), [visibleTracks, groups, laneBracketSpace])

  /** 泳道轴线的 y：各泳道高度累加；轴线在本泳道「上部线条区」之下 */
  const laneY = (idx: number) => {
    const base = laneHeights.slice(0, idx).reduce((a, b) => a + b, 0)
    return TOP + base + laneBracketSpace[idx]
  }
  /** 泳道顶（背景分隔的 top） */
  const laneTop = (idx: number) => {
    const base = laneHeights.slice(0, idx).reduce((a, b) => a + b, 0)
    return TOP + base
  }

  const calLegend = [...calendars].sort((a, b) => a.value - b.value)
    .map(c => `${c.name}(${c.value})`).join(' → ')

  if (data.length === 0) {
    return (
      <div className="p-10 text-center text-ink-400 text-sm">
        <Calendar size={32} className="mx-auto mb-2 text-ink-600" />
        暂无时间线数据。请先在「表格视图」中逐章登记（含「历法」与「发生时间」），切换回「时间轴视图」即可看到。
      </div>
    )
  }

  const totalW = groupPositions.length
    ? groupPositions[groupPositions.length - 1] + SLOT_W / 2 + 20
    : SLOT_W
  const totalH = TOP * 2 + laneHeights.reduce((a, b) => a + b, 0)

  const detail = (e: Evt) =>
    ([
      e.chapter && ['章节号', e.chapter],
      e.track && ['线 / 轨道', e.track],
      e.calName && ['历法', e.calName],
      e.time && ['发生时间', e.time],
      e.end && ['结束时间', e.end],
      (e.span !== null && e.span !== 0) && ['持续时长', `${formatSpanDays(e.span)}${e.span < 0 ? '（结束早于开始，请核对）' : ''}`],
      e.season && ['时节 / 季节', e.season],
      e.realm && ['主角当前境界 / 年龄', e.realm],
      e.location && ['重要人物位置与状态', e.location],
      e.event && ['本章关键事件', e.event],
      e.check && ['时间线检查', e.check],
      e.remark && ['备注', e.remark],
    ].filter(Boolean) as [string, string][])

  const visibleItems = data.filter(d => !hiddenTracks.has(d.track))

  return (
    <div className="page-enter">
      {/* 无环校验提示：检测到时间倒流时给出非阻断告警 */}
      {regressed.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-12 text-rose-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">时间线无环校验：</span>
            检测到 <span className="text-rose-200 font-semibold">{regressed.length}</span> 处「时间倒流」（本章发生时间早于其前序事件）。
            可能是有意倒叙，也可能是连续性漏洞，建议在「表格视图」核对相关章节的「发生时间」与「时间线检查」。
          </div>
        </div>
      )}
      {/* 工具条 */}
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <div className="text-12 text-ink-400">
          共 <span className="text-amber font-semibold">{data.length}</span> 章
          {calLegend && <>，历法顺序：<span className="text-ink-200">{calLegend}</span></>}
        </div>
        <span className="text-10 text-ink-500">
          （同一发生时间的章节共用一个圆点、卡片竖排；持续时段用彩色线条标在泳道轴上方，线条颜色与卡片左缘色条对应）
        </span>
        <div className="flex items-center gap-1">
          <span className="text-11 text-ink-500 mr-1">间距：</span>
          {([['even', '等距'], ['proportional', '按时间']] as const).map(([v, label]) => (
            <Button variant="toggle" selected={scale === v}
              key={v}
              onClick={() => setScale(v)}
              className="py-0.5 rounded-md border hover:text-ink-200"
              title={v === 'proportional' ? '按真实时间差排布；超长空档会自动压缩并以 ⟋⟋ 标出' : '所有时间点等距排列'}
            >
              {label}
            </Button>
          ))}
        </div>
        {scale === 'proportional' && breakIdx.length > 0 && (
          <span className="text-10 text-amber/80">已压缩 {breakIdx.length} 处超长空档</span>
        )}
        <div className="flex items-center gap-1.5 ml-auto flex-wrap">
          <span className="text-11 text-ink-500 mr-1 inline-flex items-center gap-1">
            <Layers size={11} /> 轨道：
          </span>
          {allTracks.map(t => {
            const idx = allTracks.indexOf(t)
            const color = COLORS[idx % COLORS.length]
            const hidden = hiddenTracks.has(t)
            return (
              <Button variant="bare"
                key={t}
                onClick={() => setHiddenTracks(prev => {
                  const next = new Set(prev)
                  if (next.has(t)) next.delete(t); else next.add(t)
                  return next
                })}
                className={`px-2.5 py-0.5 rounded-md text-11 border transition-colors inline-flex items-center gap-1
                  ${hidden ? 'bg-ink-800 text-ink-600 border-ink-700 line-through'
                    : `bg-ink-800 ${color.text} border-ink-700 hover:border-ink-600`}`}
              >
                <span className={`w-2 h-2 rounded-full ${color.dot}`} /> {t}
              </Button>
            )
          })}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-11 text-ink-500 mr-1">核对状态：</span>
          {(['all', '正常', '已修正', '待核对'] as const).map(s => (
            <Button variant="toggle" selected={filterStatus === s}
              key={s}
              onClick={() => setFilterStatus(s)}
              className="py-0.5 rounded-md border hover:text-ink-200"
            >
              {s === 'all' ? '全部' : s}
            </Button>
          ))}
        </div>
      </div>

      {visibleTracks.length === 0 ? (
        <div className="p-8 text-center text-ink-400 text-sm">已隐藏全部轨道，请点击上方轨道名恢复显示。</div>
      ) : (
        /* 多泳道：左列固定轨道标签（不横向滚动），右侧画布按故事时间顺序轴横滚 */
        <div className="flex overflow-auto rounded-xl border border-ink-700 bg-ink-900/40" style={{ maxHeight: totalH + 60 }}>
          {/* 左：泳道标签列 */}
          <div className="shrink-0 bg-ink-900/80 border-r border-ink-700" style={{ width: LANE_LABEL_W }}>
            <div style={{ height: TOP }} />
            {visibleTracks.map((t, idx) => {
              const color = COLORS[idx % COLORS.length]
              return (
                <div key={t} className="flex items-start gap-1.5 px-2 pt-2" style={{ height: laneHeights[idx] }}>
                  <span className={`mt-1 w-[3px] h-3.5 rounded-full shrink-0 ${color.dot}`} />
                  <span className={`text-11 font-semibold ${color.text} leading-tight`}>{t}</span>
                </div>
              )
            })}
          </div>
          {/* 右：可横向滚动的时间轴画布 */}
          <div className="relative flex-1 overflow-x-auto">
            <div className="relative" style={{ width: totalW, height: totalH }}>
              {/* 泳道背景分隔（高度 = 各泳道动态高） */}
              {visibleTracks.map((t, idx) => (
                <div
                  key={`lane-${t}`}
                  className={`absolute left-0 right-0 border-b border-ink-700/60 ${idx % 2 === 0 ? 'bg-ink-850/25' : ''}`}
                  style={{ top: laneTop(idx), height: laneHeights[idx] }}
                />
              ))}
              {/* 各泳道的水平轴线 + 时长线条 */}
              <svg className="absolute inset-0" width={totalW} height={totalH} style={{ zIndex: 0, overflow: 'visible' }}>
                {/* 轴体升级（2026-10-02）：底层浅色宽带 + 上层亮线 + 时间刻度 —— 与历史事件轴同一套语言 */}
                {visibleTracks.map((t, idx) => (
                  <line
                    key={`axis-band-${t}`}
                    x1={8} y1={laneY(idx)} x2={totalW - 8} y2={laneY(idx)}
                    style={{ stroke: 'rgb(var(--ink-600) / 0.16)' }} strokeWidth={8} strokeLinecap="round"
                  />
                ))}
                {visibleTracks.map((t, idx) => (
                  <line
                    key={`axis-${t}`}
                    x1={8} y1={laneY(idx)} x2={totalW - 8} y2={laneY(idx)}
                    style={{ stroke: 'rgb(var(--ink-500) / 0.55)' }} strokeWidth={2} strokeLinecap="round"
                  />
                ))}
                {groups.map((g, gi) => visibleTracks.map(t => {
                  const idx = visibleTracks.indexOf(t)
                  if (!g.items.some(d => d.track === t)) return null
                  return (
                    <line key={`tick-${gi}-${t}`} x1={groupX(gi)} y1={laneY(idx) - 6} x2={groupX(gi)} y2={laneY(idx) + 6}
                      style={{ stroke: 'rgb(var(--ink-400) / 0.4)' }} strokeWidth={1} />
                  )
                }))}
                {/* 等比模式：被压缩的超长空档 —— 每条泳道的轴上画断裂符 ⟋⟋（时间轴共享，各泳道一致）；
                    文字标注只画在第一条泳道上，避免多泳道重复刷屏 */}
                {breakIdx.map(bi => {
                  const xm = (groupX(bi) + groupX(bi + 1)) / 2
                  const txt = breakText(bi)
                  const w = txt.length * 6 + 12
                  return visibleTracks.map((t, idx) => (
                    <g key={`brk-${bi}-${t}`}>
                      <title>{breakTooltip(bi)}</title>
                      <path
                        d={`M ${xm - 6} ${laneY(idx) + 6} L ${xm + 0.5} ${laneY(idx) - 6} M ${xm - 0.5} ${laneY(idx) + 6} L ${xm + 6} ${laneY(idx) - 6}`}
                        fill="none" style={{ stroke: 'rgb(var(--graph-accent))' }} strokeWidth={1.4} strokeLinecap="round" pointerEvents="none"
                      />
                      {idx === 0 && (
                        <>
                          <rect x={xm - w / 2} y={laneY(0) - 21} width={w} height={12} rx={4} style={{ fill: 'rgb(var(--ink-900) / 0.85)' }} pointerEvents="none" />
                          <text x={xm} y={laneY(0) - 11.5} textAnchor="middle" fontSize={8.5} style={{ fill: 'rgb(var(--ink-300))' }} pointerEvents="none">{txt}</text>
                        </>
                      )}
                      <rect x={xm - 12} y={laneY(idx) - 16} width={24} height={30} fill="transparent" style={{ cursor: 'help' }} />
                    </g>
                  ))
                })}
                {visibleItems.map(d => {
                  const s = spans.find(x => x.id === d.id)
                  if (!s) return null
                  const idx = visibleTracks.indexOf(s.track)
                  const on = hover === d.id || selected?.id === d.id
                  const color = COLORS[s.colorIdx % COLORS.length]
                  const path = spanLinePath(s.x0, s.right, laneY(idx), BRACKET_DEPTH + s.j * BRACKET_STEP, 'up')
                  return (
                    <path
                      key={`bk-${d.id}`}
                      d={path}
                      fill="none"
                      className={s.neg ? 'stroke-rose-400' : color.stroke}
                      strokeWidth={on ? 2.5 : 2}
                      strokeOpacity={on ? 0.95 : 0.6}
                      strokeLinecap="round"
                      style={{ cursor: 'pointer' }}
                      onClick={() => setSelected(d)}
                      onMouseEnter={() => setHover(d.id)}
                      onMouseLeave={() => setHover(null)}
                    >
                      <title>{s.label}</title>
                    </path>
                  )
                })}
              </svg>

              {/* 事件卡片：同一发生时间一组、竖向堆叠；左缘色条与该事件的线条同色 */}
              {groups.map((g, gi) => visibleTracks.map(t => {
                const items = g.items.filter(d => d.track === t)
                if (items.length === 0) return null
                const idx = visibleTracks.indexOf(t)
                // 线条已移到轴上方，卡片堆统一挂轴下 10px（对应关系靠同色色条）
                const top = laneY(idx) + 10
                return (
                  <div
                    key={`stack-${gi}-${t}`}
                    className="absolute flex flex-col gap-2"
                    style={{
                      left: Math.min(Math.max(groupX(gi) - CARD_W / 2, 4), Math.max(4, totalW - CARD_W - 4)),
                      top,
                      width: CARD_W, zIndex: 10,
                    }}
                  >
                    {items.map(d => {
                      const sp = spans.find(x => x.id === d.id)
                      const color = sp ? COLORS[sp.colorIdx % COLORS.length] : null
                      const active = hover === d.id || selected?.id === d.id
                      return (
                        <div key={d.id} className={`border-l-4 ${color ? color.bar : 'border-ink-600'}`}
                          onMouseEnter={() => setHover(d.id)}
                          onMouseLeave={() => setHover(null)}
                        >
                          <div
                            onClick={() => setSelected(d)}
                            className={`bg-ink-850 border border-l-0 rounded-lg p-2.5 cursor-pointer transition-all relative
                              ${regressed.includes(d.id) ? 'border-rose-500/60 ring-2 ring-rose-500/30'
                                : active && color ? `${color.ring} ring-2 border-amber/40` : 'border-ink-700 hover:border-ink-600'}`}
                          >
                            {regressed.includes(d.id) && (
                              <span className="absolute -top-1.5 -right-1.5 flex items-center gap-0.5 px-1 py-0.5 rounded-full bg-rose-500 text-white text-9 font-bold shadow" title="时间倒流：发生时间早于前序事件">
                                <AlertTriangle size={8} /> 倒流
                              </span>
                            )}
                            <div className={`text-10 ${color ? color.text : 'text-ink-300'} font-semibold mb-0.5 flex items-center gap-1`}>
                              <Calendar size={9} /> {d.time ? rangeLabel(d, d.calName) : '时间未定'}
                            </div>
                            {/* 持续时长：填反了也照实显示并标红（设定冲突，不静默纠正） */}
                            {d.span !== null && d.span !== 0 && (
                              <div className={`mt-0.5 text-10 flex items-center gap-1 ${d.span < 0 ? 'text-rose-300' : 'text-ink-400'}`}>
                                <AlarmClock size={9} />
                                {d.span < 0 ? `结束早于开始 ${formatSpanDays(Math.abs(d.span))}（请核对）` : `持续 ${formatSpanDays(d.span)}`}
                              </div>
                            )}
                            <div className="text-12 text-ink-100 font-semibold leading-snug line-clamp-2">
                              {d.chapter ? `${d.chapter} ` : ''}{d.title || '（未命名章节）'}
                            </div>
                            {d.event && (
                              <div className="mt-1 text-10 text-ink-400 line-clamp-2">{d.event}</div>
                            )}
                            {d.check && (
                              <div className="mt-1.5">
                                <span className={`text-9 px-1.5 py-0.5 rounded ${CHECK_STYLE[d.check] ?? 'bg-ink-700 text-ink-300'}`}>{d.check}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              }))}

              {/* 时间点圆点（每组 × 每个有事件的泳道一个，落在该泳道轴线上） */}
              {groups.map((g, gi) => visibleTracks.map(t => {
                if (!g.items.some(d => d.track === t)) return null
                const idx = visibleTracks.indexOf(t)
                const active = g.items.some(d => d.track === t && (hover === d.id || selected?.id === d.id))
                return (
                  <div
                    key={`dot-${gi}-${t}`}
                    className={`absolute rounded-full bg-amber ring-4 ring-ink-900 transition-all ${active ? 'scale-125' : ''}`}
                    style={{ left: groupX(gi) - POINT_R, top: laneY(idx) - POINT_R, width: POINT_R * 2, height: POINT_R * 2, zIndex: 11 }}
                  />
                )
              }))}
            </div>
          </div>
        </div>
      )}

      {/* 章节详情弹窗 */}
      {selected && (
        <Modal open onClose={() => setSelected(null)} hideHeader width={480} maxHeight="85vh" bodyClassName="!p-0">
          {/* 🔴 2.4.4 六维审计：Modal 的 body 不是 flex 容器 —— 自绘头部必须自带 flex 行（同 HistoryTimeline） */}
          <div className="flex items-start gap-2 p-3">
              <div className="flex-1 min-w-0">
                <div className="text-10 text-amber font-semibold mb-0.5">
                  {selected.time ? rangeLabel(selected, selected.calName) : '时间未定'}
                  {selected.calName && <span className="text-ink-500"> · {selected.calName}</span>}
                </div>
                <h3 className="text-16 font-semibold text-ink-50 leading-snug">
                  {selected.chapter ? `${selected.chapter} ` : ''}{selected.title || '（未命名章节）'}
                </h3>
              </div>
              <Button variant="bare" iconOnly size="xs"
                title="关闭详情"
onClick={() => setSelected(null)}
                className="shrink-0 rounded-lg p-1 text-ink-500 hover:text-ink-200 hover:bg-ink-700 transition-colors"
              ><X size={16} /></Button>
          </div>
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
