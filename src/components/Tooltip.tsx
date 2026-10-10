import { Z } from '@/lib/zLayer'
import type { ReactNode } from 'react'

interface Props {
  label: string
  children: ReactNode
  /** 气泡出现在元素的哪一侧，默认上方 */
  side?: 'top' | 'bottom'
  className?: string
}

/**
 * 轻量悬浮提示：用 group-hover + CSS 实现，不依赖任何弹层。
 * 仅用于短标签（按钮用途说明），长文本说明请用 HelpPopover。
 */
export default function Tooltip({ label, children, side = 'top', className = '' }: Props) {
  return (
    <span className={`group/tt relative inline-flex ${className}`}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink-700 border border-ink-500 px-2 py-1 text-10 text-ink-100 shadow-lg
          opacity-0 scale-95 group-hover/tt:opacity-100 group-hover/tt:scale-100 transition-all duration-150
          ${side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}
        style={{ zIndex: Z.pageTip }}
      >
        {label}
      </span>
    </span>
  )
}
