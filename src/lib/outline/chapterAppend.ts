// ============ 「新建最新章节」与「卷内追加」的纯判据 ============
//
// 背景（2026-10-30 · 临时需求）：章节树右上原来只有一个「新建自由章节」。
// 作者最常见的动作其实是「接着上一章往后写」—— 那应当挂到**最后一卷的末尾**，
// 并且正文序号自动接下去；而「自由章节」是另一条意图（不想归卷、排全书最前、不占正文序号）。
//
// 两个意图混在一个按钮里会误导人，所以拆成两个入口；本文件只放**判定规则**，不碰 React、不碰库。
//
// 🔴 三条口径（改动前先读）：
//   1. **「最新的一卷」＝真卷里 order 最大的那个**。自由卷用哨兵 order（负数，见 `FREE_VOLUME_ORDER`），
//      它恒排最前、且不是「正文的最后一卷」—— 直接取 `volumes` 最大值会把它选中，那就挂错地方了。
//   2. **卷内追加序号＝该卷现有最大 order + 1，不是 `章节数`**。删过章之后两者会分叉：
//      例如卷内 order 是 0、2（中间的 1 被删），`length` 算出来是 2 —— 与既有 order 撞号，
//      排序就开始抖。这条是本次顺手修掉的既有隐患。
//   3. **没有任何真卷时返回 null**，由调用方决定是提示还是退回「自由章节」—— 本文件不替 UI 做决定。
import type { Chapter, Volume } from '@/lib/types'

/** 最新的一卷（真卷里 order 最大）；没有真卷返回 null */
export function latestRealVolume(volumes: readonly Volume[]): Volume | null {
  let best: Volume | null = null
  for (const v of volumes) {
    if (!v || v.isFree) continue
    if (!best || v.order > best.order) best = v
  }
  return best
}

/** 该卷内下一章的 order（现有最大值 + 1；空卷为 0） */
export function nextOrderInVolume(chapters: readonly Chapter[], volumeId: string): number {
  let max = -1
  for (const c of chapters) {
    if (!c || c.volumeId !== volumeId) continue
    const o = Number(c.order)
    if (Number.isFinite(o) && o > max) max = o
  }
  return max + 1
}

/**
 * 「新建最新章节」的落点：卷 + 序号。
 * @returns null 表示当前没有任何真卷（调用方应提示或改用自由章节）
 */
export function latestChapterTarget(
  volumes: readonly Volume[],
  chapters: readonly Chapter[],
): { volumeId: string; volumeTitle: string; order: number } | null {
  const vol = latestRealVolume(volumes)
  if (!vol) return null
  return { volumeId: vol.id, volumeTitle: vol.title, order: nextOrderInVolume(chapters, vol.id) }
}
