import { useCallback, useState } from 'react'
import { useListWorkspaceView } from '@/components/common/useListWorkspaceView'
import { candidateApplyContext } from '@/lib/ai/candidateContext'
import { currentWorkspaceScope } from '@/lib/settings/workspaceRuntime'
import { workspaceViews, type DetailView } from '@/lib/settings/workspaceViewState'

/** A record's display flag shares its bounded detail view; never persist it with project data. */
export function useAtlasWorkspaceOptions(projectId: string, tabId: string, objectId: string) {
  const pageId = 'atlas:' + tabId, view = useListWorkspaceView(projectId, pageId, 'none')
  const context = candidateApplyContext(), key = view.ownerKey + context + objectId
  const read = () => {
    const scope = currentWorkspaceScope(projectId, pageId)
    const value = scope ? workspaceViews.get(scope, objectId) : null
    return value?.kind === 'detail' ? value : null
  }
  const [state, setState] = useState(() => ({ key, generation: view.generation, value: read()?.showEmpty ?? false }))
  let current = state
  if (state.key !== key || state.generation !== view.generation) {
    current = { key, generation: view.generation, value: read()?.showEmpty ?? false }
    setState(current)
  }
  const { generation, isCurrent } = view
  const setShowEmpty = useCallback((value: boolean) => {
    if (!isCurrent() || context !== candidateApplyContext() || generation !== workspaceViews.generation()) return
    setState({ key, generation, value })
    const scope = currentWorkspaceScope(projectId, pageId)
    if (!scope) return
    const previous = workspaceViews.get(scope, objectId)
    const record: DetailView = previous?.kind === 'detail' ? previous : { version: 1, kind: 'detail', objectId, groups: [],
      scroll: { top: 0, ratio: 0, outerTop: 0, outerRatio: 0 } }
    workspaceViews.put(scope, { ...record, showEmpty: value }, generation)
  }, [isCurrent, context, generation, key, projectId, pageId, objectId])
  return [current.value, setShowEmpty] as const
}
