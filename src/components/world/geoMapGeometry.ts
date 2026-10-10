/**
 * 地图编辑的几何与纯工具（2026-09-19 从 GeoMapEditor.tsx 抽出，D4 组件拆分收尾）。
 * 纯搬家：语句一字未改，只给原本私有的工具与类型补了 export。无 React 依赖，可单独测。
 */
import type { CardRecord, TableRow } from '@/lib/types'
import { MAP_LAYER_COLORS } from '@/lib/settings/palette'

/** 内置类别：必须与 schema.ts 中 geography 表「类别」列的内置选项保持一致 */
export const BUILTIN_CATEGORIES = ['大陆', '区域', '国家', '城市', '秘境', '禁地', '遗迹', '山脉']

// 🔴 值收口到单一真源 `lib/palette.ts`（2.8.0 · #045/#046）
export const LAYER_COLORS = MAP_LAYER_COLORS

/** 字符串 → 稳定数值（用于哈希色相） */
export function hashNum(t: string): number {
  let h = 0
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0
  return h
}

/** 结构化联动匹配：仅按「地理位置」字段精确匹配地名（根治模糊提及/同名异写导致的错乱）。 */
export function locEquals(v: unknown, name: string): boolean {
  const s = (v ?? '').toString().trim()
  return s !== '' && s === name.trim()
}
/** 角色卡数据以「模块::字段」为 key，取出「地理位置」字段值做精确匹配。 */
export function cardLocEquals(data: Record<string, string>, name: string): boolean {
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

export interface Marker { id: string; name: string; category: string; parent: string }
export interface Linked { foreshadow: TableRow[]; character: CardRecord[]; timeline: TableRow[] }

// ---------- 层级地理包含：树构建与包围盒 ----------
export function buildChildMap(markers: Marker[], nameToMarker: Map<string, Marker>): Map<string, Marker[]> {
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
export function subtreeIds(rootId: string, childMap: Map<string, Marker[]>): string[] {
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
