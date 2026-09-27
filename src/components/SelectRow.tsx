/**
 * U-4 · 2.6.0：整行可选列表项 —— 收编 A 组裸 `<button>` 的「行选择」模式。
 *
 * 【为什么抽出来】
 *   全站 30 处「点击选中的列表行」各自手写选中态，出现 `bg-amber/10` 与 `bg-amber/15`
 *   两种漂移（Button toggle 的唯一真源是 `/15`，见 Button.tsx variantClass）。行内布局
 *   （前导图标 / truncate 标题 / 右侧徽章计数）各行不同，**颜色令牌由本组件统一，布局类
 *   仍由调用方给**——组件只接管「选中态 / 悬停态 / 禁用态」这三块最易漂移的。
 *
 * 【迁移约定】
 *   · 原 `bg-amber/15|10 text-amber` → `<SelectRow selected>`；
 *   · 原 `text-ink-200|300 hover:bg-ink-800/60` → `<SelectRow>` 默认未选态；
 *   · padding / 字号 / 行内子元素布局照旧写在 className（各行结构不同，不强求一致）。
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface SelectRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> {
  selected: boolean
  className?: string
  children: ReactNode
}

export default function SelectRow({ selected, className = '', children, type, ...rest }: SelectRowProps) {
  return (
    <button
      type={type ?? 'button'}
      {...rest}
      className={`flex w-full text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        selected ? 'bg-amber/15 text-amber' : 'text-ink-200 hover:bg-ink-800/60'
      } ${className}`}
    >
      {children}
    </button>
  )
}
