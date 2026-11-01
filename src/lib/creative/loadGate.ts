/** Coalesce concurrent hydration for the same project and storage context. */
export function createContextLoadGate(load: (pid: string) => Promise<void>, invalidate: () => void) {
  let previousContext = ''
  let pending: { pid: string; context: string; promise: Promise<void> } | null = null
  return (pid: string, context: string): Promise<void> => {
    if (pending?.pid === pid && pending.context === context) return pending.promise
    if (previousContext !== context) invalidate()
    previousContext = context
    const promise = load(pid)
    pending = { pid, context, promise }
    const clear = () => { if (pending?.promise === promise) pending = null }
    void promise.then(clear, clear)
    return promise
  }
}
