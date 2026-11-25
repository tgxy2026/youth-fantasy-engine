/**
 * 设定检索 · 表格页签的字段清单（3.6.1 修）
 *
 * 【修的是什么】原先设定检索只按 `tab.columns`（**静态 schema**）枚举字段：
 *   图鉴视图 / 采用模板后新增的**自定义字段**虽然值就存在 `row.data` 里，却永远不出现在检索页 ——
 *   作者在设定表单（图鉴视图）里刚改的字段，切回正文编辑的设定检索看不到，像是"没同步"。
 *
 * 【口径】字段清单 = **schema 列 ∪ 这条记录里真实有值的键**：
 *   · 认识的列沿用原来的控件类型（下拉仍是下拉、跨表引用仍能选、历法列仍出月历）；
 *   · 不认识的键按文本处理，显示名走与表头「字段名」同一份别名表；
 *   · 顺序：schema 列在前，自定义键按首次出现顺序追加（不随行内键顺序抖动）。
 * 🔴 只读投影：不改 `row.data`、不写库，也不在这里判断可见性（可见性仍由调用方按页签过滤）。
 */

export type SearchFieldType = 'text' | 'select' | 'characters' | 'date' | 'calendar-select' | 'tableRef'

export interface SearchField {
  label: string
  /** 作者自定义的显示名（只影响展示与搜索匹配，不改存储键） */
  alias?: string
  value: string
  dataKey: string
  type?: SearchFieldType
  options?: string[]
  refTab?: string
  refCol?: string
  multi?: boolean
}

/** schema 列的可见属性（`TabDef.columns` 的结构子集） */
export interface SearchColumnLike {
  name: string
  type?: string
  options?: string[]
  calendar?: boolean
  refTab?: string
  refCol?: string
}

export interface CollectTableFieldsInput {
  /** 记录的取值（存储键 → 文本） */
  data: Record<string, string>
  /** 要参与枚举的键（schema 列 + 自定义键，已按展示顺序排好） */
  keys: readonly string[]
  /** schema 列定义；自定义键取不到就按文本处理 */
  columnOf: (name: string) => SearchColumnLike | undefined
  /** 显示名表（存储键 → 显示名），与表头「字段名」同一份来源 */
  labels: Record<string, string>
}

/** 一条记录要展示 / 可搜的字段（跳过空值） */
export function collectTableFields(input: CollectTableFieldsInput): SearchField[] {
  const out: SearchField[] = []
  for (const key of input.keys) {
    const raw = input.data?.[key]
    const value = typeof raw === 'string' ? raw : ''
    if (!value.trim()) continue
    const alias = input.labels[key]
    const col = input.columnOf(key)
    const base = { label: key, ...(alias ? { alias } : {}), value, dataKey: key }
    if (col?.calendar) out.push({ ...base, type: 'calendar-select' })
    else if (col?.type === 'tableRef') out.push({ ...base, type: 'tableRef', refTab: col.refTab, refCol: col.refCol })
    else if (col?.type === 'select' && col.options) out.push({ ...base, type: 'select', options: col.options })
    else if (col?.type === 'characters') out.push({ ...base, type: 'characters' })
    else if (col?.type === 'date') out.push({ ...base, type: 'date' })
    else out.push(base)
  }
  return out
}

/**
 * 参与枚举的键：schema 列在前，记录里多出来的键按首次出现顺序追加。
 * 🔴 去重是必须的：schema 列本来就在 `data` 里，不去重会一条记录出现两个同名字段。
 */
export function collectTableKeys(
  rowsData: readonly Record<string, string>[],
  columnNames: readonly string[],
): string[] {
  const keys = [...columnNames]
  const seen = new Set(columnNames)
  for (const data of rowsData) {
    for (const key of Object.keys(data ?? {})) {
      if (seen.has(key)) continue
      seen.add(key)
      keys.push(key)
    }
  }
  return keys
}

/**
 * 只保留「当前有效字段」里的键。
 *
 * 🔴 3.7.3 修：记录里的历史键（删除 / 归档的自定义字段、隐藏列、旧模板字段）
 *    仍留在 `row.data` 里；表格与图鉴不渲染它们，设定检索也不该再列出来。
 *    `known` 取不到（读取失败）时回退全部键 —— 宁可多显示，也不要整页空白。
 */
export function pickKnownKeys(
  keys: readonly string[],
  known: ReadonlySet<string> | null | undefined,
): string[] {
  return known ? keys.filter(key => known.has(key)) : [...keys]
}
