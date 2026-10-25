/**
 * 跨表引用列（`type === 'tableRef'`）的候选值：**每列只读一次**。
 *
 * 🔴 为什么要单独一支：`useTableSheetModel.ts` 已经贴着 1200 行硬上限（结构护栏闸 ①），
 *    这次上提逻辑不该往里塞第 1241 行；而且它与草稿/排序/保存那套状态无关，独立更好读。
 *
 * 🔴 为什么必须上提（3.2.3 · 大表）：
 *    原先每个 `TableRefSelect` 自己在 `useEffect` 里调 `getTableRows(refTabId)` ——
 *    大表里就是「一行一次整表读取」。实测（`scripts/verify/table-hotpath.mjs`，游客真后端）：
 *    300 行 × 1 个引用列 ⇒ **304 次整表读取、读回 90,300 行**（放大 301 倍）；1000 行 ⇒ 100 万行。
 *    现在按列读一次，选项集合与原先逐行读取**口径完全相同**（同一 `getTableRows`、同一去重 + zh 排序）。
 *
 * ⚠️ 失效口径：换页签 / 换列 / 换项目会重建模型并重读；源表被本表编辑时（自引用如「上级」）不重读 ——
 *    与原先逐行读取一致（原先读的也是库，不是草稿），不引入新的陈旧窗口。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { getTableRows } from '@/lib/db'

/** 只声明用得到的字段，避免把整个列类型耦合进来 */
export interface RefColumnLike {
  name: string
  type?: string
  refTab?: string
  refCol?: string
}

export function useTableRefOptions(columns: RefColumnLike[]): Record<string, string[]> {
  const refCols = useMemo(
    () => columns.filter(c => c.type === 'tableRef' && c.refTab && c.refCol),
    [columns]
  )
  const [options, setOptions] = useState<Record<string, string[]>>({})
  const seqRef = useRef(0)

  useEffect(() => {
    if (refCols.length === 0) { setOptions({}); return }
    const seq = ++seqRef.current
    void (async () => {
      const entries = await Promise.all(refCols.map(async c => {
        try {
          const rows = await getTableRows(c.refTab!)
          const set = new Set<string>()
          for (const r of rows) {
            const v = (r.data?.[c.refCol!] || '').trim()
            if (v) set.add(v)
          }
          return [c.name, [...set].sort((a, b) => a.localeCompare(b, 'zh'))] as const
        } catch {
          // 读不到就当空表：控件本身允许手动输入，不能因为一次失败把整表卡住
          return [c.name, [] as string[]] as const
        }
      }))
      // 期间列变了（换页签/换项目）就丢弃这批结果，别把上一次的候选值盖上去
      if (seq === seqRef.current) setOptions(Object.fromEntries(entries))
    })()
  }, [refCols])

  return options
}
