/**
 * Agent 操作接口的**契约与纯逻辑**（3.4.3 可写 MCP 工具）。
 *
 * 🔴 设计边界（见 docs/3.4.3-Agent应用操作接口-设计-2026-11-08.md）：
 *   · 外部 Agent 只有在用户**显式开启连接并授权项目 / 动作**后才有写权限，默认只读；
 *   · 写入必须进入**正在运行的引擎宿主**（渲染进程内存 store + 防抖落盘），
 *     外部进程不得直接改整库 JSON —— 那会与内存、自动保存、云同步互相覆盖；
 *   · 每次写请求带 `projectId` 与 `requestId`，提交前后核验项目 / 存储上下文未切换；
 *   · 幂等由宿主侧账本负责（本文件只是协议口径）。
 *
 * 本文件不依赖 React / 浏览器 / Electron，可在 Node 单测里直接跑。
 */

import type { Project, TabDef, CardRecord, Chapter } from '@/lib/types'

// ---------- 授权范围 ----------

/** 写动作（读取不受这些动作约束：默认只读，允许读） */
export type AgentAction = 'setting:create' | 'setting:write' | 'form:write' | 'table:create' | 'table:write' | 'volume:create' | 'volume:write' | 'chapter:create' | 'chapter:write' | 'chapter:delete' | 'inspiration:write'

export const AGENT_ACTIONS: readonly AgentAction[] = ['setting:create', 'setting:write', 'form:write', 'table:create', 'table:write', 'volume:create', 'volume:write', 'chapter:create', 'chapter:write', 'chapter:delete', 'inspiration:write']

/** 动作的中文说明（界面与错误文案共用，避免两处各写一份） */
export const AGENT_ACTION_LABELS: Record<AgentAction, string> = {
  'setting:create': '创建设定卡',
  'setting:write': '修改设定卡字段',
  'form:write': '修改作品表单',
  'table:create': '创建设定表条目',
  'table:write': '修改设定表条目',
  'volume:create': '创建分卷',
  'volume:write': '修改分卷',
  'chapter:create': '创建章节',
  'chapter:write': '追加 / 覆盖正文',
  'chapter:delete': '删除章节到回收站',
  'inspiration:write': '写入灵感夹',
}

export interface AgentProjectGrant {
  projectId: string
  actions: AgentAction[]
}

export interface AgentScope {
  projects: AgentProjectGrant[]
}

export const EMPTY_AGENT_SCOPE: AgentScope = { projects: [] }

/** 单项授权最多允许的项目数 —— 防止一份授权文件无限膨胀 */
export const MAX_GRANTED_PROJECTS = 200

function isAgentAction(value: unknown): value is AgentAction {
  return typeof value === 'string' && (AGENT_ACTIONS as readonly string[]).includes(value)
}

/**
 * 把任意输入规整成合法 scope：去重项目、过滤未知动作、丢弃空项目。
 * 🔴 **不抛错**：配置文件损坏时应降级为「无授权」而不是让连接整体不可用（失败关闭）。
 */
export function normalizeAgentScope(raw: unknown): AgentScope {
  const list = (raw as { projects?: unknown } | null | undefined)?.projects
  if (!Array.isArray(list)) return { projects: [] }
  const seen = new Set<string>()
  const projects: AgentProjectGrant[] = []
  for (const item of list) {
    if (projects.length >= MAX_GRANTED_PROJECTS) break
    const projectId = typeof (item as { projectId?: unknown })?.projectId === 'string'
      ? ((item as { projectId: string }).projectId).trim()
      : ''
    if (!projectId || seen.has(projectId)) continue
    const actionsRaw = (item as { actions?: unknown }).actions
    const actions = Array.isArray(actionsRaw) ? Array.from(new Set(actionsRaw.filter(isAgentAction))) : []
    if (!actions.length) continue
    seen.add(projectId)
    projects.push({ projectId, actions })
  }
  return { projects }
}

/** 某项目是否被授予某动作。**未知项目、未知动作一律 false**（失败关闭）。 */
export function agentActionAllowed(scope: AgentScope, projectId: string, action: AgentAction): boolean {
  if (!projectId || !isAgentAction(action)) return false
  const grant = scope.projects.find(p => p.projectId === projectId)
  return !!grant && grant.actions.includes(action)
}

/** 列出某项目被授予的动作（给工具返回「可写能力」用） */
export function actionsForProject(scope: AgentScope, projectId: string): AgentAction[] {
  const grant = scope.projects.find(p => p.projectId === projectId)
  return grant ? [...grant.actions] : []
}

// ---------- 工具名与错误码 ----------

export const AGENT_TOOL_NAMES = {
  listProjects: 'yfe_list_projects',
  getProject: 'yfe_get_project',
  listChapters: 'yfe_list_chapters',
  readChapter: 'yfe_read_chapter',
  listSettingTabs: 'yfe_list_setting_tabs',
  listSettingCards: 'yfe_list_setting_cards',
  readSettingCard: 'yfe_read_setting_card',
  listDataTabs: 'yfe_list_data_tabs',
  readForm: 'yfe_read_form',
  listTableRows: 'yfe_list_table_rows',
  listTavernReports: 'yfe_list_tavern_reports',
  readTavernReport: 'yfe_read_tavern_report',
  listChapterSnapshots: 'yfe_list_chapter_snapshots',
  readChapterSnapshot: 'yfe_read_chapter_snapshot',
  listWorldSets: 'yfe_list_world_sets',
  listWorldPacks: 'yfe_list_world_packs',
  readWorldPackTable: 'yfe_read_world_pack_table',
  listProjectBackups: 'yfe_list_project_backups',
  listMaps: 'yfe_list_maps',
  listMapPlaces: 'yfe_list_map_places',
  searchProject: 'yfe_search_project',
  readPlotCanvas: 'yfe_read_plot_canvas',
  createSettingCard: 'yfe_create_setting_card',
  updateSettingCard: 'yfe_update_setting_card',
  createWorldSet: 'yfe_create_world_set',
  setWorldSetActive: 'yfe_set_world_set_active',
  updateForm: 'yfe_update_form',
  createTableRow: 'yfe_create_table_row',
  updateTableRow: 'yfe_update_table_row',
  createVolume: 'yfe_create_volume',
  createChapter: 'yfe_create_chapter',
  appendChapter: 'yfe_append_chapter',
  replaceChapter: 'yfe_replace_chapter',
  updateChapterInfo: 'yfe_update_chapter_info',
  updateVolume: 'yfe_update_volume',
  deleteChapter: 'yfe_delete_chapter',
  listInspirations: 'yfe_list_inspirations',
  addInspiration: 'yfe_add_inspiration',
  requestStatus: 'yfe_request_status',
} as const

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[keyof typeof AGENT_TOOL_NAMES]

/** 写工具（需要对应授权动作） */
export const AGENT_WRITE_TOOLS: readonly AgentToolName[] = [
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
]

export const AGENT_WRITE_TOOL_ACTIONS: Record<string, AgentAction> = {
  [AGENT_TOOL_NAMES.createSettingCard]: 'setting:create',
  [AGENT_TOOL_NAMES.updateSettingCard]: 'setting:write',
  [AGENT_TOOL_NAMES.createWorldSet]: 'setting:create',
  [AGENT_TOOL_NAMES.setWorldSetActive]: 'setting:write',
  [AGENT_TOOL_NAMES.updateForm]: 'form:write',
  [AGENT_TOOL_NAMES.createTableRow]: 'table:create',
  [AGENT_TOOL_NAMES.updateTableRow]: 'table:write',
  [AGENT_TOOL_NAMES.createVolume]: 'volume:create',
  [AGENT_TOOL_NAMES.createChapter]: 'chapter:create',
  [AGENT_TOOL_NAMES.appendChapter]: 'chapter:write',
  [AGENT_TOOL_NAMES.replaceChapter]: 'chapter:write',
  [AGENT_TOOL_NAMES.updateChapterInfo]: 'chapter:write',
  [AGENT_TOOL_NAMES.updateVolume]: 'volume:write',
  [AGENT_TOOL_NAMES.deleteChapter]: 'chapter:delete',
  [AGENT_TOOL_NAMES.addInspiration]: 'inspiration:write',
}

/**
 * 失败代码。**失败关闭**：未知代码不得被当成成功。
 *
 * `retryable` 的语义（宿主账本据此决定是否允许同 requestId 重试）：
 *   · true  —— 确定没写入，重试安全；
 *   · false —— 结果不明或已写入，禁止自动重试，只能按 requestId 查询并人工核对。
 */
export type AgentErrorCode =
  | 'BAD_REQUEST'
  | 'UNKNOWN_TOOL'
  | 'NOT_READY'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_NOT_OPEN'
  | 'NOT_FOUND'
  | 'SCOPE_DENIED'
  | 'CONFLICT'
  | 'DRAFT_DIRTY'
  | 'NO_VOLUME'
  | 'SAVE_FAILED'
  | 'OUTCOME_UNKNOWN'
  | 'STORAGE_BLOCKED'
  | 'DUPLICATE_IN_FLIGHT'
  | 'HOST_DISABLED'
  | 'UNAUTHORIZED'
  | 'INTERNAL'

export const AGENT_RETRYABLE_ERRORS: readonly AgentErrorCode[] = [
  'BAD_REQUEST', 'UNKNOWN_TOOL', 'NOT_READY', 'PROJECT_NOT_FOUND', 'PROJECT_NOT_OPEN',
  'NOT_FOUND', 'SCOPE_DENIED', 'CONFLICT', 'DRAFT_DIRTY', 'NO_VOLUME', 'DUPLICATE_IN_FLIGHT',
  'HOST_DISABLED', 'UNAUTHORIZED',
]

/** `INTERNAL` 不在此列：它可能是「写后抛错」，按结果不明处理，禁止自动重试。
 *  `STORAGE_BLOCKED` 也不在此列：存储冲突 / 锁写 / 未连接需要作者先处理，自动重试只会反复失败。 */
export function agentErrorRetryable(code: AgentErrorCode): boolean {
  return code !== 'SAVE_FAILED' && code !== 'OUTCOME_UNKNOWN' && code !== 'INTERNAL' && code !== 'STORAGE_BLOCKED'
}

export interface AgentFailure {
  ok: false
  code: AgentErrorCode
  error: string
  /** 冲突时回传当前版本，便于 Agent 重新读取后再试 */
  current?: Record<string, unknown>
}

export interface AgentSuccess {
  ok: true
  value: unknown
}

export type AgentToolResult = AgentSuccess | AgentFailure

export function fail(code: AgentErrorCode, error: string, current?: Record<string, unknown>): AgentFailure {
  return current ? { ok: false, code, error, current } : { ok: false, code, error }
}

// ---------- 请求 / 响应 ----------

export interface AgentToolCall {
  /** 桥进程每次启动生成的会话标识；宿主只要求非空（用于留痕与将来多会话隔离） */
  sessionId: string
  /** Agent 自带的去重键；重试必须复用同一个值 */
  requestId: string
  tool: string
  args: Record<string, unknown>
}

export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_RE.test(value)
}

/** 宿主账本中的请求状态 */
export type AgentRequestState = 'pending' | 'success' | 'failed' | 'unknown'

export interface AgentRequestRecord {
  requestId: string
  tool: string
  projectId: string
  state: AgentRequestState
  code?: AgentErrorCode
  error?: string
  /** 成功时的返回值（截断保存，避免账本膨胀） */
  result?: unknown
  createdAt: number
  updatedAt: number
  sessionId?: string
}

// ---------- 字段与内容限制 ----------

/** 单个正文载荷上限（字符）：再大就不该走工具调用，应该用导入通道 */
export const MAX_CONTENT_CHARS = 2_000_000
/** 单个设定字段值上限（字符） */
export const MAX_FIELD_CHARS = 20_000
/** 单张设定卡的字段值总量上限（字符） */
export const MAX_CARD_TOTAL_CHARS = 120_000
export const MAX_NAME_CHARS = 120
export const MAX_CARD_NAME_CHARS = 100

// ---------- 栏目 schema（设定卡） ----------

/**
 * 某个项目可用的「设定卡栏目」—— 只返回 `type === 'card'` 的页签。
 * 表格型设定表不在首期写工具范围内（设计：首批能力只含设定卡与章节）。
 */
export interface SettingTabInfo {
  tabId: string
  name: string
  group: string
  description: string
  fields: { path: string; name: string; desc: string }[]
}

export function settingTabInfo(tab: TabDef, fields: { path: string; name: string; desc: string }[]): SettingTabInfo {
  return { tabId: tab.id, name: tab.name, group: tab.group, description: tab.description, fields }
}

// ---------- 执行器依赖（便于单测注入） ----------

export interface AgentProjectSummary {
  id: string
  name: string
  genre: string
  intro: string
  projectType: string
  updatedAt: number
}

export function projectSummary(p: Project): AgentProjectSummary {
  return {
    id: p.id, name: p.name, genre: p.genre, intro: p.intro,
    projectType: p.projectType ?? 'full', updatedAt: p.updatedAt,
  }
}

export interface AgentChapterSummary {
  id: string
  title: string
  volumeId: string
  order: number
  status: string
  wordCount: number
  updatedAt: number
}

export function chapterSummary(c: Chapter): AgentChapterSummary {
  return {
    id: c.id, title: c.title, volumeId: c.volumeId, order: c.order,
    status: c.status, wordCount: c.wordCount, updatedAt: c.updatedAt,
  }
}

export interface AgentCardResult {
  cardId: string
  tabId: string
  name: string
  order: number
  saved: boolean
}

export interface AgentChapterWriteResult {
  chapterId: string
  title: string
  wordCount: number
  updatedAt: number
  saved: boolean
}

/** 写成功后通知当前界面（编辑器 / 设定卡页 / 章节树）刷新；不覆盖正在编辑的草稿。 */
export interface AgentWriteNotice {
  projectId: string
  kind: 'chapter' | 'setting' | 'volume' | 'world-set' | 'form' | 'table' | 'inspiration'
  /** 删除动作（章节移入回收站） */
  deleted?: boolean
  volumeId?: string
  chapterId?: string
  cardId?: string
  tabId?: string
}

/** 内部：把章节写成结果时保留 record 引用，供宿主回读确认 */
export type AgentCardRecord = CardRecord
