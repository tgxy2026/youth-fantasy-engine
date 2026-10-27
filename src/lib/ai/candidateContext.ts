import { getCurrentProjectId, getProjectContextEpoch } from '@/lib/db'
import { getStorageContextEpoch } from '@/lib/storage/contextEpoch'

/** UI/business ownership only; this does not cancel an already-issued backend write. */
export function candidateApplyContext() {
  const account = typeof window === 'undefined' ? ''
    : (window as unknown as { __YFE_USER__?: { id?: string } }).__YFE_USER__?.id ?? ''
  return JSON.stringify([getCurrentProjectId(), getStorageContextEpoch(), getProjectContextEpoch(), account])
}
export function captureCandidateOwner() {
  const projectId = getCurrentProjectId(), context = candidateApplyContext()
  return { projectId, current: () => !!projectId && context === candidateApplyContext() }
}
