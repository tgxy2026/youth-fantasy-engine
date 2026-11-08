import * as db from '@/lib/db'
import type { CardRecord } from '@/lib/types'
import type { AgentExecutorDeps } from '@/lib/agentHost/executor'
import { acquireAgentForm, cardLeaseKey } from '@/lib/agentHost/formLease'
import { agentActionAllowed, fail, type AgentScope, type AgentToolResult } from '@/lib/agentHost/contract'
import { activeKeyOf, isMultiSetTab, subTabIdOf, toggleActiveId } from '@/lib/world/worldSets'
import { guardTabWrite, isTabMigrationActive } from '@/lib/templates/migrationGuard'

export async function setWorldSetActive(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = typeof args.projectId === 'string' ? args.projectId : ''
  const tabId = typeof args.tabId === 'string' ? args.tabId : ''
  const cardId = typeof args.cardId === 'string' ? args.cardId : ''
  if (!projectId || !cardId || [projectId, tabId, cardId].some(value => value.length > 200) || !isMultiSetTab(tabId)
    || typeof args.active !== 'boolean' || typeof args.expectedActive !== 'boolean') return fail('BAD_REQUEST', '项目、栏目、条目、活跃状态和预期旧状态必须有效。')
  if (!agentActionAllowed(scope, projectId, 'setting:write')) return fail('SCOPE_DENIED', '该项目未授权修改世界设定。')
  const reason = deps.storageBlockReason()
  if (reason) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${reason}`)
  if (!(await deps.getProjects()).some(project => project.id === projectId)) return fail('PROJECT_NOT_FOUND', `项目不存在：${projectId}`)
  if (deps.currentProjectId() !== projectId) return fail('PROJECT_NOT_OPEN', '请先在引擎中打开该项目。')
  if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存。')
  const storageTabId = subTabIdOf(tabId)
  const release = acquireAgentForm(projectId, cardLeaseKey(storageTabId))
  if (!release) return fail('DRAFT_DIRTY', '该设定栏目正在编辑或保存，请先保存并离开。')
  try {
    const owner = deps.captureOwner(projectId)
    const migration = await guardTabWrite(projectId, tabId, 'import')
    if (migration) return fail('STORAGE_BLOCKED', `${migration.message} ${migration.hint}`)
    const card = await owner.store.get<CardRecord>('cardRecords', cardId)
    if (!card || card.projectId !== projectId || card.tabId !== storageTabId) return fail('NOT_FOUND', `世界设定不存在：${cardId}`)
    const raw = await db.getSettingFor<unknown>(projectId, activeKeyOf(tabId), [], owner)
    if (!Array.isArray(raw) || raw.some(value => typeof value !== 'string')) return fail('STORAGE_BLOCKED', '活跃列表格式不正确，请先在引擎中核对。')
    const current = raw.includes(cardId)
    if (current !== args.expectedActive) return fail('CONFLICT', '活跃状态已变化，请重新读取。', { cardId, active: current })
    if (current === args.active) return { ok: true, value: { projectId, tabId, cardId, active: current, unchanged: true } }
    if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '读取期间出现未保存的编辑草稿，请先保存。')
    if (isTabMigrationActive(projectId, tabId)) return fail('STORAGE_BLOCKED', '该设定栏目正在迁移模板。')
    const next = toggleActiveId(raw as string[], cardId, args.active)
    await db.setSettingFor(projectId, activeKeyOf(tabId), next, owner)
    void db.touchProject(projectId, owner.store)
    let flushed = false
    try { flushed = await deps.flush(); owner.assertCurrent() }
    catch { return fail('OUTCOME_UNKNOWN', '写入期间项目或存储状态改变，请先核对。') }
    if (!flushed) return fail('SAVE_FAILED', '修改可能已进入内存但未确认落盘，请先核对。')
    const saved = await db.getSettingFor<unknown>(projectId, activeKeyOf(tabId), null, owner)
    if (!Array.isArray(saved) || saved.includes(cardId) !== args.active) return fail('OUTCOME_UNKNOWN', '活跃状态未能确认，请先核对。')
    deps.notify({ projectId, kind: 'world-set', tabId, cardId })
    return { ok: true, value: { projectId, tabId, cardId, active: args.active, saved: true } }
  } finally { release() }
}
