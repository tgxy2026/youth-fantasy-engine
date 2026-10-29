import { getStorageContextEpoch } from './contextEpoch'

/** A logical backend/account boundary; it cannot cancel I/O already issued to a backend. */
export function storageWriteContext(): string {
  const account = typeof window === 'undefined' ? ''
    : (window as unknown as { __YFE_USER__?: { id?: string } }).__YFE_USER__?.id ?? ''
  return JSON.stringify([getStorageContextEpoch(), account])
}

/** Explicit old-project saves remain valid when only the active project changes. */
export function captureStorageWriteOwner(projectId: string) {
  const context = storageWriteContext()
  return { current: () => !!projectId && context === storageWriteContext() }
}
