import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as RPointerEvent } from 'react'
import { Layers, Maximize2, Plus, Trash2, ZoomIn, ZoomOut, ExternalLink, MapPin, Eraser, Pencil } from 'lucide-react'
import * as db from '../lib/db'
import type { CardRecord, TableRow, TabDef } from '../lib/types'
import { TABS } from '../lib/schema'
import { uid } from '../lib/id'
import { showToast, confirmDialog } from './dialogs'
import CustomSelect, { CUSTOM_OPTIONS_EVENT, resolveOptions, type ResolvedOption } from './CustomSelect'
import HelpPopover from './HelpPopover'
import { Modal } from './Modal'
import { Button } from './Button'

/** 内置类别：必须与 schema.ts 中 geography 表「类别」列的内置选项保持一致 */
const BUILTIN_CATEGORIES = ['大陆', '区域', '国家', '城市', '秘境', '禁地', '遗迹', '山脉']

const LAYER_COLORS = { foreshadow: '#f0a4a4', character: '#8fd0c4', timeline: '#e8b36a' }

/** 字符串 → 稳定数值（用于哈希色相） */
function hashNum(t: string): number {
  let h = 0
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0
  return h
}

/** 结构化联动匹配：仅按「地理位置」字段精确匹配地名（根治模糊提及/同名异写导致的错乱）。 */
function locEquals(v: unknown, name: string): boolean {
  const s = (v ?? '').toString().trim()
  return s !== '' && s === name.trim()
}
/** 角色卡数据以「模块::字段」为 key，取出「地理位置」字段值做精确匹配。 */
function cardLocEquals(data: Record<string, string>, name: string): boolean {
  for (const [k, v] of Object.entries(data)) {
    if (k.endsWith('::地理位置') && locEquals(v, name)) return true
  }
  return false
}
// ---------- 格子地图几何 ----------
/** 每个格子的屏幕边长（逻辑像素）。格子档位（每格代表多少公里）由右上角切换。 */
export const G = 36
/** 格子档位：每格边长代表的公里数（1km 精细 / 10km 快速铺大块） */
export const CELL_KM_STEPS = [1, 10]
/** 「地图格子」列的序列化格式：绝对格坐标 "gx,gy;gx,gy;…"。空 = 尚未绘制。 */
export function parseCells(s: string | undefined): Set<string> {
  const out = new Set<string>()
  if (!s) return out
  for (const part of s.split(';')) {
    const t = part.trim()
    if (/^-?\d+\s*,\s*-?\d+$/.test(t)) out.add(t.replace(/\s/g, ''))
  }
  return out
}
export function serializeCells(set: Set<string>): string {
  return [...set].join(';')
}
/** 空间形状：绝对格坐标集合 + 包围盒（逻辑像素） */
export interface SpaceShape { cells: Set<string>; bbox: { x: number; y: number; w: number; h: number } }
export function shapeOf(row: TableRow | undefined): SpaceShape {
  const cells = parseCells(row?.data['地图格子'])
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const k of cells) {
    const [gx, gy] = k.split(',').map(Number)
    minX = Math.min(minX, gx); minY = Math.min(minY, gy)
    maxX = Math.max(maxX, gx); maxY = Math.max(maxY, gy)
  }
  return { cells, bbox: { x: minX * G, y: minY * G, w: (maxX - minX + 1) * G, h: (maxY - minY + 1) * G } }
}

/** 按档位 n（每格 = n 公里）聚合格子：
 * 满 n×n 的块 → 一个大格（块索引坐标，渲染尺寸 G）；零散格保持 1km 格（渲染尺寸 G/n）。
 * 底层数据始终是 1km 格集合，档位只影响显示聚合与涂格笔刷大小——比例尺真实。 */
export function aggregateCells(cells: Set<string>, n: number): { full: [number, number][]; rest: [number, number][] } {
  const full: [number, number][] = []
  const rest: [number, number][] = []
  if (n <= 1) {
    for (const k of cells) { const [gx, gy] = k.split(',').map(Number); rest.push([gx, gy]) }
    return { full, rest }
  }
  const visited = new Set<string>()
  for (const k of cells) {
    if (visited.has(k)) continue
    const [gx, gy] = k.split(',').map(Number)
    const bx = Math.floor(gx / n) * n, by = Math.floor(gy / n) * n
    let ok = true
    for (let dx = 0; dx < n; dx++) {
      for (let dy = 0; dy < n; dy++) {
        if (!cells.has(`${bx + dx},${by + dy}`)) { ok = false; break }
      }
      if (!ok) break
    }
    if (ok) {
      full.push([bx / n, by / n])
      for (let dx = 0; dx < n; dx++) for (let dy = 0; dy < n; dy++) visited.add(`${bx + dx},${by + dy}`)
    } else rest.push([gx, gy])
  }
  return { full, rest }
}

interface Marker { id: string; name: string; category: string; parent: string }
interface Linked { foreshadow: TableRow[]; character: CardRecord[]; timeline: TableRow[] }

// ---------- 层级地理包含：树构建与包围盒 ----------
function buildChildMap(markers: Marker[], nameToMarker: Map<string, Marker>): Map<string, Marker[]> {
  const m = new Map<string, Marker[]>()
  for (const mk of markers) {
    if (!mk.parent) continue
    const p = nameToMarker.get(mk.parent)
    if (!p || p.id === mk.id) continue
    if (!m.has(p.id)) m.set(p.id, [])
    m.get(p.id)!.push(mk)
  }
  return m
}
function subtreeIds(rootId: string, childMap: Map<string, Marker[]>): string[] {
  const out: string[] = []
  const stack = [rootId]
  const seen = new Set<string>([rootId])
  while (stack.length) {
    const id = stack.pop()!
    out.push(id)
    for (const c of childMap.get(id) ?? []) if (!seen.has(c.id)) { seen.add(c.id); stack.push(c.id) }
  }
  return out
}

export default function GeoMapEditor({ tab }: { tab: TabDef }) {
  const [rows, setRows] = useState<TableRow[]>([])
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
  /** 格子档位：每格边长 = 1 或 10 公里，按项目持久化。右上角按钮切换。 */
  const [cellKm, setCellKm] = useState<number>(1)
  useEffect(() => { void db.getSetting<number>('geoMapCellKm', 1).then(v => (CELL_KM_STEPS.includes(v) ? setCellKm(v) : setCellKm(1))) }, [])
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
    void db.setSetting('geoMapCellKm', newN)
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
    const [gRows, fsRows, tlRows, charTabs] = await Promise.all([
      db.getTableRows('geography'),
      db.getTableRows('foreshadow'),
      db.getTableRows('timeline'),
      Promise.all(
        TABS.filter(t => t.type === 'card' && t.group === '角色管理').map(t => db.getCardRecords(t.id)),
      ),
    ])
    setRows(gRows)
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
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        setVp(prev => (Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1
          ? prev : { w: Math.round(r.width), h: Math.round(r.height) }))
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
    const r = svg.getBoundingClientRect()
    return { x: clientX - r.left, y: clientY - r.top }
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
    setRows(prev => prev.map(x => x.id === row.id ? updated : x))
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
          setRows(prev => prev.map(x => { const f = updates.find(u => u.r.id === x.id); return f ? f.upd : x }))
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
      id: uid(), projectId: pid, tabId: 'geography', order: rows.length,
      data: {
        '名称': name.trim(),
        '类别': category || '区域', ...(parent ? { '层级归属': parent } : {}),
      },
    }
    await db.saveTableRow(row)
    setRows(prev => [...prev, row])
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
    setRows(prev => prev.map(x => x.id === selected ? updated : x))
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
    setRows(prev => prev.filter(x => x.id !== selected))
    setSelected(null)
    showToast(`已删除「${nm}」（地图与《地理风物》同步移除）`, 'success')
  }
  const gotoTable = () => window.dispatchEvent(new CustomEvent('yfe:navigate', { detail: 'geography' }))

  const selMarker = markers.find(m => m.id === selected) || null
  const selLinked = selected ? linked.get(selected) : undefined
  const anyLayerOn = layers.foreshadow || layers.character || layers.timeline

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 顶部工具条（通栏） */}
      <div className="px-4 py-2.5 border-b border-ink-700 flex items-center gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <MapPin size={15} className="text-amber shrink-0" />
          <span className="font-semibold text-ink-100">{tab.name}</span>
          <span className="text-[11px] text-ink-500">{markers.length} 个范围 / {rows.length} 条地理条目 / 已绘制 {drawnIds.size}</span>
          <HelpPopover
            title="地图编辑"
            width="20rem"
            className="ml-1"
          >
            {'手绘格子地图 · 形状由你做主\n\n'
              + '· 点「绘制地图」选择一个范围（建议从最大的范围开始）。左键单击涂/擦一格；按住拖动框选一片批量填涂，Shift+框选批量擦除；右键单击退出、右键拖动平移画布。\n'
              + '· 右上角「精 / 粗」切换格子档位：每格边长 1 公里（精细）或 10 公里（粗略）。切档后同一区域会等比例缩放，比例尺真实；画大陆用粗档快速铺满，画城池切回精档。\n'
              + '· 滚轮缩放画面、拖空白平移；拖动整块空间可挪位置（吸附整格）。\n'
              + '· 唯一规则：子范围必须完全画在父范围之内（无飞地）；祖先链上的范围可以叠涂，别的范围不行。\n'
              + '· 图层嵌套按「层级归属」自动分层，子空间格子叠涂在父空间之上。\n'
              + '· 颜色由系统按层级自动调配：父子高对比、兄弟错开，一眼区分隶属关系。'}
          </HelpPopover>
        </div>
        <div className="flex items-center gap-1.5 ml-auto flex-wrap">
          {(['foreshadow', 'character', 'timeline'] as const).map(key => (
            <Button variant="bare"
              key={key}
              onClick={() => setLayers(l => ({ ...l, [key]: !l[key] }))}
              className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-md border text-[11px] transition-colors ${layers[key] ? 'border-amber/40 text-amber bg-amber/10' : 'border-ink-700 text-ink-400 hover:text-ink-200'}`}
              title={key === 'foreshadow' ? '叠加伏笔关联' : key === 'character' ? '叠加角色关联' : '叠加时间脉络关联'}
            >
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: LAYER_COLORS[key] }} />
              {key === 'foreshadow' ? '伏笔' : key === 'character' ? '角色' : '时间脉络'}
            </Button>
          ))}
          {painting && (
            <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-amber/50 bg-amber/10 text-[11px] text-amber">
              <Pencil size={11} /> 正在绘制：{byId.get(painting)?.name}
              <Button variant="bare" onClick={exitPaint} className="ml-0.5 text-ink-300 hover:text-ink-100" title="右键画布也可取消">完成</Button>
            </span>
          )}
          <Button variant="bare" onClick={() => setDrawDialogOpen(true)} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-ink-700 text-[11px] text-ink-300 hover:text-amber hover:border-amber/40 transition-colors" title="选择一个地理范围，用格子画出它的形状">
            <Pencil size={11} /> 绘制地图
          </Button>
          <span className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-ink-700 text-[11px] text-ink-400 select-none" title="当前格子档位：每个格子的边长所代表的真实公里数（1 = 精细 / 10 = 粗略）。用旁边的「精 / 粗」按钮切换。">
            <span className="text-ink-500">每格</span>
            <span className="text-amber font-medium">1:{cellKm}</span>
            <span className="text-ink-500">公里</span>
          </span>
          <span className="flex items-center gap-1">
            <Button variant="bare" onClick={() => stepCellKm(-1)} disabled={cellKm === CELL_KM_STEPS[0]} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-ink-700 text-[11px] text-ink-300 hover:text-amber hover:border-amber/40 transition-colors disabled:opacity-40" title="提高精度：每格边长 ÷10（1 公里格，画小范围用）"><ZoomIn size={11} />精</Button>
            <Button variant="bare" onClick={() => stepCellKm(1)} disabled={cellKm === CELL_KM_STEPS[CELL_KM_STEPS.length - 1]} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-ink-700 text-[11px] text-ink-300 hover:text-amber hover:border-amber/40 transition-colors disabled:opacity-40" title="降低精度：每格边长 ×10（10 公里格，画大范围快速铺格子）"><ZoomOut size={11} />粗</Button>
            <Button onClick={fitView}  title="重置视图（内容居中）" variant="secondary" size="md" className="items-center text-[11px]"><Maximize2 size={11} />重置</Button>
          </span>
        </div>
      </div>

      {/* 中段：画布 + 右侧面板（两者严格等高） */}
      <div className="flex-1 flex min-h-0">
        <div ref={wrapRef} className="flex-1 min-w-0 relative overflow-hidden" style={{ background: 'rgb(var(--ink-900))' }}>
          {/* 空态提示必须 pointer-events-none，否则会挡住「单击空白新增」 */}
          {loading ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center text-ink-500 text-sm pointer-events-none">加载地理数据…</div>
          ) : rows.length === 0 ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center text-ink-500 text-sm px-8 text-center pointer-events-none">
              <span>还没有《地理风物》数据。可以直接<strong className="text-ink-300">单击这里的空白处</strong>就地新增地点，也可以先去「地理风物」登记，回来用「绘制地图」给它画形状。</span>
            </div>
          ) : null}
          <svg
            id="geo-map-canvas"
            ref={svgRef}
            viewBox={`0 0 ${vp.w} ${vp.h}`}
            width={vp.w}
            height={vp.h}
            className="block"
            style={{ touchAction: 'none', cursor: painting ? 'cell' : 'grab' }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onContextMenu={e => e.preventDefault()}
          >
            <defs>
              <pattern id="gm-dots" width="26" height="26" patternUnits="userSpaceOnUse">
                <circle cx="1.4" cy="1.4" r="1" fill="#57534e" opacity={painting ? 0.32 : 0.22} />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#gm-dots)" pointerEvents="none" />
            {/* 背景交互层：拖动平移；原地松手 = 空白新增（绘制模式下原地松手 = 涂格） */}
            <rect width="100%" height="100%" fill="transparent" onPointerDown={e => onPointerDown(e as RPointerEvent<SVGElement>, 'pan')} />

            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {/* 格子地图：按层级深度从浅到深分层渲染——父空间格子铺底，子空间作为「另一图层」叠涂其上。
                  颜色由系统按层级自动调配（父子高对比）；渲染按当前档位聚合（满 n×n 块=大格，零散=1km 小格）。 */}
              {[...markers]
                .filter(m => drawnIds.has(m.id))
                .sort((a, b) => (depthMap.get(a.id) ?? 0) - (depthMap.get(b.id) ?? 0))
                .map(mk => {
                  const vs = viewShapes.get(mk.id); if (!vs) return null
                  const col = spaceColors.get(mk.id) || '#8fb4e8'
                  const active = hover === mk.id || selected === mk.id
                  const dim = hover && !active
                  const depth = depthMap.get(mk.id) ?? 0
                  const fillOp = depth === 0 ? 0.16 : depth === 1 ? 0.30 : 0.42
                  const fs = Math.max(11, 16 - depth * 2)
                  // 根范围标签放包围盒右上角外（右对齐），子/孙放各自包围盒左上角外（左对齐）——避免父子名字重叠
                  const isTop = depth === 0
                  const tx = isTop ? vs.bbox.x + vs.bbox.w + 4 : vs.bbox.x + 2
                  const anchor = isTop ? 'end' : 'start'
                  return (
                    <g key={mk.id} data-space-id={mk.id} opacity={dim ? 0.4 : 1}
                      onMouseEnter={() => setHover(mk.id)} onMouseLeave={() => setHover(null)}
                      onPointerDown={e => onPointerDown(e, 'node', mk)}
                      style={{ cursor: painting ? 'cell' : (selected === mk.id ? 'pointer' : 'grab') }}>
                      {vs.full.map(([bx, by]) => (
                        <rect key={`f${bx},${by}`} x={bx * G + 0.7} y={by * G + 0.7} width={G - 1.4} height={G - 1.4} rx={1.5}
                          fill={col} fillOpacity={fillOp} stroke={col} strokeOpacity={active ? 0.95 : 0.45} strokeWidth={active ? 1.4 : 0.8} />
                      ))}
                      {vs.rest.map(([gx, gy]) => (
                        <rect key={`r${gx},${gy}`} x={(gx / cellKm) * G + 0.3} y={(gy / cellKm) * G + 0.3} width={G / cellKm - 0.5} height={G / cellKm - 0.5} rx={G / cellKm / 5}
                          fill={col} fillOpacity={fillOp} stroke={col} strokeOpacity={active ? 0.9 : 0.4} strokeWidth={active ? 1 : 0.5} />
                      ))}
                      <text x={tx} y={vs.bbox.y - 5} textAnchor={anchor} fontSize={fs} fontWeight={600} fill={col} pointerEvents="none"
                        style={{ paintOrder: 'stroke', stroke: '#15120e', strokeWidth: 3.5 }}>{mk.name}</text>
                      <text x={tx} y={vs.bbox.y - 5 + fs + 1} textAnchor={anchor} fontSize={fs - 3} fill={col} fillOpacity={0.9} pointerEvents="none"
                        style={{ paintOrder: 'stroke', stroke: '#15120e', strokeWidth: 3 }}>{mk.category} · {vs.count} 格</text>
                      {active && !painting && (
                        <text x={tx} y={vs.bbox.y - 5 + fs * 2 + 3} textAnchor={anchor} fontSize={fs - 3.5} fill="#f4c266" pointerEvents="none"
                          style={{ paintOrder: 'stroke', stroke: '#15120e', strokeWidth: 3 }}>详情面板可绘制 · 拖动整体平移</text>
                      )}
                    </g>
                  )
                })}

              {/* 绘制模式框选预览（档位块矩形） */}
              {painting && selRect && (() => {
                const x0 = Math.min(selRect.x0, selRect.x1) * G
                const y0 = Math.min(selRect.y0, selRect.y1) * G
                const w = (Math.abs(selRect.x1 - selRect.x0) + 1) * G
                const h = (Math.abs(selRect.y1 - selRect.y0) + 1) * G
                return (
                  <rect x={x0} y={y0} width={w} height={h} rx={2}
                    fill="#f4c266" fillOpacity={0.18} stroke="#f4c266" strokeWidth={1.5} strokeDasharray="6 4" pointerEvents="none" />
                )
              })()}

              {/* 关联高亮框（贴合格子风格，挂在格子包围盒外圈） */}
              {markers.map(mk => {
                if (!drawnIds.has(mk.id)) return null
                const lk = linked.get(mk.id)
                if (!lk) return null
                const vs = viewShapes.get(mk.id)
                if (!vs) return null
                const cx = vs.bbox.x + vs.bbox.w / 2, cy = vs.bbox.y + vs.bbox.h / 2
                const rr = Math.max(vs.bbox.w, vs.bbox.h) / 2
                const rings: string[] = []
                if (layers.foreshadow && lk.foreshadow.length) rings.push(LAYER_COLORS.foreshadow)
                if (layers.character && lk.character.length) rings.push(LAYER_COLORS.character)
                if (layers.timeline && lk.timeline.length) rings.push(LAYER_COLORS.timeline)
                if (rings.length === 0) return null
                return (
                  <g key={`ring-${mk.id}`} pointerEvents="none">
                    {rings.map((col, ri) => {
                      const pad = 6 + ri * 4
                      return (
                        <rect key={ri} x={cx - rr - pad} y={cy - rr - pad} width={(rr + pad) * 2} height={(rr + pad) * 2} rx={4}
                          fill="none" stroke={col} strokeWidth={2} strokeOpacity={0.85} />
                      )
                    })}
                  </g>
                )
              })}

            </g>
          </svg>
        </div>

        {/* 右侧详情 / 新增面板：高度与画布严格一致 */}
        <div className="w-80 shrink-0 border-l border-ink-700 bg-ink-850/60 overflow-y-auto">
          <div className="p-4">
            {addPos ? (
            <AddMarkerForm
              categories={categoryNames}
                parentOptions={markers.map(m => m.name)}
                onCancel={() => setAddPos(null)}
                onCreate={createMarker}
              />
            ) : selMarker ? (
              <DetailPanel
                marker={selMarker}
                linked={selLinked}
                cells={spaceShapes.get(selMarker.id)?.cells.size ?? 0}
                categories={categoryNames}
                painting={painting === selMarker.id}
                parentOptions={markers.filter(m => m.id !== selMarker.id).map(m => m.name)}
                onPatch={updateSelected}
                onClearPainted={clearCoords}
                onPaint={() => enterPaint(selMarker.id)}
                onDelete={deleteMarker}
                onGotoTable={gotoTable}
              />
            ) : (
              <div className="text-[12px] text-ink-400 space-y-3">
                <div className="flex items-center gap-2 text-ink-200"><Layers size={14} className="text-amber" /> 使用说明</div>
                <p>· <strong className="text-ink-200">手绘格子地图</strong>：形状完全由你亲手画。点「绘制地图」选择一个范围（<strong className="text-ink-200">建议从最大的范围开始</strong>），进入绘制模式后<strong className="text-ink-200">左键单击涂/擦一格</strong>。</p>
                <p>· <strong className="text-ink-200">批量填涂</strong>：绘制模式下<strong className="text-ink-200">按住左键拖出矩形框</strong>，松手把框内整批涂上；<strong className="text-ink-200">Shift+框选 = 批量擦除</strong>。右键单击退出绘制、右键拖动平移画布。</p>
                <p>· <strong className="text-ink-200">格子档位</strong>：右上角「精 / 粗」切换每格边长 1 公里（精细）或 10 公里（粗略），比例尺真实——切档后同一区域等比例缩放。画大陆切粗档快速铺满，画城池切回精档。</p>
                <p>· <strong className="text-ink-200">唯一规则</strong>：子范围必须完全画在父范围之内（无飞地）。越界涂格会被拒绝；擦父格时若被子孙占用也会提示先擦子孙。</p>
                <p>· <strong className="text-ink-200">颜色与图层</strong>：颜色由系统按层级自动调配（父子高对比、兄弟错开）；子空间格子叠涂在父空间之上，按「层级归属」自动分层。</p>
                <p>· <strong className="text-ink-200">挪位置</strong>：非绘制模式下按住空间拖动，整块格子（含其下所有子空间）按整格吸附平移。</p>
                <p>· 点击空间查看详情、继续绘制、跳转到表格编辑，或查看其上挂载的伏笔 / 角色 / 时间线（按「地理位置」字段联动）。</p>
                <p className="text-ink-500">《地理风物》只提供名称、类别与层级归属；「范围与面积」「相对地理位置」为自由文本备注。类别可在新增/详情面板的下拉里自定义。</p>
                <p className="text-ink-500">删除地点会连《地理风物》档案一起删；只想擦掉画好的格子请用「清空绘制」。</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 底部状态条：叠加图层 + 操作提示（颜色由系统按层级自动调配，不再按类别展示色卡） */}
      <div className="px-4 py-1.5 border-t border-ink-700 flex items-center gap-3 flex-wrap text-[10px] text-ink-400 shrink-0">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-[3px] rounded-full inline-block" style={{ background: '#8fb4e8' }} />
          颜色按层级自动调配（父子高对比 · 兄弟错开）
        </span>
        <span className="ml-auto flex items-center gap-3">
          {anyLayerOn && (
            <>叠加：
              {layers.foreshadow && <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: LAYER_COLORS.foreshadow }} />伏笔</span>}
              {layers.character && <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: LAYER_COLORS.character }} />角色</span>}
              {layers.timeline && <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: LAYER_COLORS.timeline }} />时间脉络</span>}
            </>
          )}
          <span className="text-ink-500">{painting ? '绘制中：左键涂/擦 · 拖动框选批量填涂（Shift=批量擦） · 右键退出/平移' : '单击空白新增 · 拖空白平移 · 滚轮缩放画面'}</span>
        </span>
      </div>

      {drawDialogOpen && (
        <DrawDialog
          rows={rows}
          drawnCells={new Map(markers.filter(m => (spaceShapes.get(m.id)?.cells.size ?? 0) > 0).map(m => [m.id, spaceShapes.get(m.id)!.cells.size]))}
          onPick={enterPaint}
          onClose={() => setDrawDialogOpen(false)}
        />
      )}
    </div>
  )
}

/** 「绘制地图」选择弹窗：按「层级归属」缩进展示所有地理范围，提醒从最大范围开始绘制 */
function DrawDialog({ rows, drawnCells, onPick, onClose }: {
  rows: TableRow[]; drawnCells: Map<string, number>
  onPick: (id: string) => void; onClose: () => void
}) {
  // 构建缩进树：按父链算深度，根=无父级或父名不存在
  const items = rows.map(r => {
    const parentName = r.data['层级归属'] || ''
    const namesSet = new Set(rows.map(x => x.data['名称'] || ''))
    let depth = 0
    let pName: string | '' = parentName
    while (pName && namesSet.has(pName)) { depth++; pName = rows.find(x => (x.data['名称'] || '') === pName)?.data['层级归属'] || ''; if (depth > 12) break }
    return { id: r.id, name: r.data['名称'] || '(未命名)', category: r.data['类别'] || '区域', depth }
  }).sort((a, b) => a.depth - b.depth)
  return (
    <Modal
      open
      onClose={onClose}
      title="绘制地图 · 选择一个地理范围"
      icon={<Pencil size={16} />}
      width={384}
      maxHeight="80vh"
      subheader={
        <div className="px-4 py-2.5 text-[11px] text-ink-300 bg-amber/5 border-b border-ink-700 leading-relaxed">
          建议<strong className="text-amber">从最大的范围开始绘制</strong>（如大陆 → 区域 → 城市），后画的范围会叠在先画的之上。
          绘制时形状与格子数不限，唯一规则：<strong className="text-amber">子范围必须完全画在父范围之内</strong>。
        </div>
      }
      bodyClassName="p-2"
    >
          {items.length === 0 && <div className="text-center text-ink-500 text-[12px] py-6">《地理风物》还没有条目，请先去登记。</div>}
          {items.map(it => (
            <Button variant="bare" key={it.id} onClick={() => onPick(it.id)}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-ink-800 transition-colors text-left"
              style={{ paddingLeft: 12 + it.depth * 18 }}>
              {it.depth > 0 && <span className="text-ink-500 text-[10px]">└</span>}
              <span className="text-[12.5px] text-ink-100">{it.name}</span>
              <span className="text-[10px] text-ink-500">{it.category}</span>
              {(drawnCells.get(it.id) ?? 0) > 0 && (
                <span className="ml-auto text-[10px] text-emerald-400/90">已画 {drawnCells.get(it.id)} 格</span>
              )}
            </Button>
          ))}
    </Modal>
  )
}

function AddMarkerForm({ categories, parentOptions, onCancel, onCreate }: {
  categories: string[]; parentOptions: string[];
  onCancel: () => void; onCreate: (name: string, category: string, parent: string) => void
}) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState(categories[1] ?? categories[0] ?? '区域')
  const [parent, setParent] = useState('')
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-ink-100 font-medium"><Plus size={14} className="text-amber" /> 就地新增地理范围</div>
      <Field label="名称"><input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onCreate(name, category, parent) }} className="w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50" placeholder="如：南荒秘境" /></Field>
      <Field label="类别（可在下拉里新增自定义类别）">
        <CustomSelect tabId="geography" colName="类别" options={categories} value={category} onChange={setCategory} />
      </Field>
      <Field label="层级归属（可选，父级区域；选后会被包进其父框）">
        <select value={parent} onChange={e => setParent(e.target.value)} className="w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50">
          <option value="">（无 / 顶级）</option>
          {parentOptions.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </Field>
      <div className="flex gap-2 pt-1">
        <Button variant="bare" disabled={!name.trim()} onClick={() => onCreate(name, category, parent)} className="flex-1 px-3 py-1.5 rounded-md bg-amber/20 text-amber border border-amber/40 text-[12px] hover:bg-amber/30 disabled:opacity-40 transition-colors">新增地点</Button>
        <Button onClick={onCancel} variant="secondary" size="md" className="text-[12px]">取消</Button>
      </div>
      <p className="text-[10px] text-ink-500 leading-relaxed">新增后会同时出现在《地理风物》里，其余字段（地貌、势力归属、行程时间等）可到表格补全。</p>
    </div>
  )
}

function DetailPanel({ marker, linked, cells, categories, parentOptions, painting, onPatch, onClearPainted, onPaint, onDelete, onGotoTable }: {
  marker: Marker; linked: Linked | undefined; cells: number; categories: string[]; parentOptions: string[];
  painting: boolean; onPatch: (patch: Record<string, string>) => void; onClearPainted: () => void; onPaint: () => void; onDelete: () => void; onGotoTable: () => void
}) {
  const [name, setName] = useState(marker.name)
  const [category, setCategory] = useState(marker.category)
  const [parent, setParent] = useState(marker.parent)
  useEffect(() => { setName(marker.name); setCategory(marker.category); setParent(marker.parent) }, [marker])

  const commit = (patch: Record<string, string>) => onPatch(patch)
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-ink-100 font-medium"><MapPin size={14} className="text-amber" /> {marker.name}</div>
      <div className="text-[11px] text-ink-400">当前形状：<span className="text-amber">{cells} 格</span>{painting && <span className="text-ink-500">（绘制中：左键涂/擦 · 右键退出）</span>}</div>
      <Button onClick={onPaint}
        disabled={painting} variant="primary" size="md" className="w-full flex items-center justify-center text-[12px]">
        <Pencil size={12} /> {cells > 0 ? '继续绘制此范围' : '绘制此范围'}
      </Button>
      <Field label="名称"><input value={name} onChange={e => setName(e.target.value)} onBlur={() => name.trim() && name !== marker.name && commit({ '名称': name.trim() })} className="w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50" /></Field>
      <Field label="类别（可在下拉里新增自定义类别）">
        <CustomSelect
          tabId="geography" colName="类别" options={categories} value={category}
          onChange={v => { setCategory(v); commit({ '类别': v }) }}
        />
      </Field>
      <Field label="层级归属（父级区域；选后会被包进其父框）">
        <select value={parent} onChange={e => { setParent(e.target.value); commit({ '层级归属': e.target.value }) }} className="w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50">
          <option value="">（无 / 顶级）</option>
          {parentOptions.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </Field>
      <Button variant="bare" onClick={() => commit({ '地图格子': '' })} title="清掉这个范围画好的所有格子，《地理风物》档案保留" className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-ink-700 text-[12px] text-ink-200 hover:text-amber hover:border-amber/40 transition-colors"><Eraser size={12} /> 清空此范围的绘制</Button>
      <Button onClick={onGotoTable} variant="secondary" size="md" className="w-full flex items-center justify-center text-[12px]"><ExternalLink size={12} /> 在《地理风物》中编辑</Button>

      {/* 关联列表 */}
      {linked && (linked.foreshadow.length > 0 || linked.character.length > 0 || linked.timeline.length > 0) && (
        <div className="pt-1 space-y-2">
          <div className="text-[11px] text-ink-500 uppercase tracking-wider">关联（按「地理位置」字段联动）</div>
          {linked.foreshadow.length > 0 && <LinkedList title="伏笔" color={LAYER_COLORS.foreshadow} items={linked.foreshadow.map(r => r.data['伏笔内容'] || r.data['编号'] || '（未命名）')} />}
          {linked.character.length > 0 && <LinkedList title="角色" color={LAYER_COLORS.character} items={linked.character.map(r => r.name)} />}
          {linked.timeline.length > 0 && <LinkedList title="时间脉络" color={LAYER_COLORS.timeline} items={linked.timeline.map(r => `${r.data['章节标题'] || r.data['章节号'] || ''}：${r.data['重要人物位置与状态'] || ''}`)} />}
        </div>
      )}

      <div className="flex gap-2 pt-2 border-t border-ink-700">
        <Button onClick={onClearPainted} title="清掉这个范围画好的所有格子，《地理风物》档案保留" variant="secondary" size="md" className="flex-1 flex items-center justify-center text-[11px]"><Eraser size={11} /> 清空绘制</Button>
        <Button onClick={onDelete} title="连《地理风物》档案一起删除，不可撤销" variant="danger" size="md" className="flex-1 flex items-center justify-center text-[11px]"><Trash2 size={11} /> 删除地点</Button>
      </div>
      <p className="text-[10px] text-ink-500 leading-relaxed">「清空绘制」= 只擦掉画好的格子，档案保留；「删除地点」= 《地理风物》条目连档案一起删除，不可撤销。</p>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] text-ink-400 mb-1">{label}</div>
      {children}
    </label>
  )
}

function LinkedListItem({ title, color, items }: { title: string; color: string; items: string[] }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] text-ink-300 mb-1"><span className="w-2 h-2 rounded-full inline-block" style={{ background: color }} />{title}（{items.length}）</div>
      <ul className="space-y-0.5 pl-3.5">
        {items.slice(0, 12).map((it, i) => <li key={i} className="text-[11px] text-ink-400 truncate" title={it}>{it}</li>)}
        {items.length > 12 && <li className="text-[11px] text-ink-600">…还有 {items.length - 12} 条</li>}
      </ul>
    </div>
  )
}
const LinkedList = LinkedListItem
