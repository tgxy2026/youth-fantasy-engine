/**
 * 「纯黑白」主题 · 图表**第二编码**（3.1.1 第 3 项）
 *
 * 【要解决的问题】
 * 图谱 / 地图 / 情节画布 / 结构节奏带里的类别，原本**只靠颜色**区分
 * （`lib/palette.ts` 的 `REL_*` / `GROUP_*` / `MAP_*` / `PLOT_*` / `BEAT_COLORS`）。
 * 切到「纯黑白」后这些固定 hex 收成同一色 ⇒ 类别**彻底分不出来**。
 *
 * 【做法】把「类别」搬到颜色之外的通道上 —— 本模块提供两套循环档位：
 *   · **线型**（`MONO_DASHES`）：把 `strokeDasharray` 按名称哈希稳定分配；
 *   · **形状**（`MONO_SHAPES`）：把节点 / 标记的外形按名称哈希稳定分配。
 * 哈希保证「同一类别处处同形、跨次打开稳定」，正是验收口径 1 要的「同类同形、异类异形」。
 *
 * 🔴 三原则：
 *   ① **只在 mono 下启用** —— 其他主题的语义色一字不动（验收口径 3）；
 *   ② **不引入裸色值** —— 黑白一律取 `rgb(var(--ink-xxx))`，由主题变量决定（结构闸 ⑨）；
 *   ③ **纯函数、零 React / 零 DOM** —— 便于单测，也避免 lib 反向依赖 components。
 */
import { typeHash } from '@/lib/world/relationColors'

/**
 * 线型档位（第一档为实线）。
 * 🔴 档数刻意取 6：内置类型最多 8 类（人物关系），相邻档视觉差异足够大到一眼可辨；
 *    超出后循环复用 —— 循环内同名仍同线型，不会前后不一。
 */
export const MONO_DASHES: readonly string[] = ['', '7 5', '2 4', '10 4', '4 2 1 2', '1 3']

/** 形状档位 */
export const MONO_SHAPES = ['circle', 'square', 'diamond', 'triangle', 'pentagon', 'cross'] as const
export type MonoShape = typeof MONO_SHAPES[number]

/** 名称 → 线型（`''` 表示实线；调用方直接喂给 `strokeDasharray`，空串即无虚线） */
export function monoDashOf(key: string): string {
  return MONO_DASHES[typeHash(key) % MONO_DASHES.length]
}

export function monoShapeOf(key: string): MonoShape {
  return MONO_SHAPES[typeHash(key) % MONO_SHAPES.length]
}

/**
 * 按**首次出现顺序**分配线型 / 形状 —— 同一张图内**互不相同**（档位用尽才回绕）。
 *
 * 🔴 为什么不能只用哈希：哈希只保证「同名同档、跨次稳定」，**不保证同图内两个不同类别档位不同**
 *    （6 档下 3~4 个类别就有可观概率撞上）。而验收口径要的是「异类异形」——
 *    同一张图里两类共用一种线型，等于没区分开。故对「图内已知的类别集合」按序分配，
 *    集合外的散值再回落哈希（仍是稳定值）。
 */
export function monoDashLookup(keys: readonly string[]): (key: string) => string {
  const m = new Map<string, string>()
  for (const k of keys) if (!m.has(k)) m.set(k, MONO_DASHES[m.size % MONO_DASHES.length])
  return (k: string) => m.get(k) ?? monoDashOf(k)
}

export function monoShapeLookup(keys: readonly string[]): (key: string) => MonoShape {
  const m = new Map<string, MonoShape>()
  for (const k of keys) if (!m.has(k)) m.set(k, MONO_SHAPES[m.size % MONO_SHAPES.length])
  return (k: string) => m.get(k) ?? monoShapeOf(k)
}

/**
 * mono 下的**填充纹理**（给 HTML/CSS 用）：以不同角度 / 疏密的黑线替代颜色区分。
 *
 * 🔴 色值一律走 `rgb(var(--ink-100))`（mono 下即纯黑），**不写裸色** —— 结构闸 ⑨ 要求色值单一真源；
 *    而 CSS 的 `background-image` 能解析 `var()`（不同于 SVG 表现属性），故这里安全。
 */
const MONO_HATCH_ANGLES = [45, -45, 0, 90, 22, -22]
const MONO_HATCH_GAPS = [6, 5, 4, 7, 5, 6]

export function monoHatchBackground(i: number): string {
  const angle = MONO_HATCH_ANGLES[i % MONO_HATCH_ANGLES.length]
  const gap = MONO_HATCH_GAPS[i % MONO_HATCH_GAPS.length]
  return `repeating-linear-gradient(${angle}deg, rgb(var(--ink-100)) 0 1px, transparent 1px ${gap}px)`
}

/** 卡片边框可用的线型档位（CSS `border-style`） */
export const MONO_BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double'] as const

/**
 * mono 下的**卡片边框**档位：线型 × 粗细组合。
 * 🔴 只有 4 种 CSS 线型，而情节画布有 6 类卡片 ⇒ 靠「前四类细、后两类粗」补足到 6 个互不相同的组合。
 */
export function monoCardBorder(i: number): { borderStyle: typeof MONO_BORDER_STYLES[number]; borderWidth: number } {
  const style = MONO_BORDER_STYLES[i % MONO_BORDER_STYLES.length]
  const width = style === 'double' ? 3 : (i < MONO_BORDER_STYLES.length ? 1 : 2)
  return { borderStyle: style, borderWidth: width }
}

/**
 * 形状 → SVG path（以 (cx,cy) 为中心、外接半径 r）。
 *
 * ⚠️ 一律以 path 表达（不用 `<circle>` / `<polygon>` 混搭）：调用点只需把原来的
 *    `<circle cx cy r>` 换成 `<path d={…}>`，其余属性（fill / stroke / dasharray）原样沿用。
 */
export function monoShapePath(shape: MonoShape, cx: number, cy: number, r: number): string {
  const pt = (angle: number, radius = r) => [
    +(cx + radius * Math.cos(angle)).toFixed(2),
    +(cy + radius * Math.sin(angle)).toFixed(2),
  ] as const
  const poly = (n: number, rotate = -Math.PI / 2) => {
    const parts: string[] = []
    for (let i = 0; i < n; i++) {
      const [x, y] = pt(rotate + (i * 2 * Math.PI) / n)
      parts.push(`${i === 0 ? 'M' : 'L'} ${x} ${y}`)
    }
    return `${parts.join(' ')} Z`
  }
  switch (shape) {
    case 'circle':
      return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
    case 'square': {
      const s = r * 0.82
      return `M ${cx - s} ${cy - s} L ${cx + s} ${cy - s} L ${cx + s} ${cy + s} L ${cx - s} ${cy + s} Z`
    }
    case 'diamond':
      return `M ${cx} ${cy - r * 1.15} L ${cx + r * 1.15} ${cy} L ${cx} ${cy + r * 1.15} L ${cx - r * 1.15} ${cy} Z`
    case 'triangle':
      return poly(3)
    case 'pentagon':
      return poly(5)
    case 'cross': {
      const a = r * 0.95, b = r * 0.36
      return `M ${cx - b} ${cy - a} L ${cx + b} ${cy - a} L ${cx + b} ${cy - b} L ${cx + a} ${cy - b} L ${cx + a} ${cy + b}`
        + ` L ${cx + b} ${cy + b} L ${cx + b} ${cy + a} L ${cx - b} ${cy + a} L ${cx - b} ${cy + b}`
        + ` L ${cx - a} ${cy + b} L ${cx - a} ${cy - b} L ${cx - b} ${cy - b} Z`
    }
  }
}
