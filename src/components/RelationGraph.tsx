import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as RPointerEvent } from 'react'
import { RotateCcw, EyeOff, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'
import type { TableRow } from '../lib/types'
import { Button } from './Button'

interface Props {
  rows: TableRow[]
}

interface Node { name: string; x: number; y: number; degree: number }
interface Edge { a: string; b: string; type: string }

const W = 1000
const H = 640

/** 关系类型 → 线色（内置常见 8 类用精调色，与 ink/amber 主题协调） */
const TYPE_COLORS: Record<string, string> = {
  '亲属': '#f0a4a4',
  '师徒': '#8fd0c4',
  '盟友': '#8fb4e8',
  '敌对': '#e57070',
  '竞争': '#e8b36a',
  'CP感情线': '#e894c0',
  '主仆': '#a9a4f0',
  '恩怨': '#e57070',
}

/** 扩展色板：作者可自定义关系类型，未收录类型按名称哈希稳定取色（同类同色、异类尽量异色） */
const EXTRA_PALETTE = [
  '#e8918f', '#8fc8a9', '#8fb4e8', '#e8b36a', '#c894e8', '#e894c0',
  '#8fd0d6', '#a9c48f', '#e8a48f', '#9fb0e8', '#d6a06a', '#a89fe8',
  '#7fc9c0', '#c9b48f', '#e88fb4', '#8fd0a9',
]
function edgeColor(t: string): string {
  if (TYPE_COLORS[t]) return TYPE_COLORS[t]
  let h = 0
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0
  return EXTRA_PALETTE[h % EXTRA_PALETTE.length]
}

/**
 * 人物关系力导向图（v1.6 视觉重构）
 * - 力导向初始布局（确定性收敛，纯 SVG 无外部依赖）
 * - 交互：拖动节点微调布局；拖拽空白处平移画布；滚轮缩放；点击节点收起/展开（与拖动按位移阈值区分）
 * - 视觉：弧线边按关系类型着色、节点径向渐变+投影、名称药丸底、关系类型徽标、点阵背景、图例
 */
export default function RelationGraph({ rows }: Props) {
  const [hover, setHover] = useState<string | null>(null)
  // v1.3：收起（折叠）节点 —— 点击某人物可隐藏其本人与所有关系边，便于在超大关系网里聚焦
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // 画布视图变换：平移 + 缩放
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  // 节点拖拽后的位置覆盖（name -> 世界坐标），未拖过的节点用初始力导向布局坐标
  const [dragged, setDragged] = useState<Map<string, { x: number; y: number }>>(new Map())
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{
    kind: 'node' | 'pan'
    name?: string
    startSX: number
    startSY: number
    origView: { x: number; y: number; k: number }
    origNode?: { x: number; y: number }
    moved: boolean
  } | null>(null)

  const { nodes, edges, init } = useMemo(() => {
    const adj = new Map<string, { degree: number; edges: Edge[] }>()
    const ensure = (n: string) => {
      if (!adj.has(n)) adj.set(n, { degree: 0, edges: [] })
      return adj.get(n)!
    }
    for (const r of rows) {
      const a = (r.data['人物A'] || '').trim()
      const b = (r.data['人物B'] || '').trim()
      if (!a && !b) continue
      if (a) ensure(a).degree++
      if (b && b !== a) ensure(b).degree++
      if (a && b) ensure(a).edges.push({ a, b, type: r.data['关系类型'] || '关系' })
    }
    // 取度数最高的前 80 个节点，避免超大图卡顿
    let names = [...adj.keys()].sort((x, y) => adj.get(y)!.degree - adj.get(x)!.degree)
    if (names.length > 80) names = names.slice(0, 80)
    const subAdj = new Map(names.map(n => [n, adj.get(n)!]))
    const allEdges = names.flatMap(n => subAdj.get(n)!.edges)
    const n = names.length
    const k = Math.sqrt((W * H) / Math.max(n, 1))
    const pos = new Map<string, { x: number; y: number }>()
    names.forEach((nm, i) => {
      const ang = (i / Math.max(n, 1)) * Math.PI * 2
      pos.set(nm, { x: W / 2 + Math.cos(ang) * (W / 3), y: H / 2 + Math.sin(ang) * (H / 3) })
    })
    let temp = W / 8
    const disp = new Map<string, { x: number; y: number }>()
    for (let iter = 0; iter < 320; iter++) {
      for (const nm of names) disp.set(nm, { x: 0, y: 0 })
      // 斥力
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const u = names[i], v = names[j]
          const pu = pos.get(u)!, pv = pos.get(v)!
          let dx = pu.x - pv.x, dy = pu.y - pv.y
          let dist = Math.sqrt(dx * dx + dy * dy) || 0.01
          const f = (k * k) / dist
          const fx = (dx / dist) * f, fy = (dy / dist) * f
          const du = disp.get(u)!, dv = disp.get(v)!
          du.x += fx; du.y += fy; dv.x -= fx; dv.y -= fy
        }
      }
      // 引力（边）
      for (const e of allEdges) {
        const pu = pos.get(e.a), pv = pos.get(e.b)
        if (!pu || !pv) continue
        let dx = pu.x - pv.x, dy = pu.y - pv.y
        let dist = Math.sqrt(dx * dx + dy * dy) || 0.01
        const f = (dist * dist) / k
        const fx = (dx / dist) * f, fy = (dy / dist) * f
        const du = disp.get(e.a)!, dv = disp.get(e.b)!
        du.x -= fx; du.y -= fy; dv.x += fx; dv.y += fy
      }
      // 位移并限制
      for (const nm of names) {
        const p = pos.get(nm)!, d = disp.get(nm)!
        const len = Math.sqrt(d.x * d.x + d.y * d.y) || 0.01
        const step = Math.min(len, temp)
        p.x += (d.x / len) * step
        p.y += (d.y / len) * step
        p.x = Math.max(30, Math.min(W - 30, p.x))
        p.y = Math.max(30, Math.min(H - 30, p.y))
      }
      temp *= 0.95
    }
    const nodeList: Node[] = names.map(nm => ({ name: nm, x: pos.get(nm)!.x, y: pos.get(nm)!.y, degree: subAdj.get(nm)!.degree }))
    return { nodes: nodeList, edges: allEdges, init: pos }
  }, [rows])

  // 滚轮缩放（原生监听以禁用默认滚动）；deps 含 rows——首渲染 rows 为空时 svg 未渲染、监听挂不上，数据就位后需重新挂
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const rect = svg.getBoundingClientRect()
      const px = ev.clientX - rect.left
      const py = ev.clientY - rect.top
      setView(v => {
        const k = Math.min(3, Math.max(0.4, v.k * Math.exp(-ev.deltaY * 0.0012)))
        const wx = (px - v.x) / v.k
        const wy = (py - v.y) / v.k
        return { k, x: px - wx * k, y: py - wy * k }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [rows])

  if (rows.length === 0) {
    return <div className="rounded-xl border border-ink-700 bg-ink-850 px-4 py-16 text-center text-ink-500">还没有人物关系，先到「表格」视图新增关系记录。</div>
  }

  // 收起：被折叠的节点及其关联边不渲染（布局坐标仍由全部节点算得，展开后位置稳定）
  const isCollapsed = (name: string) => collapsed.has(name)
  const visibleNodes = collapsed.size ? nodes.filter(n => !isCollapsed(n.name)) : nodes
  const visibleEdges = collapsed.size ? edges.filter(e => !isCollapsed(e.a) && !isCollapsed(e.b)) : edges

  const maxDeg = Math.max(1, ...nodes.map(n => n.degree))
  const radius = (d: number) => 7 + (d / maxDeg) * 13

  const toggleCollapse = (name: string) =>
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })

  // 节点最终位置：拖拽覆盖优先，否则用初始布局
  const posMap = new Map<string, { x: number; y: number }>()
  for (const n of nodes) posMap.set(n.name, dragged.get(n.name) ?? init.get(n.name)!)

  const onPointerDown = (e: RPointerEvent<SVGElement>, kind: 'node' | 'pan', name?: string, nodePos?: { x: number; y: number }) => {
    if (kind === 'node') e.stopPropagation()
    e.preventDefault()
    svgRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = {
      kind, name, startSX: e.clientX, startSY: e.clientY,
      origView: view, origNode: nodePos, moved: false,
    }
  }

  const onPointerMove = (e: RPointerEvent<SVGElement>) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startSX
    const dy = e.clientY - d.startSY
    if (!d.moved && Math.hypot(dx, dy) > 3) d.moved = true
    if (d.kind === 'pan') {
      setView(v => ({ x: d.origView.x + dx, y: d.origView.y + dy, k: v.k }))
    } else if (d.name && d.origNode) {
      // 节点拖拽钳制在画布内（留 30px 边距），防止拖出画布后节点消失
      const nx = Math.max(30, Math.min(W - 30, d.origNode.x + dx / d.origView.k))
      const ny = Math.max(30, Math.min(H - 30, d.origNode.y + dy / d.origView.k))
      setDragged(prev => {
        const m = new Map(prev)
        m.set(d.name!, { x: nx, y: ny })
        return m
      })
    }
  }

  const onPointerUp = () => {
    const d = dragRef.current
    dragRef.current = null
    // 未发生位移的按下视为点击：切换收起/展开
    if (d && d.kind === 'node' && d.name && !d.moved) toggleCollapse(d.name)
  }

  const zoomBy = (f: number) => {
    const cx = W / 2, cy = H / 2
    setView(v => {
      const k = Math.min(3, Math.max(0.4, v.k * f))
      const wx = (cx - v.x) / v.k
      const wy = (cy - v.y) / v.k
      return { k, x: cx - wx * k, y: cy - wy * k }
    })
  }
  const resetView = () => setView({ x: 0, y: 0, k: 1 })

  const legendTypes = [...new Set(visibleEdges.map(e => e.type))]

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 overflow-hidden select-none">
      <div className="px-4 py-2 text-[11px] text-ink-500 border-b border-ink-700 flex items-center justify-between gap-2 flex-wrap">
        <span>节点越大 = 关系越多；拖动节点微调 · 拖拽空白平移 · 滚轮缩放 · 点击收起 / 展开</span>
        <span className="flex items-center gap-2">
          {collapsed.size > 0 && (
            <Button variant="bare"
              onClick={() => setCollapsed(new Set())}
              className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-ink-600 text-ink-300 hover:text-amber hover:border-amber/40 transition-colors"
              title="恢复所有被收起的人物"
            >
              <RotateCcw size={11} /> 展开全部（{collapsed.size}）
            </Button>
          )}
          <span>{visibleNodes.length} 位人物 · {visibleEdges.length} 条关系</span>
          <span className="flex items-center gap-0.5 border border-ink-700 rounded-md px-1 py-0.5">
            <Button variant="icon-amber" onClick={() => zoomBy(1.25)} className="p-0.5" title="放大">
              <ZoomIn size={11} />
            </Button>
            <Button variant="icon-amber" onClick={() => zoomBy(0.8)} className="p-0.5" title="缩小">
              <ZoomOut size={11} />
            </Button>
            <Button variant="icon-amber" onClick={resetView} className="p-0.5" title="重置视图">
              <Maximize2 size={11} />
            </Button>
          </span>
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: 'min(70vh, 640px)', touchAction: 'none', cursor: 'grab' }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <pattern id="rg-dots" width="26" height="26" patternUnits="userSpaceOnUse">
            {/* 主题化网格：表现属性不解析 var()，故走 style（浅色主题下改为该主题墨色） */}
            <circle cx="1.4" cy="1.4" r="1" style={{ fill: 'rgb(var(--graph-grid))' }} opacity="0.28" />
          </pattern>
        </defs>
        {/* 点阵背景（画布层，固定不随内容平移） */}
        <rect width="100%" height="100%" fill="url(#rg-dots)" pointerEvents="none" />
        {/* 空白处拖拽平移 */}
        <rect width="100%" height="100%" fill="transparent" onPointerDown={e => onPointerDown(e, 'pan')} />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {visibleEdges.map((e, i) => {
            const a = posMap.get(e.a)
            const b = posMap.get(e.b)
            if (!a || !b) return null
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
            const active = hover === e.a || hover === e.b
            const dim = hover && !active
            const col = edgeColor(e.type)
            const labelW = e.type.length * 9.5 + 8
            return (
              <g key={i} opacity={dim ? 0.12 : 1}>
                <line
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={col}
                  strokeWidth={active ? 2 : 1.2}
                  strokeOpacity={active ? 0.95 : 0.45}
                  strokeLinecap="round"
                />
                <g opacity={active ? 1 : 0.55}>
                  {/* ⚠️ 原写作 fill="rgb(var(--ink-850))" —— 表现属性不解析 var()，
                      该值一直无效并回退为黑色底板。改用 style 后变量才真正生效。 */}
                  <rect x={mx - labelW / 2} y={my - 8.5} width={labelW} height={15} rx={7.5}
                    style={{ fill: 'rgb(var(--ink-850))' }} stroke={col} strokeOpacity={0.45} strokeWidth={0.6} />
                  <text x={mx} y={my + 3.4} style={{ fill: active ? col : 'rgb(var(--graph-edge-label))' }} fontSize={9.5} textAnchor="middle">{e.type}</text>
                </g>
              </g>
            )
          })}
          {visibleNodes.map(n => {
            const p = posMap.get(n.name)!
            const r = radius(n.degree)
            const active = hover === n.name
            const dim = hover && !active
            // 主题化：这两个色值含 var()，故下游一律用 style 而非表现属性
            const col = active ? 'rgb(var(--graph-accent))' : 'rgb(var(--graph-label))'
            return (
              <g
                key={n.name}
                opacity={dim ? 0.3 : 1}
                onMouseEnter={() => setHover(n.name)}
                onMouseLeave={() => setHover(null)}
                onPointerDown={e => onPointerDown(e, 'node', n.name, p)}
                style={{ cursor: 'grab' }}
              >
                <circle cx={p.x} cy={p.y} r={r} style={{ fill: 'rgb(var(--graph-node))', stroke: col }} strokeWidth={active ? 3 : 2} />
                <circle cx={p.x} cy={p.y} r={r * 0.42} style={{ fill: col }} />
                <text x={p.x} y={p.y + r + 15} style={{ fill: active ? 'rgb(var(--graph-accent-text))' : 'rgb(var(--graph-node-text))' }} fontSize={10} textAnchor="middle">{n.name}</text>
              </g>
            )
          })}
        </g>
      </svg>
      {/* 图例：关系类型色板 */}
      {legendTypes.length > 0 && (
        <div className="px-4 py-1.5 border-t border-ink-700 flex items-center gap-3 flex-wrap">
          {legendTypes.map(t => (
            <span key={t} className="flex items-center gap-1.5 text-[10px] text-ink-400">
              <span className="w-3 h-[3px] rounded-full inline-block" style={{ background: edgeColor(t) }} />
              {t}
              {!TYPE_COLORS[t] && <span className="text-[9px] text-ink-500 border border-ink-700 rounded px-1 leading-none">自定义</span>}
            </span>
          ))}
          <span className="text-[10px] text-ink-500 ml-auto">节点大小 = 关系数；边 = 一条关系记录</span>
        </div>
      )}
      {/* 收起的人物：点击单个可重新展开 */}
      {collapsed.size > 0 && (
        <div className="px-4 py-2 border-t border-ink-700 flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-ink-500 shrink-0">已收起：</span>
          {[...collapsed].map(name => (
            <Button variant="bare"
              key={name}
              onClick={() => toggleCollapse(name)}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-ink-800 border border-ink-600 text-[11px] text-ink-300 hover:text-amber hover:border-amber/40 transition-colors"
              title="重新展开该人物"
            >
              <EyeOff size={10} className="opacity-70" /> {name}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
