import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

// 共享按钮：统一高度 / 圆角 / 内边距 / 字号，收敛全站 352 个手写 button 的字面量漂移。
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'info' | 'icon' | 'bare' | 'icon-amber' | 'icon-danger' | 'icon-muted' | 'icon-ghost' | 'toggle' | 'toggle-text'
// xs = 行内紧凑档（表格行内悬停操作键、行内图标键），不撑高所在行
type Size = 'xs' | 'sm' | 'md' | 'lg'
type Shape = 'rect' | 'pill' | 'round'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  shape?: Shape
  /** 仅 primary / danger：实心填充（覆盖 CTA / 危险主操作） */
  solid?: boolean
  /** 仅图标内容（自动收成正圆/方形图标键） */
  iconOnly?: boolean
  /** 仅 toggle / toggle-text：选中态开关（统一琥珀选中令牌，替代手写三元表达式） */
  selected?: boolean
  children?: ReactNode
}

// size 基线（高度 / 内边距 / 字号）—— 直接字面量出现，Tailwind 可扫描
// ⚠️ 这里**不要写 rounded-***：圆角一律由 shape 决定（见下方 shapeCls）。
// 否则「SIZE 的 rounded-lg」与「shape 的 rounded-full」会同时出现在 class 里，
// 谁生效取决于 Tailwind 的生成顺序，结果不可控 —— 实测 pill 形会被 rounded-lg 顶掉。
const SIZE: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11px]',
  sm: 'h-8 px-3 text-[12px]',
  md: 'h-9 px-4 text-[13px]',
  lg: 'h-10 px-5 text-[14px]',
}
// 图标专用：去掉横向 padding，定宽定高
const ICON_SIZE: Record<Size, string> = {
  xs: 'h-6 w-6',
  sm: 'h-8 w-8',
  md: 'h-9 w-9',
  lg: 'h-10 w-10',
}
const ROUND_ICON_SIZE: Record<Size, string> = {
  xs: 'h-6 w-6 rounded-full',
  sm: 'h-8 w-8 rounded-full',
  md: 'h-9 w-9 rounded-full',
  lg: 'h-10 w-10 rounded-full',
}

function variantClass(v: Variant, solid: boolean, selected: boolean): string {
  switch (v) {
    case 'toggle':
      // 分段式选中：选中=琥珀描边底色，未选中=ink 中性底色（令牌唯一真源，抹平 /10·/15·/20 漂移）
      return selected
        ? 'bg-amber/15 text-amber border border-amber/30'
        : 'bg-ink-800 text-ink-400 border border-ink-700'
    case 'toggle-text':
      // 纯文字/图标选中：仅选中态染琥珀，未选中态颜色由调用方 className 决定（零损迁移原有 text-ink-*）
      return selected ? 'text-amber' : ''
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
    case 'icon-ghost':
      // 等价原 .icon-btn：带可见边框的方框图标键（项目管理卡片操作键）
      return 'border border-ink-600 text-ink-400 hover:text-ink-100 hover:border-ink-500 hover:bg-ink-800'
    case 'bare':
      return ''
  }
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    // 不在此处给默认值：未显式传 size 时，由下方按 variant 分档（图标态 sm / 其余 md）
    size,
    shape = 'rect',
    solid = false,
    iconOnly = false,
    selected = false,
    type = 'button',
    className = '',
    children,
    ...rest
  },
  ref
) {
  // 图标态 variant 默认用 sm（h-8 w-8）：工具栏图标键原本约 22px，套 md(h-9/36px) 会明显撑高工具栏
  const isIconVariant = variant === 'icon-amber' || variant === 'icon-danger' || variant === 'icon-muted'
  const sizeKey: Size = size ?? (isIconVariant ? 'sm' : 'md')

  let sizeCls: string
  // v2.0 按钮统一化：bare / toggle / icon-* 原先不套尺寸基线，导致大量按钮高度靠内容撑开、
  // 与标准按钮并排时高低不齐。现在统一走 size 体系：
  //   · icon-amber / icon-danger / icon-muted → 定宽定高图标键（默认 h-8 w-8 rounded-lg）
  //   · toggle → 标准文字按钮基线（默认 h-8 px-3 text-[12px] rounded-lg）
  //   · bare 用途驳杂（从大卡片到菜单项），一刀切加固定高度会撑坏卡片类布局，故仅保留无尺寸；
  //     纯图标的 bare 按钮请传 iconOnly，即可自动套 ICON_SIZE
  //   · toggle-text 为纯文字/图标选中态（页签、侧栏），不套尺寸以免破坏既有排版
  if (iconOnly) sizeCls = shape === 'round' ? ROUND_ICON_SIZE[sizeKey] : ICON_SIZE[sizeKey]
  else if (shape === 'round') sizeCls = ROUND_ICON_SIZE[sizeKey]
  else if (isIconVariant) sizeCls = ICON_SIZE[sizeKey]
  else if (variant === 'toggle-text') sizeCls = ''
  else if (variant === 'bare') sizeCls = ''
  else sizeCls = SIZE[sizeKey]

  // 圆角唯一真源：矩形 = rounded-lg，胶囊 / 圆形 = rounded-full
  // （尺寸表里已不含 rounded-*，避免两处打架、结果取决于 Tailwind 生成顺序）
  const shapeCls = shape === 'rect' ? 'rounded-lg' : 'rounded-full'
  const vCls = variantClass(variant, solid, selected)

  const cls = [
    'inline-flex items-center justify-center gap-1.5 select-none whitespace-normal',
    'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
    sizeCls,
    shapeCls,
    vCls,
    className,
  ].join(' ')

  return (
    <button type={type} ref={ref} className={cls} {...rest}>
      {children}
    </button>
  )
})
