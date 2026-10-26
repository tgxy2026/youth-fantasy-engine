// ============ 存储层 · 页签数据（表单 / 表格行 / 卡片记录 / 自定义下拉选项）============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
import type { FormData, TableRow, CardRecord } from '@/lib/types'
import { ops, currentProjectId, touchProject } from '@/lib/db/core'

// ============ 表单数据 ============
export async function getFormData(tabId: string): Promise<Record<string, string>> {
  const rec = await ops.get<FormData>('formData', `${currentProjectId}::${tabId}`)
  return rec?.data ?? {}
}
export async function saveFormData(tabId: string, data: Record<string, string>) {
  await ops.put('formData', { tabId: `${currentProjectId}::${tabId}`, data } as FormData)
  touchProject(currentProjectId)
}

/**
 * 按**指定项目 id** 读表单数据（3.2.0 · WT1-4 模板迁移）。
 *
 * 🔴 为什么必须补：模板迁移与恢复日志都是"按 pid 执行"的（作者可能在迁移/恢复期间
 *    切了书）。上面那两个拼的是 `currentProjectId` ⇒ 会读写**当前打开的那一本**，
 *    表现是"A 书迁移，B 书的值被改了"，而且这类串书极难定位。
 *    凡"要动的不是当前项目"一律走带 `For` 的版本（判据同 `getSettingFor` / `delSettingFor`）。
 */
export async function getFormDataFor(pid: string, tabId: string): Promise<Record<string, string>> {
  if (!pid || !tabId) return {}
  const rec = await ops.get<FormData>('formData', `${pid}::${tabId}`)
  return rec?.data ?? {}
}

/** 按**指定项目 id** 写表单数据（同上；只在真有变化时调用，避免无谓 touchProject） */
export async function saveFormDataFor(pid: string, tabId: string, data: Record<string, string>) {
  if (!pid || !tabId) return
  await ops.put('formData', { tabId: `${pid}::${tabId}`, data } as FormData)
  touchProject(pid)
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

/**
 * 按**指定项目 id** 读表格行（3.2.0 · WT1-4 模板迁移）。
 *
 * 🔴 行的 `tabId` 是**裸页签 id**（`races` 这类），项目归属靠 `projectId` 字段 ——
 *    所以这里仍按 `tabId` 索引取数，再按 pid 过滤；不要改成一个不存在的复合索引键。
 */
export async function getTableRowsFor(pid: string, tabId: string): Promise<TableRow[]> {
  if (!pid || !tabId) return []
  const rows = await ops.getAllByIndex<TableRow>('tableRows', 'tabId', tabId)
  return rows
    .filter(r => r.projectId === pid)
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

/**
 * 按**指定项目 id** 读卡片记录（3.2.0 Q2 召回权限复核）。
 *
 * 🔴 与 `getTableRowsFor` 同一理由：异步任务执行期间作者可能已经切书，
 *    用 `getCardRecords` 会拿"当前项目"去复核**另一本**书的来源状态。
 */
export async function getCardRecordsFor(pid: string, tabId: string): Promise<CardRecord[]> {
  if (!pid || !tabId) return []
  const all = await ops.getAll<CardRecord>('cardRecords')
  return all.filter(r => r.projectId === pid && r.tabId === tabId).sort((a, b) => a.order - b.order)
}
/** Existence checks need routing metadata only, not an entire list or any draft fields.
 * The supplied project/tab remain authoritative even if the active project changes while reading.
 */
export async function tabRecordExistsFor({ kind, projectId, tabId, recordId }: {
  kind: 'card' | 'table'; projectId: string; tabId: string; recordId: string
}): Promise<boolean> {
  if (!projectId || !tabId || !recordId || (kind !== 'card' && kind !== 'table')) return false
  const record = await ops.get<CardRecord | TableRow>(kind === 'card' ? 'cardRecords' : 'tableRows', recordId)
  return record?.projectId === projectId && record.tabId === tabId
}
export async function saveCardRecord(rec: CardRecord) {
  const store = ops
  const pid = rec.projectId || currentProjectId
  // 创建时间（2.4.0 · A4 遗留补全）：**首次落库写一次，之后编辑不改动它**。
  // 🔴 必须回读原值再决定：若直接 `rec.createdAt ?? Date.now()`，每次用新对象保存同一张卡
  //    都会刷新成"现在"，那这个字段就失去意义（它要回答的是"这张卡什么时候建的"）。
  let createdAt = rec.createdAt
  if (createdAt === undefined) {
    const prev = await store.get<CardRecord>('cardRecords', rec.id)
    createdAt = prev?.createdAt ?? Date.now()
  }
  await store.put('cardRecords', { ...rec, projectId: pid, createdAt })
  touchProject(pid, store)
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
