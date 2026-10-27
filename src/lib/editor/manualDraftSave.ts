export interface ManualDraftSaveState {
  saving: boolean
  submitted: boolean
  error: string
}

/** One in-flight submission. A receipt covers only its immutable snapshot, never newer edits. */
export function createManualDraftSaver<T>(options: {
  current: () => boolean
  read: () => { value: T; dirty: boolean }
  write: (value: T) => Promise<void>
  committed: (value: T) => boolean
  state: (state: ManualDraftSaveState) => void
}): () => Promise<boolean> {
  let pending: Promise<boolean> | null = null
  let state: ManualDraftSaveState = { saving: false, submitted: false, error: '' }
  const update = (next: ManualDraftSaveState) => { state = next; options.state(state) }
  return () => {
    if (pending) return pending
    const operation = async () => {
      if (!options.current()) return false
      const { value, dirty } = options.read()
      if (!dirty) return true
      update({ ...state, saving: true, submitted: false })
      try {
        await options.write(value)
        if (!options.current()) return false
        const accepted = options.committed(value)
        const clean = accepted && !options.read().dirty
        update({ saving: false, submitted: clean, error: '' })
        return clean
      } catch {
        if (options.current()) update({ saving: false, submitted: false, error: '保存未完成，请保留当前草稿并重试。' })
        return false
      } finally {
        if (options.current() && state.saving) update({ ...state, saving: false })
      }
    }
    pending = operation().finally(() => { pending = null })
    return pending
  }
}
