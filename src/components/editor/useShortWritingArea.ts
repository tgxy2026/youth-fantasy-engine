/**
 * 「正文区还够不够写」的判定（3.3.0 · UX06 顺手修）。
 *
 * 【为什么需要】
 *   实测（2026-10-26，1000×640 窗口 + 160% 界面缩放 ⇒ 可用区约 625×400 CSS px）：
 *   标题行 + 换行成三排的工具行 + 底部状态栏之后，正文 textarea 只剩 **56px** ——
 *   写不了几行；而外面是 `overflow-hidden`，作者连滚都滚不到那一小块。
 *   常规窗口完全不需要这个判定，所以做成"矮了才生效"的开关，而不是全局改布局。
 *
 * 🔴 量的是**正文壳本身**（`scrollRef`），不是三栏区：
 *   三栏区含工具栏、高度基本等于整页 ⇒ 永远不触发（第一版就量错对象，测量脚本读数仍 56px 才暴露）。
 * 🔴 不会自激：正文壳高度由 flex 分配决定；给内容层 `min-height` 只会让壳**滚动**，不改壳自身高度。
 *
 * 用法：`const { shortBody, minHeight } = useShortWritingArea(scrollRef, loaded)`
 *   · shortBody 为 true 时：壳改 `overflow-y-auto`、内容层 `shrink-0` + `minHeight` 保底。
 */
import { useEffect, useState, type MutableRefObject, type RefObject } from 'react'

/** 太矮时给正文区的保底高度（CSS px，随界面缩放一起放大） */
export const WRITING_MIN_H = 240
/** 低于这个高度就认为「写不了字」（含工具栏换行后的极端档） */
const SHORT_THRESHOLD = 260

export function useShortWritingArea(
  scrollRef: RefObject<HTMLDivElement> | MutableRefObject<HTMLDivElement | null>,
  loaded: boolean,
): { shortBody: boolean; minHeight: number } {
  const [bodyH, setBodyH] = useState(0)
  // 依赖必须带 `loaded`：`!loaded` 时渲染的是 LoadingState，那时正文壳还没挂上，
  // 依赖写成 [] 就只在挂载时白跑一趟，之后 height 恒为 0、判定永远 false。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const read = () => setBodyH(el.clientHeight)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [loaded, scrollRef])
  return { shortBody: bodyH > 0 && bodyH < SHORT_THRESHOLD, minHeight: WRITING_MIN_H }
}
