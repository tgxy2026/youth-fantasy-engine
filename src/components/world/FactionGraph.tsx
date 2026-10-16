import { useEffect, useMemo, useState } from 'react'
import { getCardRecords, getTableRows } from '@/lib/db'
import type { TableRow } from '@/lib/types'
import { Network, Users, X, ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { useSvgPanZoom } from '@/lib/app/useSvgPanZoom'
import { foldVh } from '@/lib/settings/theme'
import { forceLayout } from '@/lib/world/forceLayout'
import { curvedEdge, curveMidpoint, groupColor, groupBy, convexHull, hullPath, pairKey, edgeCurveRatios, curveArrow } from '@/lib/world/graphGrouping'
import { buildTypeColors, makeColorLookup } from '@/lib/world/relationColors'
import { FACTION_PRESET_COLORS } from '@/lib/settings/palette'
import { useMonoTheme } from '@/lib/settings/useMonoTheme'
import { monoDashLookup, monoShapeLookup, monoShapePath } from '@/lib/settings/monoMarks'

interface Props {
  rows: TableRow[]
  onNavigate?: (tabId: string) => void
}

/** 势力关系图内置 5 类语义色 —— 本体在 `lib/palette.ts`（2.8.0 · #045/#046） */
const REL_COLORS: Record<string, string> = FACTION_PRESET_COLORS
const REL_ORDER = ['同盟', '敌对', '贸易', '从属', '中立']
const W = 900
const H = 600

interface FNode { name: string; x: number; y: number; degree: number; category: string; parent: string }
interface FEdge { a: string; b: string; type: string; id: string; status: string }

/** 悬停目标：节点或边 */
type Hovered = { kind: 'node'; name: string } | { kind: 'edge'; id: string } | null

/**
 * 势力关系力导向图（v2.0 视觉重构 · 2026-10-02）
 *
 * 改造前后差异（全部消费**现有字段**）：
 *  ① **布局：圆环 → 力导向**。旧版把势力均匀排在圆周上，势力一多就挤成一圈糖葫芦、
 *     也看不出「谁跟谁抱团」。改用公共 `forceLayout`（边界钳制保证节点不飘出视野），与人物关系图统一。
 *  ② **节点按《国家势力》「类别」着色**（王朝/宗门/世家/商会/魔道/隐秘组织/神族/城池）
 *     + 同类别画圆角凸包并标类别名 —— 一眼看出势力集团。
 *  ③ **「上级」层级吸附**：`nations.上级` 链上加一根弱弹簧，子势力自然靠向父势力。
 *  ④ 边改弧线 + 药丸标签（旧版是裸文字），与人物图统一视觉语言；悬停边显示「关系现状」。
 *  ⑤ 🆕 **同一对势力多条关系**：判重为有向对 + 关系类型（2.7.2）⇒ 分弧铺开 + 箭头标方向；
 *     自定义关系类型配色走公共 `relationColors`（哈希 + 同图撞色兜底），与人物图同一套色板。
 *
 * 交互不变：拖拽平移/节点、滚轮缩放、点击节点展开右侧成员面板、跳转《国家势力》。
 * 节点尺寸仍按**度数**映射 —— 不按《国家势力》「实力等级」映射：那是自由文本（"一流""九品"），
 * 解析不可靠，宁可保持简单可靠的口径。
 */
export default function FactionGraph({ rows, onNavigate }: Props) {
  const [hoverName, setHoverName] = useState<Hovered>(null)
  const [selected, setSelected] = useState<string | null>(null)

  // 《国家势力》元数据（类别 / 上级）—— 异步读取，缺失时优雅降级（无类别 = 中性色）
  const [nationMeta, setNationMeta] = useState<Map<string, { category: string; parent: string }>>(new Map())
  useEffect(() => {
    let alive = true
    getTableRows('nations').then(list => {
      if (!alive) return
      const m = new Map<string, { category: string; parent: string }>()
      for (const r of list) {
        const name = (r.data['名称'] || '').trim()
        if (!name) continue
        m.set(name, {
          category: (r.data['类别'] || '').trim(),
          parent: (r.data['上级'] || '').trim(),
        })
      }
      setNationMeta(m)
    })
    return () => { alive = false }
  }, [])

  // 平移 / 缩放 / 节点拖拽统一走公共 hook（2026-09-14 审计 P1-4）。
  const { view, dragged, svgRef, onPointerDown, onPointerMove, onPointerUp } = useSvgPanZoom({
    world: { w: W, h: H, pad: 30 },
    reattachKey: rows,
    onNodeClick: name => setSelected(sel => (sel === name ? null : name)),
  })

  const { nodes, edges, edgeCurve } = useMemo(() => {
    const adj = new Map<string, { neighbors: Set<string>; edges: FEdge[] }>()
    const ensure = (n: string) => {
      if (!adj.has(n)) adj.set(n, { neighbors: new Set(), edges: [] })
      return adj.get(n)!
    }
    for (const r of rows) {
      const a = (r.data['势力A'] || '').trim()
      const b = (r.data['势力B'] || '').trim()
      const type = r.data['关系类型'] || '中立'
      if (!a && !b) continue
      if (a && b && b !== a) {
        ensure(a).neighbors.add(b)
        ensure(b).neighbors.add(a)
      }
      if (a && b) {
        ensure(a).edges.push({
          a, b, type, id: r.id,
          status: r.data['关系现状'] || '',
        })
      }
    }
    const names = [...adj.keys()]
    const allEdges: FEdge[] = names.flatMap(nm => adj.get(nm)!.edges)
    const kept = new Set(names)
    const visibleEdges = allEdges.filter(e => kept.has(e.a) && kept.has(e.b))
    // 平行边分弧：同一对（含反向）多条关系逐条外扩
    const byPair = new Map<string, FEdge[]>()
    for (const e of visibleEdges) {
      const k = pairKey(e.a, e.b)
      const arr = byPair.get(k)
      if (arr) arr.push(e); else byPair.set(k, [e])
    }
    const edgeCurve = new Map<string, { curve: number; multi: boolean }>()
    for (const list of byPair.values()) {
      const sorted = [...list].sort((x, y) =>
        x.type < y.type ? -1 : x.type > y.type ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
      const ratios = edgeCurveRatios(sorted.length)
      sorted.forEach((e, i) => edgeCurve.set(e.id, { curve: ratios[i], multi: sorted.length > 1 }))
    }
    const nodeList: FNode[] = names.map(nm => ({
      name: nm,
      x: 0, y: 0,
      degree: adj.get(nm)!.neighbors.size,
      category: '',
      parent: '',
    }))
    return { nodes: nodeList, edges: visibleEdges, edgeCurve }
  }, [rows])

  // 类型 → 颜色（内置精调色 + 自定义哈希 + 撞色兜底；两图共用同一套）
  const edgeTypes = useMemo(() => [...new Set(edges.map(e => e.type))], [edges])
  const colorOf = useMemo(() => makeColorLookup(buildTypeColors(edgeTypes, REL_COLORS)), [edgeTypes])

  // 🔴 纯黑白（3.1.1）：语义色失效 ⇒ 关系类型改由**线型**承载、类别改由**节点形状**承载；
  //    只在此主题下分支，其他主题的语义色一字不动。
  const mono = useMonoTheme()
  const monoInk = 'rgb(var(--ink-100))'
  // 线型按「关系类型首次出现顺序」分配（图内互不相同）
  const monoDash = useMemo(() => monoDashLookup(edgeTypes), [edgeTypes])

  // 布局依赖「上级」层级（来自异步读到的 nationMeta），故与建图分开算
  const layout = useMemo(() => {
    const names = nodes.map(n => n.name)
    if (names.length === 0) return new Map<string, { x: number; y: number }>()
    const extraLinks: { a: string; b: string; strength: number }[] = []
    for (const n of names) {
      const p = nationMeta.get(n)?.parent
      if (p && names.includes(p) && p !== n) extraLinks.push({ a: n, b: p, strength: 0.3 })
    }
    return forceLayout(names, edges, { w: W, h: H, pad: 30, extraLinks })
  }, [nodes, edges, nationMeta])

  const nodesWithMeta = useMemo(
    () => nodes.map(n => {
      const m = nationMeta.get(n.name)
      const p = layout.get(n.name)
      return { ...n, category: m?.category ?? '', parent: m?.parent ?? '', x: p?.x ?? W / 2, y: p?.y ?? H / 2 }
    }),
    [nodes, nationMeta, layout],
  )

  const posOf = (nm: string) => dragged.get(nm) ?? layout.get(nm) ?? { x: W / 2, y: H / 2 }

  // 形状按「类别首次出现顺序」分配（图内互不相同；无类别一律圆形）
  const monoShape = useMemo(
    () => monoShapeLookup(nodesWithMeta.map(n => n.category).filter(Boolean)),
    [nodesWithMeta],
  )
  const nodeShapeOf = (category: string) => (category ? monoShape(category) : 'circle')

  const posMap = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>()
    for (const n of nodesWithMeta) m.set(n.name, dragged.get(n.name) ?? layout.get(n.name) ?? { x: W / 2, y: H / 2 })
    return m
  }, [nodesWithMeta, dragged, layout])

  // 类别凸包
  const hulls = useMemo(() => {
    const byCat = groupBy(nodesWithMeta.filter(n => n.category), n => n.category)
    const out: { cat: string; path: string; color: string; labelX: number; labelY: number }[] = []
    for (const [cat, list] of byCat) {
      if (list.length < 2) continue
      const pts = list.map(n => posMap.get(n.name) ?? { x: n.x, y: n.y })
      const hull = convexHull(pts)
      if (hull.length < 3) continue
      out.push({
        cat,
        path: hullPath(hull, 24, 28),
        color: groupColor(cat),
        labelX: hull.reduce((s, p) => s + p.x, 0) / hull.length,
        labelY: Math.min(...hull.map(p => p.y)) - 32,
      })
    }
    return out
  }, [nodesWithMeta, posMap])

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

  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-ink-500 gap-2"
        style={{ height: foldVh('60vh') }}>
        <Network size={32} className="opacity-40" />
        <div className="text-13">暂无势力关系</div>
        <div className="text-11 text-ink-600">请在表格登记 势力A / 势力B / 关系类型，图谱会自动生成</div>
      </div>
    )
  }

  const maxDeg = Math.max(1, ...nodesWithMeta.map(n => n.degree))
  const radius = (d: number) => 9 + (d / maxDeg) * 11

  const hoverEdge = hoverName?.kind === 'edge' ? edges.find(e => e.id === hoverName.id) : undefined
  const hoverNodeMeta = hoverName?.kind === 'node' ? nationMeta.get(hoverName.name) : undefined

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
          <pattern id="fg-dots" width="26" height="26" patternUnits="userSpaceOnUse">
            {/* 主题化网格（与人物关系图统一：同变量、同透明度） */}
            <circle cx="1.4" cy="1.4" r="1" style={{ fill: 'rgb(var(--graph-grid))' }} opacity={mono ? 1 : 0.28} />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#fg-dots)" />
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* 类别凸包（垫底） */}
          {hulls.map(h => (
            <g key={`hull-${h.cat}`} pointerEvents="none">
              {mono
                ? <path d={h.path} fill="none" stroke={monoInk} strokeWidth={1.2} strokeDasharray="7 5" />
                : <path d={h.path} fill={h.color} fillOpacity={0.09} stroke={h.color} strokeOpacity={0.38} strokeWidth={1.2} />}
              <text x={h.labelX} y={h.labelY} textAnchor="middle" fontSize={11} fontWeight={600} style={{ fill: mono ? monoInk : h.color }}>{h.cat}</text>
            </g>
          ))}
          {/* 边（弧线 + 药丸标签；同一对多条 → 分弧 + 箭头标方向） */}
          {edges.map(e => {
            const pa = posOf(e.a)
            const pb = posOf(e.b)
            if (!pa || !pb) return null
            const color = colorOf(e.type)
            const active = hoverName?.kind === 'node'
              ? (hoverName.name === e.a || hoverName.name === e.b)
              : hoverName?.kind === 'edge' && hoverName.id === e.id
            const dim = hoverName?.kind === 'node' && !active
            const cv = edgeCurve.get(e.id)
            const curve = cv?.curve ?? 0.18
            const mid = curveMidpoint(pa.x, pa.y, pb.x, pb.y, curve)
            const labelW = e.type.length * 12 + 12
            return (
              <g key={e.id} data-edge-type={e.type} data-edge-curve={curve} data-edge-multi={cv?.multi ? '1' : '0'} opacity={dim ? 0.12 : 1}>
                <path
                  d={curvedEdge(pa.x, pa.y, pb.x, pb.y, curve)}
                  fill="none"
                  stroke={mono ? monoInk : color}
                  strokeWidth={active ? 3 : 1.6}
                  strokeOpacity={active ? 0.95 : 0.55}
                  strokeLinecap="round"
                  strokeDasharray={mono ? (monoDash(e.type) || undefined) : undefined}
                />
                {cv?.multi && (
                  <path d={curveArrow(pa.x, pa.y, pb.x, pb.y, curve, 12, 6)} data-arrow="1" fill={mono ? monoInk : color} opacity={active ? 0.95 : 0.65} />
                )}
                <g
                  opacity={active ? 1 : 0.7}
                  style={{ cursor: 'pointer' }}
                  onPointerEnter={() => setHoverName({ kind: 'edge', id: e.id })}
                  onPointerLeave={() => setHoverName(h => (h?.kind === 'edge' && h.id === e.id ? null : h))}
                >
                  <rect x={mid.x - labelW / 2} y={mid.y - 9.5} width={labelW} height={17} rx={8.5}
                    style={{ fill: 'rgb(var(--ink-850))' }} stroke={mono ? monoInk : color} strokeOpacity={mono ? 1 : 0.45} strokeWidth={0.6} />
                  <text x={mid.x} y={mid.y + 4} textAnchor="middle" fontSize={11}
                    style={{ fill: mono ? monoInk : (active ? color : 'rgb(var(--graph-edge-label))') }}>{e.type}</text>
                </g>
              </g>
            )
          })}
          {/* 节点（颜色 = 势力类别） */}
          {nodesWithMeta.map(nd => {
            const pa = posMap.get(nd.name) ?? { x: nd.x, y: nd.y }
            const isSel = selected === nd.name
            const isHov = hoverName?.kind === 'node' && hoverName.name === nd.name
            const r = radius(nd.degree)
            const dim = hoverName?.kind === 'node' && !isHov
            const base = nd.category ? groupColor(nd.category) : 'rgb(var(--graph-label))'
            const color = isSel ? 'rgb(var(--graph-accent-strong))' : isHov ? 'rgb(var(--graph-accent))' : base
            return (
              <g
                key={nd.name}
                opacity={dim ? 0.28 : 1}
                transform={`translate(${pa.x},${pa.y})`}
                onPointerDown={e => onPointerDown(e, 'node', nd.name, pa)}
                onPointerEnter={() => setHoverName({ kind: 'node', name: nd.name })}
                onPointerLeave={() => setHoverName(h => (h?.kind === 'node' && h.name === nd.name ? null : h))}
                className="cursor-pointer"
              >
                {mono
                  ? <path d={monoShapePath(nodeShapeOf(nd.category), 0, 0, r)} style={{ fill: 'rgb(var(--graph-node))', stroke: monoInk }} strokeWidth={isSel ? 3 : 2} />
                  : <>
                    <circle r={r} style={{ fill: 'rgb(var(--graph-node))', stroke: color }} strokeWidth={isSel ? 3 : 2} />
                    <circle r={r * 0.42} style={{ fill: color }} />
                  </>}
                <text
                  y={r + 15}
                  textAnchor="middle"
                  style={{ fill: isHov ? 'rgb(var(--graph-accent-text))' : 'rgb(var(--graph-node-text))', fontSize: 12, fontWeight: isSel ? 700 : 400 }}
                >
                  {nd.name}
                </text>
              </g>
            )
          })}
        </g>
      </svg>

      {/* 图例：关系类型（边色） */}
      <div className="absolute left-3 top-3 flex flex-wrap gap-2 max-w-[60%] bg-ink-850/80 backdrop-blur rounded-lg px-2.5 py-1.5 border border-ink-700">
        {(() => {
          const present = [...new Set(edges.map(e => e.type))]
          const ordered = [
            ...REL_ORDER.filter(t => present.includes(t)),
            ...present.filter(t => !REL_COLORS[t]),
          ]
          return ordered.map(t => (
            <span key={t} className="flex items-center gap-1 text-11 text-ink-300">
              {mono
                ? <svg width="16" height="8" aria-hidden="true"><line x1="1" y1="4" x2="15" y2="4" stroke={monoInk} strokeWidth="2" strokeDasharray={monoDash(t) || undefined} /></svg>
                : <span className="w-2.5 h-2.5 rounded-full" style={{ background: colorOf(t) }} />}
              {t}
              {!REL_COLORS[t] && <span className="text-9 text-ink-500 bg-ink-900 px-1 rounded leading-none">自定义</span>}
            </span>
          ))
        })()}
      </div>

      {/* 悬停详情（边 → 关系现状；节点 → 类别 / 上级） */}
      {(hoverEdge || hoverName?.kind === 'node') && (
        <div className="absolute left-3 bottom-3 right-3 flex items-center gap-3 flex-wrap bg-ink-850/85 backdrop-blur rounded-lg px-2.5 py-1.5 border border-ink-700">
          {hoverEdge ? (
            <>
              <span className="text-11 font-semibold" style={{ color: mono ? monoInk : colorOf(hoverEdge.type) }}>{hoverEdge.a} → {hoverEdge.type} → {hoverEdge.b}</span>
              {hoverEdge.status && <span className="text-10 text-ink-400 truncate max-w-[50%]">现状：{hoverEdge.status}</span>}
            </>
          ) : (
            <>
              <span className="text-11 text-amber font-semibold">{hoverName && hoverName.kind === 'node' ? hoverName.name : ''}</span>
              {hoverNodeMeta?.category && <span className="text-10 text-ink-400">类别：{hoverNodeMeta.category}</span>}
              {hoverNodeMeta?.parent && <span className="text-10 text-ink-400">上级：{hoverNodeMeta.parent}</span>}
            </>
          )}
        </div>
      )}

      {/* 缩放提示 */}
      <div className="absolute right-3 top-3 text-10 text-ink-500 bg-ink-850/70 rounded px-2 py-0.5">
        滚轮缩放 · 拖拽平移/移动节点
      </div>

      {/* 右侧成员面板 */}
      {selected && (
        <div className="absolute right-3 top-12 bottom-3 w-64 bg-ink-850/95 backdrop-blur rounded-xl border border-ink-700 p-3 overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <div className="text-13 font-semibold text-amber">{selected}</div>
                <Button variant="icon-muted" onClick={() => setSelected(null)} title="关闭详情" aria-label="关闭详情">
                  <X size={16} />
                </Button>
          </div>
          <Button variant="bare"
            onClick={() => onNavigate?.('nations')}
            className="text-11 text-info hover:text-info mb-3 inline-flex items-center gap-1"
          >
            <ArrowUpRight size={11} /> 在《国家势力》查看
          </Button>
          <div className="text-11 text-ink-400 mb-1.5 flex items-center gap-1">
            <Users size={11} /> 所属成员（{members.length}）
          </div>
          {members.length === 0 ? (
            <div className="text-11 text-ink-600">暂无角色卡将「所属势力」设为 {selected}</div>
          ) : (
            <div className="space-y-1.5">
              {members.map((m, i) => (
                <div key={i} className="bg-ink-800 rounded-lg px-2 py-1.5">
                  <div className="text-12 text-ink-100">{m.name}</div>
                  <div className="text-10 text-ink-500">
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
