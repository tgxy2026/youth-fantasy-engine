export interface WorkspaceTarget { tabId: string; chapterId?: string; rowId?: string }
const id = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v)

/** Copy only routing IDs. No prose, drafts or arbitrary event properties enter navigation state. */
export function parseWorkspaceTarget(value: unknown): WorkspaceTarget | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!id(v.tabId) || (v.chapterId != null && !id(v.chapterId)) || (v.rowId != null && !id(v.rowId))) return null
  if ((v.chapterId != null && v.tabId !== 'editor') || (v.rowId != null && v.tabId === 'editor')) return null
  return { tabId: v.tabId, ...(v.chapterId != null ? { chapterId: v.chapterId as string } : {}), ...(v.rowId != null ? { rowId: v.rowId as string } : {}) }
}
export function parseWorkspaceNavigation(value: unknown): WorkspaceTarget | null {
  if (typeof value === 'string') return id(value) ? { tabId: value } : null
  try { return parseWorkspaceTarget(value) } catch { return null }
}

export interface NavigationGateOptions<T> {
  context: () => string
  busy: { current: boolean }
  capture: () => void
  validate: (intent: T) => T | null | Promise<T | null>
  dirty: () => boolean
  flush: () => Promise<{ ok: true } | { ok: false; scope: 'content' | 'meta'; error: unknown }>
  commit: (intent: T) => void
  invalid: (intent: T) => void
  failed: (intent: T, scope: 'content' | 'meta', error: unknown) => void
}

/** Clean ordinary navigation remains synchronous. All async work owns one context and ticket. */
export function createNavigationGate<T>(options: NavigationGateOptions<T>) {
  let ticket = 0
  const invalidate = () => { ticket++; options.busy.current = false }
  const request = (intent: T): void => {
    if (options.busy.current) return
    const mine = ++ticket, owner = options.context()
    const current = () => mine === ticket && owner === options.context()
    const invalid = () => { if (current()) options.invalid(intent) }
    options.capture()
    let checked: T | null | Promise<T | null>
    try { checked = options.validate(intent) } catch { invalid(); return }
    if (!(checked instanceof Promise) && !options.dirty()) {
      if (!current()) return
      if (checked) options.commit(checked)
      else invalid()
      return
    }
    options.busy.current = true
    void (async () => {
      try {
        const target = await checked
        if (!current()) return
        if (!target) { invalid(); return }
        if (options.dirty()) {
          const result = await options.flush()
          if (!current()) return
          if (!result.ok) { options.failed(intent, result.scope, result.error); return }
        }
        // An object or its visibility may have changed while saving. Never commit an old target.
        const final = await options.validate(target)
        if (!current()) return
        if (final) options.commit(final)
        else invalid()
      } catch (error) {
        if (current()) options.failed(intent, 'content', error)
      } finally { if (mine === ticket) options.busy.current = false }
    })()
  }
  return { request, invalidate }
}
