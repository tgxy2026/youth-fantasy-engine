// SVG 画布的「平移 / 缩放 / 节点拖拽」公共逻辑。
//
// 为什么抽出来（2026-09-14 审计 P1-4）：
//   这套逻辑此前在 RelationGraph / FactionGraph / GeoMapEditor / PlotCanvas 各写了一遍，
//   而且已经**实质性分叉**——同样叫「拖拽节点」，一个会钳制在画布内、另一个不会；
//   同样叫「滚轮缩放」，一个用平滑指数、另一个用阶梯步进。
//   结果是「同名功能、不同手感」，改一处修不到别处。
//
// 本 hook 统一采用**其中更稳妥的那一套**行为（见各条注释的「统一取舍」），
// 并把差异显式写在这里，避免以后再分叉。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export interface PanZoomView {
  x: number
  y: number
  k: number
}

interface DragState {
  kind: 'node' | 'pan'
  name?: string
  startSX: number
  startSY: number
  origView: PanZoomView
  origNode?: { x: number; y: number }
  moved: boolean
}

export interface UseSvgPanZoomOptions {
  /**
   * 世界坐标尺寸。给了就对**节点拖拽**做边界钳制（留 pad 边距），
   * 防止节点被拖出画布后「消失」（用户找不到、以为数据没了）。
   * 统一取舍：采用「钳制」——原先只有 RelationGraph 做了。
   */
  world?: { w: number; h: number; pad?: number }
  /** 滚轮监听的重新挂载依赖：首帧 svg 尚未渲染时挂不上，数据就位后需重挂（传 rows 即可） */
  reattachKey?: unknown
  /** 按下后未超过位移阈值即抬起，视为「点击节点」 */
  onNodeClick?: (name: string) => void
}

const MIN_K = 0.4
const MAX_K = 3
/** 判定「点击」而非「拖动」的位移阈值（px） */
const CLICK_THRESHOLD = 3

export function useSvgPanZoom(opts: UseSvgPanZoomOptions = {}) {
  const { world, reattachKey, onNodeClick } = opts
  const [view, setView] = useState<PanZoomView>({ x: 0, y: 0, k: 1 })
  /** 节点拖拽后的位置覆盖（name → 世界坐标）；未拖过的节点用调用方给的初始布局坐标 */
  const [dragged, setDragged] = useState<Map<string, { x: number; y: number }>>(new Map())
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<DragState | null>(null)

  // 用 ref 保存易变引用，保证 pointer 处理器身份稳定（不必每帧重建）
  const viewRef = useRef(view)
  viewRef.current = view
  const worldRef = useRef(world)
  worldRef.current = world
  const onClickRef = useRef(onNodeClick)
  onClickRef.current = onNodeClick

  // 滚轮缩放（原生监听以禁用页面默认滚动）。
  // 统一取舍：采用**平滑指数**缩放（exp），而非阶梯步进——手感连续、且与触控板兼容。
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const rect = svg.getBoundingClientRect()
      const px = ev.clientX - rect.left
      const py = ev.clientY - rect.top
      setView(v => {
        const k = Math.min(MAX_K, Math.max(MIN_K, v.k * Math.exp(-ev.deltaY * 0.0012)))
        // 以光标位置为锚点缩放：光标下的世界坐标保持不变
        const wx = (px - v.x) / v.k
        const wy = (py - v.y) / v.k
        return { k, x: px - wx * k, y: py - wy * k }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [reattachKey])

  /**
   * 按下开始拖拽。
   * @param kind 'pan' 拖空白平移；'node' 拖节点改位置
   * @param name 节点名（kind==='node' 时必填）
   * @param origNode 该节点**当前**世界坐标（调用方按「拖拽覆盖优先、否则初始布局」求得）
   */
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGElement>, kind: 'node' | 'pan', name?: string, origNode?: { x: number; y: number }) => {
      if (kind === 'node') e.stopPropagation() // 拖节点时不要同时触发背景平移
      e.preventDefault()
      // 统一取舍：在 svg 根节点上捕获指针（而非 e.target）。后者在节点自身被移除/重排时
      // 可能丢失后续事件，导致「拖到一半断了」。
      svgRef.current?.setPointerCapture?.(e.pointerId)
      dragRef.current = {
        kind,
        name,
        startSX: e.clientX,
        startSY: e.clientY,
        origView: { ...viewRef.current },
        origNode,
        moved: false,
      }
    },
    [],
  )

  const onPointerMove = useCallback((e: ReactPointerEvent<SVGElement>) => {
    const d = dragRef.current
    if (!d) return
    const rawDx = e.clientX - d.startSX
    const rawDy = e.clientY - d.startSY
    // 统一取舍：用欧氏距离判定位移（曼哈顿距离会把斜向轻拖误判为拖动）。
    // ⚠️ 点击判定用**原始视口像素**，保持手感不变；实际位移才折算。
    if (!d.moved && Math.hypot(rawDx, rawDy) > CLICK_THRESHOLD) d.moved = true
    // 🔴 view 坐标是 CSS 像素域，而 clientX 是视口像素 —— 不除界面缩放，拖动会比光标快约 8%
    const z = Number(document.documentElement.style.zoom) || 1
    const dx = rawDx / z
    const dy = rawDy / z

    if (d.kind === 'pan') {
      setView(v => ({ x: d.origView.x + dx, y: d.origView.y + dy, k: v.k }))
      return
    }
    if (!d.name || !d.origNode) return
    const k = d.origView.k || 1
    let nx = d.origNode.x + dx / k
    let ny = d.origNode.y + dy / k
    const w = worldRef.current
    if (w) {
      // 钳制在画布内（留 pad 边距）：避免节点被拖出可视区域后消失
      const pad = w.pad ?? 30
      nx = Math.max(pad, Math.min(w.w - pad, nx))
      ny = Math.max(pad, Math.min(w.h - pad, ny))
    }
    const name = d.name
    setDragged(prev => new Map(prev).set(name, { x: nx, y: ny }))
  }, [])

  const onPointerUp = useCallback(() => {
    const d = dragRef.current
    dragRef.current = null
    if (d?.kind === 'node' && d.name && !d.moved) onClickRef.current?.(d.name)
  }, [])

  /** 以画布中心为锚点按倍率缩放（工具条 +/- 按钮用） */
  const zoomBy = useCallback((f: number) => {
    const w = worldRef.current
    if (!w) return
    const cx = w.w / 2
    const cy = w.h / 2
    setView(v => {
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * f))
      const wx = (cx - v.x) / v.k
      const wy = (cy - v.y) / v.k
      return { k, x: cx - wx * k, y: cy - wy * k }
    })
  }, [])

  const resetView = useCallback(() => setView({ x: 0, y: 0, k: 1 }), [])

  /** 节点最终位置：拖拽覆盖优先，否则用初始布局坐标 */
  const posOf = useCallback(
    (name: string, init: Map<string, { x: number; y: number }>) => dragged.get(name) ?? init.get(name)!,
    [dragged],
  )

  return { view, setView, dragged, svgRef, dragRef, onPointerDown, onPointerMove, onPointerUp, zoomBy, resetView, posOf }
}
