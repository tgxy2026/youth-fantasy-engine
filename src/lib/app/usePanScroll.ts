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
 *      🔴 吃掉动作必须发生在 **mouseup 之后**（click 在 mouseup 之后才派发）：早先的实现是
 *      「拖拽一开始就挂 document 监听 + setTimeout(0) 移除」—— 监听在一次 tick 后就被拆了，
 *      而 click 在几百毫秒后才来 ⇒ **等于没吃掉**（2026-10-17 全量审计实测）。现改为
 *      `onClickCapture` + 时间窗（`finish()` 记时间戳，400ms 内到达的那次 click 拦掉）。
 *   ② **列宽手柄 / 表头筛选框**：`th` 右侧有个 `cursor-col-resize` 的拖柄（调列宽），
 *      表头还有 select / input（筛选）。这些区域标了 `data-nodrag` / 本身是表头表单元素 ⇒
 *      mousedown 直接放行，不启动平移，否则「拖一拖表格」会把列宽改了、把筛选框聚焦打断。
 *      🔴 **但表体的 textarea 必须放行给拖拽**（2026-10-17 全量审计）：数据单元格本身就是
 *      `CellTextarea`（常驻受控输入框），若把 textarea 一并排除，**整张表体都不可拖**，
 *      平移只剩表头能用（实测：正文起拖 scrollLeft 恒 0）。⇒ 排除规则精确到「表头表单元素」，
 *      表体 textarea 允许起拖；拖拽一旦成立就 blur 掉它（平移意图明确，别留着光标/选区）。
 *   ③ **文本选中**：拖拽中给容器加 `select-none`，不然一拖就把整张表的文字选成一片蓝。
 */
import { useCallback, useRef, useState, type RefObject } from 'react'

export interface UsePanScrollOptions {
  /** 超过多少像素才算「拖拽」而非「点击」（默认 4） */
  threshold?: number
}

export interface PanScrollHandlers {
  onMouseDown: (e: React.MouseEvent) => void
  onMouseMove: (e: React.MouseEvent) => void
  onMouseUp: () => void
  onMouseLeave: () => void
  /** 🔴 必须挂到容器的 onClickCapture：拖拽结束后那次 click 在这里被拦掉（见文件头 ①） */
  onClickCapture: (e: React.MouseEvent) => void
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
  /** 拖拽结束时刻（performance.now()）；0 = 没有待拦的 click（见 onClickCapture） */
  const suppressClickAt = useRef(0)

  /** 该区域的 mousedown 是否应该交给拖拽；false = 交给原有交互 */
  const shouldPan = useCallback((target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false
    // ① 明确排除区（列宽手柄等）
    if (target.closest('[data-nodrag]')) return false
    // ② 表头里的表单元素（筛选框 / 下拉 / 视图切换）一律不抢
    if (target.closest('thead input, thead select, thead textarea, thead [contenteditable]')) return false
    const formEl = target.closest('input, select, textarea, button, a, [contenteditable]')
    if (!formEl) return true
    // ③ 🔴 数据单元格本身就是 textarea（CellTextarea 常驻受控输入框）—— 若一并排除，
    //    整张表体不可拖、平移只剩表头能用。故**表体 textarea 允许起拖**：
    //    位移 < threshold 时仍是普通单击（聚焦编辑照常），超阈值才算拖拽（届时 blur）。
    //    🔴 但**已经在编辑的那个 textarea 不抢**：用户点进去之后在里面拖，意图是**选取文字**
    //    （复制某个字段的设定文本）——那是写作工具的常用操作，不能被平移吃掉。
    //    想要平移就按在别的单元格 / 表头上（这也符合「先点进去再选、要拖就换一处按」的直觉）。
    if (formEl.tagName !== 'TEXTAREA' || !formEl.closest('tbody')) return false
    return document.activeElement !== formEl
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
      // 从单元格输入框上起拖 ⇒ 撤掉编辑焦点：意图已是平移，别留着光标/整片选区
      // （CellTextarea 是受控组件，每次键入即落草稿，blur 不丢内容）
      const ae = document.activeElement
      if (ae instanceof HTMLElement && ae.tagName === 'TEXTAREA' && el.contains(ae)) ae.blur()
      setDragging(true)
    }
    if (draggingRef.current) {
      el.scrollLeft = start.current.left - dx
      e.preventDefault()
    }
  }, [])

  const finish = useCallback(() => {
    const wasDragging = draggingRef.current
    armed.current = false
    start.current = null
    draggingRef.current = false
    setDragging(false)
    // 🔴 时间戳在「拖拽结束」时打：click 紧随 mouseup 派发，捕获阶段据此拦掉
    if (wasDragging) suppressClickAt.current = performance.now()
  }, [])

  /**
   * 🔴 拖拽结束后 400ms 内到达的**第一次** click 一律拦掉（捕获阶段，赶在单元格 onClick 之前）。
   * 防「拖完表格顺手点开了某个单元格」。400ms 是容错窗：正常 click 紧跟 mouseup（<10ms），
   * 留足余量的同时不会误伤拖拽之后用户真正想做的下一次点击。
   */
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    const at = suppressClickAt.current
    if (at && performance.now() - at < 400) {
      suppressClickAt.current = 0
      e.preventDefault()
      e.stopPropagation()
    }
  }, [])

  const onMouseUp = useCallback(() => finish(), [finish])

  const onMouseLeave = useCallback(() => finish(), [finish])

  return {
    ref,
    dragging,
    handlers: { onMouseDown, onMouseMove, onMouseUp, onMouseLeave, onClickCapture },
  }
}
