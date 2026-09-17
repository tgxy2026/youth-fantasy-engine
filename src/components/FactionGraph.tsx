import { useEffect, useMemo, useState } from 'react'
import { getCardRecords } from '../lib/db'
import type { TableRow } from '../lib/types'
import { Network, Users, X, ArrowUpRight } from 'lucide-react'
import { Button } from './Button'
import { useSvgPanZoom } from '../lib/useSvgPanZoom'
import { foldVh } from '../lib/theme'

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

  // 平移 / 缩放 / 节点拖拽统一走公共 hook（2026-09-14 审计 P1-4）。
  // ⚠️ 本次迁移带来三处**行为变化**（统一到更稳妥的一套，详见 useSvgPanZoom 注释）：
  //    ① 节点拖拽新增画布边界钳制（此前不钳制，节点可被拖出视野后「消失」）；
  //    ② 滚轮缩放由阶梯步进（±10%）改为平滑指数，触控板手感更连续；
  //    ③ 点击判定由曼哈顿距离改为欧氏距离，斜向轻拖不再被误判为拖动。
  const { view, dragged, svgRef, onPointerDown, onPointerMove, onPointerUp } = useSvgPanZoom({
    world: { w: W, h: H, pad: 30 },
    reattachKey: rows,
    onNodeClick: name => setSelected(sel => (sel === name ? null : name)),
  })

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

  // 滚轮缩放 / 拖拽平移 / 节点拖拽均由 useSvgPanZoom 提供，此处不再重复实现

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
    <div className="relative w-full bg-ink-900 rounded-xl border border-ink-700 overflow-hidden" style={{ height: foldVh('68vh') }}>
      <svg
        ref={svgRef}
        className="w-full h-full touch-none cursor-grab active:cursor-grabbing select-none"
        onPointerDown={e => onPointerDown(e, 'pan')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <defs>
          <pattern id="fg-dots" width="22" height="22" patternUnits="userSpaceOnUse">
            {/* 主题化网格。此处原为实心 #2a2620；统一改用与关系图谱相同的网格变量并补 0.28 透明度，
                暗色下实际渲染差值约 2%（肉眼无感），换来两图风格一致 + 浅色主题下可见。 */}
            <circle cx="1" cy="1" r="1" style={{ fill: 'rgb(var(--graph-grid))' }} opacity="0.28" />
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
            // 主题化的选中/悬停/常态三态色（含 var()，故下游用 style 而非表现属性）
            const color = isSel ? 'rgb(var(--graph-accent-strong))' : isHov ? 'rgb(var(--graph-accent))' : 'rgb(var(--graph-label))'
            // 注：hook 内部已对 'node' 做 stopPropagation（避免同时触发背景平移），此处不必重复
            return (
              <g
                key={nd.name}
                transform={`translate(${pa.x},${pa.y})`}
                onPointerDown={e => onPointerDown(e, 'node', nd.name, posOf(nd.name))}
                onPointerEnter={() => setHover(nd.name)}
                onPointerLeave={() => setHover(h => (h === nd.name ? null : h))}
                className="cursor-pointer"
              >
                <circle r={r} style={{ fill: 'rgb(var(--graph-node))', stroke: color }} strokeWidth={isSel ? 3 : 2} />
                <circle r={r * 0.42} style={{ fill: color }} />
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
