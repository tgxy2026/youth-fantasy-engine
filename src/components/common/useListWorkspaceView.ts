import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { currentWorkspaceScope } from '@/lib/settings/workspaceRuntime'
import { workspaceViews, restoreListSelection, type ListView } from '@/lib/settings/workspaceViewState'
import { getCurrentProjectId } from '@/lib/db'
import { getStorageContextEpoch, subscribeStorageContext } from '@/lib/storage/contextEpoch'

const OBJECT = 'list-state'
function contextKey(projectId: string, pageId: string) {
  const account = (window as unknown as { __YFE_USER__?: { id?: string } }).__YFE_USER__?.id ?? ''
  return JSON.stringify([projectId, pageId, getStorageContextEpoch(), account])
}
const read = (projectId: string, pageId: string) => {
  const scope = currentWorkspaceScope(projectId, 'list:' + pageId)
  const saved = scope ? workspaceViews.get(scope, OBJECT) : null
  return saved?.kind === 'list' ? saved : null
}

/** View invalidation is optional UI bookkeeping, not a reason to discard a business draft.
 * Only a real project/backend/account context change reloads records. Old writers still carry
 * the view generation, and a not-yet-resolved optional identity never blocks business editing.
 */
export function useListWorkspaceView(projectId: string, pageId: string) {
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const generation = useSyncExternalStore(workspaceViews.subscribeInvalidation, workspaceViews.generation)
  useSyncExternalStore(subscribeStorageContext, getStorageContextEpoch)
  const key = contextKey(projectId, pageId)
  const [pair, setPair] = useState(() => ({ key, generation, query: read(projectId, pageId)?.query ?? '' }))
  let current = pair
  if (pair.key !== key || pair.generation !== generation) {
    current = { key, generation, query: pair.key !== key ? read(projectId, pageId)?.query ?? '' : '' }
    setPair(current)
  }
  const { query } = current
  const isCurrent = useCallback(() => mounted.current && key === contextKey(getCurrentProjectId(), pageId), [key, pageId])
  const setQuery = useCallback((value: string) => {
    if (!isCurrent()) return
    setPair(previous => previous.key === key ? { ...previous, query: value } : previous)
  }, [key, isCurrent])
  const choose = useCallback((records: readonly { id: string }[], explicit?: string | null) => {
    const saved = isCurrent() ? read(projectId, pageId) : null
    return restoreListSelection(records, saved?.selectedId ?? null, explicit)
  }, [projectId, pageId, isCurrent])
  const remember = useCallback((selectedId: string | null) => {
    if (!isCurrent()) return
    const scope = currentWorkspaceScope(projectId, 'list:' + pageId)
    if (!scope) return
    const view: ListView = { version: 1, kind: 'list', objectId: OBJECT, selectedId, query: query.slice(0, 200),
      scroll: { top: 0, ratio: 0, outerTop: 0, outerRatio: 0 } }
    workspaceViews.put(scope, view, generation)
  }, [projectId, pageId, query, generation, isCurrent])
  return { query, setQuery, choose, remember, isCurrent, ownerKey: key }
}
