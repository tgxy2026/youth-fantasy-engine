import { REL_EXTRA_PALETTE } from './palette'

/**
 * 关系边配色（人物关系图 / 势力关系图共用 · 纯函数，可单测）。
 *
 * 背景（2.7.2）：两张图此前**各自**维护一套「内置色板 + 自定义哈希兜底」，导致
 *   ① 同一「敌对」在两张图里颜色不同（视觉语言不统一）；
 *   ② 自定义类型哈希取色**会撞色** —— 16 色板 + 生日悖论，5 个以上自定义类型几乎必有两两同色，
 *      还可能恰好撞上某个内置类型的颜色（图上两条边同色不同义）。
 *
 * 主人哥哥拍板（2.7.2）：**保持哈希取色**（同一类型处处同色、跨表 / 跨项目 / 跨次打开都稳定），
 * 同时补一道**撞色兜底** —— 由「本图实际出现的类型集合」构建 类型→颜色 映射：
 *   · 内置类型取精调语义色并占用色槽；
 *   · 自定义类型按名称哈希落槽，若该槽已被占用，**顺延**到最近的空槽（线性探测，最多绕一圈）。
 * ⇒ 同图内**互不同色**；不发生碰撞时与纯哈希法**逐位一致**（零回归）。
 *
 * ⚠️ 已知代价（主人已知悉）：某自定义类型的颜色可能随「同图里还有哪些类型」而微调。
 *    换来的是「同图绝不两两撞色」；且行的顺序稳定 ⇒ 同一份数据每次打开颜色一致。
 */

// 🔴 色板本体已收口到单一真源 `lib/palette.ts`（2.8.0 · #045/#046）；本模块只再导出，既有引用不破。
export { REL_EXTRA_PALETTE }

/** 名称 → 稳定哈希（与既有实现同算法：同类同哈希） */
export function typeHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

/** 纯哈希取色（不做撞色兜底）—— 兜底外的兜底：类型集合里没喂进来的散值也能取到色 */
export function hashColor(name: string, palette: string[] = REL_EXTRA_PALETTE): string {
  if (!name) return palette[0]
  return palette[typeHash(name) % palette.length]
}

/**
 * 由「本图出现的类型集合」构建 类型→颜色 映射。
 *
 * @param types   本图实际出现的类型（**按稳定顺序**传入 —— 通常是边首次出现的顺序）
 * @param preset  内置类型 → 语义色（各表不同：人物关系 8 类 / 势力关系 5 类）
 * @param palette 自定义类型用的扩展色板
 */
export function buildTypeColors(
  types: string[],
  preset: Record<string, string>,
  palette: string[] = REL_EXTRA_PALETTE,
): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  const customs: string[] = []
  for (const t of types) {
    if (out.has(t)) continue
    const p = preset[t]
    if (p) {
      out.set(t, p)
      used.add(p)
    } else {
      customs.push(t)
    }
  }
  for (const t of customs) {
    let idx = typeHash(t) % palette.length
    let c = palette[idx]
    // 撞色兜底：顺延到最近的空槽（最多绕一圈，色板用尽则回绕复用）
    let guard = 0
    while (used.has(c) && guard < palette.length) {
      idx = (idx + 1) % palette.length
      c = palette[idx]
      guard++
    }
    out.set(t, c)
    used.add(c)
  }
  return out
}

/**
 * 便捷查色：命中映射用映射色，未命中（类型集合没喂进来）回落纯哈希。
 * 组件里可 `const colorOf = makeColorLookup(colors)` 一次生成。
 */
export function makeColorLookup(colors: Map<string, string>, palette: string[] = REL_EXTRA_PALETTE) {
  return (name: string): string => colors.get(name) ?? hashColor(name, palette)
}
