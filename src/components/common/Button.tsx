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
  xs: 'h-6 px-2 text-11',
  sm: 'h-8 px-3 text-12',
  md: 'h-9 px-4 text-13',
  lg: 'h-10 px-5 text-14',
}
// 🔴 U-2 · 2.6.0 口径明令：SIZE 已含字号，**禁止在 className 再叠 text-\***——
//    fontSize 档按 9→17 升序生成 CSS，.text-13 恒在 .text-12 之后 ⇒ 叠加的 text-12 从不生效
//    （2026-09-27 实证；历史 42 处无效叠加已批量清除）。要更小字号请降 size 档位。
//
// 🔴 U-4 · 2.6.0 裸 <button> 收编口径（巡检 48 处的判决，防下轮重复提案）：
//    · 行选择 → 用 `SelectRow.tsx`（选中态令牌真源 /15，已迁移 4 处，其余可渐进迁移）；
//    · 分段选中 /10 漂移 → 已统一 /15（2026-09-27，27 处）；
//    · **豁免**（保留裸 button，勿再提案）：① 行内微图标键（h-3~h-5，如 WorldSetSheet 活跃圆点
//      w-3 h-3——Button 最小 h-6 会撑坏行高）；② 容器式分段选择器（ExportFormatDialog /
//      PlatformCheckPanel 的 inline-flex 分段，与 Button toggle 形态不同但令牌已一致）；
//      ③ DataDock / Sidebar 自身把手（实现内部件）；④ 行内纯文字微键（裸文字无盒模型，
//      加 Button 会引入 h-6 高度盒改变行高）。
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

/**
 * 🔴 实心按钮（solid）的底色是**固定 500/600/700 级色**（不随主题变），所以字色只能用**固定色**。
 * 2026-10-03 方案 ②：danger / success / info 三变体统一「深底 + 白字」，全部达 WCAG AA
 * （正文级白字对比度 ≥ 4.5，实测：danger red-600 4.83 ✓　success emerald-700 5.48 ✓　info sky-700 5.93 ✓）。
 *   ⚠️ emerald-600 只有 3.77、sky-600 只有 4.10 —— 这两支必须用 700 级才够，别"顺手统一成 600"。
 * 🔴 别改回 `text-ink-950`：ink 是**主题变量** —— 深色主题下近黑，但浅色主题下它是浅色
 *    （如 eye-care 的 230 240 224）⇒ 会变成「浅字 + 亮底」（success 原样仅约 2.1），跨主题翻车。
 * 闸：`tests/themeContrast.test.ts` 钉死了这三支的类名与对比度。
 */
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
        ? 'bg-red-600 text-white border border-red-600 hover:bg-red-700 shadow-lg'
        : 'bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20'
    case 'success':
      return solid
        ? 'bg-emerald-700 text-white border border-emerald-700 hover:bg-emerald-800'
        : 'bg-success/15 text-success border border-success/30 hover:bg-success/20'
    case 'info':
      return solid
        ? 'bg-sky-700 text-white border border-sky-700 hover:bg-sky-800'
        : 'bg-info/15 text-info border border-info/30 hover:bg-info/20'
    case 'icon':
      return 'text-ink-400 hover:text-ink-100 hover:bg-ink-800/60 rounded-md border border-transparent'
    case 'icon-amber':
      return 'text-ink-400 hover:text-amber'
    case 'icon-danger':
      return 'text-ink-500 hover:text-danger'
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
  //   · toggle → 标准文字按钮基线（默认 h-8 px-3 text-12 rounded-lg）
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
  const sizing = iconOnly || shape === 'round' || isIconVariant ? 'icon' : variant === 'bare' || variant === 'toggle-text' ? 'content' : 'standard'

  const cls = [
    'inline-flex items-center justify-center gap-1.5 select-none whitespace-normal',
    'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
    sizeCls,
    shapeCls,
    vCls,
    className,
  ].join(' ')

  return (
    <button type={type} ref={ref} className={cls} data-button-variant={variant} data-button-size={sizeKey} data-button-sizing={sizing} {...rest}>
      {children}
    </button>
  )
})
