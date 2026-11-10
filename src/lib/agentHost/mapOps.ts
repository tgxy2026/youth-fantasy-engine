/**
 * Agent 对「地图 / 地理风物 / 地图格子」的对象级写入（3.4.3 · P1 领域）。
 *
 * 地图数据仍是普通设定表行：`geomaps` 是地图清单，`geography` 是地点档案，
 * `地图格子` 是隐藏列（"x,y;x,y" 的 1km 格集合）。本模块复用引擎自身的规则：
 *   · 名称唯一、自动编号、字段白名单与引用校验；
 *   · 子范围必须落在**所有已绘制的祖先**格集合内；
 *   · 同一格不能同时属于无祖先关系的两个范围；
 *   · 擦除被子孙占用的格必须拒绝。
 *
 * 🔴 打开地图编辑页期间拒绝写入（页面内租约），避免页面的本地状态覆盖 Agent 结果。
 */
import type { AgentExecutorDeps } from '@/lib/agentHost/executor'
import {
  agentActionAllowed, fail, MAX_FIELD_CHARS, MAX_NAME_CHARS,
  type AgentScope, type AgentToolResult,
} from '@/lib/agentHost/contract'
import { AgentContentInputError } from '@/lib/agentHost/contentOps'
import { acquireAgentForm, tableLeaseKey } from '@/lib/agentHost/formLease'
import { getTab } from '@/lib/schema'
import { touchProject } from '@/lib/db'
import { guardTabWrite, isTabMigrationActive } from '@/lib/templates/migrationGuard'
import { AUTONUM_GROUPS, nextAutoCode } from '@/lib/ai/autoCode'
import { validateImport } from '@/lib/storage/tableIO'
import { validateTableFields } from '@/lib/agentHost/validateTableFields'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'
import type { TableRow } from '@/lib/types'

const MAX_MAP_DESCRIPTION = 2_000
const MAX_CELLS = 50_000
const MAX_CELLS_PER_CHANGE = 20_000
const MAX_CELL_COORD = 10_000
const GEOMAP_TAB = 'geomaps'
const GEOGRAPHY_TAB = 'geography'
const CELL_FIELD = '地图格子'

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

function readNumber(args: Record<string, unknown>, key: string, required = true): number {
  const raw = args[key]
  if (raw === undefined || raw === null) {
    if (required) throw new AgentContentInputError(`参数 ${key} 必填（整数）`)
    return 0
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw)) throw new AgentContentInputError(`参数 ${key} 必须是整数`)
  return raw
}

export function parseCells(text: unknown): Set<string> {
  const out = new Set<string>()
  if (typeof text !== 'string' || !text) return out
  for (const part of text.split(';')) {
    const t = part.trim()
    if (/^-?\d+\s*,\s*-?\d+$/.test(t)) out.add(t.replace(/\s/g, ''))
  }
  return out
}

function serializeCells(cells: Set<string>): string {
  return [...cells].sort().join(';')
}

/** 稳定 32 位 FNV-1a；写入前作为乐观版本条件。 */
export function cellsHash(cells: Set<string>): string {
  const text = [...cells].sort().join(';')
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

function validateCell(cell: string): string | null {
  const match = /^(-?\d+),(-?\d+)$/.exec(cell)
  if (!match) return `格子格式无效：${cell}（应为 "x,y"）`
  const x = Number(match[1])
  const y = Number(match[2])
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || Math.abs(x) > MAX_CELL_COORD || Math.abs(y) > MAX_CELL_COORD) {
    return `格子坐标超出范围：${cell}`
  }
  return null
}

function readCellList(args: Record<string, unknown>, key: string): string[] {
  const raw = args[key]
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new AgentContentInputError(`参数 ${key} 必须是字符串数组`)
  if (raw.length > MAX_CELLS_PER_CHANGE) throw new AgentContentInputError(`参数 ${key} 一次最多 ${MAX_CELLS_PER_CHANGE} 个格子`)
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') throw new AgentContentInputError(`参数 ${key} 只能包含字符串`)
    const cell = item.replace(/\s/g, '')
    const bad = validateCell(cell)
    if (bad) throw new AgentContentInputError(bad)
    out.push(cell)
  }
  return out
}

async function requireOpenProject(projectId: string, deps: AgentExecutorDeps): Promise<AgentToolResult | null> {
  if (!(await deps.getProjects()).some(project => project.id === projectId)) return fail('PROJECT_NOT_FOUND', `项目不存在：${projectId}`)
  if (deps.currentProjectId() !== projectId) return fail('PROJECT_NOT_OPEN', '请先在引擎中打开该项目。')
  return null
}

async function flushAndVerify(
  owner: OwnedOperation,
  deps: AgentExecutorDeps,
  verify: () => Promise<boolean>,
  hint: string,
): Promise<AgentToolResult | null> {
  let flushed = false
  try {
    flushed = await deps.flush()
    owner.assertCurrent()
  } catch {
    return fail('OUTCOME_UNKNOWN', `${hint}：写入期间项目或存储状态改变，请先核对。`)
  }
  if (!flushed) return fail('SAVE_FAILED', `${hint}：可能已进入内存但未确认落盘，请先核对。`)
  if (!await verify()) return fail('OUTCOME_UNKNOWN', `${hint}：写入后未能确认内容，请先在引擎中核对。`)
  return null
}

/** 只把用户可写列交给字段校验：自动编号与隐藏列不在 Agent 写入白名单内。 */
function writableFields(tab: { columns?: { name: string; hidden?: boolean }[] }, data: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(data)) {
    const column = tab.columns?.find(item => item.name === key)
    if (!column || column.hidden || key === '编号') continue
    out[key] = value
  }
  return out
}

function mapNameOf(row: TableRow): string {
  return typeof row.data['名称'] === 'string' ? row.data['名称'].trim() : ''
}

function rowsOfMap(all: TableRow[], mapName: string): TableRow[] {
  return all.filter(row => (row.data['所属地图'] ?? '') === mapName)
}

/** 地点 id → 其全部子孙 id（沿「层级归属」向下）。 */
function descendantIds(rows: TableRow[], id: string): Set<string> {
  const byName = new Map(rows.map(row => [mapNameOf(row), row]))
  const children = new Map<string, string[]>()
  for (const row of rows) {
    const parent = byName.get(String(row.data['层级归属'] ?? '').trim())
    if (parent) {
      const list = children.get(parent.id) ?? []
      list.push(row.id)
      children.set(parent.id, list)
    }
  }
  const out = new Set<string>()
  const stack = [...(children.get(id) ?? [])]
  while (stack.length) {
    const next = stack.pop()!
    if (out.has(next)) continue
    out.add(next)
    stack.push(...(children.get(next) ?? []))
  }
  return out
}

function ancestorIds(rows: TableRow[], row: TableRow): string[] {
  const byName = new Map(rows.map(item => [mapNameOf(item), item]))
  const out: string[] = []
  const seen = new Set<string>()
  let current = row
  for (;;) {
    const parent = byName.get(String(current.data['层级归属'] ?? '').trim())
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    out.push(parent.id)
    current = parent
  }
  return out
}

/** 创建地图。 */
export async function createMap(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const name = readString(args, 'name', MAX_NAME_CHARS).trim()
  const kilometers = readString(args, 'kilometersPerCell', 2).trim()
  const description = readString(args, 'description', MAX_MAP_DESCRIPTION, false)
  if (kilometers !== '1' && kilometers !== '10') return fail('BAD_REQUEST', 'kilometersPerCell 只能是 "1" 或 "10"。')
  if (!agentActionAllowed(scope, projectId, 'map:create')) return fail('SCOPE_DENIED', '该项目未授权创建地图。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const tab = getTab(GEOMAP_TAB)
  if (!tab || tab.type !== 'table') return fail('INTERNAL', '地图表定义缺失。')
  const release = acquireAgentForm(projectId, tableLeaseKey(GEOMAP_TAB))
  if (!release) return fail('DRAFT_DIRTY', '地图正在引擎中编辑或保存，请先保存并离开后重试。')
  try {
    const owner = deps.captureOwner(projectId)
    const migration = await guardTabWrite(projectId, GEOMAP_TAB, 'import')
    if (migration) return fail('STORAGE_BLOCKED', `${migration.message} ${migration.hint}`)
    if (isTabMigrationActive(projectId, GEOMAP_TAB)) return fail('STORAGE_BLOCKED', '地图表正在迁移模板，请稍后重试。')
    const existing = (await owner.store.getAllByIndex<TableRow>('tableRows', 'tabId', GEOMAP_TAB)).filter(row => row.projectId === projectId)
    if (existing.some(row => mapNameOf(row) === name)) return fail('BAD_REQUEST', `地图名称已存在：${name}`)
    const columns = tab.columns ?? []
    const data: Record<string, string> = Object.fromEntries(columns.map(column => [column.name, '']))
    data['名称'] = name
    data['每格公里'] = kilometers
    data['说明'] = description
    data['底图模式'] = '格子'
    data['底图'] = ''
    if (columns.some(column => column.name === '编号') && AUTONUM_GROUPS.has(tab.group)) data['编号'] = nextAutoCode(GEOMAP_TAB, existing)
    const fieldError = await validateTableFields(owner, tab, writableFields(tab, data))
    if (fieldError) return fail(fieldError.code, fieldError.message)
    const check = validateImport([data], tab, { existing, refValues: new Map() })[0]
    if (check.missing.length || check.dupExisting || check.codeConflict || check.dangling.length) {
      return fail('BAD_REQUEST', '地图缺少主字段、重复、编号冲突或存在无效引用。')
    }
    const now = deps.now()
    const row: TableRow = { id: deps.uid(), projectId, tabId: GEOMAP_TAB, data, order: existing.reduce((max, item) => Math.max(max, item.order || 0), -1) + 1, createdAt: now, updatedAt: now }
    if (await owner.store.get<TableRow>('tableRows', row.id)) return fail('INTERNAL', '地图 ID 已存在，未创建。')
    await owner.store.put('tableRows', row)
    void touchProject(projectId, owner.store)
    const failure = await flushAndVerify(owner, deps, async () => {
      const saved = await owner.store.get<TableRow>('tableRows', row.id)
      return !!saved && saved.projectId === projectId && mapNameOf(saved) === name
    }, '创建地图后未能确认保存')
    if (failure) return failure
    deps.notify({ projectId, kind: 'table', tabId: GEOMAP_TAB })
    return { ok: true, value: { mapId: row.id, name, code: data['编号'] || undefined, kilometersPerCell: kilometers, saved: true } }
  } finally { release() }
}

/** 修改地图名称 / 档位 / 说明；改名时级联更新《地理风物》的「所属地图」。 */
export async function updateMap(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const mapId = readString(args, 'mapId', 200)
  const expectedName = readString(args, 'expectedName', MAX_NAME_CHARS)
  const expectedUpdatedAt = readNumber(args, 'expectedUpdatedAt')
  const name = readString(args, 'name', MAX_NAME_CHARS, false).trim()
  const description = readString(args, 'description', MAX_MAP_DESCRIPTION, false)
  const kilometers = readString(args, 'kilometersPerCell', 2, false).trim()
  const writesDescription = args.description !== undefined
  const writesKm = args.kilometersPerCell !== undefined
  if (!name && !writesDescription && !writesKm) return fail('BAD_REQUEST', 'name / description / kilometersPerCell 至少改一项。')
  if (writesKm && kilometers !== '1' && kilometers !== '10') return fail('BAD_REQUEST', 'kilometersPerCell 只能是 "1" 或 "10"。')
  if (!agentActionAllowed(scope, projectId, 'map:write')) return fail('SCOPE_DENIED', '该项目未授权修改地图。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const releaseMap = acquireAgentForm(projectId, tableLeaseKey(GEOMAP_TAB))
  if (!releaseMap) return fail('DRAFT_DIRTY', '地图正在引擎中编辑或保存，请先保存并离开后重试。')
  const releaseGeo = acquireAgentForm(projectId, tableLeaseKey(GEOGRAPHY_TAB))
  if (!releaseGeo) { releaseMap(); return fail('DRAFT_DIRTY', '《地理风物》正在编辑或保存，请先保存并离开后重试。') }
  try {
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const map = await owner.store.get<TableRow>('tableRows', mapId)
    if (!map || map.projectId !== projectId || map.tabId !== GEOMAP_TAB) return fail('NOT_FOUND', `地图不存在：${mapId}`)
    const oldName = mapNameOf(map)
    if (oldName !== expectedName) return fail('CONFLICT', '地图名称已变化，请重新读取。', { mapId, name: oldName })
    if (map.updatedAt !== expectedUpdatedAt) return fail('CONFLICT', '地图已在引擎中更新，请重新读取。', { mapId, updatedAt: map.updatedAt })
    const maps = (await owner.store.getAllByIndex<TableRow>('tableRows', 'tabId', GEOMAP_TAB)).filter(row => row.projectId === projectId)
    if (name && name !== oldName && maps.some(row => row.id !== mapId && mapNameOf(row) === name)) {
      return fail('BAD_REQUEST', `地图名称已存在：${name}`)
    }
    let refsUpdated = 0
    if (name && name !== oldName) {
      const geos = (await owner.store.getAllByIndex<TableRow>('tableRows', 'tabId', GEOGRAPHY_TAB)).filter(row => row.projectId === projectId)
      const refs = rowsOfMap(geos, oldName)
      for (const ref of refs) {
        await owner.store.put('tableRows', { ...ref, data: { ...ref.data, '所属地图': name }, updatedAt: deps.now() })
        refsUpdated++
      }
    }
    const next: TableRow = {
      ...map,
      data: {
        ...map.data,
        ...(name ? { '名称': name } : {}),
        ...(writesDescription ? { '说明': description } : {}),
        ...(writesKm ? { '每格公里': kilometers } : {}),
      },
      updatedAt: deps.now(),
    }
    await owner.store.put('tableRows', next)
    void touchProject(projectId, owner.store)
    const failure = await flushAndVerify(owner, deps, async () => {
      const saved = await owner.store.get<TableRow>('tableRows', mapId)
      if (!saved || mapNameOf(saved) !== (name || oldName)) return false
      if (refsUpdated) {
        const geos = (await owner.store.getAllByIndex<TableRow>('tableRows', 'tabId', GEOGRAPHY_TAB)).filter(row => row.projectId === projectId)
        return rowsOfMap(geos, name || oldName).length >= refsUpdated
      }
      return true
    }, '修改地图后未能确认保存')
    if (failure) return failure
    deps.notify({ projectId, kind: 'table', tabId: GEOMAP_TAB })
    if (refsUpdated) deps.notify({ projectId, kind: 'table', tabId: GEOGRAPHY_TAB })
    return { ok: true, value: { mapId, name: name || oldName, kilometersPerCell: next.data['每格公里'], description: next.data['说明'], referencesUpdated: refsUpdated, saved: true } }
  } finally { releaseGeo(); releaseMap() }
}

/** 删除地图；仍有《地理风物》引用时拒绝（不伪装成普通写入）。 */
export async function deleteMap(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const mapId = readString(args, 'mapId', 200)
  const expectedUpdatedAt = readNumber(args, 'expectedUpdatedAt')
  if (args.confirm !== true) return fail('BAD_REQUEST', '删除地图前必须传 confirm: true，并在预览中确认引用与影响。')
  if (!agentActionAllowed(scope, projectId, 'map:delete')) return fail('SCOPE_DENIED', '该项目未授权删除地图。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const release = acquireAgentForm(projectId, tableLeaseKey(GEOMAP_TAB))
  if (!release) return fail('DRAFT_DIRTY', '地图正在引擎中编辑或保存，请先保存并离开后重试。')
  try {
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const map = await owner.store.get<TableRow>('tableRows', mapId)
    if (!map || map.projectId !== projectId || map.tabId !== GEOMAP_TAB) return fail('NOT_FOUND', `地图不存在：${mapId}`)
    if (map.updatedAt !== expectedUpdatedAt) return fail('CONFLICT', '地图已在引擎中更新，请重新读取。', { mapId, updatedAt: map.updatedAt })
    const name = mapNameOf(map)
    const geos = (await owner.store.getAllByIndex<TableRow>('tableRows', 'tabId', GEOGRAPHY_TAB)).filter(row => row.projectId === projectId)
    const refs = rowsOfMap(geos, name)
    if (refs.length) {
      return fail('DEPENDENCY_BLOCKED', `地图仍被 ${refs.length} 条《地理风物》引用，未删除。请先修改这些条目的「所属地图」。`, {
        mapId, references: refs.slice(0, 20).map(row => ({ id: row.id, name: mapNameOf(row) })), total: refs.length,
      })
    }
    await owner.store.del('tableRows', mapId)
    void touchProject(projectId, owner.store)
    const failure = await flushAndVerify(owner, deps, async () => !(await owner.store.get<TableRow>('tableRows', mapId)), '删除地图后未能确认')
    if (failure) return failure
    deps.notify({ projectId, kind: 'table', tabId: GEOMAP_TAB })
    return { ok: true, value: { mapId, name, deleted: true } }
  } finally { release() }
}

/** 在指定地图下创建地理条目；格子初始为空，随后用 updateMapPlaceCells 绘制。 */
export async function createMapPlace(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const mapId = readString(args, 'mapId', 200)
  const name = readString(args, 'name', MAX_NAME_CHARS).trim()
  const category = readString(args, 'category', MAX_NAME_CHARS, false).trim() || '区域'
  const parent = readString(args, 'parent', MAX_NAME_CHARS, false).trim()
  const description = readString(args, 'description', MAX_FIELD_CHARS, false)
  if (!agentActionAllowed(scope, projectId, 'map:create')) return fail('SCOPE_DENIED', '该项目未授权创建地点。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const tab = getTab(GEOGRAPHY_TAB)
  if (!tab || tab.type !== 'table') return fail('INTERNAL', '《地理风物》表定义缺失。')
  const releaseMap = acquireAgentForm(projectId, tableLeaseKey(GEOMAP_TAB))
  if (!releaseMap) return fail('DRAFT_DIRTY', '地图正在引擎中编辑或保存，请先保存并离开后重试。')
  const releaseGeo = acquireAgentForm(projectId, tableLeaseKey(GEOGRAPHY_TAB))
  if (!releaseGeo) { releaseMap(); return fail('DRAFT_DIRTY', '《地理风物》正在编辑或保存，请先保存并离开后重试。') }
  try {
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const map = await owner.store.get<TableRow>('tableRows', mapId)
    if (!map || map.projectId !== projectId || map.tabId !== GEOMAP_TAB) return fail('NOT_FOUND', `地图不存在：${mapId}`)
    const mapName = mapNameOf(map)
    const existing = (await owner.store.getAllByIndex<TableRow>('tableRows', 'tabId', GEOGRAPHY_TAB)).filter(row => row.projectId === projectId)
    if (existing.some(row => mapNameOf(row) === name)) return fail('BAD_REQUEST', `地点名称已存在：${name}`)
    if (parent && !existing.some(row => mapNameOf(row) === parent && (row.data['所属地图'] ?? '') === mapName)) {
      return fail('BAD_REQUEST', `同一地图下不存在父级地点：${parent}`)
    }
    const columns = tab.columns ?? []
    const data: Record<string, string> = Object.fromEntries(columns.map(column => [column.name, '']))
    data['名称'] = name
    data['类别'] = category
    data['所属地图'] = mapName
    data['备注'] = description
    data[CELL_FIELD] = ''
    if (parent) data['层级归属'] = parent
    if (columns.some(column => column.name === '编号') && AUTONUM_GROUPS.has(tab.group)) data['编号'] = nextAutoCode(GEOGRAPHY_TAB, existing)
    const fieldError = await validateTableFields(owner, tab, writableFields(tab, data))
    if (fieldError) return fail(fieldError.code, fieldError.message)
    const check = validateImport([data], tab, { existing, refValues: new Map() })[0]
    if (check.missing.length || check.dupExisting || check.codeConflict || check.dangling.length) {
      return fail('BAD_REQUEST', '地点缺少主字段、重复、编号冲突或存在无效引用。')
    }
    const now = deps.now()
    const row: TableRow = { id: deps.uid(), projectId, tabId: GEOGRAPHY_TAB, data, order: existing.reduce((max, item) => Math.max(max, item.order || 0), -1) + 1, createdAt: now, updatedAt: now }
    await owner.store.put('tableRows', row)
    void touchProject(projectId, owner.store)
    const failure = await flushAndVerify(owner, deps, async () => {
      const saved = await owner.store.get<TableRow>('tableRows', row.id)
      return !!saved && saved.projectId === projectId && mapNameOf(saved) === name
    }, '创建地点后未能确认保存')
    if (failure) return failure
    deps.notify({ projectId, kind: 'table', tabId: GEOGRAPHY_TAB })
    return { ok: true, value: { placeId: row.id, name, mapId, mapName, category, parent: parent || null, code: data['编号'] || undefined, saved: true } }
  } finally { releaseGeo(); releaseMap() }
}

/** 增量涂 / 擦格子；写入前核对地点版本与格子指纹。 */
export async function updateMapPlaceCells(args: Record<string, unknown>, scope: AgentScope, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const placeId = readString(args, 'placeId', 200)
  const expectedUpdatedAt = readNumber(args, 'expectedUpdatedAt')
  const expectedCellsHash = readString(args, 'expectedCellsHash', 64)
  const adds = readCellList(args, 'add')
  const removes = readCellList(args, 'remove')
  if (!adds.length && !removes.length) return fail('BAD_REQUEST', 'add 与 remove 至少提供一项。')
  if (!agentActionAllowed(scope, projectId, 'map:write')) return fail('SCOPE_DENIED', '该项目未授权绘制地图。')
  const blocked = deps.storageBlockReason()
  if (blocked) return fail('STORAGE_BLOCKED', `引擎存储当前不可写入：${blocked}`)
  if (deps.unsavedDraft()) return fail('DRAFT_DIRTY', '引擎中有未保存的编辑草稿，请先保存。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const release = acquireAgentForm(projectId, tableLeaseKey(GEOGRAPHY_TAB))
  if (!release) return fail('DRAFT_DIRTY', '《地理风物》正在编辑或保存，请先保存并离开后重试。')
  try {
    const owner = deps.captureOwner(projectId)
    owner.assertCurrent()
    const row = await owner.store.get<TableRow>('tableRows', placeId)
    if (!row || row.projectId !== projectId || row.tabId !== GEOGRAPHY_TAB) return fail('NOT_FOUND', `地点不存在：${placeId}`)
    if (row.updatedAt !== expectedUpdatedAt) return fail('CONFLICT', '地点已在引擎中更新，请重新读取。', { placeId, updatedAt: row.updatedAt })
    const mapName = String(row.data['所属地图'] ?? '')
    const all = (await owner.store.getAllByIndex<TableRow>('tableRows', 'tabId', GEOGRAPHY_TAB)).filter(item => item.projectId === projectId)
    const current = parseCells(row.data[CELL_FIELD])
    const hash = cellsHash(current)
    if (hash !== expectedCellsHash) return fail('CONFLICT', '地点格子已变化，请重新读取格子指纹。', { placeId, cellsHash: hash, cells: current.size })

    const descendants = descendantIds(all, placeId)
    for (const cell of removes) {
      if (descendants.size) {
        const blocker = all.find(item => descendants.has(item.id) && parseCells(item.data[CELL_FIELD]).has(cell))
        if (blocker) return fail('DEPENDENCY_BLOCKED', `格子 ${cell} 被子孙范围「${mapNameOf(blocker)}」占用，未擦除。`, { cell, blockerId: blocker.id })
      }
      current.delete(cell)
    }
    if (current.size + adds.length > MAX_CELLS) return fail('BAD_REQUEST', `格子总数超过上限 ${MAX_CELLS}。`)

    const ancestors = ancestorIds(all, row)
    const chain = new Set([placeId, ...ancestors, ...descendants])
    for (const cell of adds) {
      for (const ancestorId of ancestors) {
        const ancestor = all.find(item => item.id === ancestorId)
        const shape = ancestor ? parseCells(ancestor.data[CELL_FIELD]) : new Set<string>()
        if (shape.size && !shape.has(cell)) return fail('BAD_REQUEST', `格子 ${cell} 超出祖先范围「${ancestor ? mapNameOf(ancestor) : ancestorId}」。`)
      }
      for (const other of all) {
        if (chain.has(other.id)) continue
        if ((other.data['所属地图'] ?? '') !== mapName) continue
        if (parseCells(other.data[CELL_FIELD]).has(cell)) {
          return fail('BAD_REQUEST', `格子 ${cell} 已被无祖先关系的范围「${mapNameOf(other)}」占用。`, { cell, otherId: other.id })
        }
      }
      current.add(cell)
    }
    const nextHash = cellsHash(current)
    const updated: TableRow = { ...row, data: { ...row.data, [CELL_FIELD]: serializeCells(current) }, updatedAt: deps.now() }
    await owner.store.put('tableRows', updated)
    void touchProject(projectId, owner.store)
    const failure = await flushAndVerify(owner, deps, async () => {
      const saved = await owner.store.get<TableRow>('tableRows', placeId)
      return !!saved && cellsHash(parseCells(saved.data[CELL_FIELD])) === nextHash
    }, '绘制格子后未能确认保存')
    if (failure) return failure
    deps.notify({ projectId, kind: 'table', tabId: GEOGRAPHY_TAB })
    return { ok: true, value: { placeId, cells: current.size, cellsHash: nextHash, added: adds.filter(cell => !parseCells(row.data[CELL_FIELD]).has(cell)).length, removed: removes.length, saved: true } }
  } finally { release() }
}
/** 列出当前项目地图摘要。 */
export async function listMaps(args: Record<string, unknown>, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  const maps = (await owner.store.getAllByIndex<TableRow>('tableRows', 'tabId', GEOMAP_TAB))
    .filter(row => row.projectId === projectId).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map(row => ({ id: row.id, code: row.data['编号'], name: row.data['名称'],
      kilometersPerCell: row.data['每格公里'], description: row.data['说明'],
      backgroundMode: row.data['底图模式'] === '图片' ? '图片' : '格子', updatedAt: row.updatedAt }))
  owner.assertCurrent()
  return { ok: true, value: { projectId, maps } }
}

/** 分页列出属于指定地图的地点，并给出格子指纹供绘制使用。 */
export async function listMapPlaces(args: Record<string, unknown>, deps: AgentExecutorDeps): Promise<AgentToolResult> {
  const projectId = readString(args, 'projectId', 200)
  const mapId = readString(args, 'mapId', 200)
  const offset = args.offset === undefined ? 0 : Number(args.offset)
  const limit = args.limit === undefined ? 20 : Number(args.limit)
  if (!Number.isInteger(offset) || offset < 0) return fail('BAD_REQUEST', 'offset 必须是非负整数。')
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail('BAD_REQUEST', 'limit 必须在 1 到 100 之间。')
  const projectError = await requireOpenProject(projectId, deps)
  if (projectError) return projectError
  const owner = deps.captureOwner(projectId)
  const map = await owner.store.get<TableRow>('tableRows', mapId)
  if (!map || map.projectId !== projectId || map.tabId !== GEOMAP_TAB) return fail('NOT_FOUND', `地图不存在：${mapId}`)
  const name = mapNameOf(map)
  if (!name) return fail('BAD_REQUEST', '地图没有名称，无法确定关联地点。')
  const places = (await owner.store.getAllByIndex<TableRow>('tableRows', 'tabId', GEOGRAPHY_TAB))
    .filter(row => row.projectId === projectId && row.data['所属地图'] === name)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return { ok: true, value: { projectId, mapId, mapName: name, total: places.length, offset,
    places: places.slice(offset, offset + limit).map(row => ({ id: row.id, name: row.data['名称'],
      code: row.data['编号'], category: row.data['类别'], parent: row.data['层级归属'],
      position: row.data['地理位置'], description: row.data['备注'], updatedAt: row.updatedAt,
      cells: parseCells(row.data[CELL_FIELD]).size, cellsHash: cellsHash(parseCells(row.data[CELL_FIELD])) })) } }
}