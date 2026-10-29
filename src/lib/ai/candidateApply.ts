export type CandidateApplyResult = void | boolean
export type CandidateSubmit = (values: Record<string, string>) => CandidateApplyResult | Promise<CandidateApplyResult>

/** A UI submission receipt is not a persistence receipt. Never close or clear a candidate on failure. */
export function createCandidateApplyGuard(options: {
  owner: () => string | null
  pending: (value: boolean) => void
  accepted: () => void
  rejected: (reason: 'declined' | 'failed') => void
  stale?: (owner: string) => void
}) {
  let busy = false, completed = false
  return {
    isBusy: () => busy,
    reset: () => {
      if (busy || !options.owner()) return false
      completed = false
      return true
    },
    async run(submit: () => CandidateApplyResult | Promise<CandidateApplyResult>): Promise<boolean> {
      const owner = options.owner()
      if (!owner || busy || completed) return false
      busy = true
      options.pending(true)
      const current = () => options.owner() === owner
      try {
        let result: CandidateApplyResult
        try { result = await submit() }
        catch {
          if (current()) options.rejected('failed')
          return false
        }
        if (!current()) return false
        if (result === false) { options.rejected('declined'); return false }
        completed = true
        options.accepted()
        return true
      } finally {
        busy = false
        if (current()) options.pending(false)
        else options.stale?.(owner)
      }
    },
  }
}
