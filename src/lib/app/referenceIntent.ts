import { parseWorkspaceNavigation, type ReferenceJump, type WorkspaceTarget } from './navigation'
import { normalizeEntry, targetKey, type HistoryEntry, type NavigationHistory } from './navigationHistory'

export interface EditorPosition { offset: number; matchLength?: number; revision?: string }
export interface PageNavigationIntent {
  kind: 'page'
  target: WorkspaceTarget
  position?: EditorPosition
  source?: HistoryEntry
  back?: HistoryEntry
}
export type NavigationIntent = PageNavigationIntent | { kind: 'exit' }
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1e9

/** A request owns all of its metadata. Rejected/busy requests have no shared pending fields. */
export function pageNavigationIntent(value: unknown): PageNavigationIntent | null {
  const target = parseWorkspaceNavigation(value)
  if (!target) return null
  const v = value as Partial<ReferenceJump> | null
  if (typeof value === 'string' || v?.offset == null) return { kind: 'page', target }
  if (target.tabId !== 'editor' || !target.chapterId || !integer(v.offset)
    || (v.matchLength != null && !integer(v.matchLength))
    || (v.revision != null && (typeof v.revision !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(v.revision)))) return null
  return { kind: 'page', target, position: { offset: v.offset,
    ...(v.matchLength != null ? { matchLength: v.matchLength } : {}), ...(v.revision ? { revision: v.revision } : {}) } }
}
export function referenceNavigationIntent(jump: ReferenceJump, from: WorkspaceTarget): PageNavigationIntent | null {
  const intent = pageNavigationIntent(jump), source = normalizeEntry(from, jump.label)
  if (!intent || !source) return null
  return { ...intent, ...(targetKey(source.target) !== targetKey(intent.target) ? { source } : {}) }
}
/** Called by the successful navigation commit only. Save errors never consume return history. */
export function commitNavigationHistory(history: NavigationHistory, intent: PageNavigationIntent): void {
  if (intent.back) {
    const top = history.top()
    if (top && targetKey(top.target) === targetKey(intent.back.target)) history.pop()
  } else if (intent.source) history.push(intent.source.target, intent.source.label)
}
