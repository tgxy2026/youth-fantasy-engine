/**
 * Agent 工具执行器（页面侧，运行在引擎渲染进程）。
 *
 * 🔴 为什么必须在这里执行：整库数据的内存真源在渲染进程（桌面 `desktopStore` /
 *   便携 `portableStore`）。外部进程直接改 JSON 会与内存、2s 防抖、云同步互相覆盖。
 *   本模块只被宿主桥调用：桌面上由主进程 IPC 转进来，便携上由本地服务队列转进来。
 *
 * 🔴 归属与并发：
 *   · 只允许写**当前打开的项目**（`PROJECT_NOT_OPEN`）。跨项目写入会绕开编辑器 / 设定页的
 *     上下文保护，而现有业务函数（`saveChapter` 等）都以当前项目为归属；
 *   · 每次写都用 `captureOwnedOperation` 包一层，任何“切换项目 / 切换存储空间”都会中止；
 *   · 正文存在未保存草稿时拒绝写入（`DRAFT_DIRTY`），绝不覆盖作者正在编辑的内容；
 *   · 覆盖 / 追加正文前留一版可恢复快照；写后等待落盘并回读确认，失败如实上报。
 */

import * as db from '@/lib/db'
import { DESKTOP, flushDesktop } from '@/lib/app/desktop'
import { PORTABLE, flushPortable } from '@/lib/storage/fileBackend'
import { captureOwnedOperation } from '@/lib/storage/ownedOperation'
import { submissionBlockReason, platformSubmissionState } from '@/lib/storage/submissionState'
import { leaveGuardDirty } from '@/lib/editor/leaveBarrier'
import { getAgentActiveChapter } from '@/lib/editor/activeChapter'
import { addInspiration, AgentContentInputError, deleteChapter, deleteInspiration, listChapterTrash, listInspirations, restoreChapter, updateInspiration, updateVolume } from '@/lib/agentHost/contentOps'
import { createMap, createMapPlace, deleteMap, listMapPlaces, listMaps, updateMap, updateMapPlaceCells } from '@/lib/agentHost/mapOps'
import {
  createPlotCard, deletePlotCard, readPlotCanvas, updatePlotCard, updatePlotConnections,
} from '@/lib/agentHost/canvasOps'
import {
  importWorldPack, previewBackupRestore, previewWorldImport, restoreProjectBackup,
} from '@/lib/agentHost/worldBackupOps'
import { cancelAgentTask, finishAgentTask, getAgentTask, listAgentTasks, startAgentTask, updateAgentTask } from '@/lib/agentHost/taskOps'
import { listCheckReports, readCheckReport, saveCheckReport } from '@/lib/agentHost/reportOps'
import { countWords } from '@/lib/editor/textStats'
import { scanText } from '@/lib/editor/sensitiveWords'
import { scanTypos } from '@/lib/editor/typoWords'
import { uid } from '@/lib/app/id'
import { getTab, TABS } from '@/lib/schema'
import { cardFieldsOf } from '@/lib/storage/cardIO'
import { latestChapterTarget, nextOrderInVolume } from '@/lib/outline/chapterAppend'
import { chapterSeqOf } from '@/lib/outline/chapterSeq'
import { syncChapterMaster } from '@/lib/outline/chapterMaster'
import { activeKeyOf, isInternalFieldKey, isMultiSetTab, subTabIdOf } from '@/lib/world/worldSets'
import { getActivePack, modulesFor } from '@/lib/schemaTemplates/index'
import { acquireAgentForm, tableLeaseKey } from '@/lib/agentHost/formLease'
import { guardTabWrite, isTabMigrationActive } from '@/lib/templates/migrationGuard'
import { AUTONUM_GROUPS, nextAutoCode } from '@/lib/ai/autoCode'
import { validateImport } from '@/lib/storage/tableIO'
import { AGENT_MUTABLE_TABLES, updateTableRow } from '@/lib/agentHost/updateTableRow'
import { validateTableFields } from '@/lib/agentHost/validateTableFields'
import { updateSettingCard } from '@/lib/agentHost/updateSettingCard'
import { setWorldSetActive } from '@/lib/agentHost/setWorldSetActive'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'
import type { CardRecord, Chapter, FormData, Project, TabDef, TableRow, Volume } from '@/lib/types'
import type { TavernReport } from '@/lib/tavern/types'
import type { Snapshot } from '@/lib/db/chapters'
import type { WorldStoredRecord } from '@/lib/world/worldTypes'
import type { BackupMeta } from '@/lib/db/backups'
import {
  AGENT_TOOL_NAMES,
  MAX_CARD_NAME_CHARS, MAX_CARD_TOTAL_CHARS, MAX_CONTENT_CHARS, MAX_FIELD_CHARS, MAX_NAME_CHARS,
  agentActionAllowed, chapterSummary, fail, projectSummary,
  type AgentAction, type AgentChapterWriteResult, type AgentScope, type AgentToolCall,
  type AgentToolResult, type AgentWriteNotice, type SettingTabInfo,
} from '@/lib/agentHost/contract'

export interface AgentExecutorDeps {
  currentProjectId(): string
  captureOwner(projectId: string): OwnedOperation
  getProjects(): Promise<Project[]>
  getVolumes(owner?: OwnedOperation): Promise<Volume[]>
  getChapters(owner?: OwnedOperation): Promise<Chapter[]>
  createChapter(ch: Chapter, owner: OwnedOperation): Promise<void>
  patchChapter(id: string, patch: Partial<Omit<Chapter, 'id' | 'projectId'>>, owner?: OwnedOperation): Promise<Chapter | undefined>
  saveCardRecord(rec: CardRecord, owner?: OwnedOperation): Promise<void>
  createSnapshot(ch: Chapter, source: 'ai-rewrite', owner?: OwnedOperation): Promise<unknown>
  syncChapterMaster(ch: Chapter, no: number, narrativeIndex?: number, owner?: OwnedOperation): Promise<void>
  chapterSeqOf(volumes: Volume[], chapters: Chapter[], chapterId: string): number
  flush(): Promise<boolean>
  unsavedDraft(): boolean
  activeChapterId(): string | null
  storageBlockReason(): string
  notify(notice: AgentWriteNotice): void
  now(): number
  uid(): string
  countWords(text: string): number
  getTab(tabId: string): TabDef | undefined
  cardFieldsOf(tab: TabDef): { name: string; path: string; desc: string }[]
}

export interface AgentExecutor {
  /** 执行一次工具调用。`scope` 由宿主传入，执行器**再校验一次**（纵深防御）。 */
  call(call: AgentToolCall, scope: AgentScope): Promise<AgentToolResult>
}

/** 生产依赖：真实 db + 平台落盘。 */
export function defaultExecutorDeps(): AgentExecutorDeps {
  return {
    currentProjectId: () => db.getCurrentProjectId(),
    captureOwner: captureOwnedOperation,
    getProjects: () => db.getAllProjects(),
    getVolumes: owner => (owner ? owner.store.getAll<Volume>('volumes') : db.getAllVolumes()),
    getChapters: owner => (owner ? owner.store.getAll<Chapter>('chapters') : db.getAllChapters()),
    createChapter: (ch, owner) => db.createChapterForOwner(ch, owner),
    patchChapter: (id, patch, owner) => db.patchChapter(id, patch, owner),
    saveCardRecord: (rec, owner) => db.saveCardRecord(rec, owner),
    createSnapshot: (ch, source, owner) => db.createSnapshot(ch, source, owner),
    syncChapterMaster: (ch, no, narrativeIndex, owner) => syncChapterMaster(ch, no, narrativeIndex, owner),
    chapterSeqOf: (volumes, chapters, chapterId) => chapterSeqOf(volumes, chapters, chapterId),
    flush: async () => (DESKTOP ? flushDesktop() : PORTABLE ? flushPortable() : true),
    unsavedDraft: () => leaveGuardDirty(),
    activeChapterId: () => getAgentActiveChapter(),
    storageBlockReason: () => submissionBlockReason(platformSubmissionState())
      || (db.isDesktopCloudSyncActive() ? '云同步模式下尚无法保证 Agent 写入与其他设备原子隔离' : ''),
    notify: notice => {
      if (typeof window === 'undefined') return
      try {
        window.dispatchEvent(new CustomEvent('yfe:agent-write', { detail: notice }))
        // 分卷变更通知总表侧栏；编辑器使用带归属校验的 Agent 专用同步。
        if (notice.kind === 'volume' || (notice.kind === 'chapter' && notice.deleted)) window.dispatchEvent(new CustomEvent('yfe:volumes-changed', { detail: { agentSource: true } }))
      } catch { /* 界面通知失败不影响已确认的写入结果 */ }
    },
    now: () => Date.now(),
    uid: () => uid(),
    countWords: text => countWords(text),
    getTab: id => getTab(id),
    cardFieldsOf: tab => cardFieldsOf(tab),
  }
}

// ---------- 参数读取 ----------

function str(args: Record<string, unknown>, key: string, max: number, required = true): string {
  const raw = args[key]
  if (raw === undefined || raw === null) {
    if (required) throw new AgentInputError(`参数 ${key} 必填（非空字符串）`)
    return ''
  }
  if (typeof raw !== 'string') throw new AgentInputError(`参数 ${key} 必须是字符串`)
  const value = raw
  if (required && !value.trim()) throw new AgentInputError(`参数 ${key} 必填（非空字符串）`)
  if (value.length > max) throw new AgentInputError(`参数 ${key} 超过上限（${max} 字符，实际 ${value.length}）`)
  return value
}

function num(args: Record<string, unknown>, key: string): number {
  const raw = args[key]
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new AgentInputError(`参数 ${key} 必填（非负整数时间戳）`)
  }
  return raw
}

class AgentInputError extends Error {}

// ---------- 执行器 ----------

// 同一页面进程内的 Agent 写操作串行队列。
// 🔴 为什么必须有：两个不同 requestId 并发追加同一章时，各自都读到同一份旧正文，
//    后写者会把先写者刚追加的内容覆盖掉（读-改-写丢更新）。串行化后第二个请求
//    进入时 updatedAt 已变化 ⇒ 返回 CONFLICT，让 Agent 重新读取，而不是静默丢内容。
//    跨窗口 / 云同步的竞态不在本队列范围内（文档如实声明，需存储层 CAS）。
const WRITE_TOOL_SET = new Set<string>([
  AGENT_TOOL_NAMES.createSettingCard,
  AGENT_TOOL_NAMES.updateSettingCard,
  AGENT_TOOL_NAMES.createWorldSet,
  AGENT_TOOL_NAMES.setWorldSetActive,
  AGENT_TOOL_NAMES.updateForm,
  AGENT_TOOL_NAMES.createTableRow,
  AGENT_TOOL_NAMES.updateTableRow,
  AGENT_TOOL_NAMES.createVolume,
  AGENT_TOOL_NAMES.createChapter,
  AGENT_TOOL_NAMES.appendChapter,
  AGENT_TOOL_NAMES.replaceChapter,
  AGENT_TOOL_NAMES.updateChapterInfo,
  AGENT_TOOL_NAMES.updateVolume,
  AGENT_TOOL_NAMES.deleteChapter,
AGENT_TOOL_NAMES.addInspiration,
  AGENT_TOOL_NAMES.updateInspiration,
  AGENT_TOOL_NAMES.deleteInspiration,
  AGENT_TOOL_NAMES.saveCheckReport,
  AGENT_TOOL_NAMES.restoreChapter,
  AGENT_TOOL_NAMES.createMap,
  AGENT_TOOL_NAMES.updateMap,
  AGENT_TOOL_NAMES.deleteMap,
  AGENT_TOOL_NAMES.createMapPlace,
  AGENT_TOOL_NAMES.updateMapPlaceCells,
  AGENT_TOOL_NAMES.createPlotCard,
  AGENT_TOOL_NAMES.updatePlotCard,
  AGENT_TOOL_NAMES.deletePlotCard,
  AGENT_TOOL_NAMES.updatePlotConnections,
  AGENT_TOOL_NAMES.importWorldPack,
  AGENT_TOOL_NAMES.restoreProjectBackup,
  AGENT_TOOL_NAMES.startAgentTask,
  AGENT_TOOL_NAMES.updateAgentTask,
  AGENT_TOOL_NAMES.finishAgentTask,
  AGENT_TOOL_NAMES.cancelAgentTask,
])
let writeChain: Promise<unknown> = Promise.resolve()

function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)
  writeChain = run.then(() => undefined, () => undefined)
  return run
}

export function createAgentExecutor(deps: AgentExecutorDeps): AgentExecutor {
  async function projectOf(projectId: string): Promise<Project | AgentToolResult> {
    const projects = await deps.getProjects()
    const project = projects.find(p => p.id === projectId)
    if (!project) return fail('PROJECT_NOT_FOUND', `项目不存在：${projectId}`)
    if (deps.currentProjectId() !== projectId) {
      return fail('PROJECT_NOT_OPEN', `该项目当前未在引擎中打开。请先在青春幻想引擎中打开《${project.name}》后再让 Agent 写入。`)
    }
    return project
  }

  function requireAction(scope: AgentScope, projectId: string, action: AgentAction): AgentToolResult | null {
    return agentActionAllowed(scope, projectId, action)
      ? null
      : fail('SCOPE_DENIED', `当前连接未授权该项目执行「${action}」动作。请在引擎「模型设置 → Agent 连接」中勾选授权。`)
  }

  /** 写前检查存储是否可写：冲突 / 锁写 / 未连接时明确拒绝，不进入保存兜底。 */
  function storageBlocked(): AgentToolResult | null {
    const reason = deps.storageBlockReason()
    return reason
      ? fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${reason}。请先在引擎中保存 / 解锁 / 解决冲突后再试。`)
      : null
  }

  /** 写后统一收口：落盘确认 + 回读确认。失败区分“确定没写”与“结果不明”。 */
  async function confirmWrite<T>(
    owner: OwnedOperation,
    verify: () => Promise<boolean>,
    value: T,
    describeFailure: string,
    notice: AgentWriteNotice,
  ): Promise<AgentToolResult> {
    let flushed = false
    try {
      flushed = await deps.flush()
    } catch {
      flushed = false
    }
    // 落盘期间项目 / 存储空间可能已被切换。此时写入可能已经成功，
    // 🔴 必须按「结果不明」上报，不能标成可安全重试。
    try {
      owner.assertCurrent()
    } catch (error) {
      return fail('OUTCOME_UNKNOWN', `${describeFailure}：写入过程中项目或存储空间已切换，结果不明（${error instanceof Error ? error.message : String(error)}）。请先在引擎中核对，不要盲目重试。`)
    }
    if (!flushed) {
      return fail('SAVE_FAILED', `${describeFailure}：写入可能已进入内存，但未能确认落盘。请先在引擎中核对并手动保存；不要复用同一 requestId 重试。`)
    }
    if (!(await verify())) {
      return fail('OUTCOME_UNKNOWN', `${describeFailure}：落盘后回读不到刚写入的内容，结果不明。请先在引擎中核对，不要盲目重试。`)
    }
    // 写已确认：通知当前界面刷新（编辑器 / 设定卡页 / 章节树）
    deps.notify(notice)
    return { ok: true, value }
  }

  async function listProjects(scope: AgentScope): Promise<AgentToolResult> {
    const projects = await deps.getProjects()
    const current = deps.currentProjectId()
    return {
      ok: true,
      value: projects.map(p => ({
        ...projectSummary(p),
        open: p.id === current,
        grantedActions: scope.projects.find(g => g.projectId === p.id)?.actions ?? [],
      })),
    }
  }

  async function listChapters(args: Record<string, unknown>, scope: AgentScope): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const chapters = await deps.getChapters(owner)
    owner.assertCurrent()
    return {
      ok: true,
      value: {
        projectId,
        projectName: project.name,
        grantedActions: scope.projects.find(g => g.projectId === projectId)?.actions ?? [],
        chapters: chapters.filter(c => c.projectId === projectId)
          .sort((a, b) => (a.volumeId ?? '').localeCompare(b.volumeId ?? '') || a.order - b.order)
          .map(c => chapterSummary(c)),
      },
    }
  }

  async function readChapter(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const chapterId = str(args, 'chapterId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const owner = deps.captureOwner(projectId)
    const chapter = await owner.store.get<Chapter>('chapters', chapterId)
    if (!chapter || chapter.projectId !== projectId) return fail('NOT_FOUND', `章节不存在：${chapterId}`)
    return {
      ok: true,
      value: {
        ...chapterSummary(chapter),
        projectId,
        content: chapter.content,
        summary: chapter.summary,
        createdAt: chapter.createdAt,
      },
    }
  }

  /** 复用检查工具的本地词库，只检查已保存正文，不修改作品或调用模型。 */
  async function checkChapterWords(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const chapterId = str(args, 'chapterId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const chapter = await owner.store.get<Chapter>('chapters', chapterId)
    if (!chapter || chapter.projectId !== projectId) return fail('NOT_FOUND', `章节不存在：${chapterId}`)
    const customRecord = await owner.store.get<{ value?: unknown }>('settingsKV', `${projectId}::customSensitiveWords`)
    const custom = customRecord ? customRecord.value : []
    owner.assertCurrent()
    if (!Array.isArray(custom) || custom.length > 5000 || custom.some(word => typeof word !== 'string' || word.length > 200)) {
      return fail('BAD_REQUEST', '自定义词库格式无效或过大，请先在检查工具中核对。')
    }
    if ((chapter.content?.length ?? 0) * (custom.length + 50) > 100_000_000) {
      return fail('BAD_REQUEST', '正文与自定义词库组合过大，请缩小检查范围或整理词库后再试。')
    }
    const hits = scanText(chapter.content || '', custom as string[])
    return { ok: true, value: { projectId, chapterId, title: chapter.title, updatedAt: chapter.updatedAt,
      totalHits: hits.length, hits: hits.slice(0, 200), truncated: hits.length > 200,
      note: '仅供人工核对，词库并非完整的平台规则；检查的是已保存正文。' } }
  }

  async function checkChapterTypos(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const chapterId = str(args, 'chapterId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const chapter = await owner.store.get<Chapter>('chapters', chapterId)
    owner.assertCurrent()
    if (!chapter || chapter.projectId !== projectId) return fail('NOT_FOUND', `章节不存在：${chapterId}`)
    if ((chapter.content?.length ?? 0) > MAX_CONTENT_CHARS) return fail('BAD_REQUEST', '章节正文过长，请先在引擎中核对。')
    const hits = scanTypos(chapter.content || '')
    return { ok: true, value: { projectId, chapterId, title: chapter.title, updatedAt: chapter.updatedAt,
      totalHits: hits.length, hits: hits.slice(0, 200), truncated: hits.length > 200,
      note: '仅供人工核对，建议可能不适用于上下文；检查的是已保存正文。' } }
  }

  async function listSettingTabs(args: Record<string, unknown>, scope: AgentScope): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const writable = agentActionAllowed(scope, projectId, 'setting:create')
    const tabs: (SettingTabInfo & { writable: boolean; canUpdate: boolean })[] = []
    // 只列 card 型页签：首期写工具只支持设定卡（表格题不在其中）
    for (const tab of cardTabs()) {
      tabs.push({
        tabId: tab.id, name: tab.name, group: tab.group, description: tab.description,
        fields: deps.cardFieldsOf(tab).map(f => ({ path: f.path, name: f.name, desc: f.desc })),
        writable,
        canUpdate: agentActionAllowed(scope, projectId, 'setting:write'),
      })
    }
    const grantedActions = scope.projects.find(g => g.projectId === projectId)?.actions ?? []
    return { ok: true, value: { projectId, grantedActions, tabs } }
  }

  async function listSettingCards(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const tabId = str(args, 'tabId', 120)
    const offset = args.offset === undefined ? 0 : num(args, 'offset')
    const limit = args.limit === undefined ? 50 : num(args, 'limit')
    if (limit < 1 || limit > 100) return fail('BAD_REQUEST', 'limit 必须在 1 到 100 之间。')
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const tab = deps.getTab(tabId)
    if (!tab || tab.type !== 'card') return fail('BAD_REQUEST', `不是设定卡栏目：${tabId}`)
    const owner = deps.captureOwner(projectId)
    const cards = (await owner.store.getAll<CardRecord>('cardRecords'))
      .filter(card => card.projectId === projectId && card.tabId === tabId)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    return { ok: true, value: { projectId, tabId, total: cards.length, offset, cards: cards.slice(offset, offset + limit).map(card => ({ id: card.id, name: card.name, order: card.order, createdAt: card.createdAt })) } }
  }

  async function readSettingCard(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const cardId = str(args, 'cardId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const owner = deps.captureOwner(projectId)
    const card = await owner.store.get<CardRecord>('cardRecords', cardId)
    if (!card || card.projectId !== projectId) return fail('NOT_FOUND', `设定卡不存在：${cardId}`)
    const fields = Object.fromEntries(Object.entries(card.data).filter(([key]) => !isInternalFieldKey(key)))
    return { ok: true, value: { id: card.id, projectId, tabId: card.tabId, name: card.name, order: card.order, createdAt: card.createdAt, fields } }
  }

  async function listDataTabs(args: Record<string, unknown>, scope: AgentScope): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    return { ok: true, value: { projectId, tabs: TABS.filter(tab => tab.type === 'form' || tab.type === 'table').map(tab => ({
      tabId: tab.id, name: tab.name, group: tab.group, type: tab.type, description: tab.description,
      canCreate: tab.type === 'table' && AGENT_MUTABLE_TABLES.has(tab.id) && agentActionAllowed(scope, projectId, 'table:create'),
      canUpdate: tab.type === 'form' ? agentActionAllowed(scope, projectId, 'form:write') : tab.type === 'table' && AGENT_MUTABLE_TABLES.has(tab.id) && agentActionAllowed(scope, projectId, 'table:write'),
      fields: tab.type === 'form' ? tab.modules?.flatMap(module => module.fields.map(field => ({ path: `${module.name}::${field.name}`, name: field.name, description: field.desc }))) : undefined,
      columns: tab.type === 'table' ? tab.columns?.filter(column => !column.hidden).map(column => ({
        name: column.name, type: column.type ?? 'text', description: column.tip,
        options: column.options, fixedOptions: column.fixedOptions === true, calendar: column.calendar === true,
        refTab: column.refTab, refCol: column.refCol, multiValue: column.multiValue === true,
        readOnly: column.name === '编号', auto: column.name === '编号' && AUTONUM_GROUPS.has(tab.group),
      })) : undefined,
    })) } }
  }

  async function readForm(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const tabId = str(args, 'tabId', 120)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const tab = TABS.find(item => item.id === tabId && item.type === 'form')
    if (!tab) return fail('BAD_REQUEST', `不是可读取的表单：${tabId}`)
    const owner = deps.captureOwner(projectId)
    const record = await owner.store.get<FormData>('formData', `${projectId}::${tabId}`)
    const fields = Object.fromEntries(Object.entries(record?.data ?? {}).filter(([key]) => !isInternalFieldKey(key)))
    return { ok: true, value: { projectId, tabId, name: tab.name, fields } }
  }

  async function listTableRows(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const tabId = str(args, 'tabId', 120)
    const offset = args.offset === undefined ? 0 : num(args, 'offset')
    const limit = args.limit === undefined ? 20 : num(args, 'limit')
    if (limit < 1 || limit > 100) return fail('BAD_REQUEST', 'limit 必须在 1 到 100 之间。')
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const tab = TABS.find(item => item.id === tabId && item.type === 'table')
    if (!tab) return fail('BAD_REQUEST', `不是可读取的表格：${tabId}`)
    const columns = new Set((tab.columns ?? []).filter(column => !column.hidden).map(column => column.name))
    const owner = deps.captureOwner(projectId)
    const rows = (await owner.store.getAllByIndex<TableRow>('tableRows', 'tabId', tabId))
      .filter(row => row.projectId === projectId).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    return { ok: true, value: { projectId, tabId, total: rows.length, offset, rows: rows.slice(offset, offset + limit).map(row => ({
      id: row.id, order: row.order, updatedAt: row.updatedAt, fields: Object.fromEntries(Object.entries(row.data).filter(([key]) => columns.has(key))),
    })) } }
  }

  async function listTavernReports(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const offset = args.offset === undefined ? 0 : num(args, 'offset')
    const limit = args.limit === undefined ? 20 : num(args, 'limit')
    if (limit < 1 || limit > 100) return fail('BAD_REQUEST', 'limit 必须在 1 到 100 之间。')
    const owner = deps.captureOwner(projectId)
    const reports = (await owner.store.getAllByIndex<TavernReport>('tavernReports', 'projectId', projectId))
      .filter(report => report.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    return { ok: true, value: { projectId, total: reports.length, offset, reports: reports.slice(offset, offset + limit).map(report => ({
      id: report.id, sessionTitle: report.sessionTitle, anchorChapterId: report.anchorChapterId,
      anchorChapterLabel: report.anchorChapterLabel, mode: report.mode, createdAt: report.createdAt,
    })) } }
  }

  async function readTavernReport(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const reportId = str(args, 'reportId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const owner = deps.captureOwner(projectId)
    const report = await owner.store.get<TavernReport>('tavernReports', reportId)
    if (!report || report.projectId !== projectId) return fail('NOT_FOUND', `推演报告不存在：${reportId}`)
    return { ok: true, value: report }
  }

  async function listChapterSnapshots(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const chapterId = str(args, 'chapterId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const owner = deps.captureOwner(projectId)
    const chapter = await owner.store.get<Chapter>('chapters', chapterId)
    if (!chapter || chapter.projectId !== projectId) return fail('NOT_FOUND', `章节不存在：${chapterId}`)
    const snapshots = (await owner.store.getAllByIndex<Snapshot>('snapshots', 'chapterId', chapterId))
      .filter(snapshot => snapshot.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt)
    return { ok: true, value: { projectId, chapterId, snapshots: snapshots.map(snapshot => ({
      id: snapshot.id, chapterTitle: snapshot.chapterTitle, wordCount: snapshot.wordCount,
      createdAt: snapshot.createdAt, source: snapshot.source ?? 'auto', label: snapshot.label, note: snapshot.note,
    })) } }
  }

  async function readChapterSnapshot(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const snapshotId = str(args, 'snapshotId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const owner = deps.captureOwner(projectId)
    const snapshot = await owner.store.get<Snapshot>('snapshots', snapshotId)
    if (!snapshot || snapshot.projectId !== projectId) return fail('NOT_FOUND', `章节快照不存在：${snapshotId}`)
    return { ok: true, value: { ...snapshot, source: snapshot.source ?? 'auto' } }
  }

  async function listWorldSets(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const tabId = str(args, 'tabId', 120)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    if (!isMultiSetTab(tabId)) return fail('BAD_REQUEST', `不是多套世界设定栏目：${tabId}`)
    const owner = deps.captureOwner(projectId)
    const [cards, rawActive] = await Promise.all([
      owner.store.getAll<CardRecord>('cardRecords'),
      db.getSettingFor<unknown>(projectId, activeKeyOf(tabId), [], owner),
    ])
    const active = new Set(Array.isArray(rawActive) ? rawActive.filter((id): id is string => typeof id === 'string') : [])
    const sets = cards.filter(card => card.projectId === projectId && card.tabId === subTabIdOf(tabId))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map(card => ({ id: card.id, name: card.name, order: card.order, active: active.has(card.id) }))
    const fields = (modulesFor(tabId, getActivePack()) ?? []).flatMap(module => module.fields.map(field => ({
      path: `${module.name}::${field.name}`, name: field.name, description: field.desc,
    })))
    return { ok: true, value: { projectId, tabId, fields, sets } }
  }

  async function listWorldPacks(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const owner = deps.captureOwner(projectId)
    const worlds = (await owner.store.getAll<WorldStoredRecord>('worlds'))
      .filter(world => world.origin?.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(world => ({ id: world.id, name: world.name, updatedAt: world.updatedAt, fingerprint: world.fingerprint,
        tables: (world.tables ?? []).map(table => ({ tabId: table.tabId, kind: table.kind, rows: table.rows.length })),
        versions: (world.versions ?? []).map(version => ({ version: version.v, at: version.at, fingerprint: version.fingerprint, note: version.note })),
      }))
    return { ok: true, value: { projectId, worlds } }
  }

  async function readWorldPackTable(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const worldId = str(args, 'worldId', 200)
    const tabId = str(args, 'tabId', 120)
    const offset = args.offset === undefined ? 0 : num(args, 'offset')
    const limit = args.limit === undefined ? 20 : num(args, 'limit')
    const version = args.version === undefined ? undefined : num(args, 'version')
    if (limit < 1 || limit > 100) return fail('BAD_REQUEST', 'limit 必须在 1 到 100 之间。')
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const owner = deps.captureOwner(projectId)
    const world = await owner.store.get<WorldStoredRecord>('worlds', worldId)
    if (!world || world.origin?.projectId !== projectId) return fail('NOT_FOUND', `世界包不存在：${worldId}`)
    const source = version === undefined ? world : (world.versions ?? []).find(item => item.v === version)
    if (!source) return fail('NOT_FOUND', `世界包版本不存在：${version}`)
    const table = (source.tables ?? []).find(item => item.tabId === tabId)
    if (!table) return fail('NOT_FOUND', `世界包栏目不存在：${tabId}`)
    return { ok: true, value: { projectId, worldId, tabId, version: version ?? null, kind: table.kind,
      total: table.rows.length, offset, rows: table.rows.slice(offset, offset + limit).map(row => ({
        id: row.id, name: row.name, order: row.order,
        fields: Object.fromEntries(Object.entries(row.data).filter(([key]) => !isInternalFieldKey(key))),
      })), activeIds: source.activeSubs?.[tabId] ?? [],
    } }
  }

  async function listProjectBackups(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const offset = args.offset === undefined ? 0 : num(args, 'offset')
    const limit = args.limit === undefined ? 20 : num(args, 'limit')
    if (limit < 1 || limit > 100) return fail('BAD_REQUEST', 'limit 必须在 1 到 100 之间。')
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const owner = deps.captureOwner(projectId)
    const backups = (await owner.store.getAll<BackupMeta>('backups')).filter(item => item.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    return { ok: true, value: { projectId, total: backups.length, offset, backups: backups.slice(offset, offset + limit).map(item => ({
      id: item.id, kind: item.kind, label: item.label, createdAt: item.createdAt, bytes: item.bytes,
      note: item.note, fingerprint: item.fingerprint, stats: item.stats,
    })) } }
  }

  async function searchProject(args: Record<string, unknown>): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const query = str(args, 'query', 200).trim()
    const limit = args.limit === undefined ? 30 : num(args, 'limit')
    if (limit < 1 || limit > 100) return fail('BAD_REQUEST', 'limit 必须在 1 到 100 之间。')
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const owner = deps.captureOwner(projectId)
    const [chapters, cards, rows, forms] = await Promise.all([
      deps.getChapters(owner), owner.store.getAll<CardRecord>('cardRecords'),
      owner.store.getAll<TableRow>('tableRows'), owner.store.getAll<FormData>('formData'),
    ])
    const results: { kind: string; id: string; tabId?: string; title: string; field: string; excerpt: string }[] = []
    const needle = query.toLocaleLowerCase()
    const add = (kind: string, id: string, title: string, field: string, value: unknown, tabId?: string) => {
      if (results.length >= limit || typeof value !== 'string') return
      const index = value.toLocaleLowerCase().indexOf(needle)
      if (index < 0) return
      results.push({ kind, id, ...(tabId ? { tabId } : {}), title, field,
        excerpt: value.slice(Math.max(0, index - 80), Math.min(value.length, index + query.length + 80)) })
    }
    for (const chapter of chapters.filter(item => item.projectId === projectId)) {
      add('chapter', chapter.id, chapter.title, 'title', chapter.title)
      add('chapter', chapter.id, chapter.title, 'summary', chapter.summary)
      add('chapter', chapter.id, chapter.title, 'content', chapter.content)
      if (results.length >= limit) break
    }
    for (const card of cards.filter(item => item.projectId === projectId)) {
      add('card', card.id, card.name, 'name', card.name, card.tabId)
      for (const [key, value] of Object.entries(card.data ?? {})) {
        if (!isInternalFieldKey(key)) add('card', card.id, card.name, key, value, card.tabId)
      }
      if (results.length >= limit) break
    }
    for (const row of rows.filter(item => item.projectId === projectId)) {
      const tab = TABS.find(item => item.id === row.tabId && item.type === 'table')
      if (!tab) continue
      const allowed = new Set((tab.columns ?? []).filter(column => !column.hidden).map(column => column.name))
      for (const [key, value] of Object.entries(row.data ?? {})) {
        if (allowed.has(key)) add('table', row.id, row.data[tab.displayCol ?? '名称'] ?? '', key, value, row.tabId)
      }
      if (results.length >= limit) break
    }
    for (const tab of TABS.filter(item => item.type === 'form')) {
      const form = forms.find(item => item.tabId === `${projectId}::${tab.id}`)
      if (!form) continue
      for (const [key, value] of Object.entries(form.data ?? {})) {
        if (!isInternalFieldKey(key)) add('form', tab.id, tab.name, key, value, tab.id)
      }
      if (results.length >= limit) break
    }
    owner.assertCurrent()
    return { ok: true, value: { projectId, query, limit, results, limitReached: results.length >= limit } }
  }

  /** 一次查询：项目 + 卷 + 章节统计 + 设定栏目 + 可写能力 + 版本（updatedAt）。 */
  async function getProject(args: Record<string, unknown>, scope: AgentScope): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const [volumes, chapters] = await Promise.all([deps.getVolumes(owner), deps.getChapters(owner)])
    const cards = await owner.store.getAll<CardRecord>('cardRecords')
    owner.assertCurrent()
    const projectVolumes = volumes.filter(v => v.projectId === projectId)
    const projectChapters = chapters.filter(c => c.projectId === projectId)
    const grantedActions = scope.projects.find(g => g.projectId === projectId)?.actions ?? []
    const writable = agentActionAllowed(scope, projectId, 'setting:create')
    return {
      ok: true,
      value: {
        ...projectSummary(project),
        open: true,
        grantedActions,
        volumes: projectVolumes
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map(v => ({ id: v.id, title: v.title, description: v.description ?? '', order: v.order, isFree: v.isFree === true })),
        chapters: projectChapters.length,
        totalWords: projectChapters.reduce((sum, c) => sum + (typeof c.wordCount === 'number' ? c.wordCount : 0), 0),
        chapterUpdatedAt: projectChapters.reduce((max, c) => Math.max(max, c.updatedAt || 0), 0),
        settings: cardTabs().map(tab => ({
          tabId: tab.id, name: tab.name, group: tab.group,
          cardCount: cards.filter(r => r.projectId === projectId && r.tabId === tab.id).length,
          writable,
          canUpdate: agentActionAllowed(scope, projectId, 'setting:write'),
        })),
      },
    }
  }

  function cardTabs(): TabDef[] {
    // 通过 getTab 逐个取，避免直接依赖 TABS 数组的静态导出形态
    const out: TabDef[] = []
    const seen = new Set<string>()
    for (const tabId of CARD_TAB_IDS) {
      const tab = deps.getTab(tabId)
      if (tab && tab.type === 'card' && !seen.has(tab.id)) { seen.add(tab.id); out.push(tab) }
    }
    return out
  }

  async function createSettingCard(args: Record<string, unknown>, scope: AgentScope): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const denied = requireAction(scope, projectId, 'setting:create')
    if (denied) return denied
    const blocked = storageBlocked()
    if (blocked) return blocked
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const tabId = str(args, 'tabId', 120)
    const name = str(args, 'name', MAX_CARD_NAME_CHARS).trim()
    const tab = deps.getTab(tabId)
    if (!tab || tab.type !== 'card') return fail('BAD_REQUEST', `栏目不是可写设定卡栏目：${tabId}`)
    const fields = args.fields
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return fail('BAD_REQUEST', '参数 fields 必填（对象：字段路径 / 字段名 → 字符串值）')
    }
    const schemaFields = deps.cardFieldsOf(tab)
    const byName = new Map(schemaFields.map(f => [f.name, f.path]))
    const byPath = new Set(schemaFields.map(f => f.path))
    const data: Record<string, string> = {}
    let total = 0
    for (const [key, raw] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof raw !== 'string') return fail('BAD_REQUEST', `字段 ${key} 的值必须是字符串`)
      if (raw.length > MAX_FIELD_CHARS) return fail('BAD_REQUEST', `字段 ${key} 超过单字段上限（${MAX_FIELD_CHARS} 字符）`)
      const path = byPath.has(key) ? key : byName.get(key)
      if (!path) {
        const hint = schemaFields.slice(0, 12).map(f => f.path).join('、')
        return fail('BAD_REQUEST', `未知字段：${key}。该栏目可用字段示例：${hint}`)
      }
      total += raw.length
      if (total > MAX_CARD_TOTAL_CHARS) return fail('BAD_REQUEST', `字段内容总量超过上限（${MAX_CARD_TOTAL_CHARS} 字符）`)
      data[path] = raw
    }
    if (!Object.keys(data).length) return fail('BAD_REQUEST', '至少需要一个设定字段')
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const all = await owner.store.getAll<CardRecord>('cardRecords')
    owner.assertCurrent()
    const sameTab = all.filter(r => r.projectId === projectId && r.tabId === tabId)
    const order = sameTab.reduce((max, r) => (Number.isFinite(r.order) && r.order > max ? r.order : max), -1) + 1
    const rec: CardRecord = {
      id: deps.uid(), projectId, tabId, name, data, order, createdAt: deps.now(),
    }
    if (await owner.store.get<CardRecord>('cardRecords', rec.id)) return fail('INTERNAL', '设定卡 ID 已存在，未创建。')
    await deps.saveCardRecord(rec, owner)
    return confirmWrite(owner, async () => {
      const saved = await owner.store.get<CardRecord>('cardRecords', rec.id)
      return !!saved && saved.projectId === projectId && saved.tabId === tabId && saved.name === name
        && Object.entries(data).every(([key, value]) => saved.data[key] === value)
    }, { cardId: rec.id, tabId, name, order, saved: true }, '创建设定卡后未能确认保存',
      { projectId, kind: 'setting', cardId: rec.id, tabId })
  }

  async function createWorldSet(args: Record<string, unknown>, scope: AgentScope): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const denied = requireAction(scope, projectId, 'setting:create')
    if (denied) return denied
    const blocked = storageBlocked()
    if (blocked) return blocked
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const tabId = str(args, 'tabId', 120)
    if (!isMultiSetTab(tabId)) return fail('BAD_REQUEST', `不是多套世界设定栏目：${tabId}`)
    const name = str(args, 'name', MAX_CARD_NAME_CHARS).trim()
    const fields = args.fields
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return fail('BAD_REQUEST', 'fields 必须是对象。')
    const modules = modulesFor(tabId, getActivePack()) ?? []
    const schema = modules.flatMap(module => module.fields.map(field => ({ name: field.name, path: `${module.name}::${field.name}` })))
    const nameCounts = new Map<string, number>()
    for (const field of schema) nameCounts.set(field.name, (nameCounts.get(field.name) ?? 0) + 1)
    const paths = new Set(schema.map(field => field.path))
    const byName = new Map(schema.filter(field => nameCounts.get(field.name) === 1).map(field => [field.name, field.path]))
    const data: Record<string, string> = {}
    let total = 0
    for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
      if (typeof value !== 'string' || value.length > MAX_FIELD_CHARS) return fail('BAD_REQUEST', `字段 ${key} 必须是长度合规的字符串。`)
      const path = paths.has(key) ? key : byName.get(key)
      if (!path) return fail('BAD_REQUEST', `未知或重名字段：${key}，请使用完整字段路径。`)
      total += value.length
      if (total > MAX_CARD_TOTAL_CHARS) return fail('BAD_REQUEST', '字段内容总量超过上限。')
      data[path] = value
    }
    if (!Object.keys(data).length) return fail('BAD_REQUEST', '至少需要一个设定字段。')
    const owner = deps.captureOwner(projectId)
    const all = await owner.store.getAll<CardRecord>('cardRecords')
    const subTab = subTabIdOf(tabId)
    const order = all.filter(card => card.projectId === projectId && card.tabId === subTab)
      .reduce((max, card) => Math.max(max, card.order || 0), -1) + 1
    const record: CardRecord = { id: deps.uid(), projectId, tabId: subTab, name, data, order, createdAt: deps.now() }
    if (await owner.store.get<CardRecord>('cardRecords', record.id)) return fail('INTERNAL', '设定 ID 已存在，未创建。')
    await deps.saveCardRecord(record, owner)
    return confirmWrite(owner, async () => {
      const saved = await owner.store.get<CardRecord>('cardRecords', record.id)
      return !!saved && saved.projectId === projectId && saved.tabId === subTab && saved.name === name
        && Object.entries(data).every(([key, value]) => saved.data[key] === value)
    }, { cardId: record.id, tabId, name, order, active: false, saved: true }, '创建世界设定后未能确认保存',
    { projectId, kind: 'world-set', cardId: record.id, tabId })
  }

  async function updateForm(args: Record<string, unknown>, scope: AgentScope): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const denied = requireAction(scope, projectId, 'form:write')
    if (denied) return denied
    const blocked = storageBlocked()
    if (blocked) return blocked
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const tabId = str(args, 'tabId', 120)
    const tab = TABS.find(item => item.id === tabId && item.type === 'form')
    if (!tab) return fail('BAD_REQUEST', `不是可修改的表单：${tabId}`)
    const changes = args.fields, expected = args.expectedFields
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)
      || !expected || typeof expected !== 'object' || Array.isArray(expected)) {
      return fail('BAD_REQUEST', 'fields 和 expectedFields 都必须是字段路径到字符串的对象。')
    }
    const paths = new Set((tab.modules ?? []).flatMap(module => module.fields.map(field => `${module.name}::${field.name}`)))
    const entries = Object.entries(changes as Record<string, unknown>)
    if (!entries.length || entries.length > 200) return fail('BAD_REQUEST', '必须提供 1 到 200 个字段。')
    const expectedValues = expected as Record<string, unknown>
    let total = 0
    for (const [path, value] of entries) {
      if (!paths.has(path) || isInternalFieldKey(path)) return fail('BAD_REQUEST', `未知或内部字段：${path}`)
      if (typeof value !== 'string' || value.length > MAX_FIELD_CHARS
        || typeof expectedValues[path] !== 'string' || (expectedValues[path] as string).length > MAX_FIELD_CHARS) {
        return fail('BAD_REQUEST', `字段 ${path} 和预期旧值必须为长度合规的字符串。`)
      }
      total += value.length
      if (total > MAX_CARD_TOTAL_CHARS) return fail('BAD_REQUEST', '字段内容总量超过上限。')
    }
    if (Object.keys(expectedValues).some(path => !Object.prototype.hasOwnProperty.call(changes, path))) {
      return fail('BAD_REQUEST', 'expectedFields 只能包含本次修改的字段。')
    }
    if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存后再修改表单。')
    const release = acquireAgentForm(projectId, tabId)
    if (!release) return fail('DRAFT_DIRTY', '该表单正在引擎中编辑或保存，请先离开并保存后重试。')
    try {
      const owner = deps.captureOwner(projectId)
      const migration = await guardTabWrite(projectId, tabId, 'import')
      if (migration) return fail('STORAGE_BLOCKED', `${migration.message} ${migration.hint}`)
      const key = `${projectId}::${tabId}`
      const old = await owner.store.get<FormData>('formData', key)
      const data = old?.data ?? {}
      for (const [path] of entries) {
        if ((data[path] ?? '') !== expectedValues[path]) return fail('CONFLICT', `字段已变化：${path}。请重新读取表单。`)
      }
      const next = { ...data, ...Object.fromEntries(entries) } as Record<string, string>
      if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '读取期间出现未保存的编辑草稿，请先保存。')
      if (isTabMigrationActive(projectId, tabId)) return fail('STORAGE_BLOCKED', '该表单正在迁移模板，请稍后重新读取。')
      await owner.store.put('formData', { tabId: key, data: next } as FormData)
      void db.touchProject(projectId, owner.store)
      return await confirmWrite(owner, async () => {
        const saved = await owner.store.get<FormData>('formData', key)
        return !!saved && entries.every(([path, value]) => saved.data[path] === value)
      }, { projectId, tabId, fields: entries.map(([path]) => path), saved: true }, '修改表单后未能确认保存',
      { projectId, kind: 'form', tabId })
    } finally { release() }
  }

  async function createTableRow(args: Record<string, unknown>, scope: AgentScope): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const denied = requireAction(scope, projectId, 'table:create')
    if (denied) return denied
    const blocked = storageBlocked()
    if (blocked) return blocked
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const tabId = str(args, 'tabId', 120)
    const tab = TABS.find(item => item.id === tabId && item.type === 'table' && AGENT_MUTABLE_TABLES.has(item.id))
    if (!tab) return fail('BAD_REQUEST', `该表格暂不支持创建条目：${tabId}`)
    if (!args.fields || typeof args.fields !== 'object' || Array.isArray(args.fields)) return fail('BAD_REQUEST', 'fields 必须是对象。')
    const columns = tab.columns ?? []
    const data: Record<string, string> = Object.fromEntries(columns.map(column => [column.name, '']))
    let total = 0
    for (const [key, value] of Object.entries(args.fields as Record<string, unknown>)) {
      const column = columns.find(item => item.name === key)
      if (!column) return fail('BAD_REQUEST', `未知的字段：${key}`)
      if (column.hidden || key === '编号') return fail('READ_ONLY_FIELD', `字段 ${key} 由引擎维护，不可写入${key === '编号' ? '（编号在创建时自动分配）' : ''}。`)
      if (typeof value !== 'string' || value.length > MAX_FIELD_CHARS) return fail('BAD_REQUEST', `字段 ${key} 必须是长度合规的字符串。`)
      total += value.length
      if (total > MAX_CARD_TOTAL_CHARS) return fail('BAD_REQUEST', '字段内容总量超过上限。')
      data[key] = value
    }
    if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存。')
    const release = acquireAgentForm(projectId, tableLeaseKey(tabId))
    if (!release) return fail('DRAFT_DIRTY', '该表格正在引擎中编辑或保存，请先保存并离开后重试。')
    try {
      const owner = deps.captureOwner(projectId)
      const migration = await guardTabWrite(projectId, tabId, 'import')
      if (migration) return fail('STORAGE_BLOCKED', `${migration.message} ${migration.hint}`)
      const existing = (await owner.store.getAllByIndex<TableRow>('tableRows', 'tabId', tabId)).filter(row => row.projectId === projectId)
      if (columns.some(column => column.name === '编号') && AUTONUM_GROUPS.has(tab.group)) data['编号'] = nextAutoCode(tabId, existing)
      const fieldError = await validateTableFields(owner, tab, args.fields as Record<string, string>)
      if (fieldError) return fail(fieldError.code, fieldError.message)
      if ((tabId === 'timeline' || tabId === 'history') && data['发生时间'] && !data['结束时间']) data['结束时间'] = data['发生时间']
      const check = validateImport([data], tab, { existing, refValues: new Map() })[0]
      if (check.missing.length || check.dupExisting || check.codeConflict || check.dangling.length) {
        return fail('BAD_REQUEST', '条目缺少主字段、重复、编号冲突或存在无效引用。')
      }
      const now = deps.now()
      const row: TableRow = { id: deps.uid(), projectId, tabId, data, order: existing.reduce((max, item) => Math.max(max, item.order || 0), -1) + 1, createdAt: now, updatedAt: now }
      if (await owner.store.get<TableRow>('tableRows', row.id)) return fail('INTERNAL', '表格条目 ID 已存在，未创建。')
      if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '读取期间出现未保存的编辑草稿，请先保存。')
      if (isTabMigrationActive(projectId, tabId)) return fail('STORAGE_BLOCKED', '该表格正在迁移模板，请稍后重新读取。')
      await owner.store.put('tableRows', row)
      void db.touchProject(projectId, owner.store)
      return await confirmWrite(owner, async () => {
        const saved = await owner.store.get<TableRow>('tableRows', row.id)
        return !!saved && saved.projectId === projectId && saved.tabId === tabId
          && Object.entries(data).every(([key, value]) => saved.data[key] === value)
      }, { projectId, tabId, rowId: row.id, code: data['编号'] || undefined, saved: true }, '创建表格条目后未能确认保存',
      { projectId, kind: 'table', tabId })
    } finally { release() }
  }

  async function createVolume(args: Record<string, unknown>, scope: AgentScope): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const denied = requireAction(scope, projectId, 'volume:create')
    if (denied) return denied
    const blocked = storageBlocked()
    if (blocked) return blocked
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const title = str(args, 'title', MAX_NAME_CHARS).trim()
    const description = str(args, 'description', MAX_FIELD_CHARS, false)
    const owner = deps.captureOwner(projectId)
    const volumes = await deps.getVolumes(owner)
    const order = volumes.filter(volume => volume.projectId === projectId && !volume.isFree)
      .reduce((max, volume) => Math.max(max, volume.order), -1) + 1
    const volume: Volume = { id: deps.uid(), projectId, title, description, order, createdAt: deps.now() }
    if (await owner.store.get<Volume>('volumes', volume.id)) return fail('INTERNAL', '分卷 ID 已存在，未创建分卷。')
    await owner.store.put('volumes', volume)
    void db.touchProject(projectId, owner.store)
    return confirmWrite(owner, async () => {
      const saved = await owner.store.get<Volume>('volumes', volume.id)
      return !!saved && saved.projectId === projectId && saved.title === title
    }, { volumeId: volume.id, title, order, saved: true }, '创建分卷后未能确认保存',
    { projectId, kind: 'volume', volumeId: volume.id })
  }

  async function createChapter(args: Record<string, unknown>, scope: AgentScope): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const denied = requireAction(scope, projectId, 'chapter:create')
    if (denied) return denied
    const blocked = storageBlocked()
    if (blocked) return blocked
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const title = str(args, 'title', MAX_NAME_CHARS).trim()
    const content = str(args, 'content', MAX_CONTENT_CHARS, false)
    const summary = str(args, 'summary', MAX_FIELD_CHARS, false)
    const wantedVolume = str(args, 'volumeId', 200, false)
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const [volumes, chapters] = await Promise.all([deps.getVolumes(owner), deps.getChapters(owner)])
    owner.assertCurrent()
    let volumeId = ''
    if (wantedVolume) {
      if (!volumes.some(v => v.id === wantedVolume && v.projectId === projectId)) {
        return fail('BAD_REQUEST', `卷不存在或不属于该项目：${wantedVolume}`)
      }
      volumeId = wantedVolume
    } else {
      const target = latestChapterTarget(volumes.filter(v => v.projectId === projectId), chapters.filter(c => c.projectId === projectId))
      if (!target) return fail('NO_VOLUME', '项目中还没有分卷。请先在引擎「正文写作」中新建至少一个卷，再让 Agent 录入正文。')
      volumeId = target.volumeId
    }
    const order = nextOrderInVolume(chapters, volumeId)
    const now = deps.now()
    const ch: Chapter = {
      id: deps.uid(), projectId, volumeId, order, title,
      content, summary, status: '草稿', wordCount: deps.countWords(content),
      createdAt: now, updatedAt: now,
    }
    await deps.createChapter(ch, owner)
    owner.assertCurrent()
    // 台账 / 序号是派生行为：失败不能让已写入的章节变成“未知”，但要如实带回警告
    const warnings: string[] = []
    try {
      const [lv, lc] = await Promise.all([deps.getVolumes(owner), deps.getChapters(owner)])
      await deps.syncChapterMaster(ch, deps.chapterSeqOf(lv, lc, ch.id), undefined, owner)
    } catch (error) {
      warnings.push(`章节台账同步失败（正文已保存）：${error instanceof Error ? error.message : String(error)}`)
    }
    const value = { ...toWriteResult(ch), ...(warnings.length ? { warnings } : {}) }
    return confirmWrite(owner, async () => {
      const saved = await owner.store.get<Chapter>('chapters', ch.id)
      return !!saved && saved.projectId === projectId && saved.content === content
    }, value, '创建章节后未能确认保存',
      { projectId, kind: 'chapter', chapterId: ch.id })
  }

  async function updateChapterInfo(args: Record<string, unknown>, scope: AgentScope): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const denied = requireAction(scope, projectId, 'chapter:write')
    if (denied) return denied
    const blocked = storageBlocked()
    if (blocked) return blocked
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const chapterId = str(args, 'chapterId', 200)
    const expected = num(args, 'expectedUpdatedAt')
    if (args.title === undefined && args.summary === undefined) return fail('BAD_REQUEST', '必须提供 title 或 summary。')
    const title = args.title === undefined ? undefined : str(args, 'title', MAX_NAME_CHARS).trim()
    const summary = args.summary === undefined ? undefined : str(args, 'summary', MAX_FIELD_CHARS, false)
    if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存后再修改章节。')
    const owner = deps.captureOwner(projectId)
    const old = await owner.store.get<Chapter>('chapters', chapterId)
    if (!old || old.projectId !== projectId) return fail('NOT_FOUND', `章节不存在：${chapterId}`)
    if (old.updatedAt !== expected) return fail('CONFLICT', '章节已更新，请重新读取后再试。', { chapterId, updatedAt: old.updatedAt })
    if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '读取期间出现未保存的编辑草稿，请先保存。')
    const patch = { ...(title === undefined ? {} : { title }), ...(summary === undefined ? {} : { summary }), updatedAt: Math.max(deps.now(), (old.updatedAt || 0) + 1) }
    const updated = await deps.patchChapter(chapterId, patch, owner)
    if (!updated) return fail('OUTCOME_UNKNOWN', '章节修改结果不明，请在引擎中核对。')
    const warnings: string[] = []
    try {
      const [volumes, chapters] = await Promise.all([deps.getVolumes(owner), deps.getChapters(owner)])
      await deps.syncChapterMaster(updated, deps.chapterSeqOf(volumes, chapters, updated.id), undefined, owner)
    } catch (error) { warnings.push(`章节台账同步失败：${error instanceof Error ? error.message : String(error)}`) }
    return confirmWrite(owner, async () => {
      const saved = await owner.store.get<Chapter>('chapters', chapterId)
      return !!saved && saved.projectId === projectId && saved.updatedAt === updated.updatedAt
        && saved.title === updated.title && saved.summary === updated.summary
    }, { ...toWriteResult(updated), summary: updated.summary, ...(warnings.length ? { warnings } : {}) },
    '修改章节信息后未能确认保存', { projectId, kind: 'chapter', chapterId })
  }

  async function appendOrReplace(args: Record<string, unknown>, scope: AgentScope, mode: 'append' | 'replace'): Promise<AgentToolResult> {
    const projectId = str(args, 'projectId', 200)
    const denied = requireAction(scope, projectId, 'chapter:write')
    if (denied) return denied
    const blocked = storageBlocked()
    if (blocked) return blocked
    const project = await projectOf(projectId)
    if ('ok' in project) return project
    const chapterId = str(args, 'chapterId', 200)
    const content = str(args, 'content', MAX_CONTENT_CHARS, mode === 'replace')
    const expected = num(args, 'expectedUpdatedAt')
    if (deps.unsavedDraft()) {
      return fail('DRAFT_DIRTY', '引擎中还有未保存的编辑草稿。请先保存（或离开编辑页）后再让 Agent 写入，以免覆盖作者正在修改的内容。')
    }
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const old = await owner.store.get<Chapter>('chapters', chapterId)
    if (!old || old.projectId !== projectId) return fail('NOT_FOUND', `章节不存在：${chapterId}`)
    if (old.updatedAt !== expected) {
      return fail('CONFLICT', '章节已在引擎中更新，本次写入未执行。请重新读取章节后再试。', {
        chapterId, updatedAt: old.updatedAt, wordCount: old.wordCount, title: old.title,
      })
    }
    const nextContent = mode === 'replace'
      ? content
      : appendText(old.content, content)
    if (nextContent === old.content) return { ok: true, value: { ...toWriteResult(old), saved: true, unchanged: true } }
    // 覆盖 / 追加前留一版可恢复快照（章级最多 12 份，自动裁剪走引擎既有策略）
    try {
      await deps.createSnapshot(old, 'ai-rewrite', owner)
    } catch {
      return fail('SAVE_FAILED', '无法创建可恢复版本，已放弃本次正文写入（未改动原章节）。')
    }
    // 创建快照会让出事件循环，作者可能在这段时间开始输入或保存新版本。
    if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '创建快照期间出现未保存草稿，请先保存后重试。')
    const latest = await owner.store.get<Chapter>('chapters', chapterId)
    if (!latest || latest.projectId !== projectId) return fail('NOT_FOUND', '章节已不存在或不属于该项目。')
    if (latest.updatedAt !== expected || latest.content !== old.content) return fail('CONFLICT', '创建快照期间章节已变化，请重新读取后再试。', { chapterId, updatedAt: latest.updatedAt })
    if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '读取章节期间出现未保存草稿，请先保存后重试。')
    // 每次 Agent 写入让 updatedAt **严格递增**：同一毫秒内的两次写入若更新值相同，
    // 后一个请求的 expectedUpdatedAt 仍会「看起来匹配」，版本前置条件就失效了。
    // 只抬高 Agent 写入自身的 updatedAt，不改引擎其他保存路径的取值口径。
    const nextUpdatedAt = Math.max(deps.now(), (old.updatedAt || 0) + 1)
    const updated = await deps.patchChapter(chapterId, {
      content: nextContent,
      wordCount: deps.countWords(nextContent),
      updatedAt: nextUpdatedAt,
    }, owner)
    if (!updated) return fail('OUTCOME_UNKNOWN', '写入过程中章节已不存在，结果不明。请先在引擎中核对。')
    const warnings: string[] = []
    try {
      const [lv, lc] = await Promise.all([deps.getVolumes(owner), deps.getChapters(owner)])
      await deps.syncChapterMaster(updated, deps.chapterSeqOf(lv, lc, updated.id), undefined, owner)
    } catch (error) {
      warnings.push(`章节台账同步失败（正文已保存）：${error instanceof Error ? error.message : String(error)}`)
    }
    const value = { ...toWriteResult(updated), ...(warnings.length ? { warnings } : {}) }
    return confirmWrite(owner, async () => {
      const saved = await owner.store.get<Chapter>('chapters', updated.id)
      return !!saved && saved.content === nextContent && saved.wordCount === updated.wordCount
    }, value, mode === 'replace' ? '覆盖正文后未能确认保存' : '追加正文后未能确认保存',
      { projectId, kind: 'chapter', chapterId: updated.id })
  }

  return {
    async call(call: AgentToolCall, scope: AgentScope): Promise<AgentToolResult> {
      const invoke = async (): Promise<AgentToolResult> => {
        try {
          switch (call.tool) {
            case AGENT_TOOL_NAMES.listProjects: return await listProjects(scope)
            case AGENT_TOOL_NAMES.getProject: return await getProject(call.args, scope)
            case AGENT_TOOL_NAMES.listChapters: return await listChapters(call.args, scope)
            case AGENT_TOOL_NAMES.readChapter: return await readChapter(call.args)
            case AGENT_TOOL_NAMES.checkChapterWords: return await checkChapterWords(call.args)
            case AGENT_TOOL_NAMES.checkChapterTypos: return await checkChapterTypos(call.args)
            case AGENT_TOOL_NAMES.listSettingTabs: return await listSettingTabs(call.args, scope)
            case AGENT_TOOL_NAMES.listSettingCards: return await listSettingCards(call.args)
            case AGENT_TOOL_NAMES.readSettingCard: return await readSettingCard(call.args)
            case AGENT_TOOL_NAMES.listDataTabs: return await listDataTabs(call.args, scope)
            case AGENT_TOOL_NAMES.readForm: return await readForm(call.args)
            case AGENT_TOOL_NAMES.listTableRows: return await listTableRows(call.args)
            case AGENT_TOOL_NAMES.listTavernReports: return await listTavernReports(call.args)
            case AGENT_TOOL_NAMES.readTavernReport: return await readTavernReport(call.args)
            case AGENT_TOOL_NAMES.listChapterSnapshots: return await listChapterSnapshots(call.args)
            case AGENT_TOOL_NAMES.readChapterSnapshot: return await readChapterSnapshot(call.args)
            case AGENT_TOOL_NAMES.listWorldSets: return await listWorldSets(call.args)
            case AGENT_TOOL_NAMES.listWorldPacks: return await listWorldPacks(call.args)
            case AGENT_TOOL_NAMES.readWorldPackTable: return await readWorldPackTable(call.args)
            case AGENT_TOOL_NAMES.listProjectBackups: return await listProjectBackups(call.args)
            case AGENT_TOOL_NAMES.listMaps: return await listMaps(call.args, deps)
            case AGENT_TOOL_NAMES.listMapPlaces: return await listMapPlaces(call.args, deps)
            case AGENT_TOOL_NAMES.searchProject: return await searchProject(call.args)
            case AGENT_TOOL_NAMES.readPlotCanvas: return await readPlotCanvas(call.args, deps)
            case AGENT_TOOL_NAMES.createSettingCard: return await createSettingCard(call.args, scope)
            case AGENT_TOOL_NAMES.updateSettingCard: return await updateSettingCard(call.args, scope, deps)
            case AGENT_TOOL_NAMES.createWorldSet: return await createWorldSet(call.args, scope)
            case AGENT_TOOL_NAMES.setWorldSetActive: return await setWorldSetActive(call.args, scope, deps)
            case AGENT_TOOL_NAMES.updateForm: return await updateForm(call.args, scope)
            case AGENT_TOOL_NAMES.createTableRow: return await createTableRow(call.args, scope)
            case AGENT_TOOL_NAMES.updateTableRow: return await updateTableRow(call.args, scope, deps)
            case AGENT_TOOL_NAMES.createVolume: return await createVolume(call.args, scope)
            case AGENT_TOOL_NAMES.createChapter: return await createChapter(call.args, scope)
            case AGENT_TOOL_NAMES.appendChapter: return await appendOrReplace(call.args, scope, 'append')
            case AGENT_TOOL_NAMES.replaceChapter: return await appendOrReplace(call.args, scope, 'replace')
            case AGENT_TOOL_NAMES.updateChapterInfo: return await updateChapterInfo(call.args, scope)
            case AGENT_TOOL_NAMES.updateVolume: return await updateVolume(call.args, scope, deps)
            case AGENT_TOOL_NAMES.deleteChapter: return await deleteChapter(call.args, scope, deps)
            case AGENT_TOOL_NAMES.listInspirations: return await listInspirations(call.args, deps)
            case AGENT_TOOL_NAMES.listChapterTrash: return await listChapterTrash(call.args, deps)
            case AGENT_TOOL_NAMES.saveCheckReport: return await saveCheckReport(call.args, scope, deps, call.requestId)
            case AGENT_TOOL_NAMES.listCheckReports: return await listCheckReports(call.args, deps)
            case AGENT_TOOL_NAMES.readCheckReport: return await readCheckReport(call.args, deps)
            case AGENT_TOOL_NAMES.updateInspiration: return await updateInspiration(call.args, scope, deps)
            case AGENT_TOOL_NAMES.deleteInspiration: return await deleteInspiration(call.args, scope, deps)
            case AGENT_TOOL_NAMES.startAgentTask: return await startAgentTask(call.args, scope, deps)
            case AGENT_TOOL_NAMES.updateAgentTask: return await updateAgentTask(call.args, scope, deps)
            case AGENT_TOOL_NAMES.finishAgentTask: return await finishAgentTask(call.args, scope, deps)
            case AGENT_TOOL_NAMES.cancelAgentTask: return await cancelAgentTask(call.args, scope, deps)
            case AGENT_TOOL_NAMES.listAgentTasks: return await listAgentTasks(call.args, deps)
            case AGENT_TOOL_NAMES.getAgentTask: return await getAgentTask(call.args, deps)
            case AGENT_TOOL_NAMES.restoreChapter: return await restoreChapter(call.args, scope, deps)
            case AGENT_TOOL_NAMES.addInspiration: return await addInspiration(call.args, scope, deps)
            case AGENT_TOOL_NAMES.createMap: return await createMap(call.args, scope, deps)
            case AGENT_TOOL_NAMES.updateMap: return await updateMap(call.args, scope, deps)
            case AGENT_TOOL_NAMES.deleteMap: return await deleteMap(call.args, scope, deps)
            case AGENT_TOOL_NAMES.createMapPlace: return await createMapPlace(call.args, scope, deps)
            case AGENT_TOOL_NAMES.updateMapPlaceCells: return await updateMapPlaceCells(call.args, scope, deps)
            case AGENT_TOOL_NAMES.createPlotCard: return await createPlotCard(call.args, scope, deps)
            case AGENT_TOOL_NAMES.updatePlotCard: return await updatePlotCard(call.args, scope, deps)
            case AGENT_TOOL_NAMES.deletePlotCard: return await deletePlotCard(call.args, scope, deps)
            case AGENT_TOOL_NAMES.updatePlotConnections: return await updatePlotConnections(call.args, scope, deps)
            case AGENT_TOOL_NAMES.previewWorldImport: return await previewWorldImport(call.args, scope, deps)
            case AGENT_TOOL_NAMES.importWorldPack: return await importWorldPack(call.args, scope, deps)
            case AGENT_TOOL_NAMES.previewBackupRestore: return await previewBackupRestore(call.args, scope, deps)
            case AGENT_TOOL_NAMES.restoreProjectBackup: return await restoreProjectBackup(call.args, scope, deps)
            default: return fail('UNKNOWN_TOOL', `未知工具：${call.tool}`)
          }
        } catch (error) {
          if (error instanceof AgentInputError || error instanceof AgentContentInputError) return fail('BAD_REQUEST', error.message)
          const message = error instanceof Error ? error.message : String(error)
          // 归属 / 存储上下文切换：写函数在写前抛错＝未写入；写后抛错＝结果不明。
          // 这里无法区分，按**结果不明**上报（宁可让作者核对，也不能让 Agent 盲目重试造成重复追加）。
          if (message.includes('项目或存储空间已切换') || message.includes('存储空间已切换')) {
            return fail('OUTCOME_UNKNOWN', `${message}（结果不明，请先在引擎中核对，不要复用同一 requestId 重试）`)
          }
          return fail('INTERNAL', `执行失败（未确认写入）：${message}`)
        }
      }
      return WRITE_TOOL_SET.has(call.tool) ? enqueueWrite(invoke) : invoke()
    },
  }
}

function toWriteResult(ch: Chapter): AgentChapterWriteResult {
  return {
    chapterId: ch.id, title: ch.title, wordCount: ch.wordCount, updatedAt: ch.updatedAt, saved: true,
  }
}

/** 追加时避免正文直接粘连：旧文非空且两边都没有换行时补一个空行分隔 */
export function appendText(old: string, add: string): string {
  if (!old) return add
  if (!add) return old
  if (old.endsWith('\n') || add.startsWith('\n')) return old + add
  return old + (old.endsWith('\n\n') ? '' : '\n\n') + add
}

/**
 * 首期开放的「设定卡」栏目 —— 与 `schemaTabs/part*.ts` 里 `type: 'card'` 的页签逐项一致。
 * 🔴 只列 card 型：表单型（世界设定 / 力量体系）是单份母级数据，不能“创建一张卡”；
 *    表格型没有卡片名与字段结构，首期不纳入写工具。
 */
export const CARD_TAB_IDS: readonly string[] = [
  'char-main', 'char-secondary', 'char-npc', 'misc-settings', 'volume-outline', 'chapter-outline',
]
