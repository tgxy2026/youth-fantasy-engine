import type { AgentExecutorDeps } from '@/lib/agentHost/executor'
import { acquireAgentForm, cardLeaseKey } from '@/lib/agentHost/formLease'
import { agentActionAllowed, fail, MAX_CARD_TOTAL_CHARS, MAX_FIELD_CHARS, type AgentScope, type AgentToolResult } from '@/lib/agentHost/contract'
import { CARD_TABLE_REF_FIELDS } from '@/lib/schema'
import { CARD_SELECT_FIELDS } from '@/lib/world/cardFields'
import { guardTabWrite, isTabMigrationActive } from '@/lib/templates/migrationGuard'
import { touchProject } from '@/lib/db'
import type { CardRecord, TableRow } from '@/lib/types'
import { isMultiSetTab, subTabIdOf } from '@/lib/world/worldSets'
import { getActivePack, modulesFor } from '@/lib/schemaTemplates/index'

/** 字段级修改；不提供重命名或删除，保留卡片图片及未修改字段。 */
export async function updateSettingCard(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = typeof args.projectId === 'string' ? args.projectId : ''
  const tabId = typeof args.tabId === 'string' ? args.tabId : ''
  const cardId = typeof args.cardId === 'string' ? args.cardId : ''
  if (!projectId || !tabId || !cardId || [projectId, tabId, cardId].some(value => value.length > 200)) return fail('BAD_REQUEST', 'projectId、tabId 和 cardId 必须是非空字符串。')
  if (!agentActionAllowed(scope, projectId, 'setting:write')) return fail('SCOPE_DENIED', '该项目未授权修改设定卡字段。')
  const reason = deps.storageBlockReason()
  if (reason) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${reason}`)
  if (!(await deps.getProjects()).some(project => project.id === projectId)) return fail('PROJECT_NOT_FOUND', `项目不存在：${projectId}`)
  if (deps.currentProjectId() !== projectId) return fail('PROJECT_NOT_OPEN', '请先在引擎中打开该项目。')
  const worldSet = isMultiSetTab(tabId)
  const tab = deps.getTab(tabId)
  if (!worldSet && (!tab || tab.type !== 'card')) return fail('BAD_REQUEST', `不是可修改的设定卡栏目：${tabId}`)
  const storageTabId = worldSet ? subTabIdOf(tabId) : tabId
  const fields = args.fields, expected = args.expectedFields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !expected || typeof expected !== 'object' || Array.isArray(expected)) return fail('BAD_REQUEST', 'fields 和 expectedFields 必须是对象。')
  const entries = Object.entries(fields as Record<string, unknown>), oldValues = expected as Record<string, unknown>
  if (!entries.length || entries.length > 200) return fail('BAD_REQUEST', '必须提供 1 到 200 个字段。')
  const schema = new Set(worldSet
    ? (modulesFor(tabId, getActivePack()) ?? []).flatMap(module => module.fields.map(field => `${module.name}::${field.name}`))
    : deps.cardFieldsOf(tab!).map(field => field.path))
  let total = 0
  for (const [path, value] of entries) {
    if (!schema.has(path)) return fail('BAD_REQUEST', `未知或内部字段：${path}`)
    if (typeof value !== 'string' || value.length > MAX_FIELD_CHARS || typeof oldValues[path] !== 'string' || (oldValues[path] as string).length > MAX_FIELD_CHARS) return fail('BAD_REQUEST', `字段 ${path} 与旧值必须是长度合规的字符串。`)
    total += value.length
    if (total > MAX_CARD_TOTAL_CHARS) return fail('BAD_REQUEST', '字段内容总量超过上限。')
  }
  if (Object.keys(oldValues).some(path => !Object.prototype.hasOwnProperty.call(fields, path))) return fail('BAD_REQUEST', 'expectedFields 只能包含本次修改的字段。')
  if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存。')
  const release = acquireAgentForm(projectId, cardLeaseKey(storageTabId))
  if (!release) return fail('DRAFT_DIRTY', '该设定栏目正在编辑或保存，请先保存并离开。')
  try {
    const owner = deps.captureOwner(projectId)
    const migration = await guardTabWrite(projectId, tabId, 'import')
    if (migration) return fail('STORAGE_BLOCKED', `${migration.message} ${migration.hint}`)
    const old = await owner.store.get<CardRecord>('cardRecords', cardId)
    if (!old || old.projectId !== projectId || old.tabId !== storageTabId) return fail('NOT_FOUND', `设定卡不存在：${cardId}`)
    for (const [path, value] of entries) {
      if ((old.data[path] ?? '') !== oldValues[path]) return fail('CONFLICT', `字段已变化：${path}。请重新读取。`)
      const name = path.split('::').pop() ?? ''
      if (!worldSet && name === '姓名' && value !== old.name) return fail('BAD_REQUEST', '暂不支持通过字段修改重命名角色。')
      const selected = worldSet ? undefined : CARD_SELECT_FIELDS[name]
      if (value && selected && !selected.some(option => option.value === value)) return fail('BAD_REQUEST', `字段 ${name} 的值不在固定选项中。`)
      const ref = worldSet ? undefined : CARD_TABLE_REF_FIELDS[name]
      if (value && ref) {
        const rows = await owner.store.getAllByIndex<TableRow>('tableRows', 'tabId', ref.tabId)
        const allowed = new Set(rows.filter(row => row.projectId === projectId).map(row => row.data[ref.col]).filter(Boolean))
        const values = ref.multi ? (value as string).split(/[，,]/).map(item => item.trim()).filter(Boolean) : [(value as string).trim()]
        if (values.some(item => !allowed.has(item))) return fail('BAD_REQUEST', `字段 ${name} 引用了不存在的设定。`)
      }
    }
    if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '读取期间出现未保存的编辑草稿，请先保存。')
    if (isTabMigrationActive(projectId, tabId)) return fail('STORAGE_BLOCKED', '该设定栏目正在迁移模板。')
    const patchData: Record<string, string> = {}
    for (const [path, value] of entries) patchData[path] = value as string
    const next: CardRecord = { ...old, data: { ...old.data, ...patchData } }
    await owner.store.put('cardRecords', next)
    void touchProject(projectId, owner.store)
    let flushed = false
    try { flushed = await deps.flush(); owner.assertCurrent() }
    catch { return fail('OUTCOME_UNKNOWN', '写入期间项目或存储状态改变，请先核对。') }
    if (!flushed) return fail('SAVE_FAILED', '修改可能已进入内存但未确认落盘，请先核对。')
    const saved = await owner.store.get<CardRecord>('cardRecords', cardId)
    if (!saved || saved.projectId !== projectId || saved.tabId !== storageTabId || entries.some(([path, value]) => saved.data[path] !== value)) return fail('OUTCOME_UNKNOWN', '修改后未能确认内容，请先核对。')
    deps.notify({ projectId, kind: worldSet ? 'world-set' : 'setting', tabId, cardId })
    return { ok: true, value: { projectId, tabId, cardId, fields: entries.map(([path]) => path), saved: true } }
  } finally { release() }
}
