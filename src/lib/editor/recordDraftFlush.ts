import type { LeaveFlushResult } from './leaveBarrier'

/** Serialize manual save, selection and page leave. Read the latest immutable draft when a job
 * starts; an older slow write cannot finish after a newer one. Ownership includes mount lifetime.
 */
export function createRecordDraftFlusher<T>(options: {
  current: () => boolean
  read: () => { record: T | null; dirty: boolean }
  write: (record: T) => Promise<void>
  saved: (record: T) => void
}): () => Promise<LeaveFlushResult> {
  let tail: Promise<unknown> = Promise.resolve()
  const changed = (): LeaveFlushResult => ({ ok: false, scope: 'record', error: new Error('资料上下文已改变') })
  return () => {
    const operation = async (): Promise<LeaveFlushResult> => {
      if (!options.current()) return changed()
      const { record, dirty } = options.read()
      if (!record || !dirty) return { ok: true }
      try {
        await options.write(record)
        if (!options.current()) return changed()
        options.saved(record)
        return { ok: true }
      } catch (error) { return { ok: false, scope: 'record', error } }
    }
    const result = tail.then(operation, operation)
    tail = result.then(() => undefined, () => undefined)
    return result
  }
}
