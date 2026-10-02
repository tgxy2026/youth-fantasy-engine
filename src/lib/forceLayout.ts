/**
 * 通用确定性力导向布局（Fruchterman-Reingold 变体）。
 *
 * 为什么抽成公共模块：人物关系图（RelationGraph）与势力关系图（FactionGraph）都需要力导向布局，
 * 而此前**只有人物图**有实现、势力图用的是「纯圆环」均分排布 —— 两图既不是一套视觉语言，
 * 圆环在势力一多时又会挤成一圈糖葫芦。2026-10-02 可视化升级把两者统一到这一份实现，
 * 避免日后出现第三份分叉（同类教训见 `useSvgPanZoom.ts` 的分叉史）。
 *
 * 🔴 确定性：**不使用随机数**。初始位置按「等角圆环」播撒，同一份数据每次打开布局完全一致 ——
 *    读者对关系图建立的心智地图不会在每次打开时漂移。
 *
 * 🔴 复杂度：斥力为 O(n²)（与改造前一致）。调用方需自行限制节点数上限
 *    （RelationGraph 取度数 Top 80），否则大图会卡。
 */

export interface ForceEdgeInput {
  a: string
  b: string
}

export interface ForceExtraLink {
  a: string
  b: string
  /** 弹簧强度系数（0~1），作为额外弹簧与普通边叠加（如《国家势力》的「上级」吸附） */
  strength: number
}

export interface ForceLayoutOptions {
  /** 画布宽（世界坐标） */
  w: number
  /** 画布高（世界坐标） */
  h: number
  /** 迭代次数（默认 320，与改造前一致） */
  iterations?: number
  /** 初始圆环半径系数（默认 1/3，即半径 = min(w,h)/3） */
  initialRadiusRatio?: number
  /** 迭代初始温度（默认 w/8） */
  initialTemp?: number
  /** 每轮温度衰减（默认 0.95） */
  cooling?: number
  /** 额外弱弹簧（层级吸附等） */
  extraLinks?: ForceExtraLink[]
  /** 边界内边距（默认 30） */
  pad?: number
}

export type Positions = Map<string, { x: number; y: number }>

/**
 * 计算力导向布局，返回「节点名 → 坐标」映射。
 * 未出现在 names 里的边会被忽略（调用方应已做子图裁剪）。
 */
export function forceLayout(
  names: string[],
  edges: ForceEdgeInput[],
  opts: ForceLayoutOptions,
): Positions {
  const {
    w,
    h,
    iterations = 320,
    initialRadiusRatio = 1 / 3,
    initialTemp,
    cooling = 0.95,
    extraLinks = [],
    pad = 30,
  } = opts

  const n = names.length
  const pos: Positions = new Map()
  if (n === 0) return pos
  if (n === 1) {
    pos.set(names[0], { x: w / 2, y: h / 2 })
    return pos
  }

  // 初始布局：等角圆环（确定性）
  const r0 = Math.min(w, h) * initialRadiusRatio
  names.forEach((nm, i) => {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2
    pos.set(nm, { x: w / 2 + Math.cos(ang) * r0, y: h / 2 + Math.sin(ang) * r0 })
  })

  // 理想边长 k（FR 算法标准式）
  const k = Math.sqrt((w * h) / n)
  let temp = initialTemp ?? w / 8
  const disp = new Map<string, { x: number; y: number }>()

  for (let iter = 0; iter < iterations; iter++) {
    for (const nm of names) disp.set(nm, { x: 0, y: 0 })

    // 斥力：所有节点两两相斥
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const u = names[i]
        const v = names[j]
        const pu = pos.get(u)!
        const pv = pos.get(v)!
        const dx = pu.x - pv.x
        const dy = pu.y - pv.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01
        const f = (k * k) / dist
        const fx = (dx / dist) * f
        const fy = (dy / dist) * f
        const du = disp.get(u)!
        const dv = disp.get(v)!
        du.x += fx
        du.y += fy
        dv.x -= fx
        dv.y -= fy
      }
    }

    // 引力：有边的节点互相吸引
    for (const e of edges) {
      const pu = pos.get(e.a)
      const pv = pos.get(e.b)
      if (!pu || !pv) continue
      const dx = pu.x - pv.x
      const dy = pu.y - pv.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01
      const f = (dist * dist) / k
      const fx = (dx / dist) * f
      const fy = (dy / dist) * f
      const du = disp.get(e.a)!
      const dv = disp.get(e.b)!
      du.x -= fx
      du.y -= fy
      dv.x += fx
      dv.y += fy
    }

    // 额外弱弹簧（如「上级」层级吸附）
    for (const e of extraLinks) {
      const pu = pos.get(e.a)
      const pv = pos.get(e.b)
      if (!pu || !pv) continue
      const dx = pu.x - pv.x
      const dy = pu.y - pv.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01
      const f = ((dist * dist) / k) * e.strength
      const fx = (dx / dist) * f
      const fy = (dy / dist) * f
      const du = disp.get(e.a)!
      const dv = disp.get(e.b)!
      du.x -= fx
      du.y -= fy
      dv.x += fx
      dv.y += fy
    }

    // 位移 + 限温 + 边界钳制
    // 🔴 边界钳制本身就是「防飘出视野」的手段 —— 2026-10-02 曾加过一个 `centerGravity` 中心弱引力，
    //    实测（tests/graphVisual 探针）发现它要 gravity≈2 才生效：斥力是 `k²/dist`、引力若写成
    //    `dist×gravity` 则量纲不匹配，小值完全无效。既然边界钳制已保证节点不跑出视野，
    //    这个「调不到直觉区间」的参数只会误导后来者，故删除。
    for (const nm of names) {
      const p = pos.get(nm)!
      const d = disp.get(nm)!
      const len = Math.sqrt(d.x * d.x + d.y * d.y) || 0.01
      const step = Math.min(len, temp)
      p.x += (d.x / len) * step
      p.y += (d.y / len) * step
      p.x = Math.max(pad, Math.min(w - pad, p.x))
      p.y = Math.max(pad, Math.min(h - pad, p.y))
    }

    temp *= cooling
  }

  return pos
}
