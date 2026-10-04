// ============ 存储层 · 页签数据（表单 / 表格行 / 卡片记录 / 自定义下拉选项）============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
import type { FormData, TableRow, CardRecord } from '../types'
import { ops, currentProjectId, touchProject } from './core'

// ============ 表单数据 ============
export async function getFormData(tabId: string): Promise<Record<string, string>> {
  const rec = await ops.get<FormData>('formData', `${currentProjectId}::${tabId}`)
  return rec?.data ?? {}
}
export async function saveFormData(tabId: string, data: Record<string, string>) {
  await ops.put('formData', { tabId: `${currentProjectId}::${tabId}`, data } as FormData)
  touchProject(currentProjectId)
}

// ============ 表格行 ============
export async function getTableRows(tabId: string): Promise<TableRow[]> {
  // #020：走 tabId 索引只取本表行，避免每开一张表就全表扫（portable/desktop/cloud 三端
  // 的 getAllByIndex 均按字段过滤，等价于索引查询；仅 idb 端真正用 IndexedDB 索引）。
  const rows = await ops.getAllByIndex<TableRow>('tableRows', 'tabId', tabId)
  return rows
    .filter(r => r.projectId === currentProjectId)
    .sort((a, b) => a.order - b.order)
}
export async function saveTableRow(row: TableRow) {
  await ops.put('tableRows', { ...row, projectId: row.projectId || currentProjectId, updatedAt: Date.now() })
  touchProject(currentProjectId)
}
export async function deleteTableRow(id: string) {
  await ops.del('tableRows', id)
}

// ============ 卡片记录 ============
export async function getCardRecords(tabId: string): Promise<CardRecord[]> {
  const all = await ops.getAll<CardRecord>('cardRecords')
  return all.filter(r => r.projectId === currentProjectId && r.tabId === tabId).sort((a, b) => a.order - b.order)
}
export async function saveCardRecord(rec: CardRecord) {
  const pid = rec.projectId || currentProjectId
  // 创建时间（2.4.0 · A4 遗留补全）：**首次落库写一次，之后编辑不改动它**。
  // 🔴 必须回读原值再决定：若直接 `rec.createdAt ?? Date.now()`，每次用新对象保存同一张卡
  //    都会刷新成"现在"，那这个字段就失去意义（它要回答的是"这张卡什么时候建的"）。
  let createdAt = rec.createdAt
  if (createdAt === undefined) {
    const prev = await ops.get<CardRecord>('cardRecords', rec.id)
    createdAt = prev?.createdAt ?? Date.now()
  }
  await ops.put('cardRecords', { ...rec, projectId: pid, createdAt })
  touchProject(currentProjectId)
}
export async function deleteCardRecord(id: string) {
  await ops.del('cardRecords', id)
}

// ============ 项目独立自定义下拉选项 ============
// key 格式：customOption::<projectId>::<tabId>::<colName>，value 为 { items: string[], hidden: string[] }
// items = 用户可见的全部（=内置 ∪ 自定义） - hidden；hidden = 已删除的内置项
// 每个项目独立管理下拉选项
const CUSTOM_OPTION_PREFIX = 'customOption::'

export interface CustomOptionPayload {
  items: string[]   // 用户新增的项（不含被删除的内置项）
  hidden: string[]  // 用户删除的内置项
  renamed?: Record<string, string>  // 内置项改名（原名 -> 新名）
}

export async function getCustomOptions(tabId: string, colName: string): Promise<CustomOptionPayload> {
  const rec = await ops.get<{ key: string; value: CustomOptionPayload }>('settingsKV', `${CUSTOM_OPTION_PREFIX}${currentProjectId}::${tabId}::${colName}`)
  return rec?.value ?? { items: [], hidden: [] }
}

async function saveCustomOptions(tabId: string, colName: string, payload: CustomOptionPayload) {
  await ops.put('settingsKV', { key: `${CUSTOM_OPTION_PREFIX}${currentProjectId}::${tabId}::${colName}`, value: payload })
}

/** 便捷：新增一个用户项 */
export async function addCustomItem(tabId: string, colName: string, value: string): Promise<CustomOptionPayload> {
  const v = value.trim()
  if (!v) return getCustomOptions(tabId, colName)
  const cur = await getCustomOptions(tabId, colName)
  if (cur.items.includes(v) || cur.hidden.includes(v) || Object.values(cur.renamed ?? {}).includes(v)) return cur
  const next = { ...cur, items: [...cur.items, v] }
  await saveCustomOptions(tabId, colName, next)
  return next
}

/** 便捷：隐藏内置项（不会清空数据，只是不在下拉里出现） */
export async function hideBuiltinItem(tabId: string, colName: string, name: string): Promise<CustomOptionPayload> {
  const cur = await getCustomOptions(tabId, colName)
  if (cur.hidden.includes(name)) return cur
  const renamed = { ...(cur.renamed ?? {}) }
  delete renamed[name]
  const next = { ...cur, hidden: [...cur.hidden, name], renamed }
  await saveCustomOptions(tabId, colName, next)
  return next
}

/** 便捷：恢复一个内置项 */
export async function restoreBuiltinItem(tabId: string, colName: string, name: string): Promise<CustomOptionPayload> {
  const cur = await getCustomOptions(tabId, colName)
  const next = { ...cur, hidden: cur.hidden.filter(h => h !== name) }
  await saveCustomOptions(tabId, colName, next)
  return next
}

/** 便捷：重命名内置项（不影响数据迁移：把已使用的旧值替换为新值交给上层） */
export async function renameBuiltinItem(tabId: string, colName: string, oldName: string, newName: string): Promise<CustomOptionPayload> {
  const v = newName.trim()
  if (!v || v === oldName) return getCustomOptions(tabId, colName)
  const cur = await getCustomOptions(tabId, colName)
  const renamed = { ...(cur.renamed ?? {}) }
  // 同名则覆盖
  for (const k of Object.keys(renamed)) if (renamed[k] === v) delete renamed[k]
  renamed[oldName] = v
  const next = { ...cur, renamed }
  await saveCustomOptions(tabId, colName, next)
  return next
}

/** 便捷：删除用户自定义项 */
export async function removeCustomItem(tabId: string, colName: string, value: string): Promise<CustomOptionPayload> {
  const cur = await getCustomOptions(tabId, colName)
  const next = { ...cur, items: cur.items.filter(i => i !== value) }
  await saveCustomOptions(tabId, colName, next)
  return next
}
