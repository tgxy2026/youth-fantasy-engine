/** Bounded session views only. No business content, persistent preferences or database writes. */
export const VIEW_VERSION = 1
export const VIEW_LIMITS = { projects: 10, objectsPerProject: 50, recordBytes: 16 * 1024, totalBytes: 256 * 1024 } as const
export type ViewPlatform = 'desktop' | 'portable' | 'web-cloud' | 'web-guest' | 'browser'
export interface ViewIdentity { platform: ViewPlatform; space: string; identity: string }
export interface WorkspaceScope extends ViewIdentity { projectId: string; pageId: string }
export interface ViewScroll { top: number; ratio: number; outerTop: number; outerRatio: number }
export interface EditorView {
  version: 1; kind: 'editor'; objectId: string; revision: string; length: number
  selection: { start: number; end: number; direction: 'forward' | 'backward' | 'none' }
  scroll: ViewScroll
  layout: { width: number; height: number; fontSize: number; lineHeight: number }
  focused: boolean
}
export interface ViewAnchor { id: string; offset: number }
export interface DetailView { version: 1; kind: 'detail'; objectId: string; groups: string[]; scroll: ViewScroll; anchor?: ViewAnchor }
/** Search is transient UI input, never persisted; no record fields or draft bodies are retained. */
export interface ListView { version: 1; kind: 'list'; objectId: string; selectedId: string | null; query: string; scroll: ViewScroll; anchor?: ViewAnchor }
export type WorkspaceView = EditorView | DetailView | ListView
export function restoreListSelection(records: readonly { id: string }[], remembered: string | null, explicit?: string | null): string | null {
  for (const candidate of [explicit, remembered]) if (candidate && records.some(record => record.id === candidate)) return candidate
  return records[0]?.id ?? null
}
const platforms = new Set<ViewPlatform>(['desktop', 'portable', 'web-cloud', 'web-guest', 'browser'])
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
const opaqueId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value)
const number = (value: unknown, max = 1e9): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const projectKey = (scope: WorkspaceScope) => JSON.stringify([scope.platform, scope.space, scope.identity, scope.projectId])
export function workspaceScopeKey(scope: WorkspaceScope): string | null {
  return scope && platforms.has(scope.platform) && [scope.space, scope.identity].every(opaqueId) && [scope.projectId, scope.pageId].every(id)
    ? JSON.stringify([scope.platform, scope.space, scope.identity, scope.projectId, scope.pageId]) : null
}
const scrollOf = (value: unknown): ViewScroll | null => {
  if (!value || typeof value !== 'object') return null
  const v = value as ViewScroll
  return number(v.top) && number(v.ratio, 1) && number(v.outerTop) && number(v.outerRatio, 1)
    ? { top: v.top, ratio: v.ratio, outerTop: v.outerTop, outerRatio: v.outerRatio } : null
}
/** Copy the allowlisted shape; accidental extra fields (including prose) never enter the view store. */
function normalize(value: unknown): WorkspaceView | null {
  if (!value || typeof value !== 'object') return null
  const v = value as WorkspaceView
  if (v.version !== VIEW_VERSION || !id(v.objectId)) return null
  const scroll = scrollOf(v.scroll)
  if (!scroll) return null
  const candidate = v.kind === 'list' || v.kind === 'detail' ? v.anchor : undefined
  if (candidate != null && (!id(candidate.id) || typeof candidate.offset !== 'number'
    || !Number.isFinite(candidate.offset) || Math.abs(candidate.offset) > 1e9)) return null
  const anchor = candidate ? { id: candidate.id, offset: candidate.offset } : undefined
  if (v.kind === 'list') {
    if ((v.selectedId !== null && !id(v.selectedId)) || typeof v.query !== 'string' || v.query.length > 200) return null
    return { version: 1, kind: 'list', objectId: v.objectId, selectedId: v.selectedId, query: v.query, scroll, ...(anchor ? { anchor } : {}) }
  }
  if (v.kind === 'detail') {
    if (!Array.isArray(v.groups) || v.groups.length > 128 || !v.groups.every(id)) return null
    return { version: 1, kind: 'detail', objectId: v.objectId, groups: [...new Set(v.groups)], scroll, ...(anchor ? { anchor } : {}) }
  }
  if (v.kind !== 'editor' || !opaqueId(v.revision) || !number(v.length) || !Number.isInteger(v.length)) return null
  const s = v.selection, l = v.layout
  if (!s || !number(s.start, v.length) || !number(s.end, v.length) || s.start > s.end
    || !Number.isInteger(s.start) || !Number.isInteger(s.end) || !['forward', 'backward', 'none'].includes(s.direction)) return null
  if (!l || ![l.width, l.height, l.fontSize, l.lineHeight].every(item => number(item)) || typeof v.focused !== 'boolean') return null
  return { version: 1, kind: 'editor', objectId: v.objectId, revision: v.revision, length: v.length,
    selection: { start: s.start, end: s.end, direction: s.direction }, scroll,
    layout: { width: l.width, height: l.height, fontSize: l.fontSize, lineHeight: l.lineHeight }, focused: v.focused }
}
export function parseWorkspaceView(raw: unknown): WorkspaceView | null {
  if (typeof raw !== 'string' || raw.length > VIEW_LIMITS.recordBytes) return null
  try {
    if (new TextEncoder().encode(raw).byteLength > VIEW_LIMITS.recordBytes) return null
    const record = normalize(JSON.parse(raw))
    return record && bytes(record) <= VIEW_LIMITS.recordBytes ? record : null
  } catch { return null }
}

interface Entry { project: string; scope: string; key: string; value: WorkspaceView; bytes: number }
/** Per-process memory; limits apply across all identities, not once per account. */
export function createWorkspaceViewStore() {
  const projects = new Map<string, Map<string, Entry>>()
  const entries = new Map<string, Entry>()
  let totalBytes = 0, generation = 0
  const invalidations = new Set<() => void>()
  const invalidate = () => { generation++; for (const fn of invalidations) { try { fn() } catch { /* Optional view listeners cannot block a storage operation. */ } } }
  const remove = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key); totalBytes -= entry.bytes
    const project = projects.get(entry.project)
    project?.delete(key)
    if (!project?.size) projects.delete(entry.project)
  }
  const touch = (entry: Entry) => {
    const project = projects.get(entry.project)!
    projects.delete(entry.project); projects.set(entry.project, project)
    project.delete(entry.key); project.set(entry.key, entry)
    entries.delete(entry.key); entries.set(entry.key, entry)
  }
  const deleteProjectKey = (key: string) => { for (const entry of [...(projects.get(key)?.values() ?? [])]) remove(entry.key) }
  return {
    generation: () => generation,
    subscribeInvalidation(fn: () => void) { invalidations.add(fn); return () => { invalidations.delete(fn) } },
    put(scope: WorkspaceScope, input: unknown, expectedGeneration = generation): boolean {
      try {
        const scopeKey = workspaceScopeKey(scope), value = normalize(input)
        if (!scopeKey || !value || expectedGeneration !== generation || bytes(value) > VIEW_LIMITS.recordBytes) return false
        const key = JSON.stringify([scopeKey, value.objectId]), project = projectKey(scope)
        const entry: Entry = { key, project, scope: scopeKey, value, bytes: bytes({ scope: scopeKey, value }) }
        if (entry.bytes > VIEW_LIMITS.totalBytes) return false
        remove(key)
        const objects = projects.get(project) ?? new Map<string, Entry>()
        projects.set(project, objects); objects.set(key, entry); entries.set(key, entry); totalBytes += entry.bytes
        touch(entry)
        while (objects.size > VIEW_LIMITS.objectsPerProject) remove(objects.keys().next().value!)
        while (projects.size > VIEW_LIMITS.projects) deleteProjectKey(projects.keys().next().value!)
        while (totalBytes > VIEW_LIMITS.totalBytes) remove(entries.keys().next().value!)
        return entries.has(key)
      } catch { return false }
    },
    get(scope: WorkspaceScope, objectId: string): WorkspaceView | null {
      const scopeKey = workspaceScopeKey(scope)
      if (!scopeKey || !id(objectId)) return null
      const entry = entries.get(JSON.stringify([scopeKey, objectId]))
      if (!entry) return null
      touch(entry)
      return JSON.parse(JSON.stringify(entry.value)) as WorkspaceView
    },
    deleteProject(scope: WorkspaceScope) {
      if (!workspaceScopeKey(scope)) return
      deleteProjectKey(projectKey(scope)); invalidate()
    },
    clearIdentity(identity: ViewIdentity) {
      for (const [key, objects] of [...projects]) {
        const entry = objects.values().next().value
        if (!entry) continue
        const [platform, space, owner] = JSON.parse(entry.scope) as string[]
        if (platform === identity.platform && space === identity.space && owner === identity.identity) deleteProjectKey(key)
      }
      invalidate()
    },
    clear() { projects.clear(); entries.clear(); totalBytes = 0; invalidate() },
    stats: () => ({ projects: projects.size, objects: entries.size, bytes: totalBytes, generation }),
  }
}
export const workspaceViews = createWorkspaceViewStore()
