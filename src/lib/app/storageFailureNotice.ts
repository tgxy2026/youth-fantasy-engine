import { storageWriteStatus, type StorageWriteFacts } from './storageWriteStatus'
import { storageFailureReason } from './storageFailureReason'

/** One safe notice per failure episode; changing temporary paths are not new failures. */
export function createStorageFailureNotice() {
  let owner = '', previous = ''
  return (facts: StorageWriteFacts, context = ''): string | null => {
    if (context !== owner) { owner = context; previous = '' }
    const status = storageWriteStatus(facts)
    if (status.kind === 'error' || status.kind === 'locked' || status.kind === 'conflict') {
      const failure = status.kind === 'error' ? storageFailureReason(facts.lastError).code : status.kind
      if (previous === failure) return null
      previous = failure
      return '数据保存未确认：' + status.description
    }
    // A retry can temporarily clear lastError while still dirty/writing. Do not re-arm then.
    if (facts.connected && !facts.dirty && !facts.saving) previous = ''
    return null
  }
}
