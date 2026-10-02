/**
 * 关系图的分组着色与凸包轮廓（纯函数，可单测）。
 *
 * 背景（2026-10-02 可视化升级）：两张关系图此前**只**把「关系类型」编码成边的颜色，
 * 节点一律同色纯圆 —— 看不出阵营分布。行业范例（如 AntV G6 官方哈利波特关系图）
 * 无一例外按「阵营 / 社群」给节点着色，并用凸包把同群组框起来。
 *
 * 本模块提供六件事：
 *   ① `groupColor` —— 按分组名稳定取色（同类同色、异类尽量异色）；
 *   ② `convexHull` —— Andrew 单调链求凸包（O(n log n)）；
 *   ③ `hullPath` —— 把凸包顶点外扩并圆角化，输出可直接用于 `<path d>` 的闭合路径；
 *   ④ `curvedEdge` / `curveMidpoint` —— 边弧线路径与中点（挂类型标签）；
 *   ⑤ `pairKey` / `edgeCurveRatios` —— 2.7.2「同一对多条关系」：无序对键 + 平行边分弧序列；
 *   ⑥ `curveArrow` —— 有向边终点的小箭头（标注「谁→谁」）。
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

/**
 * 无序对键：同一对实体的**所有**关系（含反向 A→B / B→A）归到同一条「走廊」，
 * 便于把平行边扇形铺开。2.7.2 起关系表的判重是**有向**的，但**视觉分组**仍按无序对 ——
 * 反向边只是一对端点间的另一条边，理应与正向边一起排布、而非被当成两条独立走廊。
 */
export function pairKey(a: string, b: string): string {
  return a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

/**
 * 平行边曲率序列：同一对端点之间有 k 条边时，按此序列**逐条外扩**，避免完全重叠。
 *
 * 🔴 为什么是**同号递增**而不是 `[-x, +x]` 对称分布：
 *    `curvedEdge` 的法向由「入参端点顺序」决定 —— 反向边（B→A）的法向自带翻转。
 *    因此**同号**会让「A→B 与 B→A」自然分居**两侧**（方向差异天然可见）；
 *    同向的多条边则落在同一侧、靠幅度差分离。若改成对称正负号，反向边会被翻到**同侧**、反而重叠。
 *
 * @param k    同一对之间的边数
 * @param base 首条曲率（约 0.18，与改造前单边视觉一致）
 * @param step 每条递增的曲率
 */
export function edgeCurveRatios(k: number, base = 0.18, step = 0.17): number[] {
  const n = Math.max(1, k)
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(Math.min(base + i * step, 0.75))
  return out
}

/**
 * 边终点（B 端）的**箭头三角形**路径 —— 用于「有向关系」标注方向。
 *
 * 取二次贝塞尔在 t=1 处的切向（B − 控制点），在离终点 `back` 处落一个指向该切向的小三角，
 * 避开节点圆盘、又贴合弧线走向。返回可直接用于 `<path d>` 的闭合路径；用边色填充。
 */
export function curveArrow(
  x1: number, y1: number, x2: number, y2: number,
  curveRatio = 0.18, back = 10, size = 5,
): string {
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const dx = x2 - x1
  const dy = y2 - y1
  const dist = Math.hypot(dx, dy) || 1
  const off = dist * curveRatio
  const cx = mx + (-dy / dist) * off
  const cy = my + (dx / dist) * off
  let tx = x2 - cx
  let ty = y2 - cy
  const tl = Math.hypot(tx, ty) || 1
  tx /= tl
  ty /= tl
  const tipx = x2 - tx * back
  const tipy = y2 - ty * back
  const basex = tipx - tx * size
  const basey = tipy - ty * size
  const px = -ty
  const py = tx
  const hw = size * 0.62
  return `M ${tipx.toFixed(1)} ${tipy.toFixed(1)}`
    + ` L ${(basex + px * hw).toFixed(1)} ${(basey + py * hw).toFixed(1)}`
    + ` L ${(basex - px * hw).toFixed(1)} ${(basey - py * hw).toFixed(1)} Z`
}
