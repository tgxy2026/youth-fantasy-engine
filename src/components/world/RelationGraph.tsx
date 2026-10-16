import { useEffect, useMemo, useState } from 'react'
import { RotateCcw, EyeOff, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'
import type { TableRow } from '@/lib/types'
import { Button } from '@/components/common/Button'
import { useSvgPanZoom } from '@/lib/app/useSvgPanZoom'
import { foldVh } from '@/lib/settings/theme'
import { REL_PRESET_COLORS } from '@/lib/settings/palette'
import { getCardRecords } from '@/lib/db'
import { forceLayout } from '@/lib/world/forceLayout'
import { convexHull, hullPath, curvedEdge, curveMidpoint, groupColor, groupBy, pairKey, edgeCurveRatios, curveArrow } from '@/lib/world/graphGrouping'
import { buildTypeColors, makeColorLookup } from '@/lib/world/relationColors'
import { useMonoTheme } from '@/lib/settings/useMonoTheme'
import { monoDashLookup, monoShapeLookup, monoShapePath } from '@/lib/settings/monoMarks'

interface Props {
  rows: TableRow[]
}

interface Node { name: string; x: number; y: number; degree: number; faction: string; status: string; identity: string }
interface Edge {
  id: string
  a: string
  b: string
  type: string
  /** 关系现状（悬停详情用） */
 现状: string
  /** 知情度（悬停详情用） */
 知情度: string
}

const W = 1000
const H = 640

/** 关系类型 → 线色（内置常见 8 类用精调色；自定义类型由 `relationColors.buildTypeColors` 哈希取色 + 撞色兜底） */
/** 人物关系图内置 8 类语义色 —— 本体在 `lib/palette.ts`（2.8.0 · #045/#046） */
const TYPE_COLORS: Record<string, string> = REL_PRESET_COLORS

/**
 * 边线型：把「关系的性质」作为第二维编码 —— 颜色说「什么关系」，线型说「这关系是什么质地」。
 * 敌对 / 恩怨用虚线（一眼分辨冲突关系），竞争用点线，其余实线。
 * 🔴 线型只是**第二编码**，不是唯一编码 —— 色盲用户仍可从颜色与标签读出类型。
 */
function edgeDash(t: string): string | undefined {
  if (t === '敌对' || t === '恩怨') return '7 5'
  if (t === '竞争') return '2 4'
  return undefined
}

const CHAR_TABS = ['char-main', 'char-secondary', 'char-npc']

interface CharMeta { faction: string; status: string; identity: string }

/** 悬停目标：节点或边（两者共用一块信息条，避免各自飘一块浮层） */
type Hovered = { kind: 'node'; name: string } | { kind: 'edge'; id: string } | null

/**
 * 人物关系力导向图（v2.0 视觉重构 · 2026-10-02；v2.1 支持同对多关系）
 *
 * 相比改造前新增（全部消费**现有字段**，不新增表/列）：
 *  ① **节点按「所属势力」着色** + 同势力节点画**圆角凸包**并标势力名（来源：角色卡「所属势力」）。
 *  ② **人物状态标记**：「未登场」的人物用虚线描边（来源：角色卡「人物状态」）。
 *  ③ **边线型双编码** + **悬停详情条**（关系现状 / 知情度，来源：关系表现有列）。
 *  ④ 🆕 **同一对多条关系**：关系表判重为**有向对 + 关系类型**（2.7.2）⇒ 同一对可并存多种关系；
 *     渲染上把同一对的边**分弧**铺开、并加**箭头**标出每条的方向（A→B）。
 *  ⑤ 🆕 自定义关系类型配色走公共 `relationColors`（哈希取色 + 同图撞色兜底）。
 *
 * 交互不变：拖动节点微调布局；拖拽空白处平移画布；滚轮缩放；点击节点收起/展开。
 * 布局改用公共 `forceLayout`（确定性圆环播种，同一份数据每次打开长得一样）。
 */
export default function RelationGraph({ rows }: Props) {
  const [hoverName, setHoverName] = useState<Hovered>(null)
  // 收起（折叠）节点：点击某人物可隐藏其本人与所有关系边，便于在超大关系网里聚焦
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  // 角色卡元数据（所属势力 / 人物状态 / 身份定位）—— 异步读取，缺失时优雅降级为「无阵营」
  const [chars, setChars] = useState<Map<string, CharMeta>>(new Map())
  useEffect(() => {
    let alive = true
    Promise.all(CHAR_TABS.map(t => getCardRecords(t))).then(lists => {
      if (!alive) return
      const m = new Map<string, CharMeta>()
      for (const recs of lists) {
        for (const rec of recs) {
          const name = (rec.name || '').trim()
          if (!name) continue
          let faction = ''
          let status = ''
          let identity = ''
          for (const [k, v] of Object.entries(rec.data)) {
            const val = (v || '').trim()
            if (k.endsWith('所属势力') && !faction) faction = val
            else if (k === '人物状态' && !status) status = val
            else if ((k.endsWith('身份定位') || k === '身份') && !identity) identity = val
          }
          m.set(name, { faction, status, identity })
        }
      }
      setChars(m)
    })
      // 🔴 补 catch：IndexedDB 读失败会产生 unhandled rejection（控制台红字、且作者无从得知）。
      //    元数据只影响节点形状/阵营着色，失败时保持空 Map 即可（已有「无阵营」降级）。
      .catch(e => console.warn('[graph] 角色卡元数据读取失败，按「无阵营」降级：', e))
    return () => { alive = false }
  }, [])

  // 定义须在 hook 之前：下面要把它作为 onNodeClick 传进去（const 箭头有 TDZ，不能后置引用）
  const toggleCollapse = (name: string) =>
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })

  // 平移 / 缩放 / 节点拖拽统一走公共 hook（2026-09-14 审计 P1-4）。
  const { view, dragged, svgRef, onPointerDown, onPointerMove, onPointerUp, zoomBy, resetView } =
    useSvgPanZoom({ world: { w: W, h: H, pad: 30 }, reattachKey: rows, onNodeClick: toggleCollapse })

  const { nodes, edges, init, edgeCurve } = useMemo(() => {
    const adj = new Map<string, { neighbors: Set<string>; edges: Edge[] }>()
    const ensure = (n: string) => {
      if (!adj.has(n)) adj.set(n, { neighbors: new Set(), edges: [] })
      return adj.get(n)!
    }
    for (const r of rows) {
      const a = (r.data['人物A'] || '').trim()
      const b = (r.data['人物B'] || '').trim()
      if (!a && !b) continue
      if (a && b && b !== a) {
        ensure(a).neighbors.add(b)
        ensure(b).neighbors.add(a)
      }
      if (a && b) {
        ensure(a).edges.push({
          id: r.id, a, b,
          type: r.data['关系类型'] || '关系',
          现状: r.data['关系现状'] || '',
          知情度: r.data['知情度（互相知道什么）'] || '',
        })
      }
    }
    // 取度数最高的前 80 个节点（度数 = **不同邻居数**：同一对多条关系不再虚增权重）
    let names = [...adj.keys()].sort((x, y) => adj.get(y)!.neighbors.size - adj.get(x)!.neighbors.size)
    if (names.length > 80) names = names.slice(0, 80)
    const subAdj = new Map(names.map(n => [n, adj.get(n)!]))
    const allEdges = names.flatMap(n => subAdj.get(n)!.edges)
    const kept = new Set(names)
    const visibleEdges = allEdges.filter(e => kept.has(e.a) && kept.has(e.b))
    // 平行边分弧：同一对（含反向）的多条边按稳定序逐条外扩，避免完全重叠
    const byPair = new Map<string, Edge[]>()
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
    const pos = forceLayout(names, visibleEdges, { w: W, h: H, pad: 30 })
    const nodeList: Node[] = names.map(nm => ({
      name: nm,
      x: pos.get(nm)!.x,
      y: pos.get(nm)!.y,
      degree: subAdj.get(nm)!.neighbors.size,
      faction: '',
      status: '',
      identity: '',
    }))
    return { nodes: nodeList, edges: visibleEdges, init: pos, edgeCurve }
  }, [rows])

  // 类型 → 颜色（内置精调色 + 自定义哈希取色 + 同图撞色兜底）。用**全部边**算，收起节点时颜色不跳。
  const edgeTypes = useMemo(() => [...new Set(edges.map(e => e.type))], [edges])
  const colorOf = useMemo(() => makeColorLookup(buildTypeColors(edgeTypes, TYPE_COLORS)), [edgeTypes])

  // 🔴 纯黑白（3.1.1）：语义色全部失效 ⇒ 类别改由**线型**（关系类型）与**形状**（所属势力）承载。
  //    只有 mono 下才走这一支，其他主题的语义色一字不动。
  const mono = useMonoTheme()
  /** mono 下的「墨色」（该主题里 ink-100 = #000）——不写裸色值，故仍走主题变量 */
  const monoInk = 'rgb(var(--ink-100))'
  // 线型按「关系类型首次出现顺序」分配（图内互不相同）。
  // 与 colorOf 同源：都用**全部**边算，收起节点时线型不跳。
  const monoDash = useMemo(() => monoDashLookup(edgeTypes), [edgeTypes])

  // 把角色卡元数据合并进节点（依赖 chars，故与布局 memo 分开）
  const nodesWithMeta = useMemo(
    () => nodes.map(n => {
      const m = chars.get(n.name)
      return m ? { ...n, faction: m.faction, status: m.status, identity: m.identity } : n
    }),
    [nodes, chars],
  )

  // 形状按「势力首次出现顺序」分配（图内互不相同；无势力一律圆形）
  const monoShape = useMemo(
    () => monoShapeLookup(nodesWithMeta.map(n => n.faction).filter(Boolean)),
    [nodesWithMeta],
  )
  const nodeShapeOf = (faction: string) => (faction ? monoShape(faction) : 'circle')

  // 收起：被折叠的节点及其关联边不渲染（布局坐标仍由全部节点算得，展开后位置稳定）
  const visibleNodes = useMemo(
    () => (collapsed.size ? nodesWithMeta.filter(n => !collapsed.has(n.name)) : nodesWithMeta),
    [nodesWithMeta, collapsed],
  )
  const visibleEdges = useMemo(
    () => (collapsed.size ? edges.filter(e => !collapsed.has(e.a) && !collapsed.has(e.b)) : edges),
    [edges, collapsed],
  )

  // 节点最终位置：拖拽覆盖优先，否则用初始布局
  const posMap = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>()
    for (const n of nodesWithMeta) m.set(n.name, dragged.get(n.name) ?? init.get(n.name)!)
    return m
  }, [nodesWithMeta, dragged, init])

  // 分组凸包：同「所属势力」的可见节点外包一层圆角轮廓（< 2 人的组不画，避免小圆圈噪音）
  const hulls = useMemo(() => {
    const byFaction = groupBy(
      visibleNodes.filter(n => n.faction),
      n => n.faction,
    )
    const out: { faction: string; path: string; color: string; labelX: number; labelY: number }[] = []
    for (const [faction, list] of byFaction) {
      if (list.length < 2) continue
      const pts = list.map(n => posMap.get(n.name) ?? { x: n.x, y: n.y })
      const hull = convexHull(pts)
      if (hull.length < 3) continue
      const topY = Math.min(...hull.map(p => p.y))
      const avgX = hull.reduce((s, p) => s + p.x, 0) / hull.length
      out.push({
        faction,
        path: hullPath(hull, 22, 26),
        color: groupColor(faction),
        labelX: avgX,
        labelY: topY - 30,
      })
    }
    return out
  }, [visibleNodes, posMap])

  if (rows.length === 0) {
    return <div className="rounded-xl border border-ink-700 bg-ink-850 px-4 py-16 text-center text-ink-500">还没有人物关系，先到「表格」视图新增关系记录。</div>
  }

  const maxDeg = Math.max(1, ...nodesWithMeta.map(n => n.degree))
  const radius = (d: number) => 7 + (d / maxDeg) * 13

  const legendTypes = [...new Set(visibleEdges.map(e => e.type))]

  const hoverEdge = hoverName?.kind === 'edge' ? visibleEdges.find(e => e.id === hoverName.id) : undefined
  const hoverNode = hoverName?.kind === 'node' ? visibleNodes.find(n => n.name === hoverName.name) : undefined

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 overflow-hidden select-none">
      <div className="px-4 py-2 text-11 text-ink-500 border-b border-ink-700 flex items-center justify-between gap-2 flex-wrap">
        <span>{mono
          ? '节点形状 = 所属势力，外框 = 阵营范围；线型 = 关系类型（边中点标出类型名）；同一对多条关系 → 分弧 + 箭头标方向；拖动节点微调 · 拖拽空白平移 · 滚轮缩放 · 点击收起 / 展开'
          : '节点颜色 = 所属势力，外框 = 阵营范围；线色 = 关系类型，虚线 = 敌对/恩怨；同一对多条关系 → 分弧 + 箭头标方向；拖动节点微调 · 拖拽空白平移 · 滚轮缩放 · 点击收起 / 展开'}</span>
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
        style={{ height: foldVh('min(70vh, 640px)'), touchAction: 'none', cursor: 'grab' }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <pattern id="rg-dots" width="26" height="26" patternUnits="userSpaceOnUse">
            {/* 主题化网格：表现属性不解析 var()，故走 style（浅色主题下改为该主题墨色） */}
            <circle cx="1.4" cy="1.4" r="1" style={{ fill: 'rgb(var(--graph-grid))' }} opacity={mono ? 1 : 0.28} />
          </pattern>
        </defs>
        {/* 点阵背景（画布层，固定不随内容平移） */}
        <rect width="100%" height="100%" fill="url(#rg-dots)" pointerEvents="none" />
        {/* 空白处拖拽平移 */}
        <rect width="100%" height="100%" fill="transparent" onPointerDown={e => onPointerDown(e, 'pan')} />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {/* 分组凸包（最底层：垫在边与节点之下，不拦指针） */}
          {hulls.map(h => (
            <g key={`hull-${h.faction}`} pointerEvents="none">
              {mono
                ? <path d={h.path} fill="none" style={{ stroke: monoInk }} strokeWidth={1.2} strokeDasharray="7 5" />
                : <path d={h.path} fill={h.color} fillOpacity={0.09} stroke={h.color} strokeOpacity={0.4} strokeWidth={1.2} strokeDasharray="1 0" />}
              <text x={h.labelX} y={h.labelY} textAnchor="middle" fontSize={11} fontWeight={600} style={{ fill: mono ? monoInk : h.color }}>{h.faction}</text>
            </g>
          ))}
          {/* 关系边（弧线 + 类型色 + 性质线型；同一对多条 → 分弧 + 箭头标方向） */}
          {visibleEdges.map(e => {
            const a = posMap.get(e.a)
            const b = posMap.get(e.b)
            if (!a || !b) return null
            const active = hoverName?.kind === 'node'
              ? (hoverName.name === e.a || hoverName.name === e.b)
              : hoverName?.kind === 'edge' && hoverName.id === e.id
            const dim = hoverName?.kind === 'node' && !active
            const col = colorOf(e.type)
            const cv = edgeCurve.get(e.id)
            const curve = cv?.curve ?? 0.18
            const mid = curveMidpoint(a.x, a.y, b.x, b.y, curve)
            const labelW = e.type.length * 9.5 + 8
            return (
              <g key={e.id} data-edge-type={e.type} data-edge-curve={curve} data-edge-multi={cv?.multi ? '1' : '0'} opacity={mono ? 1 : (dim ? 0.12 : 1)}>
                <path
                  d={curvedEdge(a.x, a.y, b.x, b.y, curve)}
                  fill="none"
                  style={{ stroke: mono ? monoInk : col }}
                  // 🔴 mono 下不用「透明度淡化」（半透明=灰，违背严格二值）：改用**线宽**区分
                  //    淡化 0.8 / 常规 1.5 / 悬停 3 —— 仍是纯黑，只是粗细不同（P0-D 验收第 3 条）。
                  strokeWidth={mono ? (active ? 3 : dim ? 0.8 : 1.5) : (active ? 2.4 : 1.3)}
                  strokeOpacity={mono ? 1 : (active ? 0.95 : 0.5)}
                  strokeLinecap="round"
                  strokeDasharray={mono ? (monoDash(e.type) || undefined) : edgeDash(e.type)}
                />
                {/* 同一对出现多条关系时，用箭头标出本条方向（A→B）—— 区分「谁怎么看谁」 */}
                {cv?.multi && (
                  <path d={curveArrow(a.x, a.y, b.x, b.y, curve)} data-arrow="1" style={{ fill: mono ? monoInk : col }} opacity={mono ? 1 : (active ? 0.95 : 0.62)} />
                )}
                <g
                  opacity={mono ? 1 : (active ? 1 : 0.6)}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoverName({ kind: 'edge', id: e.id })}
                  onMouseLeave={() => setHoverName(null)}
                >
                  <rect x={mid.x - labelW / 2} y={mid.y - 8.5} width={labelW} height={15} rx={7.5}
                    style={{ fill: 'rgb(var(--ink-850))', stroke: mono ? monoInk : col }} strokeOpacity={mono ? 1 : 0.45} strokeWidth={0.6} />
                  <text x={mid.x} y={mid.y + 3.4} style={{ fill: mono ? monoInk : (active ? col : 'rgb(var(--graph-edge-label))') }} fontSize={9.5} textAnchor="middle">{e.type}</text>
                </g>
              </g>
            )
          })}
          {/* 节点（颜色 = 所属势力；未登场 = 虚线描边） */}
          {visibleNodes.map(n => {
            const p = posMap.get(n.name)!
            const r = radius(n.degree)
            const active = hoverName?.kind === 'node' && hoverName.name === n.name
            const dim = hoverName?.kind === 'node' && !active
            const col = n.faction ? groupColor(n.faction) : 'rgb(var(--graph-label))'
            const notYet = n.status === '未登场'
            return (
              <g
                key={n.name}
                opacity={mono ? 1 : (dim ? 0.28 : 1)}
                onMouseEnter={() => setHoverName({ kind: 'node', name: n.name })}
                onMouseLeave={() => setHoverName(null)}
                onPointerDown={e => onPointerDown(e, 'node', n.name, p)}
                style={{ cursor: 'grab' }}
              >
                {mono
                  ? <path d={monoShapePath(nodeShapeOf(n.faction), p.x, p.y, r)}
                    style={{ fill: 'rgb(var(--graph-node))', stroke: monoInk }}
                    strokeWidth={dim ? 1.2 : active ? 3.4 : 2.2} strokeDasharray={notYet ? '3 3' : undefined} />
                  : <>
                    <circle cx={p.x} cy={p.y} r={r} style={{ fill: 'rgb(var(--graph-node))', stroke: active ? 'rgb(var(--graph-accent))' : col }}
                      strokeWidth={active ? 3 : 2} strokeDasharray={notYet ? '3 3' : undefined} />
                    <circle cx={p.x} cy={p.y} r={r * 0.42} style={{ fill: active ? 'rgb(var(--graph-accent))' : col }} />
                  </>}
                <text x={p.x} y={p.y + r + 15} style={{ fill: active ? 'rgb(var(--graph-accent-text))' : 'rgb(var(--graph-node-text))' }} fontSize={10} textAnchor="middle">{n.name}</text>
              </g>
            )
          })}
        </g>
      </svg>
      {/* 悬停详情条（节点 → 身份/状态；边 → 关系现状/知情度） */}
      <div className="px-4 py-1.5 border-t border-ink-700 flex items-center gap-3 flex-wrap min-h-[30px]">
        {hoverNode ? (
          <>
            <span className="text-11 text-amber font-semibold">{hoverNode.name}</span>
            {hoverNode.faction && <span className="text-10 text-ink-400">势力：{hoverNode.faction}</span>}
            {hoverNode.identity && <span className="text-10 text-ink-400 truncate max-w-[32%]">身份：{hoverNode.identity}</span>}
            {hoverNode.status && <span className="text-10 text-ink-400">状态：{hoverNode.status}</span>}
          </>
        ) : hoverEdge ? (
          <>
            <span className="text-11 font-semibold" style={{ color: mono ? monoInk : colorOf(hoverEdge.type) }}>{hoverEdge.a} → {hoverEdge.type} → {hoverEdge.b}</span>
            {hoverEdge.现状 && <span className="text-10 text-ink-400 truncate max-w-[38%]">现状：{hoverEdge.现状}</span>}
            {hoverEdge.知情度 && <span className="text-10 text-ink-400 truncate max-w-[38%]">知情度：{hoverEdge.知情度}</span>}
          </>
        ) : (
          <span className="text-10 text-ink-500">悬停节点看身份与状态，悬停连线看关系现状与知情度</span>
        )}
      </div>
      {/* 图例：关系类型色板 */}
      {legendTypes.length > 0 && (
        <div className="px-4 py-1.5 border-t border-ink-700 flex items-center gap-3 flex-wrap">
          {legendTypes.map(t => (
            <span key={t} className="flex items-center gap-1.5 text-10 text-ink-400">
              {mono
                ? <svg width="16" height="8" aria-hidden="true"><line x1="1" y1="4" x2="15" y2="4" style={{ stroke: monoInk }} strokeWidth="2" strokeDasharray={monoDash(t) || undefined} /></svg>
                : <span className="w-3 h-3px rounded-full inline-block" style={{ background: colorOf(t) }} />}
              {t}
              {!TYPE_COLORS[t] && <span className="text-9 text-ink-500 border border-ink-700 rounded px-1 leading-none">自定义</span>}
            </span>
          ))}
          <span className="text-10 text-ink-500 ml-auto">{mono
            ? '线型 = 关系类型；节点形状 = 所属势力；节点大小 = 交际面（不同关系人数）'
            : '节点大小 = 交际面（不同关系人数）；同一对可并存多种关系（分弧 + 箭头标方向）'}</span>
        </div>
      )}
      {/* 收起的人物：点击单个可重新展开 */}
      {collapsed.size > 0 && (
        <div className="px-4 py-2 border-t border-ink-700 flex items-center gap-2 flex-wrap">
          <span className="text-10 text-ink-500 shrink-0">已收起：</span>
          {[...collapsed].map(name => (
            <Button variant="bare"
              key={name}
              onClick={() => toggleCollapse(name)}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-ink-800 border border-ink-600 text-11 text-ink-300 hover:text-amber hover:border-amber/40 transition-colors"
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
