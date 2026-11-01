/** Serialize schema changes and recovery checks within the same browser origin. */
export async function withAtlasSchemaLock<T>(projectId: string, tabId: string, action: () => Promise<T>): Promise<T> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !navigator.locks) return action()
  return navigator.locks.request(`yfe-atlas-schema-v1:${projectId}:${tabId}`, { mode: 'exclusive' }, action)
}
