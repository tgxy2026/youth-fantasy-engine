export interface WorkspaceTarget { tabId: string; chapterId?: string; rowId?: string }
/**
 * 「带来源的关联跳转」（UX05）。
 * 🔴 用**对象入参**而不是位置参数：先前用 5 个位置参数时，把「来源记录 id」写成第 4 参会
 *    被当成「目标行」，随后被路由校验判成「正文页带行目标」而静默不跳（2026-10-26 实测踩到）。
 *    改成具名字段后，这类顺序错误在类型层面就不成立了。
 */
export interface ReferenceJump {
  /** 目标页签（正文为 'editor'） */
  tabId: string
  /** 返回按钮上显示的一行来源标签（如角色名），会被净化后截断 */
  label: string
  /** 目标章节（仅正文页） */
  chapterId?: string
  /** 目标记录行（表格 / 卡片页；正文页不可带） */
  rowId?: string
  /** 正文内字符偏移：段落级定位（仅正文页） */
  offset?: number
  /** 命中词长度：把命中的那一截选中 */
  matchLength?: number
  /** Search-time body revision; a changed body must not receive an old offset. */
  revision?: string
  /** 来源记录 id（返回时把同一条选回来） */
  sourceId?: string
}
export type NavigateToReference = (jump: ReferenceJump) => void
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
  failed: (intent: T, scope: 'content' | 'meta' | 'target', error: unknown) => void
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
    try { checked = options.validate(intent) } catch (error) { if (current()) options.failed(intent, 'target', error); return }
    if (!(checked instanceof Promise) && !options.dirty()) {
      if (!current()) return
      if (checked) options.commit(checked)
      else invalid()
      return
    }
    options.busy.current = true
    void (async () => {
      let phase: 'target' | 'content' = 'target'
      try {
        let target = await checked
        if (!current()) return
        if (!target) { invalid(); return }
        // A slow existence/permission read can overlap new typing after the first flush.
        // Reflush that new draft before leaving, with a bound so continuous typing cannot trap navigation.
        for (let attempt = 0; attempt < 3; attempt++) {
          if (options.dirty()) {
            phase = 'content'
            const result = await options.flush()
            if (!current()) return
            if (!result.ok) { options.failed(intent, result.scope, result.error); return }
          }
          phase = 'target'
          target = await options.validate(target)
          if (!current()) return
          if (!target) { invalid(); return }
          if (!options.dirty()) { options.commit(target); return }
        }
        options.failed(intent, 'content', new Error('检查目标期间仍有新修改，请稍后重试离开'))
      } catch (error) {
        if (current()) options.failed(intent, phase, error)
      } finally { if (mine === ticket) options.busy.current = false }
    })()
  }
  return { request, invalidate }
}
