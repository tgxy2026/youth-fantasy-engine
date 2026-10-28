/** Same-workspace actions against the same chapter must compare and write in order. */
const queues = new Map<string, Promise<void>>()

export function serializeRevision<T>(context: string, chapterId: string, run: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([context, chapterId])
  const previous = queues.get(key) ?? Promise.resolve()
  const result = previous.then(run)
  const tail = result.then(() => undefined, () => undefined)
  queues.set(key, tail)
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return result
}
