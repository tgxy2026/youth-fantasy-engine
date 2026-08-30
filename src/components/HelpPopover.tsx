import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { HelpCircle } from 'lucide-react'
import { Button } from './Button'

interface Props {
  title: string
  children: React.ReactNode
  className?: string
  size?: number
  /** 弹窗宽度（支持 '20rem' / '320px'），默认 18rem */
  width?: string
  /** 展开方向：'left' 弹窗右边缘对齐图标（向左铺开，默认）；'right' 向右铺开 */
  side?: 'left' | 'right'
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

  return (
    <span
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
    >
      <Button variant="bare"
        ref={btnRef}
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        className={`p-0.5 rounded transition-colors ${open ? 'text-amber' : 'text-ink-500 hover:text-amber'}`}
        title={`${title}（点击查看说明）`}
        aria-label={title}
      >
        <HelpCircle size={size} />
      </Button>
      {open && createPortal(
        <div
          ref={popRef}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          style={{
            left: pos?.left ?? -9999,
            top: pos?.top ?? -9999,
            width: pos?.w ?? remToPx(width),
            visibility: pos ? 'visible' : 'hidden',
          }}
          className="fixed z-[10000] bg-ink-800 border border-ink-600 rounded-lg shadow-2xl p-3 text-[11.5px] text-ink-200 leading-relaxed max-h-[70vh] overflow-y-auto"
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
