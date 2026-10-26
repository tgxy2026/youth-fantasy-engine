/** Invalidate ephemeral consumers when the underlying library/backend is replaced. No content stored. */
let epoch = 0
const listeners = new Set<() => void>()
const projectListeners = new Set<(projectId: string) => void>()
export const getStorageContextEpoch = () => epoch
export function invalidateStorageContext(): void {
  epoch++
  for (const listener of listeners) { try { listener() } catch { /* A view/cache cannot block a backend change. */ } }
}
export function subscribeStorageContext(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function notifyProjectDeleted(projectId: string): void {
  for (const listener of projectListeners) { try { listener(projectId) } catch { /* Optional consumers cannot block deletion. */ } }
}
export function subscribeProjectDeletion(listener: (projectId: string) => void): () => void {
  projectListeners.add(listener)
  return () => { projectListeners.delete(listener) }
}
