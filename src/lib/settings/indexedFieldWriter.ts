import { getCardRecordsFor, getTableRowsFor, saveCardRecord, saveTableRow } from '@/lib/db'
import { beginRecordOperation } from '@/lib/storage/recordOperation'
import { DESKTOP, getDesktopState } from '@/lib/app/desktop'
import { PORTABLE, getPortableState } from '@/lib/storage/fileBackend'
import { describeFieldSave, type FieldSaveOutcome } from './fieldSaveOutcome'

export interface IndexedFieldWrite {
  kind: 'card' | 'table'; tabId: string; recordId: string; dataKey: string; value: string
}
const stale: FieldSaveOutcome = { ok: false, kind: 'stale', message: '当前记录或存储空间已切换，本次提交结果不再适用于此处。' }
type WriteState = { connected: boolean; writeLocked?: boolean; saveConflict?: boolean }
function platformWriteState(): WriteState {
  return DESKTOP ? getDesktopState() : PORTABLE ? getPortableState() : { connected: true }
}
function writeBlock(state: WriteState): FieldSaveOutcome | null {
  const reason = state.saveConflict ? '存储存在冲突' : state.writeLocked ? '存储已暂停写入' : !state.connected ? '存储尚未连接' : ''
  // Pending/ongoing disk flushes can accept edits. An interface receipt never proves durability.
  return reason ? { ok: false, kind: 'blocked', message: `${reason}，本次修改未确认保存。请保留输入，先查看存储栏的处理说明，再重试提交。` } : null
}

/** Each mounted index owns its queue. Re-read records and preserve unrelated fields without mutating cached rows. */
export function createIndexedFieldWriter(projectId: string, current: () => boolean, readWriteState: () => WriteState = platformWriteState) {
  let tail: Promise<unknown> = Promise.resolve()
  const pending = new Map<string, Promise<FieldSaveOutcome>>()
  return (input: IndexedFieldWrite): Promise<FieldSaveOutcome> => {
    if (!current()) return Promise.resolve(stale)
    const value = { ...input }, key = JSON.stringify(value), duplicate = pending.get(key)
    if (duplicate) return duplicate
    const result = tail.then(async (): Promise<FieldSaveOutcome> => {
      try {
        const owner = beginRecordOperation(projectId, current)
        const blocked = writeBlock(readWriteState())
        if (blocked) return blocked
        if (!value.recordId || !value.tabId || !value.dataKey) return describeFieldSave({ written: false })
        if (value.kind === 'card') {
          const record = (await getCardRecordsFor(owner.projectId, value.tabId)).find(r => r.id === value.recordId)
          owner.assertCurrent()
          if (!record) return describeFieldSave({ written: false })
          const blocked = writeBlock(readWriteState())
          if (blocked) return blocked
          await saveCardRecord({ ...record, projectId: owner.projectId, data: { ...record.data, [value.dataKey]: value.value } })
        } else {
          const record = (await getTableRowsFor(owner.projectId, value.tabId)).find(r => r.id === value.recordId)
          owner.assertCurrent()
          if (!record) return describeFieldSave({ written: false })
          const blocked = writeBlock(readWriteState())
          if (blocked) return blocked
          await saveTableRow({ ...record, projectId: owner.projectId, data: { ...record.data, [value.dataKey]: value.value } })
        }
        owner.assertCurrent()
        const blockedAfterWrite = writeBlock(readWriteState())
        if (blockedAfterWrite) return blockedAfterWrite
        return describeFieldSave({ written: true })
      } catch (error) { return current() ? describeFieldSave({ written: false, error }) : stale }
    })
    tail = result; pending.set(key, result)
    void result.finally(() => { if (pending.get(key) === result) pending.delete(key) })
    return result
  }
}
