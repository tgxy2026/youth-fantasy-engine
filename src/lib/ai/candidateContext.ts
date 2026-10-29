import { getCurrentProjectId, getProjectContextEpoch } from '@/lib/db'
import { storageWriteContext } from '@/lib/storage/writeOwner'

/** UI/business ownership only; this does not cancel an already-issued backend write. */
export function candidateApplyContext() {
  return JSON.stringify([getCurrentProjectId(), getProjectContextEpoch(), storageWriteContext()])
}
export function captureCandidateOwner() {
  const projectId = getCurrentProjectId(), context = candidateApplyContext()
  return { projectId, current: () => !!projectId && context === candidateApplyContext() }
}
