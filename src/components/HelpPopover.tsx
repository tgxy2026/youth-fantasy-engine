import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { HelpCircle } from 'lucide-react'
import { Button } from './Button'
import { Z } from '../lib/zLayer'
import { foldVh } from '../lib/theme'

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
 * - 默认向【左】铺开（弹窗右边缘与图标对齐），贴近右侧边界时自动回弹到视口内；
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
    const w = Math.min(remToPx(width), window.innerWidth - 24)
    // 向左铺开：弹窗右边缘与图标右边缘对齐
    let left = side === 'left' ? b.right - w : b.left
    left = Math.max(12, Math.min(left, window.innerWidth - w - 12))
    const h = popRef.current?.offsetHeight ?? 180
    let top = b.bottom + 6
    if (top + h > window.innerHeight - 12) top = Math.max(12, b.top - h - 6)
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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('keydown', onKey)
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
        type="button"
        {...(triggerIconBox ? { iconOnly: true, size: 'sm' as const } : {})}
        disabled={triggerDisabled}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        className={triggerClassName ?? `p-0.5 rounded transition-colors ${open ? 'text-amber' : 'text-ink-500 hover:text-amber'}`}
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
          className="fixed bg-ink-800 border border-ink-600 rounded-lg shadow-2xl p-3 text-[11.5px] text-ink-200 leading-relaxed overflow-y-auto"
        >
          <div className="font-semibold text-amber mb-1.5 flex items-center gap-1">
            <HelpCircle size={11} /> {title}
          </div>
          <div className="whitespace-pre-wrap">{children}</div>
        </div>,
        document.body
      )}
    </span>
  )
}
