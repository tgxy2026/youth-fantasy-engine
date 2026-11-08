/** 设定表字段级修改：只修改基础文本列，阻止覆盖页面草稿。 */
import type { AgentExecutorDeps } from '@/lib/agentHost/executor'
import { acquireAgentForm, tableLeaseKey } from '@/lib/agentHost/formLease'
import { agentActionAllowed, fail, MAX_CARD_TOTAL_CHARS, MAX_FIELD_CHARS, type AgentScope, type AgentToolResult } from '@/lib/agentHost/contract'
import { TABS } from '@/lib/schema'
import { guardTabWrite, isTabMigrationActive } from '@/lib/templates/migrationGuard'
import { validateImport } from '@/lib/storage/tableIO'
import { touchProject } from '@/lib/db'
import type { TableRow } from '@/lib/types'
import { validateTableFields } from '@/lib/agentHost/validateTableFields'

export const AGENT_MUTABLE_TABLES = new Set(['relations', 'nations', 'faction-rels', 'geography', 'races', 'items', 'history', 'terms', 'foreshadow', 'timeline', 'hookpoints', 'subplots', 'secrets', 'ideas', 'feedback'])

export async function updateTableRow(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = typeof args.projectId === 'string' ? args.projectId : ''
  const tabId = typeof args.tabId === 'string' ? args.tabId : ''
  const rowId = typeof args.rowId === 'string' ? args.rowId : ''
  if (!projectId || !tabId || !rowId || [projectId, tabId, rowId].some(value => value.length > 200)) return fail('BAD_REQUEST', 'projectId、tabId 和 rowId 必须是非空字符串。')
  if (!agentActionAllowed(scope, projectId, 'table:write')) return fail('SCOPE_DENIED', '该项目未授权修改设定表条目。')
  const reason = deps.storageBlockReason()
  if (reason) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${reason}`)
  const project = (await deps.getProjects()).find(item => item.id === projectId)
  if (!project) return fail('PROJECT_NOT_FOUND', `项目不存在：${projectId}`)
  if (deps.currentProjectId() !== projectId) return fail('PROJECT_NOT_OPEN', '请先在引擎中打开该项目。')
  const tab = TABS.find(item => item.id === tabId && item.type === 'table' && AGENT_MUTABLE_TABLES.has(item.id))
  if (!tab) return fail('BAD_REQUEST', `该表格暂不支持修改：${tabId}`)
  const fields = args.fields, expected = args.expectedFields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !expected || typeof expected !== 'object' || Array.isArray(expected)) return fail('BAD_REQUEST', 'fields 和 expectedFields 必须是对象。')
  const entries = Object.entries(fields as Record<string, unknown>), expectedValues = expected as Record<string, unknown>
  if (!entries.length || entries.length > 200) return fail('BAD_REQUEST', '必须提供 1 到 200 个字段。')
  let total = 0
  for (const [key, value] of entries) {
    const column = tab.columns?.find(item => item.name === key)
    if (!column || column.hidden || column.name === '编号') return fail('BAD_REQUEST', `不可写或未知的字段：${key}`)
    if (typeof value !== 'string' || value.length > MAX_FIELD_CHARS || typeof expectedValues[key] !== 'string' || (expectedValues[key] as string).length > MAX_FIELD_CHARS) return fail('BAD_REQUEST', `字段 ${key} 与预期旧值必须是长度合规的字符串。`)
    total += value.length
    if (total > MAX_CARD_TOTAL_CHARS) return fail('BAD_REQUEST', '字段内容总量超过上限。')
  }
  if (Object.keys(expectedValues).some(key => !Object.prototype.hasOwnProperty.call(fields, key))) return fail('BAD_REQUEST', 'expectedFields 只能包含本次修改的字段。')
  if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存。')
  const release = acquireAgentForm(projectId, tableLeaseKey(tabId))
  if (!release) return fail('DRAFT_DIRTY', '该表格正在编辑或保存，请先保存并离开后重试。')
  try {
    const owner = deps.captureOwner(projectId)
    const migration = await guardTabWrite(projectId, tabId, 'import')
    if (migration) return fail('STORAGE_BLOCKED', `${migration.message} ${migration.hint}`)
    const old = await owner.store.get<TableRow>('tableRows', rowId)
    if (!old || old.projectId !== projectId || old.tabId !== tabId) return fail('NOT_FOUND', `表格条目不存在：${rowId}`)
    for (const [key] of entries) if ((old.data[key] ?? '') !== expectedValues[key]) return fail('CONFLICT', `字段已变化：${key}。请重新读取。`)
    const fieldError = await validateTableFields(owner, tab, fields as Record<string, string>)
    if (fieldError) return fail('BAD_REQUEST', fieldError)
    const patchData: Record<string, string> = {}
    for (const [key, value] of entries) patchData[key] = value as string
    const next: TableRow = { ...old, data: { ...old.data, ...patchData }, updatedAt: Math.max(deps.now(), (old.updatedAt ?? 0) + 1) }
    const newStart = (fields as Record<string, unknown>)['发生时间']
    if ((tabId === 'timeline' || tabId === 'history') && typeof newStart === 'string' && newStart
      && !Object.prototype.hasOwnProperty.call(fields, '结束时间')
      && (!(old.data['结束时间'] ?? '').trim() || old.data['结束时间'] === old.data['发生时间'])) {
      next.data['结束时间'] = newStart
    }
    const existing = (await owner.store.getAllByIndex<TableRow>('tableRows', 'tabId', tabId)).filter(row => row.projectId === projectId && row.id !== rowId)
    const check = validateImport([next.data], tab, { existing, refValues: new Map() })[0]
    if (check.missing.length || check.dupExisting || check.codeConflict) return fail('BAD_REQUEST', '修改会造成主字段为空、重复或编号冲突。')
    if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '读取期间出现未保存的编辑草稿，请先保存。')
    if (isTabMigrationActive(projectId, tabId)) return fail('STORAGE_BLOCKED', '表格正在迁移模板，请重新读取。')
    await owner.store.put('tableRows', next)
    void touchProject(projectId, owner.store)
    let flushed = false
    try { flushed = await deps.flush(); owner.assertCurrent() }
    catch { return fail('OUTCOME_UNKNOWN', '写入期间项目或存储状态改变，请先核对。') }
    if (!flushed) return fail('SAVE_FAILED', '修改可能已进入内存但未确认落盘，请先核对。')
    const saved = await owner.store.get<TableRow>('tableRows', rowId)
    if (!saved || saved.projectId !== projectId || saved.tabId !== tabId || entries.some(([key, value]) => saved.data[key] !== value)
      || saved.data['结束时间'] !== next.data['结束时间']) return fail('OUTCOME_UNKNOWN', '修改后未能确认内容，请先核对。')
    deps.notify({ projectId, kind: 'table', tabId })
    return { ok: true, value: { projectId, tabId, rowId, updatedAt: saved.updatedAt,
      fields: entries.map(([key]) => key), ...(next.data['结束时间'] !== old.data['结束时间'] ? { endTime: next.data['结束时间'] } : {}), saved: true } }
  } finally { release() }
}
