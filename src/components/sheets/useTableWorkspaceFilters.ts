import { useCallback, useEffect, useState, type SetStateAction } from 'react'
import { getCurrentProjectId } from '@/lib/db'
import { currentWorkspaceScope } from '@/lib/settings/workspaceRuntime'
import { workspaceViews, type ListView } from '@/lib/settings/workspaceViewState'
import { useListWorkspaceView } from '@/components/common/useListWorkspaceView'

const OBJECT = 'filter-state'
function read(page: string) {
  const scope = currentWorkspaceScope(getCurrentProjectId(), page)
  const saved = scope ? workspaceViews.get(scope, OBJECT) : null
  return saved?.kind === 'list' ? saved.filters ?? {} : null
}

/** Separate optional UI state: invalidation must never clear rows, live drafts or their DOM. */
export function useTableWorkspaceFilters(tabId: string, focusRowId?: string | null) {
  const page = 'table:' + tabId
  const { ownerKey, generation, isCurrent } = useListWorkspaceView(getCurrentProjectId(), page)
  const [pair, setPair] = useState(() => ({ ownerKey, generation, filters: read(page) ?? {} }))
  let current = pair
  if (pair.ownerKey !== ownerKey || pair.generation !== generation) {
    const saved = read(page)
    current = { ownerKey, generation, filters: pair.ownerKey === ownerKey && saved ? pair.filters : saved ?? {} }
    setPair(current)
  }
  const filters = current.filters
  const setFilters = useCallback((action: SetStateAction<Record<string, string>>) => {
    if (!isCurrent()) return
    setPair(previous => {
      const next = typeof action === 'function' ? action(previous.filters) : action
      return { ownerKey, generation, filters: Object.fromEntries(Object.entries(next).map(([key, value]) => [key, value.slice(0, 200)])) }
    })
  }, [ownerKey, generation, isCurrent])
  useEffect(() => {
    if (!isCurrent()) return
    const scope = currentWorkspaceScope(getCurrentProjectId(), page)
    if (!scope) return
    const value: ListView = { version: 1, kind: 'list', objectId: OBJECT, selectedId: null, query: '', filters,
      scroll: { top: 0, ratio: 0, outerTop: 0, outerRatio: 0 } }
    workspaceViews.put(scope, value, generation)
  }, [page, filters, generation, isCurrent])
  // Explicit navigation owns the destination, including a target hidden by an earlier filter.
  useEffect(() => { if (focusRowId) setFilters({}) }, [focusRowId, setFilters])
  return [filters, setFilters] as const
}
