/**
 * 表格页签的**排序与列宽偏好**的纯函数部分（自 `useTableSheetModel.ts` 抽出）。
 *
 * 🔴 为什么抽出来：`useTableSheetModel` 是表格页签的"总装车间"，什么都往里塞 ——
 *    它已经贴着 1200 行硬上限（结构闸 ①）了。这几样是**与 React 无关的纯工具**
 *    （编号排序键 / 列宽偏好键 / 旧键迁移 / 自动排序规则），放这里既能让主文件瘦身，
 *    也顺带可以被单测直接钉住（挂在 hook 里就只能靠界面点）。
 *
 * 🔴 抽文件的纪律：**原样搬，不改逻辑、不删注释** —— 抽文件是为了解决"文件太长"，
 *    不是顺手重构的机会（顺手改最容易把排序规则改歪，而这玩意错了很难被发现）。
 */
import type { TabDef, TableRow } from '@/lib/types'
import { writeStringPref } from '@/lib/settings/uiPrefs'

/**
 * 编号自然排序键：数字段补零后拼接，使 "F2" < "F10"、"9" < "10"
 * 返回 null 表示编号为空或纯文字（无法参与编号排序）
 */
export function codeSortKey(s: string | undefined): string | null {
  if (!s || !s.trim()) return null
  const raw = s.trim()
  if (!/\d/.test(raw)) return null
  return raw.replace(/\d+/g, m => m.padStart(8, '0'))
}

/** 列宽偏好的 uiPrefs 键（`yfe-ui:colw.<表 id>`）；旧键 `yfe-colw::<表 id>` 见 migrateColWidths */
export function colWidthsKey(tabId: string): string {
  return `colw.${tabId}`
}

/** 表格页签的全部视图（含 3.1.3 的图鉴）；顺序只影响类型推断，不影响界面顺序 */
export const TABLE_VIEW_MODES = ['table', 'timeline', 'graph', 'storyline', 'atlas'] as const
export type TableViewMode = (typeof TABLE_VIEW_MODES)[number]

/**
 * 一次性迁移旧键 `yfe-colw::<表 id>` → uiPrefs 的 `yfe-ui:colw.<表 id>`。
 *
 * 🔴 为什么不直接换键：换键而不迁移＝老用户调过的列宽**静默回到默认**
 *    （界面上看不出是「迁移失败」还是「本来就没调过」）。所以首次读取时搬一次并删旧键。
 */
export function migrateColWidths(tabId: string): string | null {
  try {
    const legacy = localStorage.getItem(`yfe-colw::${tabId}`)
    if (!legacy) return null
    writeStringPref(colWidthsKey(tabId), legacy)
    localStorage.removeItem(`yfe-colw::${tabId}`)
    return legacy
  } catch {
    return null
  }
}

/**
 * 表格自动排序规则：
 * - 有「编号」/「章节号」列的表格：按编号升序，编号空白的行自动沉底
 * - 无编号列的表格：按最后编辑时间降序（最近编辑的排最前）
 */
export function sortRows(tab: TabDef, rows: TableRow[]): TableRow[] {
  const list = [...rows]
  // 按创建时间倒序：越新创建的行越靠上（章节总表等"后写的在最前"场景）
  if (tab.newestFirst) {
    const key = (r: TableRow) => r.createdAt ?? r.order ?? 0
    list.sort((a, b) => key(b) - key(a))
    return list
  }
  const idCol = tab.columns?.find(c => c.name === '编号' || c.name === '章节号')?.name
  if (idCol) {
    const key = (r: TableRow) => codeSortKey(r.data[idCol])
    list.sort((a, b) => {
      const ka = key(a), kb = key(b)
      if (!ka && !kb) return 0
      if (!ka) return 1   // 空白编号沉底
      if (!kb) return -1
      return ka.localeCompare(kb)
    })
  } else {
    list.sort((a, b) => (b.updatedAt ?? b.order ?? 0) - (a.updatedAt ?? a.order ?? 0))
  }
  return list
}
