/**
 * Agent 对「世界包跨项目引入」与「项目备份恢复」的执行（3.4.3 · P1 领域）。
 *
 * 两个操作都会**覆盖现有内容**，因此：
 *   · 必须先调用对应的 preview 工具，并把 preview 返回的目标/表清单原样带回；
 *   · 必须显式 `confirm: true`；
 *   · 引擎侧会再创建一份「操作前安全备份」并回读确认，失败即中止；
 *   · 打开中的编辑器 / 未保存草稿 / 正在编辑章节一律拒绝；
 *   · 世界包引入中途失败时，自动用刚创建的安全备份回滚，并如实报告回滚结果。
 *
 * 世界包引入复用 `worldImport.importWorldIntoCurrent`（快照复制 + 自定义字段 id 重映射）；
 * 备份恢复复用 `db.restoreBackup`（先写后删 + 强制预备份），不另造一套覆盖逻辑。
 */
import type { AgentExecutorDeps } from '@/lib/agentHost/executor'
import {
  agentActionAllowed, fail,
  type AgentScope, type AgentToolResult,
} from '@/lib/agentHost/contract'
import { AgentContentInputError } from '@/lib/agentHost/contentOps'
import { canvasLeaseKey, cardLeaseKey, isFormLeaseBusy, tableLeaseKey } from '@/lib/agentHost/formLease'
import * as db from '@/lib/db'
import type { BackupMeta } from '@/lib/db/backups'
import type { ProjectBundle } from '@/lib/db/projects'
import type { WorldPackTable, WorldVersion } from '@/lib/world/worldTypes'
import { getWorldImportRecordFor, importWorldIntoProject, WorldImportStaleError } from '@/lib/world/worldImport'
import { rebuildKbIndexAfterRestore } from '@/lib/search/kbRestoreIndex'
import { invalidateTemplateCache } from '@/lib/templates/cache'
import { TABS } from '@/lib/schema'
import type { Project, TabDef } from '@/lib/types'

function readString(args: Record<string, unknown>, key: string, max: number, required = true): string {
  const raw = args[key]
  if (raw === undefined || raw === null) {
    if (required) throw new AgentContentInputError(`参数 ${key} 必填（非空字符串）`)
    return ''
  }
  if (typeof raw !== 'string') throw new AgentContentInputError(`参数 ${key} 必须是字符串`)
  if (required && !raw.trim()) throw new AgentContentInputError(`参数 ${key} 必填（非空字符串）`)
  if (raw.length > max) throw new AgentContentInputError(`参数 ${key} 超过上限（${max} 字符）`)
  return raw
}

function readInt(args: Record<string, unknown>, key: string, required = true): number {
  const raw = args[key]
  if (raw === undefined || raw === null) {
    if (required) throw new AgentContentInputError(`参数 ${key} 必填（整数）`)
    return 0
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw)) throw new AgentContentInputError(`参数 ${key} 必须是整数`)
  return raw
}

async function requireOpenProject(projectId: string, deps: AgentExecutorDeps): Promise<AgentToolResult | null> {
  if (!(await deps.getProjects()).some(project => project.id === projectId)) return fail('PROJECT_NOT_FOUND', `项目不存在：${projectId}`)
  if (deps.currentProjectId() !== projectId) return fail('PROJECT_NOT_OPEN', '请先在引擎中打开该项目。')
  return null
}

async function currentProjectUpdatedAt(projectId: string, deps: AgentExecutorDeps): Promise<number> {
  const project = (await deps.getProjects()).find(item => item.id === projectId)
  return project?.updatedAt ?? 0
}

function tableKindOf(tabId: string, packTables: WorldPackTable[]): WorldPackTable['kind'] | null {
  return packTables.find(table => table.tabId === tabId)?.kind ?? null
}

function leasesFor(tabId: string, kind: WorldPackTable['kind']): string[] {
  if (kind === 'table') return [tableLeaseKey(tabId)]
  if (kind === 'form') return [tabId]
  if (kind === 'card') return [cardLeaseKey(tabId)]
  return [tabId, cardLeaseKey(tabId)]
}

async function countsOf(tabId: string, kind: WorldPackTable['kind'], projectId: string, owner: ReturnType<AgentExecutorDeps['captureOwner']>): Promise<number> {
  if (kind === 'table') return (await owner.store.getAllByIndex<{ projectId?: string }>('tableRows', 'tabId', tabId)).filter(row => row.projectId === projectId).length
  if (kind === 'card') return (await owner.store.getAllByIndex<{ projectId?: string }>('cardRecords', 'tabId', tabId)).filter(row => row.projectId === projectId).length
  if (kind === 'form') {
    const form = await db.getFormDataFor(projectId, tabId, owner)
    return Object.values(form ?? {}).some(value => String(value ?? '').trim() !== '') ? 1 : 0
  }
  return (await db.getSubSetsFor(projectId, tabId, owner)).length
}

/** 预览世界包引入：影响哪些表、当前各有多少内容、来源项目。 */
export async function previewWorldImport(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const worldId = readString(args, 'worldId', 200)
  const version = readInt(args, 'version', false)
  if (!agentActionAllowed(scope, projectId, 'world:write')) return fail('SCOPE_DENIED', '该项目未授权引入世界包。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const world = await db.getWorld(worldId)
  if (!world) return fail('NOT_FOUND', `世界包不存在：${worldId}`)
  if (world.origin?.projectId && world.origin.projectId !== projectId
    && !agentActionAllowed(scope, world.origin.projectId, 'world:read')) {
    return fail('SCOPE_DENIED', '跨项目读取世界包还需要来源项目的「读取其它项目的世界包」授权。')
  }
  const ver = version > 0 ? (world.versions ?? []).find(item => item.v === version) : undefined
  if (version > 0 && !ver) return fail('NOT_FOUND', `世界包版本不存在：${version}`)
  const tables = ver ? ver.tables : world.tables
  const tabIds = [...new Set(tables.map(table => table.tabId))]
  const owner = deps.captureOwner(projectId)
  const counts = await Promise.all(tables.map(async table => ({ tabId: table.tabId, kind: table.kind, rows: table.rows.length, current: await countsOf(table.tabId, table.kind, projectId, owner) })))
  return {
    ok: true,
    value: {
      projectId, worldId, worldName: world.name, version: version > 0 ? version : 0,
      sourceProjectId: world.origin?.projectId ?? '', fingerprint: ver ? ver.fingerprint : world.fingerprint,
      tables: counts, requiredTabs: tabIds.sort(), projectUpdatedAt: await currentProjectUpdatedAt(projectId, deps),
      willOverwrite: counts.some(item => item.current > 0),
    },
  }
}

/** 引入世界包；失败时用操作前安全备份回滚。 */
export async function importWorldPack(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const worldId = readString(args, 'worldId', 200)
  const version = readInt(args, 'version', false)
  if (args.confirm !== true) return fail('BAD_REQUEST', '引入世界包会覆盖本项目对应表，必须传 confirm: true。')
  const expectedFingerprint = readString(args, 'expectedFingerprint', 200)
  if (!Array.isArray(args.expectedTabs) || args.expectedTabs.some(item => typeof item !== 'string')) {
    return fail('BAD_REQUEST', '必须把 preview 返回的 requiredTabs 原样作为 expectedTabs 传入。')
  }
  const expectedTabs = (args.expectedTabs as string[]).slice().sort()
  const expectedProjectUpdatedAt = readInt(args, 'expectedProjectUpdatedAt')
  if (!agentActionAllowed(scope, projectId, 'world:write')) return fail('SCOPE_DENIED', '该项目未授权引入世界包。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  owner.assertCurrent()
  const world = await db.getWorld(worldId)
  if (!world) return fail('NOT_FOUND', `世界包不存在：${worldId}`)
  if (world.origin?.projectId && world.origin.projectId !== projectId
    && !agentActionAllowed(scope, world.origin.projectId, 'world:read')) {
    return fail('SCOPE_DENIED', '跨项目读取世界包还需要来源项目的「读取其它项目的世界包」授权。')
  }
  const ver: WorldVersion | undefined = version > 0 ? (world.versions ?? []).find(item => item.v === version) : undefined
  if (version > 0 && !ver) return fail('NOT_FOUND', `世界包版本不存在：${version}`)
  if ((ver ? ver.fingerprint : world.fingerprint) !== expectedFingerprint) return fail('CONFLICT', '世界包内容已变化，请重新预览。')
  const tables = ver ? ver.tables : world.tables
  const requiredTabs = [...new Set(tables.map(table => table.tabId))].sort()
  if (JSON.stringify(requiredTabs) !== JSON.stringify(expectedTabs)) {
    return fail('CONFLICT', '世界包内容与预览不一致，请重新调用 preview 后再试。', { requiredTabs })
  }
  const currentUpdatedAt = await currentProjectUpdatedAt(projectId, deps)
  if (currentUpdatedAt !== expectedProjectUpdatedAt) {
    return fail('CONFLICT', '项目已在引擎中更新，请重新预览后再试。', { projectUpdatedAt: currentUpdatedAt })
  }
  const keys = requiredTabs.flatMap(tabId => {
    const kind = tableKindOf(tabId, tables)
    return kind ? leasesFor(tabId, kind) : []
  })
  const busy = keys.find(key => isFormLeaseBusy(projectId, key))
  if (busy) return fail('DRAFT_DIRTY', `「${busy}」正在引擎中编辑或保存，请先离开该页面后重试。`)
  let preBackupId: string | undefined
  let importStarted = false
  try {
    const pre = await db.createAutoBackup(projectId, 'manual', `世界包引入前安全备份 · ${new Date().toLocaleString('zh-CN')}`, { store: owner.store })
    if (!pre) return fail('SAVE_FAILED', '操作前安全备份创建失败，已中止引入。')
    preBackupId = pre.id
    owner.assertCurrent()
    if (!await db.getBackupPayload(pre.id, owner.store)) return fail('SAVE_FAILED', '操作前安全备份回读失败，已中止引入。')
    if (!await deps.flush()) return fail('SAVE_FAILED', '操作前安全备份未确认落盘，已中止引入。')
    owner.assertCurrent()
    if (deps.unsavedDraft() || keys.some(key => isFormLeaseBusy(projectId, key))) return fail('DRAFT_DIRTY', '预备份期间出现编辑或草稿，已中止引入。')
    if (await currentProjectUpdatedAt(projectId, deps) !== expectedProjectUpdatedAt) return fail('CONFLICT', '预备份期间项目已更新，请重新预览。')
    owner.assertCurrent()
    const latestWorld = await db.getWorld(worldId)
    const latestVersion = version > 0 ? latestWorld?.versions?.find(item => item.v === version) : undefined
    if (!latestWorld || (version > 0 && !latestVersion) || (latestVersion ? latestVersion.fingerprint : latestWorld.fingerprint) !== expectedFingerprint) {
      return fail('CONFLICT', '预备份期间世界包内容已变化，请重新预览。')
    }
    owner.assertCurrent()
    importStarted = true
    const imported = await importWorldIntoProject(worldId, version > 0 ? version : 0, projectId, owner, expectedFingerprint)
    owner.assertCurrent()
    if (!imported) return fail('INTERNAL', '世界包引入未返回结果。')
    let flushed = false
    try { flushed = await deps.flush() } catch { /* 下方按结果不明处理 */ }
    if (!flushed) throw new Error('世界包引入后未确认落盘')
    const record = await getWorldImportRecordFor(projectId, owner)
    if (!record || record.worldId !== worldId || record.fingerprint !== imported.fingerprint) {
      throw new Error('世界包引入后回读不一致')
    }
    for (const table of tables) {
      const kind = table.kind
      deps.notify({ projectId, kind: kind === 'form' ? 'form' : kind === 'table' ? 'table' : 'setting', tabId: table.tabId })
    }
    deps.notify({ projectId, kind: 'world-import' })
    return { ok: true, value: { worldId, worldName: world.name, version: version > 0 ? version : 0, fingerprint: imported.fingerprint, tabs: imported.tabIds, preBackupId: pre.id, saved: true } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof WorldImportStaleError) return fail('CONFLICT', message)
    if (!importStarted) return fail('SAVE_FAILED', `引入前检查或安全备份失败，未执行引入：${message}`, { preBackupId })
    if (preBackupId) {
      try {
        owner.assertCurrent()
        if (deps.unsavedDraft() || keys.some(key => isFormLeaseBusy(projectId, key))) throw new Error('出现新的编辑或草稿，不能自动覆盖回滚')
        const restored = await db.restoreBackup(preBackupId, undefined, owner.store)
        owner.assertCurrent()
        if (!restored?.ok || !await deps.flush()) throw new Error('回滚未确认落盘')
        owner.assertCurrent()
        return fail('ROLLED_BACK', `世界包引入失败，已用操作前安全备份回滚：${message}`, { preBackupId, rolledBack: true })
      } catch (rollbackError) {
        return fail('OUTCOME_UNKNOWN', `世界包引入失败且自动回滚未确认：${message}；回滚：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, { preBackupId, rolledBack: false })
      }
    }
    return fail('OUTCOME_UNKNOWN', `世界包引入失败，结果不明：${message}`)
  }
}

function bundleCounts(bundle: ProjectBundle) {
  return {
    volumes: bundle.volumes?.length ?? 0,
    chapters: bundle.chapters?.length ?? 0,
    tableRows: bundle.tableRows?.length ?? 0,
    cards: bundle.cardRecords?.length ?? 0,
    forms: bundle.formData?.length ?? 0,
    totalWords: (bundle.chapters ?? []).reduce((sum, chapter) => sum + (typeof chapter.wordCount === 'number' ? chapter.wordCount : 0), 0),
  }
}

async function findBackup(projectId: string, backupId: string, owner?: ReturnType<AgentExecutorDeps['captureOwner']>): Promise<BackupMeta | null> {
  const list = await db.listBackups(projectId, owner?.store)
  return list.find(item => item.id === backupId) ?? null
}

/** 预览备份恢复：备份内容、当前内容、是否会发生覆盖。 */
export async function previewBackupRestore(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const backupId = readString(args, 'backupId', 200)
  if (!agentActionAllowed(scope, projectId, 'backup:restore')) return fail('SCOPE_DENIED', '该项目未授权恢复项目备份。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  const meta = await findBackup(projectId, backupId, owner)
  if (!meta) return fail('NOT_FOUND', `备份不存在或不属于该项目：${backupId}`)
  const bundle = await db.getBackupPayload(backupId, owner.store)
  if (!bundle) return fail('NOT_FOUND', '这份备份的元数据仍在，但载荷已缺失，无法恢复。')
  const [volumes, chapters] = await Promise.all([deps.getVolumes(owner), deps.getChapters(owner)])
  const projectChapters = chapters.filter(chapter => chapter.projectId === projectId)
  return {
    ok: true,
    value: {
      projectId, backupId, label: meta.label, kind: meta.kind, createdAt: meta.createdAt,
      backup: { projectName: bundle.project?.name ?? '', ...bundleCounts(bundle) },
      current: {
        volumes: volumes.filter(volume => volume.projectId === projectId).length,
        chapters: projectChapters.length,
        totalWords: projectChapters.reduce((sum, chapter) => sum + (chapter.wordCount || 0), 0),
      },
      projectUpdatedAt: await currentProjectUpdatedAt(projectId, deps),
      willReplaceProject: true,
      preBackupGuaranteed: true,
      reloadRequired: true,
    },
  }
}

/** 恢复备份（覆盖当前项目全部内容）；引擎内部会先创建并校验安全备份。 */
export async function restoreProjectBackup(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const backupId = readString(args, 'backupId', 200)
  const expectedProjectUpdatedAt = readInt(args, 'expectedProjectUpdatedAt')
  if (args.confirm !== true) return fail('BAD_REQUEST', '恢复备份会覆盖当前项目全部内容，必须传 confirm: true。')
  if (!agentActionAllowed(scope, projectId, 'backup:restore')) return fail('SCOPE_DENIED', '该项目未授权恢复项目备份。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存。')
  if (deps.activeChapterId()) return fail('DRAFT_DIRTY', '请先关闭正在编辑的章节，再恢复备份。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  owner.assertCurrent()
  const meta = await findBackup(projectId, backupId, owner)
  if (!meta) return fail('NOT_FOUND', `备份不存在或不属于该项目：${backupId}`)
  if (!await db.getBackupPayload(backupId, owner.store)) return fail('NOT_FOUND', '这份备份载荷缺失，无法恢复。')
  const currentUpdatedAt = await currentProjectUpdatedAt(projectId, deps)
  if (currentUpdatedAt !== expectedProjectUpdatedAt) return fail('CONFLICT', '项目已在引擎中更新，请重新预览后再试。', { projectUpdatedAt: currentUpdatedAt })

  // 恢复会替换所有页面数据：任何打开中的编辑器/表单/表格/画布都先拒绝。
  const keys: string[] = []
  for (const tab of TABS as TabDef[]) {
    if (tab.type === 'table') keys.push(tableLeaseKey(tab.id))
    else if (tab.type === 'form') keys.push(tab.id)
    else if (tab.type === 'card') keys.push(cardLeaseKey(tab.id))
    else keys.push(tab.id, cardLeaseKey(tab.id))
  }
  keys.push(canvasLeaseKey, tableLeaseKey('geomaps'), tableLeaseKey('geography'))
  const busy = [...new Set(keys)].find(key => isFormLeaseBusy(projectId, key))
  if (busy) return fail('DRAFT_DIRTY', `「${busy}」正在引擎中编辑或保存，请先离开所有编辑页面后重试。`)
  try {
    owner.assertCurrent()
    const outcome = await db.restoreBackup(backupId, undefined, owner.store)
    if (!outcome?.ok) return fail('SAVE_FAILED', '恢复接口未返回成功结果。')
    owner.assertCurrent()
    // 项目时间戳是恢复前置条件：必须严格递增并等待写入，不能使用可能同毫秒且吞错的 touchProject。
    const project = await owner.store.get<Project>('projects', projectId)
    if (!project) throw new Error('恢复后无法读取目标项目版本')
    await owner.store.put('projects', { ...project, updatedAt: Math.max(Date.now(), expectedProjectUpdatedAt + 1, (project.updatedAt ?? 0) + 1) })
    let flushed = false
    try { flushed = await deps.flush() } catch { /* 下方按结果不明处理 */ }
    if (!flushed) return fail('OUTCOME_UNKNOWN', '恢复已执行但未确认落盘，请重新打开项目核对。', { reloadRequired: true })
    void rebuildKbIndexAfterRestore(projectId)
    invalidateTemplateCache()
    const [volumes, chapters] = await Promise.all([deps.getVolumes(owner), deps.getChapters(owner)])
    const projectVolumes = volumes.filter(volume => volume.projectId === projectId).length
    const projectChapters = chapters.filter(chapter => chapter.projectId === projectId).length
    if (projectVolumes !== outcome.restoredVolumes || projectChapters !== outcome.restoredChapters) {
      return fail('OUTCOME_UNKNOWN', '恢复结果与回读的卷 / 章数量不一致，请重新打开项目核对。', { reloadRequired: true, preBackupId: outcome.preBackupId })
    }
    deps.notify({ projectId, kind: 'backup-restore' })
    return {
      ok: true,
      value: {
        projectId, backupId, restoredVolumes: outcome.restoredVolumes, restoredChapters: outcome.restoredChapters,
        preBackupId: outcome.preBackupId, knowledgeBase: outcome.knowledgeBase ?? null,
        reloadRequired: true, saved: true,
      },
    }
  } catch (error) {
    return fail('OUTCOME_UNKNOWN', `备份恢复失败或结果不明：${error instanceof Error ? error.message : String(error)}`, { reloadRequired: true })
  }
}
