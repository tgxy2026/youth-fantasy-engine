/**
 * GeoMapEditor 的状态与交互（2026-09-19 从 GeoMapEditor.tsx 抽出，D4 组件拆分收尾）。
 * 纯搬家：语句一字未改。视图侧用「同名解构」接回，JSX 因此一行都不用动。
 * 🔴 内部私有 30 个（curMap / toViewBox / applyPaint / dragRef …）**不 return**，避免 API 面虚胖。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as RPointerEvent } from 'react'
import * as db from '../lib/db'
import type { CardRecord, TableRow } from '../lib/types'
import { TABS } from '../lib/schema'
import { uid } from '../lib/id'
import { showToast, confirmDialog } from './dialogs'
import { CUSTOM_OPTIONS_EVENT, resolveOptions, type ResolvedOption } from './CustomSelect'
import { BUILTIN_CATEGORIES, G, CELL_KM_STEPS, hashNum, locEquals, cardLocEquals, parseCells, serializeCells, shapeOf, aggregateCells, buildChildMap, subtreeIds } from './geoMapGeometry'
import type { SpaceShape, Marker, Linked } from './geoMapGeometry'

export function useGeoMapModel() {
  /** 全部地理行（跨所有地图）；画布只渲染当前地图的那一批 —— 见下方 rows 派生 */
  const [allRows, setAllRows] = useState<TableRow[]>([])
  /** 《地图》表清单 + 当前地图 id（方案 B：每张地图一块独立画布） */
  const [maps, setMaps] = useState<TableRow[]>([])
  const [mapId, setMapId] = useState('')
  const curMap = useMemo(() => maps.find(m => m.id === mapId), [maps, mapId])
  const curMapName = curMap?.data['名称'] || ''
  /** 当前地图的说明：非编辑态显示在右侧面板（说明的编辑入口在左侧列表的「地图信息」里） */
  const mapNote = curMap?.data['说明'] || ''
  /**
   * 当前地图上的地理行。
   * 🔴 未指定「所属地图」的行**不显示**在任何画布上 —— 宁可让作者回《地理风物》补归属，
   *    也不能让它同时出现在每张图上（那正是「只有一张地图」时代的旧行为）。
   */
  const rows = useMemo(
    () => (curMapName ? allRows.filter(r => (r.data['所属地图'] || '') === curMapName) : []),
    [allRows, curMapName],
  )
  const [fs, setFs] = useState<TableRow[]>([])
  const [tl, setTl] = useState<TableRow[]>([])
  const [chars, setChars] = useState<CardRecord[]>([])
  const [catOptions, setCatOptions] = useState<ResolvedOption[]>(
    BUILTIN_CATEGORIES.map(n => ({ name: n, builtinOrigin: n, kind: 'builtin' as const })),
  )
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const [hover, setHover] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  /** 拖拽中的整组格偏移（格数）：Map<空间id, {dx,dy}> */
  const [dragOverride, setDragOverride] = useState<Map<string, { dx: number; dy: number }>>(new Map())
  const [addPos, setAddPos] = useState<{ x: number; y: number } | null>(null)
  const [layers, setLayers] = useState({ foreshadow: true, character: false, timeline: false })
  /** 格子档位：每格边长 = 1 或 10 公里。**跟着当前地图走**（每张图各自持有精细度），右上角按钮切换。 */
  const [cellKm, setCellKm] = useState<number>(1)
  useEffect(() => {
    const km = Number(curMap?.data['每格公里'])
    setCellKm(CELL_KM_STEPS.includes(km) ? km : 1)
  }, [curMap])
  const stepCellKm = (dir: 1 | -1) => {
    const i = CELL_KM_STEPS.indexOf(cellKm)
    const ni = Math.min(CELL_KM_STEPS.length - 1, Math.max(0, i + dir))
    if (ni === i) return
    const newN = CELL_KM_STEPS[ni]
    // 真比例尺：切档后同一地理区域的显示位置向视野中心等比例收缩（newN/oldN 倍），
    // 视野中心那个地理点保持不动；画面缩放 k 归 1（档位本身已承担比例语义）。
    const wcx = (vp.w / 2 - view.x) / view.k
    const wcy = (vp.h / 2 - view.y) / view.k
    const ratio = newN / cellKm
    setCellKm(newN)
    setView({ k: 1, x: vp.w / 2 - wcx / ratio, y: vp.h / 2 - wcy / ratio })
    // 写回当前地图行（原先存项目级 setting，多地图后必须按图区分）
    if (curMap) {
      const upd = { ...curMap, data: { ...curMap.data, '每格公里': String(newN) } }
      setMaps(prev => prev.map(m => (m.id === curMap.id ? upd : m)))
      void db.saveTableRow(upd)
    }
  }
  /** 绘制模式：正在绘制的空间 id */
  const [painting, setPainting] = useState<string | null>(null)
  /** 绘制模式框选矩形（档位块坐标，含起点与当前点） */
  const [selRect, setSelRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [drawDialogOpen, setDrawDialogOpen] = useState(false)
  /** SVG 视口尺寸随容器实测，viewBox 与像素 1:1，避免 letterbox 造成的坐标偏移 */
  const [vp, setVp] = useState({ w: 1000, h: 700 })
  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{
    kind: 'node' | 'pan' | 'paint' | 'pan2'; name?: string
    startVX: number; startVY: number
    origView: { x: number; y: number; k: number }
    moved: boolean
  } | null>(null)

  // ---------- 数据加载 ----------
  const loadCategories = useCallback(async () => {
    const payload = await db.getCustomOptions('geography', '类别')
    setCatOptions(resolveOptions(BUILTIN_CATEGORIES, payload))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const [gRows, fsRows, tlRows, mapRowsAll, charTabs] = await Promise.all([
      db.getTableRows('geography'),
      db.getTableRows('foreshadow'),
      db.getTableRows('timeline'),
      db.getTableRows('geomaps'),
      Promise.all(
        TABS.filter(t => t.type === 'card' && t.group === '角色管理').map(t => db.getCardRecords(t.id)),
      ),
    ])
    setAllRows(gRows)
    setMaps(mapRowsAll)
    // 默认选第一张；原选择若还在就保留（重新加载后不跳图）
    setMapId(prev => (prev && mapRowsAll.some(m => m.id === prev) ? prev : (mapRowsAll[0]?.id ?? '')))
    setFs(fsRows)
    setTl(tlRows)
    setChars(charTabs.flat())
    await loadCategories()
    setLoading(false)
  }, [loadCategories])
  useEffect(() => { void load() }, [load])

  // 别处（表格里的下拉）增删类别时，图例与下拉同步刷新
  useEffect(() => {
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ tabId: string; colName: string }>).detail
      if (!d || d.tabId !== 'geography' || d.colName !== '类别') return
      void loadCategories()
    }
    window.addEventListener(CUSTOM_OPTIONS_EVENT, onChanged)
    return () => window.removeEventListener(CUSTOM_OPTIONS_EVENT, onChanged)
  }, [loadCategories])

  // 容器尺寸实测
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    // 🔴 必须用 clientWidth/clientHeight（CSS 像素）：
    //    `<html>` 上有界面缩放（默认 108%），getBoundingClientRect 返回的是**缩放后的视口像素**；
    //    拿它当 CSS px 写进 svg 的 width/height，画布就会比容器大 8%，右侧与下方被 overflow-hidden 永久裁掉，
    //    连 fitView 的"居中"也会偏。同型画布 PlotCanvas 用的正是 clientWidth/clientHeight。
    const measure = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w > 0 && h > 0) {
        setVp(prev => (prev.w === w && prev.h === h ? prev : { w, h }))
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [loading, rows.length])

  const categoryNames = useMemo(() => catOptions.map(o => o.name), [catOptions])

  const markers = useMemo<Marker[]>(() => {
    const out: Marker[] = []
    for (const r of rows) {
      out.push({
        id: r.id,
        name: r.data['名称'] || '(未命名)',
        category: r.data['类别'] || '区域',
        parent: r.data['层级归属'] || '',
      })
    }
    return out
  }, [rows])

  const byId = useMemo(() => new Map(markers.map(m => [m.id, m])), [markers])
  /** 行数据按 id 索引，供读写「地图格子」形状 */
  const rowById = useMemo(() => new Map(rows.map(r => [r.id, r])), [rows])
  const nameToMarker = useMemo(() => {
    const m = new Map<string, Marker>()
    for (const mk of markers) m.set(mk.name, mk)
    return m
  }, [markers])
  const childMap = useMemo(() => buildChildMap(markers, nameToMarker), [markers, nameToMarker])
  const subtreeCache = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const mk of markers) m.set(mk.id, subtreeIds(mk.id, childMap))
    return m
  }, [markers, childMap])
  const depthMap = useMemo(() => {
    const dm = new Map<string, number>()
    const dfs = (id: string, d: number) => {
      if (dm.has(id) && (dm.get(id) ?? 0) >= d) return
      dm.set(id, d)
      for (const c of childMap.get(id) ?? []) dfs(c.id, d + 1)
    }
    for (const mk of markers) if (!mk.parent || !nameToMarker.get(mk.parent)) dfs(mk.id, 0)
    return dm
  }, [markers, childMap, nameToMarker])

  /** 层级自适应配色：顶级空间按 id 哈希定色相；子级 = 父色相 +140°（高对比），同父兄弟再 +45° 错开。 */
  const spaceColors = useMemo(() => {
    const m = new Map<string, string>()
    const hueCache = new Map<string, number>()
    const childIdx = new Map<string, number>()
    const hueOf = (mk: Marker): number => {
      const cached = hueCache.get(mk.id)
      if (cached != null) return cached
      let h: number
      const p = mk.parent ? nameToMarker.get(mk.parent) : null
      if (!p || p.id === mk.id) {
        h = hashNum(mk.id) % 360
      } else {
        h = (hueOf(p) + 140 + (childIdx.get(p.id) ?? 0) * 45) % 360
        childIdx.set(p.id, (childIdx.get(p.id) ?? 0) + 1)
      }
      hueCache.set(mk.id, h)
      return h
    }
    for (const mk of markers) {
      const h = hueOf(mk)
      m.set(mk.id, `hsl(${h} 62% 55%)`)
    }
    return m
  }, [markers, nameToMarker])

  /** 各空间的格子形状：绝对格坐标集合（含拖拽中的 dragOverride 格偏移）+ 包围盒。
   * 「地图格子」列为空 = 尚未绘制，不显示在画布上。 */
  const spaceShapes = useMemo(() => {
    const m = new Map<string, SpaceShape>()
    for (const mk of markers) {
      const s = shapeOf(rowById.get(mk.id))
      const o = dragOverride.get(mk.id)
      if (o && (o.dx || o.dy)) {
        const cells = new Set<string>()
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const k of s.cells) {
          const [gx, gy] = k.split(',').map(Number)
          cells.add(`${gx + o.dx},${gy + o.dy}`)
          minX = Math.min(minX, gx + o.dx); minY = Math.min(minY, gy + o.dy)
          maxX = Math.max(maxX, gx + o.dx); maxY = Math.max(maxY, gy + o.dy)
        }
        m.set(mk.id, { cells, bbox: { x: minX * G, y: minY * G, w: (maxX - minX + 1) * G, h: (maxY - minY + 1) * G } })
      } else m.set(mk.id, s)
    }
    return m
  }, [markers, rowById, dragOverride])
  /** 已绘制（有格子）的空间 id */
  const drawnIds = useMemo(() => {
    const set = new Set<string>()
    for (const mk of markers) if ((spaceShapes.get(mk.id)?.cells.size ?? 0) > 0) set.add(mk.id)
    return set
  }, [markers, spaceShapes])

  /** 显示形状：按当前档位聚合（满块=大格、零散=1km 小格）+ 显示包围盒（格位×G 坐标系） */
  const viewShapes = useMemo(() => {
    const m = new Map<string, { full: [number, number][]; rest: [number, number][]; bbox: { x: number; y: number; w: number; h: number }; count: number }>()
    for (const mk of markers) {
      const s = spaceShapes.get(mk.id)
      if (!s || s.cells.size === 0) continue
      const { full, rest } = aggregateCells(s.cells, cellKm)
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const [bx, by] of full) {
        minX = Math.min(minX, bx); minY = Math.min(minY, by)
        maxX = Math.max(maxX, bx + 1); maxY = Math.max(maxY, by + 1)
      }
      for (const [gx, gy] of rest) {
        minX = Math.min(minX, gx / cellKm); minY = Math.min(minY, gy / cellKm)
        maxX = Math.max(maxX, gx / cellKm + 1 / cellKm); maxY = Math.max(maxY, gy / cellKm + 1 / cellKm)
      }
      m.set(mk.id, {
        full, rest, count: s.cells.size,
        bbox: { x: minX * G, y: minY * G, w: (maxX - minX) * G, h: (maxY - minY) * G },
      })
    }
    return m
  }, [markers, spaceShapes, cellKm])

  const linked = useMemo(() => {
    const map = new Map<string, Linked>()
    for (const mk of markers) {
      const name = mk.name
      map.set(mk.id, {
        // 仅按结构化「地理位置」字段精确匹配（新增字段，从《地理风物》选取，杜绝同名异写/模糊提及）
        foreshadow: fs.filter(r => locEquals(r.data['地理位置'], name)),
        character: chars.filter(r => cardLocEquals(r.data, name)),
        timeline: tl.filter(r => locEquals(r.data['地理位置'], name)),
      })
    }
    return map
  }, [markers, fs, tl, chars])

  // ---------- 坐标换算（屏幕 → viewBox → 世界） ----------
  const toViewBox = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const ctm = svg.getScreenCTM()
    if (ctm) {
      const inv = ctm.inverse()
      const px = inv.a * clientX + inv.c * clientY + inv.e
      const py = inv.b * clientX + inv.d * clientY + inv.f
      return { x: px, y: py }
    }
    // CTM 拿不到时的兜底：屏幕坐标 → 用户坐标同样要按界面缩放折算（用户坐标 = CSS 像素）
    const r = svg.getBoundingClientRect()
    const z = Number(document.documentElement.style.zoom) || 1
    return { x: (clientX - r.left) / z, y: (clientY - r.top) / z }
  }, [])

  /** 居中内容：把全部已绘制空间显示包围盒放到画布正中 */
  const fitView = useCallback(() => {    const bboxes = [...viewShapes.values()].map(s => s.bbox)
    if (bboxes.length === 0) { setView({ x: 0, y: 0, k: 1 }); return }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const b of bboxes) {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
    }
    const bw = (maxX - minX) || 1, bh = (maxY - minY) || 1
    const k = Math.min(2.5, Math.max(0.04, Math.min(vp.w / (bw + 120), vp.h / (bh + 120))))
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    setView({ k, x: vp.w / 2 - cx * k, y: vp.h / 2 - cy * k })
  }, [viewShapes, vp])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const p = toViewBox(ev.clientX, ev.clientY)
      setView(v => {
        const k = Math.min(3, Math.max(0.04, v.k * Math.exp(-ev.deltaY * 0.0012)))
        const wx = (p.x - v.x) / v.k; const wy = (p.y - v.y) / v.k
        return { k, x: p.x - wx * k, y: p.y - wy * k }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [loading, rows.length, toViewBox])

  // ---------- 指针交互（手绘格子地图） ----------
  /** 逻辑像素坐标 → 绝对格坐标 */
  const cellAt = (wx: number, wy: number) => ({ gx: Math.floor(wx / G), gy: Math.floor(wy / G) })
  /** 某空间的全部祖先 id 集合（沿「层级归属」向上） */
  const ancestorsOf = useCallback((id: string): Set<string> => {
    const out = new Set<string>()
    let m = byId.get(id)
    while (m?.parent) {
      const p = nameToMarker.get(m.parent)
      if (!p || out.has(p.id)) break
      out.add(p.id)
      m = p
    }
    return out
  }, [byId, nameToMarker])
  const enterPaint = (id: string) => {
    setPainting(id)
    setSelected(id)
    setSelRect(null)
    setDrawDialogOpen(false)
  }
  const exitPaint = () => {
    setPainting(null)
    setSelRect(null)
    showToast('已退出绘制', 'info')
  }
  /**
   * 批量涂/擦一个「档位块」矩形（含单块）。逐 1km 格过校验，能涂的都涂：
   * · 子范围不得在父范围外有飞地 → 涂格必须落在所有【已绘制的祖先】之内；
   * · 一个格子只能属于一条祖先链 → 与自己无祖先关系的空间已占该格时跳过；
   * · 擦除时被子孙占用的格保留并计入提示。
   * mode：'paint' 涂 | 'erase' 擦 | 'toggle' 单块（满则擦、不满则涂）
   */
  const applyPaint = async (bx0: number, by0: number, bx1: number, by1: number, mode: 'paint' | 'erase' | 'toggle') => {
    if (!painting) return
    const mk = byId.get(painting)
    if (!mk) return
    // 从 DB 重读最新行：连续快速涂格时 React rows 可能滞后，用旧快照写回会覆盖掉前一次的格子
    const allRows = await db.getTableRows('geography')
    const row = allRows.find(x => x.id === painting)
    if (!row) return
    const cur = parseCells(row.data['地图格子'])
    const n = cellKm
    const anc = ancestorsOf(mk.id)
    const chain = new Set([mk.id, ...anc])
    const descendants = subtreeIds(mk.id, childMap).filter(d => d !== mk.id)
    let added = 0, removed = 0, skipped = 0
    for (let bx = Math.min(bx0, bx1); bx <= Math.max(bx0, bx1); bx++) {
      for (let by = Math.min(by0, by1); by <= Math.max(by0, by1); by++) {
        const cellsInBlock: string[] = []
        for (let dx = 0; dx < n; dx++) for (let dy = 0; dy < n; dy++) cellsInBlock.push(`${bx * n + dx},${by * n + dy}`)
        const full = cellsInBlock.every(c => cur.has(c))
        const doErase = mode === 'erase' || (mode === 'toggle' && full)
        if (doErase) {
          for (const c of cellsInBlock) {
            if (!cur.has(c)) continue
            const blocker = descendants.find(dId => spaceShapes.get(dId)?.cells.has(c))
            if (blocker) { skipped++; continue }
            cur.delete(c); removed++
          }
        } else {
          for (const c of cellsInBlock) {
            if (cur.has(c)) continue
            let bad = false
            for (const ancId of anc) {
              const aShape = spaceShapes.get(ancId)
              if ((aShape?.cells.size ?? 0) > 0 && !aShape!.cells.has(c)) { bad = true; break }
            }
            if (!bad) {
              for (const other of markers) {
                if (chain.has(other.id)) continue
                if (spaceShapes.get(other.id)?.cells.has(c)) { bad = true; break }
              }
            }
            if (bad) { skipped++; continue }
            cur.add(c); added++
          }
        }
      }
    }
    if (added === 0 && removed === 0) {
      showToast(skipped > 0 ? `${skipped} 格越界、重叠或被子孙占用，未做修改` : '没有需要修改的格子', 'info')
      return
    }
    const updated: TableRow = { ...row, data: { ...row.data, '地图格子': serializeCells(cur) } }
    await db.saveTableRow(updated)
    setAllRows(prev => prev.map(x => x.id === row.id ? updated : x))
    if (skipped > 0) showToast(`已修改 ${added + removed} 格；${skipped} 格越界、重叠或被子孙占用，已跳过`, 'info')
  }
  const onPointerDown = (e: RPointerEvent<SVGElement>, kind: 'node' | 'pan', _mk?: Marker) => {
    const rightBtn = e.button === 2
    if (e.button !== 0 && !rightBtn && e.pointerType === 'mouse') return
    e.preventDefault()
    svgRef.current?.setPointerCapture(e.pointerId)
    const v = toViewBox(e.clientX, e.clientY)
    if (painting && rightBtn) {
      // 绘制模式下右键拖动 = 平移画布；右键原地松开 = 退出绘制
      dragRef.current = { kind: 'pan2', startVX: v.x, startVY: v.y, origView: view, moved: false }
    } else if (painting) {
      // 左键：原地松开 = 单块涂/擦切换；按住拖动 = 框选批量填涂（Shift = 批量擦除）
      dragRef.current = { kind: 'paint', startVX: v.x, startVY: v.y, origView: view, moved: false }
    } else if (kind === 'node' && _mk) {
      e.stopPropagation()
      dragRef.current = { kind: 'node', name: _mk.id, startVX: v.x, startVY: v.y, origView: view, moved: false }
    } else {
      dragRef.current = { kind, startVX: v.x, startVY: v.y, origView: view, moved: false }
    }
  }
  const onPointerMove = (e: RPointerEvent<SVGElement>) => {
    const d = dragRef.current
    if (!d) return
    const v = toViewBox(e.clientX, e.clientY)
    const dvx = v.x - d.startVX; const dvy = v.y - d.startVY
    if (!d.moved && Math.hypot(dvx, dvy) > 3) d.moved = true
    if (!d.moved) return
    if (d.kind === 'pan' || d.kind === 'pan2') {
      // 平移画布（绘制模式下右键拖动同样是平移）
      setView(prev => ({ x: d.origView.x + dvx, y: d.origView.y + dvy, k: prev.k }))
    } else if (d.kind === 'paint') {
      // 框选预览：起点块 → 当前光标块
      const w = vbToWorld(v.x, v.y)
      const c = cellAt(w.x, w.y)
      const b0 = cellAt(d.startVX, d.startVY)
      setSelRect({
        x0: Math.floor(b0.gx / cellKm), y0: Math.floor(b0.gy / cellKm),
        x1: Math.floor(c.gx / cellKm), y1: Math.floor(c.gy / cellKm),
      })
    } else if (d.name) {
      // 拖动空间：整棵子树的格子平移相同格数（吸附整格）；
      // 有父级时要求子树格集合整体 ⊆ 父级格集合——出不了父范围（轴分离滑动）。
      const rootId = d.name
      const rootMk = byId.get(rootId)
      const rootShape = spaceShapes.get(rootId)
      if (!rootMk || !rootShape || rootShape.cells.size === 0) return
      let sx = Math.round((dvx / d.origView.k) / G)
      let sy = Math.round((dvy / d.origView.k) / G)
      const pMk = rootMk.parent ? nameToMarker.get(rootMk.parent) : null
      const pShape = pMk ? spaceShapes.get(pMk.id) : null
      if (pShape && pShape.cells.size > 0) {
        const fits = (mx: number, my: number): boolean => {
          for (const k of rootShape.cells) {
            const [gx, gy] = k.split(',').map(Number)
            if (!pShape.cells.has(`${gx + mx},${gy + my}`)) return false
          }
          return true
        }
        if (!fits(sx, sy)) {
          if (fits(sx, 0)) sy = 0
          else if (fits(0, sy)) sx = 0
          else { sx = 0; sy = 0 }
        }
      }
      setDragOverride(prev => {
        const map = new Map(prev)
        const ids = subtreeCache.get(rootId) ?? [rootId]
        for (const id of ids) map.set(id, { dx: sx, dy: sy })
        return map
      })
    }
  }
  const onPointerUp = (e: RPointerEvent<SVGElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.kind === 'pan2') {
      // 绘制模式右键：原地松开 = 退出绘制；拖动已在 move 里平移
      if (!d.moved) exitPaint()
      return
    }
    if (d.kind === 'paint') {
      const v = toViewBox(e.clientX, e.clientY)
      const w = vbToWorld(v.x, v.y)
      const c = cellAt(w.x, w.y)
      const bNow = { x: Math.floor(c.gx / cellKm), y: Math.floor(c.gy / cellKm) }
      if (d.moved && selRect) {
        // 框选批量：松手把框内整批涂上（Shift = 批量擦除）
        const erase = e.shiftKey
        void applyPaint(selRect.x0, selRect.y0, selRect.x1, selRect.y1, erase ? 'erase' : 'paint')
      } else {
        void applyPaint(bNow.x, bNow.y, bNow.x, bNow.y, 'toggle')
      }
      setSelRect(null)
      return
    }
    if (d.kind === 'node' && d.name) {
      if (!d.moved) {
        setSelected(d.name); setAddPos(null)
        return
      }
      const ids = [...new Set([...(subtreeCache.get(d.name) ?? [d.name])])]
      const updates = ids.map(id => {
        const off = dragOverride.get(id)
        if (!off) return null
        const r = rows.find(x => x.id === id); if (!r) return null
        const cur = parseCells(r.data['地图格子'])
        if (cur.size === 0) return null
        const moved = new Set<string>()
        for (const k of cur) {
          const [gx, gy] = k.split(',').map(Number)
          moved.add(`${gx + off.dx},${gy + off.dy}`)
        }
        const upd: TableRow = { ...r, data: { ...r.data, '地图格子': serializeCells(moved) } }
        return { r, upd }
      }).filter(Boolean) as { r: TableRow; upd: TableRow }[]
      if (updates.length) {
        void Promise.all(updates.map(u => db.saveTableRow(u.upd))).then(() => {
          setAllRows(prev => prev.map(x => { const f = updates.find(u => u.r.id === x.id); return f ? f.upd : x }))
          setDragOverride(new Map())
        })
      }
      return
    }
    // 空白处：未发生位移即视为「点击空白新增」
    // 注意：setPointerCapture 会把后续 click 事件转投到 svg 上，rect 的 onClick 永不触发，
    // 所以判定必须在 pointerup 里做，不能依赖 click。
    if (d.kind === 'pan' && !d.moved) {
      const v = toViewBox(e.clientX, e.clientY)
      const w = vbToWorld(v.x, v.y)
      setSelected(null)
      setAddPos({ x: w.x, y: w.y })
    }
  }
  /** viewBox 坐标 → 世界坐标（去掉平移缩放） */
  const vbToWorld = (vx: number, vy: number, v = view) => ({ x: (vx - v.x) / v.k, y: (vy - v.y) / v.k })

  const createMarker = async (name: string, category: string, parent: string) => {
    if (!addPos || !name.trim()) return
    const pid = db.getCurrentProjectId()
    const row: TableRow = {
      id: uid(), projectId: pid, tabId: 'geography', order: allRows.length,
      data: {
        '名称': name.trim(),
        '类别': category || '区域', ...(parent ? { '层级归属': parent } : {}),
        // 就地新增的地点默认落在**当前地图**上，否则新点会立刻从画布上消失
        ...(curMapName ? { '所属地图': curMapName } : {}),
      },
    }
    await db.saveTableRow(row)
    setAllRows(prev => [...prev, row])
    setAddPos(null)
    setSelected(row.id)
    showToast(`已登记「${name.trim()}」，点右上角「绘制地图」为它画出地理形状`, 'success')
  }

  const updateSelected = async (patch: Record<string, string>) => {
    if (!selected) return
    const r = rows.find(x => x.id === selected)
    if (!r) return
    const updated: TableRow = { ...r, data: { ...r.data, ...patch } }
    await db.saveTableRow(updated)
    setAllRows(prev => prev.map(x => x.id === selected ? updated : x))
  }
  const clearCoords = async () => {
    if (!selected) return
    const nm = rows.find(x => x.id === selected)?.data['名称'] || '该范围'
    const ok = await confirmDialog({
      title: `清空「${nm}」的绘制？`,
      message: '这个范围画好的所有格子会被清掉并从地图上消失，《地理风物》档案仍完整保留。\n\n确定清空吗？',
      confirmText: '清空绘制',
      cancelText: '取消',
    })
    if (!ok) return
    await updateSelected({ '地图格子': '' })
    setSelected(null)
    if (painting === selected) setPainting(null)
    showToast(`已清空「${nm}」的绘制（《地理风物》条目保留）`, 'info')
  }
  const deleteMarker = async () => {
    if (!selected) return
    const r = rows.find(x => x.id === selected)
    const nm = r?.data['名称'] || '该地点'
    const ok = await confirmDialog({
      title: `删除地点「${nm}」？`,
      message:
        '⚠️ 这是「连库删除」：\n'
        + `《地理风物》里的「${nm}」整条档案（范围与面积、相对地理位置、行程时间等全部字段）会一起消失，且无法撤销。\n\n`
        + '如果只是想擦掉它画好的格子、但保留档案 —— 请改用「清空绘制」。',
      confirmText: '确认两边一起删除',
      cancelText: '取消',
      danger: true,
    })
    if (!ok) return
    await db.deleteTableRow(selected)
    setAllRows(prev => prev.filter(x => x.id !== selected))
    setSelected(null)
    showToast(`已删除「${nm}」（地图与《地理风物》同步移除）`, 'success')
  }
  const gotoTable = () => window.dispatchEvent(new CustomEvent('yfe:navigate', { detail: 'geography' }))

  const selMarker = markers.find(m => m.id === selected) || null
  const selLinked = selected ? linked.get(selected) : undefined
  const anyLayerOn = layers.foreshadow || layers.character || layers.timeline

  return {
    curMapName,
    mapNote,
    rows,
    stepCellKm,
    wrapRef,
    svgRef,
    load,
    categoryNames,
    markers,
    byId,
    depthMap,
    spaceColors,
    spaceShapes,
    drawnIds,
    viewShapes,
    linked,
    fitView,
    enterPaint,
    exitPaint,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    createMarker,
    updateSelected,
    clearCoords,
    deleteMarker,
    gotoTable,
    selMarker,
    selLinked,
    anyLayerOn,
    allRows,
    maps,
    mapId,
    setMapId,
    loading,
    view,
    hover,
    setHover,
    selected,
    addPos,
    setAddPos,
    layers,
    setLayers,
    cellKm,
    painting,
    selRect,
    drawDialogOpen,
    setDrawDialogOpen,
    vp,
  }
}
