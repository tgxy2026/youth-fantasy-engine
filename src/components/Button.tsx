import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

// 共享按钮：统一高度 / 圆角 / 内边距 / 字号，收敛全站 352 个手写 button 的字面量漂移。
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'info' | 'icon' | 'bare' | 'icon-amber' | 'icon-danger' | 'icon-muted'
type Size = 'sm' | 'md' | 'lg'
type Shape = 'rect' | 'pill' | 'round'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  shape?: Shape
  /** 仅 primary / danger：实心填充（覆盖 CTA / 危险主操作） */
  solid?: boolean
  /** 仅图标内容（自动收成正圆/方形图标键） */
  iconOnly?: boolean
  children?: ReactNode
}

// size 基线（高度 / 圆角 / 内边距 / 字号 / 字重）—— 直接字面量出现，Tailwind 可扫描
const SIZE: Record<Size, string> = {
  sm: 'h-8 px-3 text-[12px] rounded-lg',
  md: 'h-9 px-4 text-[13px] rounded-lg',
  lg: 'h-10 px-5 text-[14px] rounded-lg',
}
// 图标专用：去掉横向 padding，定宽定高
const ICON_SIZE: Record<Size, string> = {
  sm: 'h-8 w-8 rounded-lg',
  md: 'h-9 w-9 rounded-lg',
  lg: 'h-10 w-10 rounded-lg',
}
const ROUND_ICON_SIZE: Record<Size, string> = {
  sm: 'h-8 w-8 rounded-full',
  md: 'h-9 w-9 rounded-full',
  lg: 'h-10 w-10 rounded-full',
}

function variantClass(v: Variant, solid: boolean): string {
  switch (v) {
    case 'primary':
      return solid
        ? 'bg-amber text-ink-900 border border-amber hover:bg-amber/90 shadow-lg shadow-amber/20'
        : 'bg-amber/15 text-amber border border-amber/30 hover:bg-amber/25'
    case 'secondary':
      return 'bg-ink-800 text-ink-200 border border-ink-600 hover:bg-ink-700'
    case 'ghost':
      return 'text-ink-400 hover:text-ink-100 hover:bg-ink-800/60 border border-transparent'
    case 'danger':
      return solid
        ? 'bg-red-500 text-white border border-red-500 hover:bg-red-600 shadow-lg'
        : 'bg-red-500/10 text-red-300 border border-red-500/30 hover:bg-red-500/20'
    case 'success':
      return solid
        ? 'bg-emerald-500 text-ink-950 border border-emerald-500 hover:bg-emerald-400'
        : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20'
    case 'info':
      return solid
        ? 'bg-sky-500 text-white border border-sky-500 hover:bg-sky-600'
        : 'bg-sky-500/15 text-sky-300 border border-sky-500/30 hover:bg-sky-500/20'
    case 'icon':
      return 'text-ink-400 hover:text-ink-100 hover:bg-ink-800/60 rounded-md border border-transparent'
    case 'icon-amber':
      return 'text-ink-400 hover:text-amber'
    case 'icon-danger':
      return 'text-ink-500 hover:text-red-400'
    case 'icon-muted':
      return 'text-ink-500 hover:text-ink-200'
    case 'bare':
      return ''
  }
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    shape = 'rect',
    solid = false,
    iconOnly = false,
    className = '',
    children,
    ...rest
  },
  ref
) {
  let sizeCls: string
  if (variant === 'bare' || variant === 'icon-amber' || variant === 'icon-danger' || variant === 'icon-muted') sizeCls = ''
  else if (iconOnly) sizeCls = shape === 'round' ? ROUND_ICON_SIZE[size] : ICON_SIZE[size]
  else if (shape === 'round') sizeCls = ROUND_ICON_SIZE[size]
  else sizeCls = SIZE[size]

  const shapeCls = shape === 'pill' ? 'rounded-full' : ''
  const vCls = variantClass(variant, solid)

  const cls = [
    'inline-flex items-center justify-center gap-1.5 select-none whitespace-nowrap',
    'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
    sizeCls,
    shapeCls,
    vCls,
    className,
  ].join(' ')

  return (
    <button ref={ref} className={cls} {...rest}>
      {children}
    </button>
  )
})
