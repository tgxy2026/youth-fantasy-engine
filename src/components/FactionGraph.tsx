import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { getCardRecords } from '../lib/db'
import type { TableRow } from '../lib/types'
import { Network, Users, X, ArrowUpRight } from 'lucide-react'
import { Button } from './Button'

interface Props {
  rows: TableRow[]
  onNavigate?: (tabId: string) => void
}

const REL_COLORS: Record<string, string> = {
  '同盟': '#34d399',
  '敌对': '#fb7185',
  '贸易': '#fbbf24',
  '从属': '#818cf8',
  '中立': '#94a3b8',
}
const REL_ORDER = ['同盟', '敌对', '贸易', '从属', '中立']

/** 扩展色板：作者自定义关系类型（如"联姻""宿敌"）按名称哈希稳定取色，与边同色 */
const REL_EXTRA = [
  '#60a5fa', '#f472b6', '#2dd4bf', '#fb923c', '#a78bfa', '#f87171',
  '#4ade80', '#c084fc', '#38bdf8', '#facc15', '#fb7185', '#34d399',
]
function relColor(t: string): string {
  if (REL_COLORS[t]) return REL_COLORS[t]
  let h = 0
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0
  return REL_EXTRA[h % REL_EXTRA.length]
}
const W = 900
const H = 600

interface FNode { name: string; x: number; y: number; degree: number }
interface FEdge { a: string; b: string; type: string; id: string }

/**
 * 势力关系力导向图（Phase 2）：节点 = 《国家势力》中的势力，边 = 《势力关系》表登记的
 * 同盟/敌对/贸易/从属/中立。点击节点展开右侧面板，列出「所属势力」=该势力的角色卡成员
 * （直接消费角色卡 ↔ 国家势力的 tableRef 联动）。节点可跳转《国家势力》。
 */
export default function FactionGraph({ rows, onNavigate }: Props) {
  const [hover, setHover] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const [dragged, setDragged] = useState<Map<string, { x: number; y: number }>>(new Map())
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{
    kind: 'node' | 'pan'
    name?: string
    sx: number
    sy: number
    origView: { x: number; y: number; k: number }
    origNode?: { x: number; y: number }
    moved: boolean
  } | null>(null)

  const { nodes, edges, init } = useMemo(() => {
    const adj = new Map<string, { degree: number; edges: FEdge[] }>()
    const ensure = (n: string) => {
      if (!adj.has(n)) adj.set(n, { degree: 0, edges: [] })
      return adj.get(n)!
    }
    rows.forEach(r => {
      const a = (r.data['势力A'] || '').trim()
      const b = (r.data['势力B'] || '').trim()
      const type = r.data['关系类型'] || '中立'
      if (!a && !b) return
      if (a) ensure(a).degree++
      if (b && b !== a) ensure(b).degree++
      if (a && b) ensure(a).edges.push({ a, b, type, id: r.id })
    })
    const names = [...adj.keys()]
    const n = names.length
    const pos = new Map<string, { x: number; y: number }>()
    const radius = Math.min(W, H) * 0.36
    names.forEach((nm, i) => {
      const ang = (i / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2
      pos.set(nm, { x: W / 2 + Math.cos(ang) * radius, y: H / 2 + Math.sin(ang) * radius })
    })
    const nodeList: FNode[] = names.map(nm => ({
      name: nm,
      x: pos.get(nm)!.x,
      y: pos.get(nm)!.y,
      degree: adj.get(nm)!.degree,
    }))
    const allEdges: FEdge[] = names.flatMap(nm => adj.get(nm)!.edges)
    return { nodes: nodeList, edges: allEdges, init: pos }
  }, [rows])

  // 成员角色：消费角色卡「所属势力」联动（手输没了，归属准确率 100%）
  const [members, setMembers] = useState<{ name: string; type: string; role: string }[]>([])
  useEffect(() => {
    if (!selected) {
      setMembers([])
      return
    }
    let alive = true
    const tabs = [
      { id: 'char-main', label: '主要角色' },
      { id: 'char-secondary', label: '次要角色' },
      { id: 'char-npc', label: 'NPC角色' },
    ]
    Promise.all(tabs.map(t => getCardRecords(t.id))).then(lists => {
      if (!alive) return
      const out: { name: string; type: string; role: string }[] = []
      lists.forEach((recs, i) => {
        recs.forEach(rec => {
          for (const [k, v] of Object.entries(rec.data)) {
            if (k.endsWith('所属势力') && (v || '').trim() === selected) {
              let role = ''
              for (const [k2, v2] of Object.entries(rec.data)) {
                if (k2.endsWith('身份定位') || k2.endsWith('身份')) {
                  role = (v2 || '').trim()
                  break
                }
              }
              out.push({ name: rec.name, type: tabs[i].label, role })
              break
            }
          }
        })
      })
      setMembers(out)
    })
    return () => {
      alive = false
    }
  }, [selected])

  // 滚轮缩放
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      setView(v => {
        const k = Math.min(3, Math.max(0.4, v.k * (e.deltaY < 0 ? 1.1 : 0.9)))
        const wx = (mx - v.x) / v.k
        const wy = (my - v.y) / v.k
        return { k, x: mx - wx * k, y: my - wy * k }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: ReactPointerEvent, name?: string) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragRef.current = {
      kind: name ? 'node' : 'pan',
      name,
      sx: e.clientX,
      sy: e.clientY,
      origView: { ...view },
      origNode: name ? dragged.get(name) ?? init.get(name)! : undefined,
      moved: false,
    }
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true
    if (d.kind === 'pan') {
      setView(v => ({ ...v, x: d.origView.x + dx, y: d.origView.y + dy }))
    } else if (d.name && d.origNode) {
      const wx = dx / view.k
      const wy = dy / view.k
      setDragged(m => new Map(m).set(d.name!, { x: d.origNode!.x + wx, y: d.origNode!.y + wy }))
    }
  }
  const onPointerUp = () => {
    const d = dragRef.current
    dragRef.current = null
    if (d?.kind === 'node' && d.name && !d.moved) {
      const name = d.name
      setSelected(sel => (sel === name ? null : name))
    }
  }

  const posOf = (nm: string) => dragged.get(nm) ?? init.get(nm)!

  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] text-ink-500 gap-2">
        <Network size={32} className="opacity-40" />
        <div className="text-[13px]">暂无势力关系</div>
        <div className="text-[11px] text-ink-600">请在表格登记 势力A / 势力B / 关系类型，图谱会自动生成</div>
      </div>
    )
  }

  return (
    <div className="relative w-full h-[68vh] bg-ink-900 rounded-xl border border-ink-700 overflow-hidden">
      <svg
        ref={svgRef}
        className="w-full h-full touch-none cursor-grab active:cursor-grabbing select-none"
        onPointerDown={e => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <defs>
          <pattern id="fg-dots" width="22" height="22" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="#2a2620" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#fg-dots)" />
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* 边 */}
          {edges.map(e => {
            const pa = posOf(e.a)
            const pb = posOf(e.b)
            if (!pa || !pb) return null
            const mx = (pa.x + pb.x) / 2
            const my = (pa.y + pb.y) / 2
            const color = relColor(e.type)
            const active = hover === e.a || hover === e.b || selected === e.a || selected === e.b
            return (
              <g key={e.id}>
                <path
                  d={`M ${pa.x} ${pa.y} Q ${mx} ${my - 28} ${pb.x} ${pb.y}`}
                  fill="none"
                  stroke={color}
                  strokeWidth={active ? 3 : 1.6}
                  strokeOpacity={active ? 0.95 : 0.55}
                />
                <text x={mx} y={my - 32} textAnchor="middle" className="fill-ink-300" style={{ fontSize: 11 }}>
                  {e.type}
                </text>
              </g>
            )
          })}
          {/* 节点 */}
          {nodes.map(nd => {
            const pa = posOf(nd.name)
            const isSel = selected === nd.name
            const isHov = hover === nd.name
            const r = 14 + Math.min(nd.degree, 8) * 2.2
            const color = isSel ? '#f59e0b' : isHov ? '#fbbf24' : '#d6c7a1'
            return (
              <g
                key={nd.name}
                transform={`translate(${pa.x},${pa.y})`}
                onPointerDown={e => {
                  e.stopPropagation()
                  onPointerDown(e, nd.name)
                }}
                onPointerEnter={() => setHover(nd.name)}
                onPointerLeave={() => setHover(h => (h === nd.name ? null : h))}
                className="cursor-pointer"
              >
                <circle r={r} fill="#1c1916" stroke={color} strokeWidth={isSel ? 3 : 2} />
                <circle r={r * 0.42} fill={color} />
                <text
                  y={r + 14}
                  textAnchor="middle"
                  className="fill-ink-100"
                  style={{ fontSize: 12, fontWeight: isSel ? 700 : 400 }}
                >
                  {nd.name}
                </text>
              </g>
            )
          })}
        </g>
      </svg>

      {/* 图例：系统预设关系类型 + 作者自定义关系类型（自定义标"自定义"） */}
      <div className="absolute left-3 top-3 flex flex-wrap gap-2 max-w-[70%] bg-ink-850/80 backdrop-blur rounded-lg px-2.5 py-1.5 border border-ink-700">
        {(() => {
          const present = [...new Set(edges.map(e => e.type))]
          const ordered = [
            ...REL_ORDER.filter(t => present.includes(t)),
            ...present.filter(t => !REL_COLORS[t]),
          ]
          return ordered.map(t => (
            <span key={t} className="flex items-center gap-1 text-[11px] text-ink-300">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: relColor(t) }} />
              {t}
              {!REL_COLORS[t] && <span className="text-[9px] text-ink-500 bg-ink-900 px-1 rounded leading-none">自定义</span>}
            </span>
          ))
        })()}
      </div>

      {/* 缩放提示 */}
      <div className="absolute right-3 top-3 text-[10px] text-ink-500 bg-ink-850/70 rounded px-2 py-0.5">
        滚轮缩放 · 拖拽平移/移动节点
      </div>

      {/* 右侧成员面板 */}
      {selected && (
        <div className="absolute right-3 top-12 bottom-3 w-64 bg-ink-850/95 backdrop-blur rounded-xl border border-ink-700 p-3 overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[13px] font-semibold text-amber">{selected}</div>
            <Button variant="icon-muted" onClick={() => setSelected(null)}>
              <X size={16} />
            </Button>
          </div>
          <Button variant="bare"
            onClick={() => onNavigate?.('nations')}
            className="text-[11px] text-sky-400 hover:text-sky-300 mb-3 inline-flex items-center gap-1"
          >
            <ArrowUpRight size={11} /> 在《国家势力》查看
          </Button>
          <div className="text-[11px] text-ink-400 mb-1.5 flex items-center gap-1">
            <Users size={11} /> 所属成员（{members.length}）
          </div>
          {members.length === 0 ? (
            <div className="text-[11px] text-ink-600">暂无角色卡将「所属势力」设为 {selected}</div>
          ) : (
            <div className="space-y-1.5">
              {members.map((m, i) => (
                <div key={i} className="bg-ink-800 rounded-lg px-2 py-1.5">
                  <div className="text-[12px] text-ink-100">{m.name}</div>
                  <div className="text-[10px] text-ink-500">
                    {m.type}
                    {m.role ? ' · ' + m.role : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
