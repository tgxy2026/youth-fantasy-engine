/**
 * 横向「按住拖动平移」（拖拽滚动）—— 给宽表格用的抓手。
 *
 * 【为什么需要它】宽表格看右侧信息的老路数是：滚到表格底部 → 找到横向滚动条 → 拖过去 → 再滚回来。
 *   一次两次还能忍，一张几十列的表能把人逼疯。改成「左键按住表格左右一拖」直接平移。
 *
 * 【只认左键】主人 2026-10-17 拍板：原口径「左键或右键都能拖」，review 时改成
 *   「保留一个常用的就好」—— 左键是绝大多数软件（设计工具 / 图表 / 文件列表）的拖拽平移习惯；
 *   右键还带来两个纯负担：① 必须拦系统右键菜单；② 用户会猜「右键是不是有别的意思」。
 *   ⇒ 这里只认 `button === 0`，且**不再**有 `onContextMenu`（表格本来就没有自有右键菜单，右键就是系统菜单）。
 *
 * 【三个必须处理的冲突】
 *   ① **单击编辑 vs 拖拽**：按下后位移超过 `threshold`（默认 4px）才算拖拽；没超过就还是普通点击
 *      （该进单元格编辑照常进）。拖拽一旦成立，随后那次 `click` 在捕获阶段被吃掉 —— 否则会
 *      「拖完表格，顺手把某个单元格也点开了」。
 *   ② **列宽手柄 / 表头筛选框**：`th` 右侧有个 `cursor-col-resize` 的拖柄（调列宽），
 *      表头还有 select / input（筛选）。这些区域标了 `data-nodrag` / 本身是表单元素 ⇒ mousedown 直接放行，
 *      不启动平移，否则「拖一拖表格」会把列宽改了、把筛选框聚焦打断。
 *   ③ **文本选中**：拖拽中给容器加 `select-none`，不然一拖就把整张表的文字选成一片蓝。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export interface UsePanScrollOptions {
  /** 超过多少像素才算「拖拽」而非「点击」（默认 4） */
  threshold?: number
}

export interface PanScrollHandlers {
  onMouseDown: (e: React.MouseEvent) => void
  onMouseMove: (e: React.MouseEvent) => void
  onMouseUp: () => void
  onMouseLeave: () => void
}

export function usePanScroll<T extends HTMLElement = HTMLElement>(
  opts: UsePanScrollOptions = {},
): {
  ref: RefObject<T>
  handlers: PanScrollHandlers
  /** 是否正在拖拽（调用方用来切光标 / 禁选中） */
  dragging: boolean
} {
  // 配置走 ref：调用方多半直接 `usePanScroll()`（每次渲染新建 opts 对象），
  // 若把 threshold 放进依赖数组会让回调每次重建 —— 那是纯噪音。
  const optsRef = useRef(opts)
  optsRef.current = opts
  const ref = useRef<T | null>(null)
  const [dragging, setDragging] = useState(false)
  // 按下起点（scrollLeft + clientX）；armed=已按下但还没过阈值
  const start = useRef<{ x: number; left: number } | null>(null)
  const armed = useRef(false)
  const draggingRef = useRef(false)

  /** 该区域的 mousedown 是否应该交给拖拽；false = 交给原有交互 */
  const shouldPan = useCallback((target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false
    // ① 明确排除区（列宽手柄等）
    if (target.closest('[data-nodrag]')) return false
    // ② 表单元素：聚焦 / 输入 / 下拉 / 按钮 一律不抢
    const tag = target.closest('input, select, textarea, button, a, [contenteditable]')
    return tag === null
  }, [])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // 只认左键（见文件头：主人拍板「保留一个常用的就好」）
    if (e.button !== 0) return
    const el = ref.current
    if (!el || !shouldPan(e.target)) return
    start.current = { x: e.clientX, left: el.scrollLeft }
    armed.current = true
  }, [shouldPan])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!armed.current || !start.current) return
    const el = ref.current
    if (!el) return
    const dx = e.clientX - start.current.x
    const threshold = optsRef.current.threshold ?? 4
    if (!draggingRef.current && Math.abs(dx) > threshold) {
      draggingRef.current = true
      setDragging(true)
    }
    if (draggingRef.current) {
      el.scrollLeft = start.current.left - dx
      e.preventDefault()
    }
  }, [])

  const finish = useCallback(() => {
    armed.current = false
    start.current = null
    draggingRef.current = false
    setDragging(false)
  }, [])

  // ③ 拖拽成立 ⇒ 吃掉随后那次 click（捕获阶段，赶在 React 的 onClick 之前）
  useEffect(() => {
    if (!dragging) return
    const kill = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }
    // 用 capture=true + 一次性：下一次 click 到达时无论落在哪都拦掉
    document.addEventListener('click', kill, true)
    const t = setTimeout(() => document.removeEventListener('click', kill, true), 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('click', kill, true)
    }
  }, [dragging])

  const onMouseUp = useCallback(() => finish(), [finish])

  const onMouseLeave = useCallback(() => finish(), [finish])

  return {
    ref,
    dragging,
    handlers: { onMouseDown, onMouseMove, onMouseUp, onMouseLeave },
  }
}
