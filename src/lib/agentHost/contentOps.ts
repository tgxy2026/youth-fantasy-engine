/**
 * Agent 对「卷 / 章节结构 / 灵感夹」的写入与读取。
 *
 * 与正文写入同一条纪律：只作用于当前打开项目、写前查草稿与存储状态、
 * 写后等待落盘并回读、成功才通知界面。删除章节只移入回收站（可恢复），
 * 且拒绝删除正在编辑器中打开的章。
 */
import type { AgentExecutorDeps } from '@/lib/agentHost/executor'
import { agentActionAllowed, fail, MAX_CONTENT_CHARS, MAX_NAME_CHARS, type AgentScope, type AgentToolResult } from '@/lib/agentHost/contract'
import { listTrash, restoreFromTrash, touchProject } from '@/lib/db'
import { getSettingFor } from '@/lib/db/meta'
import type { Chapter, Volume } from '@/lib/types'
import { addItem as addInspirationItem, INSPIRATION_BOX_KEY, INSPIRATION_MAX, removeItem as removeInspirationItem, updateItem as updateInspirationItem } from '@/lib/creative/inspirationBox'

const MAX_VOLUME_DESCRIPTION = 2_000
const MAX_INSPIRATION_CHARS = 2_000
export class AgentContentInputError extends Error {}

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

async function requireOpenProject(projectId: string, deps: AgentExecutorDeps): Promise<AgentToolResult | null> {
  if (!(await deps.getProjects()).some(project => project.id === projectId)) {
    return fail('PROJECT_NOT_FOUND', `项目不存在：${projectId}`)
  }
  if (deps.currentProjectId() !== projectId) {
    return fail('PROJECT_NOT_OPEN', '请先在引擎中打开该项目。')
  }
  return null
}

// ---------- 卷 ----------

export async function updateVolume(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const volumeId = readString(args, 'volumeId', 200)
  const expectedTitle = readString(args, 'expectedTitle', MAX_NAME_CHARS)
  const title = readString(args, 'title', MAX_NAME_CHARS, false)
  const description = readString(args, 'description', MAX_VOLUME_DESCRIPTION, false)
  const writesDescription = args.description !== undefined
  if (!title.trim() && !writesDescription) return fail('BAD_REQUEST', 'title 与 description 至少改一项。')
  if (writesDescription && typeof args.expectedDescription !== 'string') return fail('BAD_REQUEST', '修改分卷描述前必须提供读取时的 expectedDescription。')
  const expectedDescription = writesDescription ? readString(args, 'expectedDescription', MAX_VOLUME_DESCRIPTION, false) : ''
  if (!agentActionAllowed(scope, projectId, 'volume:write')) return fail('SCOPE_DENIED', '该项目未授权修改分卷。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  owner.assertCurrent()
  const volume = await owner.store.get<Volume>('volumes', volumeId)
  if (!volume || volume.projectId !== projectId) return fail('NOT_FOUND', `分卷不存在：${volumeId}`)
  if (volume.isFree) return fail('BAD_REQUEST', '自由卷不支持重命名或改描述。')
  if (volume.title !== expectedTitle) return fail('CONFLICT', '分卷标题已变化，请重新读取。', { volumeId, title: volume.title })
  if (writesDescription && (volume.description ?? '') !== expectedDescription) return fail('CONFLICT', '分卷描述已变化，请重新读取。', { volumeId, title: volume.title, description: volume.description ?? '' })
  const next: Volume = {
    ...volume,
    ...(title.trim() ? { title: title.trim() } : {}),
    ...(writesDescription ? { description } : {}),
  }
  await owner.store.put('volumes', next)
  void touchProject(projectId, owner.store)
  let flushed = false
  try { flushed = await deps.flush(); owner.assertCurrent() } catch {
    return fail('OUTCOME_UNKNOWN', '写入期间项目或存储状态改变，请先核对。')
  }
  if (!flushed) return fail('SAVE_FAILED', '分卷修改可能已进入内存但未确认落盘，请先核对。')
  const saved = await owner.store.get<Volume>('volumes', volumeId)
  if (!saved || saved.projectId !== projectId || saved.title !== next.title || saved.description !== next.description) {
    return fail('OUTCOME_UNKNOWN', '修改后未能确认分卷内容，请先在引擎中核对。')
  }
  deps.notify({ projectId, kind: 'volume', volumeId })
  return { ok: true, value: { volumeId, title: saved.title, description: saved.description, saved: true } }
}

// ---------- 章节删除（回收站） ----------

export async function deleteChapter(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const chapterId = readString(args, 'chapterId', 200)
  const expected = args.expectedUpdatedAt
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    return fail('BAD_REQUEST', '删除章节前必须读取并提供非负整数 expectedUpdatedAt。')
  }
  if (!agentActionAllowed(scope, projectId, 'chapter:delete')) return fail('SCOPE_DENIED', '该项目未授权删除章节。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  if (deps.activeChapterId() === chapterId) return fail('DRAFT_DIRTY', '该章正在编辑器中打开，请先切换到别的章节再删除。')
  const owner = deps.captureOwner(projectId)
  owner.assertCurrent()
  const chapter = await owner.store.get<Chapter>('chapters', chapterId)
  if (!chapter || chapter.projectId !== projectId) return fail('NOT_FOUND', `章节不存在：${chapterId}`)
  if (chapter.updatedAt !== expected) {
    return fail('CONFLICT', '章节已在引擎中更新，本次删除未执行。请重新读取。', { chapterId, updatedAt: chapter.updatedAt, title: chapter.title })
  }
  if (deps.unsavedDraft() || deps.activeChapterId() === chapterId) return fail('DRAFT_DIRTY', '读取期间章节已打开或出现未保存草稿，请先保存并切换章节。')
  await owner.store.put('trash', { ...chapter, deletedAt: deps.now(), kind: 'chapter' })
  if (deps.unsavedDraft() || deps.activeChapterId() === chapterId) return fail('OUTCOME_UNKNOWN', '删除过程中章节被打开或出现草稿，章节仍需核对，回收站可能已留副本。')
  const latest = await owner.store.get<Chapter>('chapters', chapterId)
  if (!latest || latest.projectId !== projectId || latest.updatedAt !== chapter.updatedAt || latest.content !== chapter.content
    || latest.title !== chapter.title || latest.summary !== chapter.summary || latest.volumeId !== chapter.volumeId || latest.order !== chapter.order) {
    return fail('OUTCOME_UNKNOWN', '放入回收站期间章节发生变化，未继续删除；请核对正文和回收站副本。')
  }
  if (deps.unsavedDraft() || deps.activeChapterId() === chapterId) return fail('OUTCOME_UNKNOWN', '删除前章节被打开或出现草稿，未继续删除；请核对正文和回收站副本。')
  await owner.store.del('chapters', chapterId)
  await owner.store.del('tableRows', `ch-${chapterId}`)
  const snapshots = await owner.store.getAllByIndex<{ id: string }>('snapshots', 'chapterId', chapterId)
  if (snapshots.length) await owner.store.bulkDel('snapshots', snapshots.map(snapshot => snapshot.id))
  void touchProject(projectId, owner.store)
  let flushed = false
  try { flushed = await deps.flush(); owner.assertCurrent() } catch {
    return fail('OUTCOME_UNKNOWN', '删除期间项目或存储状态改变，请先核对。')
  }
  if (!flushed) return fail('SAVE_FAILED', '删除可能已进入内存但未确认落盘，请先在引擎中核对。')
  const gone = await owner.store.get<Chapter>('chapters', chapterId)
  const trashed = await owner.store.get<{ kind?: string }>('trash', chapterId)
  if (gone || !trashed || trashed.kind !== 'chapter') return fail('OUTCOME_UNKNOWN', '删除后未能确认回收站记录，请先在引擎中核对。')
  deps.notify({ projectId, kind: 'chapter', chapterId, deleted: true })
  return { ok: true, value: { chapterId, title: chapter.title, trashed: true, saved: true } }
}

// ---------- 回收站 ----------

/** 列出当前项目回收站里的章节（可恢复）。 */
export async function listChapterTrash(args: Record<string, unknown>, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const offset = args.offset === undefined ? 0 : Number(args.offset)
  const limit = args.limit === undefined ? 20 : Number(args.limit)
  if (!Number.isInteger(offset) || offset < 0) return fail('BAD_REQUEST', 'offset 必须是非负整数。')
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail('BAD_REQUEST', 'limit 必须在 1 到 100 之间。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const items = (await listTrash()).filter(item => item.projectId === projectId)
  return {
    ok: true,
    value: {
      projectId, total: items.length, offset,
      items: items.slice(offset, offset + limit).map(item => ({
        id: item.id, title: item.title, volumeId: item.volumeId, volumeTitle: item.volumeTitle ?? '',
        deletedAt: item.deletedAt, wordCount: item.wordCount, updatedAt: item.updatedAt,
      })),
    },
  }
}

/** 从回收站恢复章节；原卷不在时引擎会放入「已恢复章节」卷并重建章节台账。 */
export async function restoreChapter(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const chapterId = readString(args, 'chapterId', 200)
  let expectedDeletedAt: number | undefined
  if (args.expectedDeletedAt !== undefined) {
    if (typeof args.expectedDeletedAt !== 'number' || !Number.isFinite(args.expectedDeletedAt)) return fail('BAD_REQUEST', 'expectedDeletedAt 必须是数字。')
    expectedDeletedAt = args.expectedDeletedAt
  }
  if (!agentActionAllowed(scope, projectId, 'chapter:restore')) return fail('SCOPE_DENIED', '该项目未授权从回收站恢复章节。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  owner.assertCurrent()
  const trashed = await owner.store.get<{ projectId?: string; deletedAt?: number }>('trash', chapterId)
  if (!trashed || trashed.projectId !== projectId) return fail('NOT_FOUND', `回收站中没有该章节：${chapterId}`)
  if (expectedDeletedAt !== undefined && trashed.deletedAt !== expectedDeletedAt) {
    return fail('CONFLICT', '回收站条目已变化，请重新读取。', { chapterId, deletedAt: trashed.deletedAt })
  }
  const existing = await owner.store.get<Chapter>('chapters', chapterId)
  if (existing) return fail('CONFLICT', '同 ID 的章节已存在，未恢复。请核对后重试。', { chapterId })
  const restored = await restoreFromTrash(chapterId)
  if (!restored) return fail('OUTCOME_UNKNOWN', '恢复接口未返回章节，请先在引擎中核对回收站与章节列表。')
  let flushed = false
  try {
    flushed = await deps.flush()
    owner.assertCurrent()
  } catch {
    return fail('OUTCOME_UNKNOWN', '恢复期间项目或存储状态改变，请先核对。')
  }
  if (!flushed) return fail('SAVE_FAILED', '恢复可能已进入内存但未确认落盘，请先核对。')
  const saved = await owner.store.get<Chapter>('chapters', restored.id)
  const stillTrashed = await owner.store.get<{ projectId?: string }>('trash', chapterId)
  if (!saved || saved.projectId !== projectId || stillTrashed) return fail('OUTCOME_UNKNOWN', '恢复后未能确认章节与回收站状态，请先在引擎中核对。')
  deps.notify({ projectId, kind: 'chapter', chapterId: saved.id })
  return { ok: true, value: { chapterId: saved.id, title: saved.title, volumeId: saved.volumeId, wordCount: saved.wordCount, restored: true, saved: true } }
}

// ---------- 灵感夹 ----------

interface InspirationItem {
  id: string
  text: string
  createdAt: number
  chapterId?: string
}

export async function listInspirations(args: Record<string, unknown>, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  owner.assertCurrent()
  const record = await owner.store.get<{ value?: unknown }>('settingsKV', `${projectId}::${INSPIRATION_BOX_KEY}`)
  const items = record ? record.value : []
  if (!Array.isArray(items) || items.some(item => !item || typeof item.id !== 'string' || typeof item.text !== 'string')) {
    return fail('INTERNAL', '灵感夹数据格式无效，请在引擎中核对，未将异常数据当作空列表。')
  }
  const list = items as InspirationItem[]
  return {
    ok: true,
    value: list.map(item => ({
      id: item.id, text: item.text, createdAt: item.createdAt, ...(item.chapterId ? { chapterId: item.chapterId } : {}),
    })),
  }
}

export async function addInspiration(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const text = readString(args, 'text', Math.min(MAX_INSPIRATION_CHARS, MAX_CONTENT_CHARS)).trim()
  const chapterId = readString(args, 'chapterId', 200, false)
  if (!agentActionAllowed(scope, projectId, 'inspiration:write')) return fail('SCOPE_DENIED', '该项目未授权写入灵感夹。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  owner.assertCurrent()
  if (chapterId) {
    const chapter = await owner.store.get<Chapter>('chapters', chapterId)
    if (!chapter || chapter.projectId !== projectId) return fail('NOT_FOUND', `章节不存在：${chapterId}`)
  }
  const added = await addInspirationItem(text, undefined, projectId, chapterId || undefined)
  if (!added.added) return fail('BAD_REQUEST', added.reason === 'full'
    ? `灵感夹已达 ${INSPIRATION_MAX} 条上限，请先在引擎中整理。`
    : added.reason === 'dup' ? '相同灵感已存在，未重复添加。' : '灵感内容不能为空。')
  const item = added.items.find(entry => entry.text === text)
  if (!item) return fail('OUTCOME_UNKNOWN', '灵感写入结果不明，请先在引擎中核对。')
  let flushed = false
  try { flushed = await deps.flush(); owner.assertCurrent() } catch {
    return fail('OUTCOME_UNKNOWN', '写入期间项目或存储状态改变，请先核对。')
  }
  if (!flushed) return fail('SAVE_FAILED', '灵感写入可能已进入内存但未确认落盘，请先核对。')
  const saved = await getSettingFor<unknown>(projectId, 'inspirationBox', [], owner)
  const hit = Array.isArray(saved) ? (saved as InspirationItem[]).find(entry => entry.id === item.id) : undefined
  if (!hit || hit.text !== text) return fail('OUTCOME_UNKNOWN', '写入后未能确认灵感条目，请先在引擎中核对。')
  deps.notify({ projectId, kind: 'inspiration' })
  return { ok: true, value: { inspirationId: item.id, text: hit.text, saved: true } }
}

/** 修改灵感夹条目；旧文本作为版本条件，保留 id / 时间 / 章节引用。 */
export async function updateInspiration(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const inspirationId = readString(args, 'inspirationId', 200)
  const text = readString(args, 'text', MAX_INSPIRATION_CHARS).trim()
  const expectedText = readString(args, 'expectedText', MAX_INSPIRATION_CHARS)
  if (!agentActionAllowed(scope, projectId, 'inspiration:write')) return fail('SCOPE_DENIED', '该项目未授权写入灵感夹。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  owner.assertCurrent()
  const result = await updateInspirationItem(inspirationId, text, expectedText, projectId)
  if (!result.updated) {
    if (result.reason === 'missing') return fail('NOT_FOUND', `灵感条目不存在：${inspirationId}`)
    if (result.reason === 'conflict') return fail('CONFLICT', '灵感内容已变化，请重新读取。', { inspirationId })
    if (result.reason === 'dup') return fail('BAD_REQUEST', '相同灵感已存在，未修改。')
    return fail('BAD_REQUEST', '灵感内容不能为空。')
  }
  let flushed = false
  try {
    flushed = await deps.flush()
    owner.assertCurrent()
  } catch {
    return fail('OUTCOME_UNKNOWN', '修改期间项目或存储状态改变，请先核对。')
  }
  if (!flushed) return fail('SAVE_FAILED', '灵感修改可能已进入内存但未确认落盘，请先核对。')
  const saved = await getSettingFor<unknown>(projectId, 'inspirationBox', [], owner)
  const hit = Array.isArray(saved) ? (saved as InspirationItem[]).find(entry => entry.id === inspirationId) : undefined
  if (!hit || hit.text !== text) return fail('OUTCOME_UNKNOWN', '修改后未能确认灵感条目，请先在引擎中核对。')
  deps.notify({ projectId, kind: 'inspiration' })
  return { ok: true, value: { inspirationId, text: hit.text, saved: true } }
}

/** 删除灵感夹条目；需旧文本前置与 confirm:true。 */
export async function deleteInspiration(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const inspirationId = readString(args, 'inspirationId', 200)
  const expectedText = readString(args, 'expectedText', MAX_INSPIRATION_CHARS)
  if (args.confirm !== true) return fail('BAD_REQUEST', '删除灵感前必须传 confirm: true。')
  if (!agentActionAllowed(scope, projectId, 'inspiration:write')) return fail('SCOPE_DENIED', '该项目未授权写入灵感夹。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  owner.assertCurrent()
  const before = await getSettingFor<unknown>(projectId, 'inspirationBox', [], owner)
  if (!Array.isArray(before)) return fail('INTERNAL', '灵感夹数据格式无效，请在引擎中核对。')
  const items = before as InspirationItem[]
  const hit = items.find(item => item.id === inspirationId)
  if (!hit) return fail('NOT_FOUND', `灵感条目不存在：${inspirationId}`)
  if (hit.text !== expectedText) return fail('CONFLICT', '灵感内容已变化，请重新读取。', { inspirationId })
  await removeInspirationItem(inspirationId, items)
  let flushed = false
  try {
    flushed = await deps.flush()
    owner.assertCurrent()
  } catch {
    return fail('OUTCOME_UNKNOWN', '删除期间项目或存储状态改变，请先核对。')
  }
  if (!flushed) return fail('SAVE_FAILED', '灵感删除可能已进入内存但未确认落盘，请先核对。')
  const after = await getSettingFor<unknown>(projectId, 'inspirationBox', [], owner)
  const gone = Array.isArray(after) && !(after as InspirationItem[]).some(item => item.id === inspirationId)
  if (!gone) return fail('OUTCOME_UNKNOWN', '删除后仍能读到该灵感，请先在引擎中核对。')
  deps.notify({ projectId, kind: 'inspiration' })
  return { ok: true, value: { inspirationId, deleted: true, saved: true } }
}