/**
 * 关系图的分组着色与凸包轮廓（纯函数，可单测）。
 *
 * 背景（2026-10-02 可视化升级）：两张关系图此前**只**把「关系类型」编码成边的颜色，
 * 节点一律同色纯圆 —— 看不出阵营分布。行业范例（如 AntV G6 官方哈利波特关系图）
 * 无一例外按「阵营 / 社群」给节点着色，并用凸包把同群组框起来。
 *
 * 本模块提供三件事：
 *   ① `groupColor` —— 按分组名稳定取色（同类同色、异类尽量异色）；
 *   ② `convexHull` —— Andrew 单调链求凸包（O(n log n)）；
 *   ③ `hullPath` —— 把凸包顶点外扩并圆角化，输出可直接用于 `<path d>` 的闭合路径。
 */

export interface Pt {
  x: number
  y: number
}

/**
 * 分组类别色板（节点色 = 阵营 / 类别）。
 * 🔴 与「关系类型」的边色板是两套语义：节点色说「你属于谁」，边色说「你们什么关系」。
 * 取色策略与既有 `TYPE_COLORS` / `REL_COLORS` 一致 —— 内置色精调、未收录的按名称哈希稳定取色。
 */
export const GROUP_PALETTE = [
  '#4f8ff7', '#e06c9f', '#3fb98f', '#e8a33d', '#9b7ff0', '#e07a5f',
  '#3fa9c9', '#8fb04a', '#d46a8a', '#6f86e0', '#c9913f', '#5fae9b',
]

/** 无分组（不属于任何阵营）时的中性色 */
export const GROUP_NEUTRAL = '#8b8680'

/** 按分组名稳定取色：同一分组名恒定同色 */
export function groupColor(name: string): string {
  if (!name) return GROUP_NEUTRAL
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return GROUP_PALETTE[h % GROUP_PALETTE.length]
}

/** 按 key 分组，保持首次出现顺序（比 Map 手写更不易出错） */
export function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const it of items) {
    const k = keyFn(it)
    const arr = m.get(k)
    if (arr) arr.push(it)
    else m.set(k, [it])
  }
  return m
}

/** 叉积：> 0 表示 o→a→b 逆时针 */
function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

/**
 * Andrew 单调链求凸包。返回构成凸包的顶点（不含共线的中间点）。
 * 点数 ≤ 2 时原样返回（调用方自行决定退化画法）。
 */
export function convexHull(pts: Pt[]): Pt[] {
  if (pts.length <= 2) return pts.slice()
  const p = [...pts].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x))
  const lower: Pt[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Pt[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

function unit(dx: number, dy: number): Pt {
  const len = Math.hypot(dx, dy) || 1
  return { x: dx / len, y: dy / len }
}

/**
 * 由凸包顶点生成「外扩 + 圆角」的闭合 SVG 路径。
 *
 * 做法：每个顶点沿「远离质心」方向外推 `pad`，让轮廓留出呼吸感；
 * 再在每个顶点处沿两条边各退让 `corner`，用二次贝塞尔切角，
 * 避免出现「直棱直角」的硬边框 —— 与关系图弧线的柔和气质一致。
 *
 * @param pts   凸包顶点（通常来自 convexHull）
 * @param pad   外扩距离
 * @param corner 圆角半径上限
 */
export function hullPath(pts: Pt[], pad = 18, corner = 20): string {
  if (pts.length === 0) return ''
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  const grown = pts.map(p => {
    const u = unit(p.x - cx, p.y - cy)
    return { x: p.x + u.x * pad, y: p.y + u.y * pad }
  })

  if (grown.length === 1) {
    const r = pad + 8
    const p = grown[0]
    return `M ${(p.x - r).toFixed(1)} ${p.y.toFixed(1)} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`
  }
  if (grown.length === 2) {
    const [a, b] = grown
    const u = unit(b.x - a.x, b.y - a.y)
    const nx = -u.y
    const ny = u.x
    const r = pad + 8
    return [
      `M ${(a.x + nx * r).toFixed(1)} ${(a.y + ny * r).toFixed(1)}`,
      `L ${(b.x + nx * r).toFixed(1)} ${(b.y + ny * r).toFixed(1)}`,
      `A ${r} ${r} 0 0 1 ${(b.x - nx * r).toFixed(1)} ${(b.y - ny * r).toFixed(1)}`,
      `L ${(a.x - nx * r).toFixed(1)} ${(a.y - ny * r).toFixed(1)}`,
      `A ${r} ${r} 0 0 1 ${(a.x + nx * r).toFixed(1)} ${(a.y + ny * r).toFixed(1)}`,
      'Z',
    ].join(' ')
  }

  const n = grown.length
  let d = ''
  for (let i = 0; i < n; i++) {
    const prev = grown[(i - 1 + n) % n]
    const cur = grown[i]
    const next = grown[(i + 1) % n]
    const v1 = unit(prev.x - cur.x, prev.y - cur.y)
    const v2 = unit(next.x - cur.x, next.y - cur.y)
    const r = Math.min(
      corner,
      Math.hypot(prev.x - cur.x, prev.y - cur.y) / 2,
      Math.hypot(next.x - cur.x, next.y - cur.y) / 2,
    )
    const p1 = { x: cur.x + v1.x * r, y: cur.y + v1.y * r }
    const p2 = { x: cur.x + v2.x * r, y: cur.y + v2.y * r }
    d += i === 0 ? `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}` : ` L ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`
    d += ` Q ${cur.x.toFixed(1)} ${cur.y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
  }
  return d + ' Z'
}

/**
 * 边的弯曲路径：以两点中点为基准、沿垂直于连线方向偏移 `curveRatio × 边长` 控制点。
 *
 * 🔴 为什么要弯曲：直线边在「同一对节点多条关系」或「相邻对角线」时会完全重叠，
 *    行业惯例（Visual Complexity）是给 0.15~0.25 × 边长的曲率来分离平行边。
 *    曲率方向由两端节点的相对次序决定，因此同一条边每次渲染弯曲方向一致（确定性）。
 */
export function curvedEdge(x1: number, y1: number, x2: number, y2: number, curveRatio = 0.18): string {
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const dx = x2 - x1
  const dy = y2 - y1
  const dist = Math.hypot(dx, dy) || 1
  // 单位法向量（逆时针旋转 90°）
  const nx = -dy / dist
  const ny = dx / dist
  const off = dist * curveRatio
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${(mx + nx * off).toFixed(1)} ${(my + ny * off).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`
}

/** 弧度采样：把曲线中点算出来（用于给弧线挂类型标签） */
export function curveMidpoint(x1: number, y1: number, x2: number, y2: number, curveRatio = 0.18): Pt {
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const dx = x2 - x1
  const dy = y2 - y1
  const dist = Math.hypot(dx, dy) || 1
  const off = dist * curveRatio
  // 二次贝塞尔 t=0.5 处的点 = (P0 + 2C + P2) / 4
  const cxC = mx + (-dy / dist) * off
  const cyC = my + (dx / dist) * off
  return { x: (x1 + 2 * cxC + x2) / 4, y: (y1 + 2 * cyC + y2) / 4 }
}
