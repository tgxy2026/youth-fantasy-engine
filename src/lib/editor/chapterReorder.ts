/**
 * 键盘替代入口的**纯判据**（UX12：不许有"只能拖、键盘/读屏做不到"的操作）。
 *
 * 为什么单独成文件：拖拽重排的落点算在 `handleDrop` 里（要 dragKind/dragId/overKey 一堆状态），
 * 而「按一下 Alt+↓ 该跟谁换位」只需要**同一分组内按 order 排好的相邻项**。把它抽成纯函数，
 * 三条边界就能直接单测：
 *   · 已在第一个 / 最后一个 ⇒ 没有落点（不产生空操作与假"排序已保存"）；
 *   · 目标不在这一组里 ⇒ 不越权（章只能在自己卷内换位，卷只在真卷之间换）；
 *   · 落点位置必须是「before/after 相邻项」，与拖拽用同一套 `reorderChapters/Volumes` 语义。
 */

export type MoveDir = -1 | 1
export interface MoveTarget {
  /** 相邻那一项的 id（拖拽语义里的 overId） */
  id: string
  /** 插到它前面还是后面（与拖拽落点位置同口径） */
  pos: 'before' | 'after'
}

/** 在**同一分组**里找键盘移动的落点；到边界或找不到自己时返回 null */
export function keyboardNeighbor<T extends { id: string; order: number }>(
  list: T[],
  id: string,
  dir: MoveDir,
): MoveTarget | null {
  const sorted = [...list].sort((a, b) => a.order - b.order)
  const from = sorted.findIndex(x => x.id === id)
  if (from < 0) return null
  const to = from + dir
  if (to < 0 || to >= sorted.length) return null
  return { id: sorted[to].id, pos: dir < 0 ? 'before' : 'after' }
}

/** 这一步键盘移动是否有意义（界面据此决定是否给出提示/禁用提示） */
export function canMove<T extends { id: string; order: number }>(list: T[], id: string, dir: MoveDir): boolean {
  return keyboardNeighbor(list, id, dir) !== null
}
