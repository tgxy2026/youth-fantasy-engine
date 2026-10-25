import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isOverlayObscured, usePopupLayer } from '@/lib/app/overlayScope'
import { HelpCircle } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Z } from '@/lib/app/zLayer'
import { foldVh, currentUiZoom } from '@/lib/settings/theme'

interface Props {
  title: string
  children: React.ReactNode
  className?: string
  size?: number
  /** 弹窗宽度（支持 '20rem' / '320px'），默认 18rem */
  width?: string
  /** 展开方向：'left' 弹窗右边缘对齐图标（向左铺开，默认）；'right' 向右铺开 */
  side?: 'left' | 'right'
  // ---- 以下 4 项为可选扩展（不传 = 原行为，问号触发键）----
  /** 自定义触发内容。用于「触发键本身就是功能入口」的场景（如 AI 伴写的钢笔键＝开关+说明同一个键） */
  trigger?: React.ReactNode
  /** 自定义触发键 class。**给了它就不再套默认问号样式**，选中态配色由调用方自带（本组件不介入） */
  triggerClassName?: string
  /** 自定义触发键的 title / aria-label（默认 `${title}（点击查看说明）`） */
  triggerTitle?: string
  triggerDisabled?: boolean
  /** 触发键套图标尺寸基线（h-8 w-8）。与工具栏其它图标键并排时传 true，否则高度会差一截 */
  triggerIconBox?: boolean
  /**
   * 钉住：**不因鼠标移出而关闭**，只由「再次点触发键 / 点击外部 / Esc」关闭。
   * 设置类内容（里面要点的控件多）必须传它 —— 否则鼠标一挪到弹窗里的控件上就容易误关。
   */
  pin?: boolean
}

const remToPx = (v: string) => {
  const n = parseFloat(v)
  if (!Number.isFinite(n)) return 288
  return v.trim().endsWith('rem') ? n * 16 : n
}

/**
 * 问号指引：点击 ? 图标弹出该功能的操作说明。
 * - 弹窗用 Portal 渲染到 body + fixed 定位，不会被滚动容器/表格裁剪或遮挡；
 * - 默认向【左】铺开（弹窗右边缘与图标对齐）；左侧空间不足时【自动翻转】到图标右侧，
 *   两边都放不下才夹进视口（3.0.2 修复：此前左侧不足会被夹到最左 12px，弹窗反而压在触发键右侧）；
 * - 下方空间不足时自动翻到图标上方；
 * - 鼠标移出图标与弹窗后自动消失，也可点击外部 / Esc 关闭。
 */
export default function HelpPopover({
  title, children, className = '', size = 13, width = '18rem', side = 'left',
  trigger, triggerClassName, triggerTitle, triggerDisabled, triggerIconBox, pin = false,
}: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; w: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const portalHost = usePopupLayer(open, () => setOpen(false), btnRef)
  const popRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()

  const scheduleClose = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 220)
  }
  const cancelClose = () => clearTimeout(closeTimer.current)
  useEffect(() => () => clearTimeout(closeTimer.current), [])

  const update = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect()
    if (!b) return
    // 🔴 3.0.2 修复（真根因 = 界面缩放二次放大）：
    //   `<html style="zoom:X">` 会把内联 left/top/width **再乘一次 zoom**。
    //   getBoundingClientRect() 量到的已是【视觉像素】（zoom 1.08 时放大 8%），
    //   直接写 style.left 会被浏览器再乘 1.08 ⇒ 弹窗整体右移 ~8%，窄窗口下跑出屏幕被遮。
    //   故：量到的坐标一律【除以 zoom】转成「未缩放 CSS 像素」，在这个坐标系里算位置与边界，
    //       写进 style 后由 zoom 乘回来 —— 与 foldVh 同源思路（foldVh 折 CSS 长度，这里折 JS 数值）。
    const z = currentUiZoom()
    const vw = window.innerWidth / z    // 未缩放坐标系下的视口宽
    const vh = window.innerHeight / z
    const br = b.right / z, bl = b.left / z, bt = b.top / z, bb = b.bottom / z
    const w = Math.min(remToPx(width), vw - 24)
    // ① 按语义方向放；② 放不下时【翻转】到触发键另一侧；③ 两边都放不下才夹进视口
    let left: number
    if (side === 'left') {
      left = br - w                       // 期望：右边缘对齐图标（向左铺开）
      if (left < 12) left = bl            // 左侧不够 → 翻到图标右侧（向右铺开）
    } else {
      left = bl                           // 期望：左边缘对齐图标（向右铺开）
      if (left + w > vw - 12) left = br - w   // 右侧不够 → 翻到图标左侧
    }
    left = Math.max(12, Math.min(left, vw - w - 12))
    const h = popRef.current?.offsetHeight ?? 180
    let top = bb + 6
    if (top + h > vh - 12) top = Math.max(12, bt - h - 6)
    setPos(prev => (prev && prev.left === left && prev.top === top && prev.w === w ? prev : { left, top, w }))
  }, [width, side])

  // 打开时定位（仅当 open 变化时触发，避免每次渲染都 setState 造成无限循环）
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    update()
    // 二次校正：待弹窗渲染后按真实高度修正 top（避免被底部裁切）
    const r = requestAnimationFrame(update)
    return () => cancelAnimationFrame(r)
  }, [open, update])

  // 滚动 / 尺寸变化时跟随；Esc 与外部点击关闭
  useEffect(() => {
    if (!open) return
    const onMove = () => update()
    const onDown = (e: MouseEvent) => {
      if (isOverlayObscured(btnRef.current)) return
      const t = e.target as Node
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, update])

  // pin = 不随鼠标移出关闭（设置类弹窗）；其余场景保持"移出即收起"的原行为
  const leave = pin ? {} : { onMouseEnter: cancelClose, onMouseLeave: scheduleClose }
  return (
    <span
      className={`relative inline-flex items-center ${className}`}
      {...leave}
    >
      <Button variant="bare"
        ref={btnRef}
        aria-expanded={open}
        type="button"
        {...(triggerIconBox ? { iconOnly: true, size: 'sm' as const } : {})}
        disabled={triggerDisabled}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        /**
         * 🔴 3.2.2（审计 U2）：**点击区不得小于 24×24 CSS px**。
         * 原先 `p-0.5`（图标 13 + 4）实测只有约 19.7×19.7 —— 图标可以小，
         * 但手指/鼠标要能点中。`p-1.5` 把它撑到约 25×25，视觉大小几乎不变
         * （图标本身没变大，只是透明内边距），不必为此改版式。
         */
        className={triggerClassName ?? `p-1.5 rounded transition-colors ${open ? 'text-amber' : 'text-ink-500 hover:text-amber'}`}
        title={triggerTitle ?? `${title}（点击查看说明）`}
        aria-label={triggerTitle ?? title}
      >
        {trigger ?? <HelpCircle size={size} />}
      </Button>
      {open && createPortal(
        <div
          ref={popRef}
          {...leave}
          style={{
            zIndex: Z.popover,
            left: pos?.left ?? -9999,
            top: pos?.top ?? -9999,
            width: pos?.w ?? remToPx(width),
            visibility: pos ? 'visible' : 'hidden',
            maxHeight: foldVh('70vh'), // vh 随界面缩放折算，否则 160% 下视觉高度≈112vh，说明的后半段落到视口外
          }}
          className="fixed bg-ink-800 border border-ink-600 rounded-lg shadow-2xl p-3 text-11 text-ink-200 leading-relaxed overflow-y-auto"
        >
          <div className="font-semibold text-amber mb-1.5 flex items-center gap-1">
            <HelpCircle size={11} /> {title}
          </div>
          <div className="whitespace-pre-wrap">{children}</div>
        </div>,
        portalHost()
      )}
    </span>
  )
}
