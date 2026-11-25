import type { ReactNode } from 'react'
import { Z } from '@/lib/app/zLayer'

/**
 * 全站页签页头（唯一视觉真源）。
 *
 * 🔴 2026-11-24 主人反馈：各页签左上角的标题区「有的有背景填充、有的没有，字号也不统一」。
 *    这里收口成一档：标题 20px / semibold、说明 13px、问号统一 14px、
 *    吸顶页头统一半透明底色 + 细分隔线，避免各页各写一套后再次漂移。
 *
 * 例外：编辑器 / 地图 / 剧情画布的工具栏有自己的高度与交互契约，仍保留独立结构，
 * 只借用下面导出的标题 / 说明类名，不套整个页头。
 */
interface Props {
  title: string
  description?: ReactNode
  help?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  /** 引导锚点：普通页签用 page-header，表单页用 form-header，设置页用 settings-header */
  anchor?: string
  /** 少数页头位于自身滚动容器外（如控制面板），可关闭吸顶 */
  sticky?: boolean
  /** 覆盖外层间距；默认 mb-5（父级已有 space-y 时传 mb-0） */
  className?: string
}

/** 页头容器：吸顶 + 半透明填充 + 细分隔线（各页签共用，不要另写） */
export const PAGE_HEADER_CLASS =
  'shrink-0 border-b border-ink-700/50 py-2.5'

/** 页签主标题：统一 18px / semibold / 紧凑字距 */
export const PAGE_TITLE_CLASS = 'text-[18px] font-semibold tracking-tight leading-snug text-ink-50 break-words'

/** 页签说明：统一 12px / 次要色 */
export const PAGE_DESCRIPTION_CLASS = 'mt-1 max-w-full truncate text-12 leading-relaxed text-ink-400'

/**
 * 页头说明只保留第一句，并交给 PAGE_DESCRIPTION_CLASS 单行省略。
 * 🔴 2026-11-24 主人反馈：说明不许换行 —— 长说明会把页头撑成两三行，各页视觉高度不一致。
 */
export function pageSummary(text: string | null | undefined, fallback = ''): string {
  const raw = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return fallback
  const first = raw.split(/[。；！？]/)[0].trim()
  return first || fallback
}

/** 完整页头（含吸顶与底色）：复杂工具条页面直接套这个类名，不再手抄 */
export const PAGE_HEADER_STICKY_CLASS = `${PAGE_HEADER_CLASS} sticky top-0 bg-ink-900/92 backdrop-blur-md`

/** 块状页头（标题行 + 说明上下堆叠）：酒馆角色卡 / 背景设定这类页签使用 */
export const PAGE_HEADER_BLOCK_CLASS =
  'shrink-0 border-b border-ink-700/50 bg-ink-900/92 backdrop-blur-md py-2.5'

export default function PageHeader({
  title, description, help, status, actions, anchor = 'page-header', sticky = true, className = 'mb-5',
}: Props) {
  return (
    <header
      data-guide={anchor}
      data-page-header
      className={`${sticky ? PAGE_HEADER_STICKY_CLASS : PAGE_HEADER_CLASS} ${className}`}
      style={sticky ? { zIndex: Z.pageBase } : undefined}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-[14rem] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className={PAGE_TITLE_CLASS}>{title}</h1>
            {help}
            {status}
          </div>
          {description && <div className={PAGE_DESCRIPTION_CLASS}>{description}</div>}
        </div>
        {actions && <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">{actions}</div>}
      </div>
    </header>
  )
}
