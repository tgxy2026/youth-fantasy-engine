/**
 * Agent 对「卷 / 章节结构 / 灵感夹」的写入与读取。
 *
 * 与正文写入同一条纪律：只作用于当前打开项目、写前查草稿与存储状态、
 * 写后等待落盘并回读、成功才通知界面。删除章节只移入回收站（可恢复），
 * 且拒绝删除正在编辑器中打开的章。
 */
import type { AgentExecutorDeps } from '@/lib/agentHost/executor'
import { agentActionAllowed, fail, MAX_CONTENT_CHARS, MAX_NAME_CHARS, type AgentScope, type AgentToolResult } from '@/lib/agentHost/contract'
import { touchProject } from '@/lib/db'
import { getSettingFor, setSettingFor } from '@/lib/db/meta'
import type { Chapter, Volume } from '@/lib/types'

const MAX_VOLUME_DESCRIPTION = 2_000
const MAX_INSPIRATIONS = 500
const MAX_INSPIRATION_CHARS = 2_000

function readString(args: Record<string, unknown>, key: string, max: number, required = true): string {
  const raw = args[key]
  if (raw === undefined || raw === null) {
    if (required) throw new Error(`参数 ${key} 必填（非空字符串）`)
    return ''
  }
  if (typeof raw !== 'string') throw new Error(`参数 ${key} 必须是字符串`)
  if (required && !raw.trim()) throw new Error(`参数 ${key} 必填（非空字符串）`)
  if (raw.length > max) throw new Error(`参数 ${key} 超过上限（${max} 字符）`)
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
  if (!title.trim() && description === '') return fail('BAD_REQUEST', 'title 与 description 至少改一项。')
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
  const next: Volume = {
    ...volume,
    ...(title.trim() ? { title: title.trim() } : {}),
    ...(description !== '' ? { description } : {}),
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
  if (expected !== undefined && (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0)) {
    return fail('BAD_REQUEST', 'expectedUpdatedAt 必须是非负整数时间戳。')
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
  if (typeof expected === 'number' && chapter.updatedAt !== expected) {
    return fail('CONFLICT', '章节已在引擎中更新，本次删除未执行。请重新读取。', { chapterId, updatedAt: chapter.updatedAt, title: chapter.title })
  }
  await owner.store.put('trash', { ...chapter, deletedAt: deps.now(), kind: 'chapter' })
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
  const items = await getSettingFor<unknown>(projectId, 'inspirationBox', [], owner)
  const list = Array.isArray(items) ? items as InspirationItem[] : []
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
  const current = await getSettingFor<unknown>(projectId, 'inspirationBox', [], owner)
  const list = Array.isArray(current) ? current as InspirationItem[] : []
  if (list.length >= MAX_INSPIRATIONS) return fail('BAD_REQUEST', `灵感夹已达 ${MAX_INSPIRATIONS} 条上限，请先在引擎中整理。`)
  const item: InspirationItem = { id: deps.uid(), text, createdAt: deps.now(), ...(chapterId ? { chapterId } : {}) }
  await setSettingFor(projectId, 'inspirationBox', [...list, item], owner)
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