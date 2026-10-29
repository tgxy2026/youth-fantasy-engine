// ============ 引导高亮与卡片的几何计算（纯函数，可单测） ============
//
// 为什么要单独抽出来算：
//   · 高亮框必须**正好**套住目标（含 80%～160% 界面缩放、分栏拖动、窗口 resize 之后）；
//   · 卡片不能盖住被高亮的区域，也不能跑出视口；
//   · 这两件事都是纯算术，放进组件里就只能靠肉眼看 —— 拿不到可回归的证据。
//
// 🔴 只用「视口坐标」（`getBoundingClientRect` 的原样值），**不再乘除缩放系数**。
//    应用缩放是通过改变根字号 / zoom 生效的，`getBoundingClientRect` 已经反映了最终像素位置；
//    再乘一次就会错位（规划 §3.4 明确点出这条坑）。

export interface GuidePoint {
  top: number
  left: number
  width: number
  height: number
}

export interface GuideLayoutInput {
  /** 目标矩形；null = 这一步没有高亮目标（居中说明） */
  target: GuidePoint | null
  viewport: { width: number; height: number }
  card: { width: number; height: number }
  /** 高亮框相对目标外扩多少像素 */
  pad?: number
  /** 卡片与高亮框的最小间距 */
  gap?: number
  /** 卡片距视口边缘的安全边距 */
  margin?: number
}

export type GuideCardPlacement = 'below' | 'above' | 'center' | 'bottom'

export interface GuideLayout {
  /** 高亮孔（视口坐标，已夹到视口内）；null = 整屏变暗 */
  hole: GuidePoint | null
  card: { top: number; left: number }
  placement: GuideCardPlacement
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

export function computeGuideLayout({
  target, viewport, card, pad = 8, gap = 12, margin = 12,
}: GuideLayoutInput): GuideLayout {
  const cardWidth = Math.min(card.width, Math.max(0, viewport.width - margin * 2))
  const left = clamp(
    target ? target.left + target.width / 2 - cardWidth / 2 : viewport.width / 2 - cardWidth / 2,
    margin,
    Math.max(margin, viewport.width - cardWidth - margin),
  )

  if (!target) {
    // 无目标：垂直居中，读起来最稳
    return {
      hole: null,
      card: { top: clamp(viewport.height / 2 - card.height / 2, margin, Math.max(margin, viewport.height - card.height - margin)), left },
      placement: 'center',
    }
  }

  const hole: GuidePoint = {
    top: clamp(target.top - pad, 0, viewport.height),
    left: clamp(target.left - pad, 0, viewport.width),
    width: clamp(target.width + pad * 2, 0, viewport.width),
    height: clamp(target.height + pad * 2, 0, viewport.height),
  }
  hole.width = Math.min(hole.width, viewport.width - hole.left)
  hole.height = Math.min(hole.height, viewport.height - hole.top)

  const belowTop = hole.top + hole.height + gap
  const aboveTop = hole.top - gap - card.height
  const roomBelow = viewport.height - belowTop - margin
  const roomAbove = hole.top - gap - margin
  // 目标占据了大半屏（如整块正文）：卡片贴底，别硬塞在缝里
  if (hole.height > viewport.height * 0.65) {
    return { hole, card: { top: clamp(viewport.height - card.height - margin, margin, viewport.height), left }, placement: 'bottom' }
  }
  if (roomBelow >= card.height) return { hole, card: { top: belowTop, left }, placement: 'below' }
  if (roomAbove >= card.height) return { hole, card: { top: aboveTop, left }, placement: 'above' }
  // 上下都放不下（小窗口）：卡片贴底并允许内部滚动 —— 保持步骤与退出可达（规划 §3.4）
  return { hole, card: { top: clamp(viewport.height - card.height - margin, margin, viewport.height), left }, placement: 'bottom' }
}

/** 四块遮罩（上 / 下 / 左 / 右）—— 中间留出高亮孔，同时把背景点击全部吃掉 */
export function guideMasks(hole: GuidePoint | null, viewport: { width: number; height: number }): GuidePoint[] {
  if (!hole) return [{ top: 0, left: 0, width: viewport.width, height: viewport.height }]
  const right = hole.left + hole.width
  const bottom = hole.top + hole.height
  return [
    { top: 0, left: 0, width: viewport.width, height: Math.max(0, hole.top) },
    { top: bottom, left: 0, width: viewport.width, height: Math.max(0, viewport.height - bottom) },
    { top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height },
    { top: hole.top, left: right, width: Math.max(0, viewport.width - right), height: hole.height },
  ]
}
