/**
 * 图鉴卡片的展示顺序（3.2.0 · 2026-10-21）
 *
 * 【为什么单独成文件】原先图鉴顺序**完全由表格的自动排序决定**（有「编号」列 ⇒ 编号升序，空白沉底），
 * 作者想按名字找条目只能回表格翻。这里给一个显式开关，并把规则抽成纯函数以便单测钉住。
 *
 * 🔴 三条纪律：
 *   ① **只排展示顺序**：不写库、不动 `row.order`、不影响导出与表格视图 —— 数据层的唯一真源仍是「编号」列；
 *   ② **编号比较与表格同口径**：`tableSheetOrder.codeSortKey` 用的是「数字段补零后拼接」，
 *      本文件 `codeKeyOf` 逐行同实现（`lib` 不能 import `components`，所以只能复制；
 *      `tests/atlasOrder.test.ts` 有一条**交叉断言**保证两边结果一致，谁改了都会红）；
 *   ③ 图鉴页签可能没有编号列（老数据 / 自定义模版）⇒ 该档退化为原顺序，**不乱排**。
 */
import type { TabDef, TableRow } from '@/lib/types'

export type AtlasOrder = 'code' | 'name' | 'recent'

export const ATLAS_ORDERS: { id: AtlasOrder; label: string; hint: string }[] = [
  { id: 'code', label: '按编号', hint: '按「编号」列升序（与表格自动排序一致；没填编号的沉底）' },
  { id: 'name', label: '按名称', hint: '按显示名做中文排序' },
  { id: 'recent', label: '按最近编辑', hint: '最近改过的排在前面' },
]

/**
 * 编号自然排序键：数字段补零后拼接，使 "F2" < "F10"、"9" < "10"。
 * 空 / 纯文字返回 null（不参与编号排序）。
 * 🔴 与 `components/sheets/tableSheetOrder.ts` 的 `codeSortKey` **必须逐字一致**（有交叉单测）。
 */
export function codeKeyOf(s: string | undefined): string | null {
  if (!s || !s.trim()) return null
  const raw = s.trim()
  if (!/\d/.test(raw)) return null
  return raw.replace(/\d+/g, m => m.padStart(8, '0'))
}

/** 该页签用来排序的编号列名（没有则 null） */
export function idColumnOf(tab: TabDef): string | null {
  return tab.columns?.find(c => c.name === '编号' || c.name === '章节号')?.name ?? null
}

/**
 * 按指定顺序返回新数组（**不修改入参**）。
 * @param rows 已并入草稿 + 已筛选的行
 */
export function sortAtlasRows(tab: TabDef, rows: readonly TableRow[], order: AtlasOrder): TableRow[] {
  const list = [...rows]
  if (order === 'code') {
    const col = idColumnOf(tab)
    if (!col) return list
    list.sort((a, b) => {
      const ka = codeKeyOf(a.data?.[col])
      const kb = codeKeyOf(b.data?.[col])
      if (!ka && !kb) return 0
      if (!ka) return 1   // 空白编号沉底（与表格一致）
      if (!kb) return -1
      return ka.localeCompare(kb)
    })
    return list
  }
  if (order === 'name') {
    const nameCol = tab.displayCol ?? '名称'
    list.sort((a, b) =>
      String(a.data?.[nameCol] ?? '').localeCompare(String(b.data?.[nameCol] ?? ''), 'zh'))
    return list
  }
  list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return list
}
