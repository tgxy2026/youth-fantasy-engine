import { useMemo, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'

/**
 * 主从双栏工作台（Master-Detail Workbench）
 *
 * 2026-10-05 建立 —— 收编「左列表 + 右详情」型页签的滚动与筛选口径。
 *
 * ## 为什么需要它
 * 页面全局只有 `App.tsx` 的 `<main overflow-y-auto>` 一根滚动条。若页签内部的双栏
 * 只有 `minHeight` 而没有锁定 `height`，左栏条目一多就会把整页撑高，右栏**被迫垫在
 * 下面一起滚**——用户想「批量改某栏数据」时要上下来回滚（社区反馈 #1）。
 *
 * ## 用法
 * ```tsx
 * <MasterDetail height={contentHeight(CARD_SHEET_CHROME_PX)}>
 *   <MasterList query={q} onQueryChange={setQ} placeholder="搜角色名…">
 *     {filtered.map(x => <Row …/>)}
 *   </MasterList>
 *   <div>右栏详情…</div>
 * </MasterDetail>
 * ```
 * 🔴 两栏**各自**滚动，互不带动。左栏宽度由 `MasterList` 的 `widthClass` 决定。
 */

/** 两栏工作台外壳：锁定高度 + 两栏各自独立滚动 */
export function MasterDetail({
  children,
  height,
}: {
  children: ReactNode
  /** 由 `contentHeight(…CHROME_PX)` 提供，切勿手抄 calc */
  height: string
}) {
  return (
    <div data-master-detail className="flex gap-5 min-h-0 overflow-hidden" style={{ height }}>
      {children}
    </div>
  )
}

/**
 * 左栏：可选搜索框 + 独立滚动区。
 *
 * 搜索框是**可选**的（不传 `onQueryChange` 就不渲染），但推荐都开——
 * 条目一多（>15 条）时，滚动只解决「找不到」，搜索才解决「定位快」。
 */
export function MasterList({
  children,
  widthClass = 'w-44',
  query,
  onQueryChange,
  placeholder = '搜索…',
  searchHint,
  header,
  footer,
  emptyHint,
  isEmpty,
}: {
  children: ReactNode
  /** 左栏宽度，如 `w-44`（角色卡）/ `w-52`（大纲）。响应式可写 `w-full lg:w-52` */
  widthClass?: string
  /** 受控搜索词；与 `onQueryChange` 同传才渲染搜索框 */
  query?: string
  onQueryChange?: (v: string) => void
  placeholder?: string
  /** 搜索框下方的小字提示（如「已筛出 3 / 共 40」）；也可放「新建」按钮 */
  searchHint?: ReactNode
  /** 列表上方的固定区（如工具按钮），不参与滚动 */
  header?: ReactNode
  /** 列表下方的固定区，不参与滚动 */
  footer?: ReactNode
  /** 搜索结果为空时的占位文案 */
  emptyHint?: string
  /** 外部已完成筛选时传 true，用于触发 `emptyHint` 占位 */
  isEmpty?: boolean
}) {
  const showSearch = typeof onQueryChange === 'function'
  return (
    <aside data-master-list className={`${widthClass} shrink-0 flex flex-col min-h-0`}>
      {showSearch && (
        <div className="relative shrink-0 mb-2.5">
          <input
            value={query ?? ''}
            onChange={e => onQueryChange!(e.target.value)}
            placeholder={placeholder}
            className="w-full !pl-7 text-12"
          />
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-500 pointer-events-none" />
        </div>
      )}
      {searchHint && <div className="shrink-0 mb-2">{searchHint}</div>}
      {header && <div className="shrink-0 mb-2">{header}</div>}

      {/* 🔴 唯一滚动区：`min-h-0` 必须留，否则 flex 子项 min-height:auto 会撑破锁高 */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain -mr-1 pr-1 space-y-1.5">
        {isEmpty && emptyHint
          ? (
            <div className="text-center text-ink-500 text-12 py-12 border border-dashed border-ink-700 rounded-lg">
              {emptyHint}
            </div>
          )
          : children}
      </div>

      {footer && <div className="shrink-0 mt-2">{footer}</div>}
    </aside>
  )
}

/**
 * 便捷钩子：按 `keys(record)` 里的文本做不区分大小写的包含匹配。
 *
 * 各页签的「名称字段」不统一（角色卡是 `name`、大纲也走 `name`），所以由调用方
 * 传一个取字段的函数，而不是硬编码 `record.name`。
 */
export function useMasterFilter<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
): { filtered: T[]; isFiltering: boolean } {
  return useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return { filtered: items, isFiltering: false }
    return {
      filtered: items.filter(it => getText(it).toLowerCase().includes(q)),
      isFiltering: true,
    }
  }, [items, query, getText])
}

/** 受控搜索词的小封装（省去每个页签写一遍 useState） */
export function useMasterQuery(): [string, (v: string) => void] {
  return useState('')
}
