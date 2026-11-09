/**
 * Agent 对「情节画布」的对象级写入（3.4.3 · P1 领域）。
 *
 * 画布数据存于项目 settingsKV 的 `plotCanvas`（`{ selected, cards, conns }`）。
 * 写入纪律：
 *   · 每次写都必须携带读取时的 `expectedFingerprint`（整个画布内容的稳定指纹）；
 *   · 画布编辑页打开期间拒绝写入（页面内有防抖草稿，会覆盖 Agent 结果）；
 *   · 写后落盘确认并回读指纹，失败按「结果不明」处理。
 */
import type { AgentExecutorDeps } from '@/lib/agentHost/executor'
import {
  agentActionAllowed, fail,
  type AgentScope, type AgentToolResult,
} from '@/lib/agentHost/contract'
import { AgentContentInputError } from '@/lib/agentHost/contentOps'
import { acquireAgentForm, canvasLeaseKey } from '@/lib/agentHost/formLease'
import * as db from '@/lib/db'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'

const KEY = 'plotCanvas'
const MAX_CARD_TEXT = 20_000
const MAX_CARD_TYPE = 40
const MAX_BADGES = 2_000

export interface PlotCardLike {
  id: string
  chapter?: string
  type?: string
  text?: string
  x?: number
  y?: number
  basedOn?: string
  [key: string]: unknown
}

export interface PlotCanvasLike {
  selected: string[]
  cards: PlotCardLike[]
  conns: [string, string][]
  [key: string]: unknown
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 稳定指纹：与卡片顺序无关，但保留连接的多重集合顺序敏感。 */
export function plotCanvasFingerprint(canvas: PlotCanvasLike): string {
  const cards = [...canvas.cards].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const text = stable({ cards, conns: canvas.conns })
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function normalizePlotCanvas(raw: unknown): PlotCanvasLike {
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) throw new Error('画布数据格式损坏，拒绝读取或修改')
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  if ((record.cards !== undefined && !Array.isArray(record.cards))
    || (record.conns !== undefined && !Array.isArray(record.conns))
    || (record.selected !== undefined && !Array.isArray(record.selected))) throw new Error('画布数据格式损坏，拒绝读取或修改')
  const cards = Array.isArray(record.cards)
    ? record.cards.filter((item): item is PlotCardLike => !!item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string')
    : []
  const conns = (Array.isArray(record.conns) ? record.conns : []).filter((item): item is [string, string] =>
    Array.isArray(item) && item.length === 2 && typeof item[0] === 'string' && typeof item[1] === 'string')
  const selected = (Array.isArray(record.selected) ? record.selected : []).filter((id): id is string => typeof id === 'string')
  if ((Array.isArray(record.cards) && cards.length !== record.cards.length)
    || (Array.isArray(record.conns) && conns.length !== record.conns.length)
    || (Array.isArray(record.selected) && selected.length !== record.selected.length)) throw new Error('画布数据包含无效条目，拒绝读取或修改')
  return { ...record, selected, cards, conns }
}

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

function readNumber(args: Record<string, unknown>, key: string): number {
  const raw = args[key]
  if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > 1_000_000) {
    throw new AgentContentInputError(`参数 ${key} 必须是有限数字（绝对值 ≤ 1000000）`)
  }
  return raw
}

async function requireOpenProject(projectId: string, deps: AgentExecutorDeps): Promise<AgentToolResult | null> {
  if (!(await deps.getProjects()).some(project => project.id === projectId)) return fail('PROJECT_NOT_FOUND', `项目不存在：${projectId}`)
  if (deps.currentProjectId() !== projectId) return fail('PROJECT_NOT_OPEN', '请先在引擎中打开该项目。')
  return null
}

async function writeCanvas(
  projectId: string,
  next: PlotCanvasLike,
  owner: OwnedOperation,
  deps: AgentExecutorDeps,
): Promise<string> {
  await db.setSettingFor(projectId, KEY, next, owner)
  void db.touchProject(projectId, owner.store)
  let flushed = false
  try {
    flushed = await deps.flush()
    owner.assertCurrent()
  } catch {
    throw new Error('画布写入期间项目或存储状态改变，结果不明')
  }
  if (!flushed) throw new Error('画布写入可能已进入内存但未确认落盘')
  const saved = normalizePlotCanvas(await db.getSettingFor<unknown>(projectId, KEY, null, owner))
  if (plotCanvasFingerprint(saved) !== plotCanvasFingerprint(next)) throw new Error('画布写入后回读不一致')
  deps.notify({ projectId, kind: 'canvas' })
  return plotCanvasFingerprint(saved)
}

function prepare(projectId: string, scope: AgentScope, deps: AgentExecutorDeps): AgentToolResult | null {
  if (!agentActionAllowed(scope, projectId, 'canvas:write')) return fail('SCOPE_DENIED', '该项目未授权修改情节画布。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存。')
  return null
}

/** 创建一张情节卡。 */
export async function createPlotCard(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const expectedFingerprint = readString(args, 'expectedFingerprint', 64)
  const text = readString(args, 'text', MAX_CARD_TEXT)
  const type = readString(args, 'type', MAX_CARD_TYPE, false) || '情节'
  const chapter = readString(args, 'chapter', 200, false)
  const basedOn = readString(args, 'basedOn', 200, false)
  const x = readNumber(args, 'x')
  const y = readNumber(args, 'y')
  const problem = prepare(projectId, scope, deps)
  if (problem) return problem
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const release = acquireAgentForm(projectId, canvasLeaseKey)
  if (!release) return fail('DRAFT_DIRTY', '情节画布正在引擎中打开或保存，请先离开该页面再重试。')
  try {
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    if (chapter) {
      const chapters = await deps.getChapters(owner)
      if (!chapters.some(item => item.id === chapter && item.projectId === projectId)) return fail('BAD_REQUEST', `章节不存在：${chapter}`)
    }
    const canvas = normalizePlotCanvas(await db.getSettingFor<unknown>(projectId, KEY, null, owner))
    if (plotCanvasFingerprint(canvas) !== expectedFingerprint) return fail('CONFLICT', '情节画布已变化，请重新读取。', { fingerprint: plotCanvasFingerprint(canvas) })
    const card: PlotCardLike = {
      id: deps.uid(),
      ...(chapter ? { chapter } : {}),
      type, text, x, y,
      ...(basedOn ? { basedOn } : {}),
    }
    const next: PlotCanvasLike = { ...canvas, cards: [...canvas.cards, card] }
    const fingerprint = await writeCanvas(projectId, next, owner, deps)
    return { ok: true, value: { cardId: card.id, fingerprint, saved: true } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(/回读|落盘|状态改变/.test(message) ? 'OUTCOME_UNKNOWN' : 'SAVE_FAILED', message)
  } finally { release() }
}

/** 修改一张情节卡；只允许改白名单字段。 */
export async function updatePlotCard(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const cardId = readString(args, 'cardId', 200)
  const expectedFingerprint = readString(args, 'expectedFingerprint', 64)
  const tells = ['text', 'type', 'chapter', 'basedOn', 'x', 'y'] as const
  if (!tells.some(key => args[key] !== undefined)) return fail('BAD_REQUEST', 'text / type / chapter / basedOn / x / y 至少改一项。')
  const patch: Partial<PlotCardLike> = {}
  if (args.text !== undefined) patch.text = readString(args, 'text', MAX_CARD_TEXT)
  if (args.type !== undefined) patch.type = readString(args, 'type', MAX_CARD_TYPE)
  if (args.chapter !== undefined) patch.chapter = readString(args, 'chapter', 200, false)
  if (args.basedOn !== undefined) patch.basedOn = readString(args, 'basedOn', 200, false)
  if (args.x !== undefined) patch.x = readNumber(args, 'x')
  if (args.y !== undefined) patch.y = readNumber(args, 'y')
  const problem = prepare(projectId, scope, deps)
  if (problem) return problem
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const release = acquireAgentForm(projectId, canvasLeaseKey)
  if (!release) return fail('DRAFT_DIRTY', '情节画布正在引擎中打开或保存，请先离开该页面再重试。')
  try {
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    if (patch.chapter) {
      const chapters = await deps.getChapters(owner)
      if (!chapters.some(item => item.id === patch.chapter && item.projectId === projectId)) return fail('BAD_REQUEST', `章节不存在：${patch.chapter}`)
    }
    const canvas = normalizePlotCanvas(await db.getSettingFor<unknown>(projectId, KEY, null, owner))
    if (plotCanvasFingerprint(canvas) !== expectedFingerprint) return fail('CONFLICT', '情节画布已变化，请重新读取。', { fingerprint: plotCanvasFingerprint(canvas) })
    const index = canvas.cards.findIndex(card => card.id === cardId)
    if (index < 0) return fail('NOT_FOUND', `情节卡不存在：${cardId}`)
    const nextCards = [...canvas.cards]
    nextCards[index] = { ...nextCards[index], ...patch }
    const next: PlotCanvasLike = { ...canvas, cards: nextCards }
    const fingerprint = await writeCanvas(projectId, next, owner, deps)
    return { ok: true, value: { cardId, fingerprint, saved: true } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(/回读|落盘|状态改变/.test(message) ? 'OUTCOME_UNKNOWN' : 'SAVE_FAILED', message)
  } finally { release() }
}

/** 删除情节卡及其全部连线。 */
export async function deletePlotCard(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const cardId = readString(args, 'cardId', 200)
  const expectedFingerprint = readString(args, 'expectedFingerprint', 64)
  const problem = prepare(projectId, scope, deps)
  if (problem) return problem
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const release = acquireAgentForm(projectId, canvasLeaseKey)
  if (!release) return fail('DRAFT_DIRTY', '情节画布正在引擎中打开或保存，请先离开该页面再重试。')
  try {
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const canvas = normalizePlotCanvas(await db.getSettingFor<unknown>(projectId, KEY, null, owner))
    if (plotCanvasFingerprint(canvas) !== expectedFingerprint) return fail('CONFLICT', '情节画布已变化，请重新读取。', { fingerprint: plotCanvasFingerprint(canvas) })
    if (!canvas.cards.some(card => card.id === cardId)) return fail('NOT_FOUND', `情节卡不存在：${cardId}`)
    const removedConns = canvas.conns.filter(conn => conn[0] === cardId || conn[1] === cardId).length
    const next: PlotCanvasLike = {
      ...canvas,
      cards: canvas.cards.filter(card => card.id !== cardId),
      conns: canvas.conns.filter(conn => conn[0] !== cardId && conn[1] !== cardId),
      selected: canvas.selected.filter(id => id !== cardId),
    }
    const fingerprint = await writeCanvas(projectId, next, owner, deps)
    return { ok: true, value: { cardId, removedConnections: removedConns, fingerprint, saved: true } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(/回读|落盘|状态改变/.test(message) ? 'OUTCOME_UNKNOWN' : 'SAVE_FAILED', message)
  } finally { release() }
}

/** 增加 / 移除连线。 */
export async function updatePlotConnections(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const expectedFingerprint = readString(args, 'expectedFingerprint', 64)
  const readPairs = (key: string): [string, string][] => {
    const raw = args[key]
    if (raw === undefined) return []
    if (!Array.isArray(raw) || raw.length > MAX_BADGES) throw new AgentContentInputError(`参数 ${key} 必须是 [from,to] 数组（最多 ${MAX_BADGES} 项）`)
    return raw.map(item => {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string') {
        throw new AgentContentInputError(`参数 ${key} 的每一项必须是 [from,to] 字符串对`)
      }
      if (item[0] === item[1]) throw new AgentContentInputError('连线两端不能是同一张卡')
      return [item[0], item[1]] as [string, string]
    })
  }
  const add = readPairs('add')
  const remove = readPairs('remove')
  if (!add.length && !remove.length) return fail('BAD_REQUEST', 'add 与 remove 至少提供一项。')
  const problem = prepare(projectId, scope, deps)
  if (problem) return problem
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const release = acquireAgentForm(projectId, canvasLeaseKey)
  if (!release) return fail('DRAFT_DIRTY', '情节画布正在引擎中打开或保存，请先离开该页面再重试。')
  try {
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const canvas = normalizePlotCanvas(await db.getSettingFor<unknown>(projectId, KEY, null, owner))
    if (plotCanvasFingerprint(canvas) !== expectedFingerprint) return fail('CONFLICT', '情节画布已变化，请重新读取。', { fingerprint: plotCanvasFingerprint(canvas) })
    const ids = new Set(canvas.cards.map(card => card.id))
    for (const pair of add) {
      if (!ids.has(pair[0]) || !ids.has(pair[1])) return fail('BAD_REQUEST', '连线引用了不存在的情节卡。')
    }
    const keyOf = (pair: [string, string]) => `${pair[0]}\u0000${pair[1]}`
    const removeKeys = new Set(remove.map(keyOf))
    const conns: [string, string][] = canvas.conns.filter(conn => !removeKeys.has(keyOf(conn)))
    for (const pair of add) if (!conns.some(conn => keyOf(conn) === keyOf(pair))) conns.push(pair)
    const next: PlotCanvasLike = { ...canvas, conns }
    const fingerprint = await writeCanvas(projectId, next, owner, deps)
    return { ok: true, value: { connections: conns.length, added: add.length, removed: remove.length, fingerprint, saved: true } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(/回读|落盘|状态改变/.test(message) ? 'OUTCOME_UNKNOWN' : 'SAVE_FAILED', message)
  } finally { release() }
}
/** 分页读取当前项目已保存的情节画布；返回指纹供后续写入做版本条件。 */
export async function readPlotCanvas(args: Record<string, unknown>, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const offset = args.offset === undefined ? 0 : Number(args.offset)
  const limit = args.limit === undefined ? 20 : Number(args.limit)
  if (!Number.isInteger(offset) || offset < 0) return fail('BAD_REQUEST', 'offset 必须是非负整数。')
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail('BAD_REQUEST', 'limit 必须在 1 到 100 之间。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  const canvas = normalizePlotCanvas(await db.getSettingFor<unknown>(projectId, KEY, null, owner))
  const ids = new Set(canvas.cards.slice(offset, offset + limit).map(card => card.id))
  const connections = canvas.conns.filter(conn => ids.has(conn[0]) || ids.has(conn[1]))
  owner.assertCurrent()
  return { ok: true, value: { projectId, total: canvas.cards.length, offset,
    cards: canvas.cards.slice(offset, offset + limit).map(card => ({ id: card.id, chapter: card.chapter, type: card.type, text: card.text, x: card.x, y: card.y, basedOn: card.basedOn })),
    connections, selected: canvas.selected, fingerprint: plotCanvasFingerprint(canvas) } }
}
