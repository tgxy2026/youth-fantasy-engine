import type { NavigationIntent, PageNavigationIntent } from './referenceIntent'

export interface NavigationDestinationReader {
  available: (tabId: string) => boolean
  recordKind: (tabId: string) => 'card' | 'table' | null
  chapterExists: (id: string) => Promise<boolean>
  recordExists: (kind: 'card' | 'table', tabId: string, id: string) => Promise<boolean>
}

/** Only explicit object requests read storage. Ordinary clean sidebar navigation stays synchronous.
 * A missing object returns to the writing dashboard, where a new selection is possible without
 * displaying a cached deleted draft. This never recreates records or treats read errors as absence.
 */
export function resolveNavigationDestination(intent: NavigationIntent, read: NavigationDestinationReader): NavigationIntent | Promise<NavigationIntent> {
  if (intent.kind === 'exit') return intent
  const fallback = (notice: PageNavigationIntent['notice']): PageNavigationIntent => ({
    ...intent, target: { tabId: 'dashboard' }, position: undefined, notice,
  })
  if (!read.available(intent.target.tabId)) return fallback('unavailable-page')
  const { tabId, chapterId, rowId } = intent.target
  if (chapterId) return read.chapterExists(chapterId).then(exists => exists ? intent : fallback('missing-chapter'))
  if (rowId) {
    const kind = read.recordKind(tabId)
    if (!kind) return fallback('unsupported-record')
    return read.recordExists(kind, tabId, rowId).then(exists => exists ? intent : fallback('missing-record'))
  }
  return intent
}

export function navigationDestinationNotice(notice: PageNavigationIntent['notice']): string | null {
  switch (notice) {
    case 'missing-chapter': return '目标章节已不存在，已回到写作面板，请重新选择章节'
    case 'missing-record': return '目标记录已不存在，已回到写作面板，请重新选择资料'
    case 'unavailable-page': return '目标页面已隐藏或不可用，已回到写作面板'
    case 'unsupported-record': return '目标页面暂不支持这条记录的定位，已回到写作面板，请重新选择资料'
    default: return null
  }
}
