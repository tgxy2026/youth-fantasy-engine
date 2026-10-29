import { captureCandidateOwner } from '@/lib/ai/candidateContext'
import { ops } from '@/lib/db/core'
import { captureSubmissionBoundary } from '@/lib/storage/submissionState'
import type { StoreOps } from '@/lib/storage/storeOps'

/** Logical ownership for one asynchronous operation. Issued I/O cannot be cancelled. */
export interface OwnedOperation {
  projectId: string
  store: StoreOps
  assertCurrent: () => void
}

export function captureOwnedOperation(projectId: string): OwnedOperation {
  const owner = captureCandidateOwner(), submission = captureSubmissionBoundary(), original = ops
  const assertCurrent = () => {
    if (!projectId || owner.projectId !== projectId || !owner.current()) {
      throw new Error('项目或存储空间已切换，请回到原项目核对候选与正文。')
    }
    submission()
  }
  const store = new Proxy(original, {
    get(target, key, receiver) {
      const method = Reflect.get(target, key, receiver)
      if (typeof method !== 'function') return method
      return async (...args: unknown[]) => {
        assertCurrent()
        const result = await method.apply(target, args)
        assertCurrent()
        return result
      }
    },
  })
  return { projectId, store, assertCurrent }
}
