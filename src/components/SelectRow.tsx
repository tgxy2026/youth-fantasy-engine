/**
 * U-4 · 2.6.0：整行可选列表项 —— 收编 A 组裸 `<button>` 的「行选择」模式。
 *
 * 【为什么抽出来】
 *   全站 30 处「点击选中的列表行」各自手写选中态，出现 `bg-amber/10` 与 `bg-amber/15`
 *   两种漂移（Button toggle 的唯一真源是 `/15`，见 Button.tsx variantClass）。行内布局
 *   （前导图标 / truncate 标题 / 右侧徽章计数）各行不同，**颜色令牌由本组件统一，布局类
 *   仍由调用方给**——组件只接管「选中态 / 悬停态 / 禁用态」这三块最易漂移的。
 *
 * 【variant】
 *   · fill（默认）：选中=琥珀底色填充（ChapterPicker / 各设置行的原始形态）；
 *   · outline：选中=琥珀底 + 描边、未选=透明描边占位（TavernCardList / TavernPlotScenes /
 *     TavernReport 的卡片行形态，未选时 border 占位防抖动）。
 *
 * 【迁移约定】
 *   · 原 `bg-amber/15|10 text-amber` → `<SelectRow selected>`；
 *   · 原 `text-ink-200|300 hover:bg-ink-800/60` → `<SelectRow>` 默认未选态；
 *   · padding / 字号 / 行内子元素布局照旧写在 className（各行结构不同，不强求一致）；
 *   · 有「选中专属底色/描边」的**卡选择器**（TavernScript / ExportFormatDialog 一族）不迁 ——
 *     未选态底色是它自己的一部分，硬套会把未选样式搅进组件默认值。
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface SelectRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> {
  selected: boolean
  /** fill＝底色填充；outline＝底色 + 描边（未选透明描边占位） */
  variant?: 'fill' | 'outline'
  className?: string
  children: ReactNode
}

const STATE_CLS: Record<'fill' | 'outline', { on: string; off: string }> = {
  fill: { on: 'bg-amber/15 text-amber', off: 'text-ink-200 hover:bg-ink-800/60' },
  outline: {
    on: 'bg-amber/15 text-amber border border-amber/30',
    off: 'text-ink-200 hover:bg-ink-800/60 border border-transparent',
  },
}

export default function SelectRow({ selected, variant = 'fill', className = '', children, type, ...rest }: SelectRowProps) {
  const st = STATE_CLS[variant]
  return (
    <button
      type={type ?? 'button'}
      {...rest}
      className={`flex w-full text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        selected ? st.on : st.off
      } ${className}`}
    >
      {children}
    </button>
  )
}
