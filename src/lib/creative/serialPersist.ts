import { ops } from '@/lib/db/core'
import { captureStorageWriteOwner } from '@/lib/storage/writeOwner'
import { DESKTOP, flushDesktop, getDesktopState } from '@/lib/app/desktop'
import { PORTABLE, flushPortable, getPortableState } from '@/lib/storage/fileBackend'
export { CreativeCheckpointError } from './checkpointError'

let tail: Promise<unknown> = Promise.resolve()

/** Preserve invocation order and the original storage owner for queued session snapshots. */
export function persistCreativeSnapshot(projectId: string, key: string, snapshot: unknown): Promise<void> {
  const store = ops, owner = captureStorageWriteOwner(projectId)
  const value = JSON.parse(JSON.stringify(snapshot)) as unknown
  const write = async () => {
    if (!owner.current() || store !== ops) throw new Error('存储空间已切换，未写入创作记录。')
    if (store.putStrict) await store.putStrict('meta', { key, value })
    else await store.put('meta', { key, value })
    if (!owner.current() || store !== ops) throw new Error('存储空间已切换，请核对创作记录。')
  }
  const result = tail.then(write)
  tail = result.catch(() => undefined)
  return result
}

/** Confirm file-backed stores reached disk before requesting the next chapter. */
export async function flushCreativeCheckpoint(projectId: string): Promise<boolean> {
  try {
    const owner = captureStorageWriteOwner(projectId), store = ops
    if (!owner.current()) return false
    if (!DESKTOP && !PORTABLE) return true
    const state = DESKTOP ? getDesktopState : getPortableState
    const flush = DESKTOP ? flushDesktop : flushPortable
    const deadline = Date.now() + 10000
    while (state().saving && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    if (!owner.current() || store !== ops || state().saving) return false
    return await flush() && owner.current() && store === ops
  } catch { return false }
}
