import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

// 全站唯一 z 轴真源，替换散落在各处的魔数（z-50 / z-[60] / z-[9998] / z-[9999] …）
export const Z = {
  dropdown: 1000, // CustomSelect / CharacterSelect / TableRefSelect / CalendarPicker 等下拉
  modal: 2000, // 绝大多数弹窗（原 z-50 / z-[60] / z-[1000] / z-[9998] 收敛于此）
  modalNested: 2100, // 弹窗内嵌弹窗（如设置弹窗里再弹 PromptModal）
  prompt: 3000, // PromptModal / confirmDialog（需盖住任何 modal）
  popover: 4000, // HelpPopover
  toast: 5000, // showToast
} as const

export type ModalWidth = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | number
export type ModalVariant = 'blur' | 'plain' | 'opaque'
export type ModalAccent = 'default' | 'amber' | 'emerald'
export type ModalFooterAlign = 'end' | 'between' | 'stretch'

const WIDTH_PX: Record<string, number> = {
  sm: 384,
  md: 448,
  lg: 576,
  xl: 672,
  '2xl': 768,
}

// ---- 全局 Esc 栈：只有栈顶 Modal 响应，嵌套弹窗一次只关一层 ----
const escStack: Array<() => void> = []
function onEscKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  const top = escStack[escStack.length - 1]
  if (top) {
    e.preventDefault()
    top()
  }
}

// ---- body 滚动锁定：引用计数，所有嵌套弹窗都关闭后才释放 ----
let scrollLockCount = 0
function lockScroll() {
  if (scrollLockCount === 0) document.body.style.overflow = 'hidden'
  scrollLockCount++
}
function unlockScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1)
  if (scrollLockCount === 0) document.body.style.overflow = ''
}

export interface ModalProps {
  // ---- 基础 ----
  open: boolean
  onClose: () => void
  children?: ReactNode

  // ---- 标题区 ----
  /** 纯文本标题；与 titleSlot 二选一 */
  title?: string
  /** 富标题（如「时间小字 + 章节标题」双行） */
  titleSlot?: ReactNode
  /** 标题左侧图标（可选） */
  icon?: ReactNode
  /** 标题栏右侧、关闭按钮左侧的附加内容（如「立即备份」按钮、套用目标说明） */
  headerExtra?: ReactNode
  /** 隐藏整个标题栏，标题由 children 自绘 */
  hideHeader?: boolean
  /** 是否显示 X 关闭按钮，默认 true（PrivacyNotice / WebGate / 小黑屋目标态设为 false） */
  showCloseButton?: boolean

  // ---- header 与 body 之间的独立说明条 ----
  subheader?: ReactNode

  // ---- 底部操作区（解决「按钮跟着内容滚」）----
  footer?: ReactNode
  /** 'end'(默认，右对齐) | 'between'(左右分组) | 'stretch'(调用方自排，如全宽单按钮) */
  footerAlign?: ModalFooterAlign

  // ---- 尺寸 ----
  /** 语义档位或像素数；内部统一附加 max-w-[92vw] */
  width?: ModalWidth
  /** 默认 '85vh' */
  maxHeight?: string

  // ---- 对齐 ----
  align?: 'center' | 'top'
  /** align='top' 时的顶部留白，默认 '12vh' */
  topOffset?: string

  // ---- 外观变体 ----
  variant?: ModalVariant // blur(默认，半透明+模糊) | plain(半透明无模糊) | opaque(不透明，门禁/小黑屋)
  accent?: ModalAccent // default | amber | emerald
  surface?: '850' | '900' // 面板底色，默认 ink-850

  // ---- 层级与交互 ----
  layer?: number // 默认 Z.modal
  /** false 关闭遮罩点击与 Esc 关闭（必读/门禁/防误退） */
  dismissible?: boolean
  closeOnOverlayClick?: boolean // 默认 = dismissible
  closeOnEsc?: boolean // 默认 = dismissible

  // ---- 逃生口 ----
  className?: string // 面板
  bodyClassName?: string // 滚动 body
}

export function Modal({
  open,
  onClose,
  children,
  title,
  titleSlot,
  icon,
  headerExtra,
  hideHeader = false,
  showCloseButton = true,
  subheader,
  footer,
  footerAlign = 'end',
  width = 'xl',
  maxHeight = '85vh',
  align = 'center',
  topOffset = '12vh',
  variant = 'blur',
  accent = 'default',
  surface = '850',
  layer,
  dismissible = true,
  closeOnOverlayClick,
  closeOnEsc,
  className = '',
  bodyClassName = '',
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const overlayClose = closeOnOverlayClick ?? dismissible
  const escClose = closeOnEsc ?? dismissible

  // body 滚动锁定（引用计数）
  useEffect(() => {
    if (!open) return
    lockScroll()
    return () => unlockScroll()
  }, [open])

  // Esc 栈式关闭（只有栈顶响应，嵌套一次只关一层）
  useEffect(() => {
    if (!open || !escClose) return
    const wrapped = () => {
      if (escStack[escStack.length - 1] === wrapped) onCloseRef.current()
    }
    escStack.push(wrapped)
    if (escStack.length === 1) document.addEventListener('keydown', onEscKey)
    return () => {
      const i = escStack.indexOf(wrapped)
      if (i >= 0) escStack.splice(i, 1)
      if (escStack.length === 0) document.removeEventListener('keydown', onEscKey)
    }
  }, [open, escClose])

  // 打开时聚焦面板（轻量无障碍：键盘可达）
  useEffect(() => {
    if (!open) return
    const t = requestAnimationFrame(() => panelRef.current?.focus())
    return () => cancelAnimationFrame(t)
  }, [open])

  if (!open) return null

  const widthPx = typeof width === 'number' ? width : WIDTH_PX[width] ?? 672

  const overlayVariant =
    variant === 'blur'
      ? 'bg-black/45 backdrop-blur-[2px]'
      : variant === 'plain'
        ? 'bg-black/60'
        : 'bg-ink-950'
  const overlayAlign =
    align === 'center' ? 'items-center justify-center p-4' : 'items-start justify-center'
  const overlayStyle = align === 'top' ? { paddingTop: topOffset } : undefined

  const panelSurface = surface === '900' ? 'bg-ink-900' : 'bg-ink-850'
  const panelAccent =
    accent === 'amber' ? 'border-amber/30' : accent === 'emerald' ? 'border-emerald-700/50' : 'border-ink-700'
  const footerAlignCls =
    footerAlign === 'between' ? 'justify-between' : footerAlign === 'stretch' ? '' : 'justify-end'

  return createPortal(
    <div
      className={`fixed inset-0 flex z-[2000] ${overlayVariant} ${overlayAlign}`}
      style={{ zIndex: layer ?? Z.modal, ...overlayStyle }}
      onMouseDown={e => {
        if (overlayClose && e.target === e.currentTarget) onCloseRef.current()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`${panelSurface} ${panelAccent} rounded-2xl shadow-2xl flex flex-col outline-none ${className}`}
        style={{ width: `${widthPx}px`, maxWidth: '92vw', maxHeight }}
        onMouseDown={e => e.stopPropagation()}
      >
        {!hideHeader && (
          <div className="flex items-center gap-2 px-5 h-12 border-b border-ink-700 shrink-0">
            {icon && <span className="text-amber shrink-0">{icon}</span>}
            {titleSlot ? (
              <div id={titleId} className="flex-1 min-w-0">
                {titleSlot}
              </div>
            ) : (
              <h3 id={titleId} className="text-[14px] font-semibold text-ink-50 flex-1 truncate">
                {title}
              </h3>
            )}
            {headerExtra}
            {showCloseButton && (
              <button
                type="button"
                onClick={() => onCloseRef.current()}
                title="关闭"
                aria-label="关闭"
                className="p-1 text-ink-400 hover:text-ink-100 transition-colors"
              >
                <X size={16} />
              </button>
            )}
          </div>
        )}
        {subheader && <div className="border-b border-ink-700 shrink-0">{subheader}</div>}
        <div className={`flex-1 overflow-y-auto p-5 ${bodyClassName}`}>{children}</div>
        {footer && (
          <div className={`px-5 py-3 border-t border-ink-700 shrink-0 flex gap-2 ${footerAlignCls}`}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
