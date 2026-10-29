import { DESKTOP, getDesktopState } from '@/lib/app/desktop'
import { PORTABLE, getPortableState } from './fileBackend'
import { storageWriteContext } from './writeOwner'

export interface SubmissionState { connected: boolean; writeLocked?: boolean; saveConflict?: boolean }
export function platformSubmissionState(): SubmissionState {
  return DESKTOP ? getDesktopState() : PORTABLE ? getPortableState() : { connected: true }
}
/** Cached edits may be accepted during a disk flush. This does not confirm durability. */
export function submissionBlockReason(state: SubmissionState): string {
  return state.saveConflict ? '存储存在冲突' : state.writeLocked ? '存储已暂停写入' : !state.connected ? '存储尚未连接' : ''
}
export function assertSubmissionAvailable(): void {
  const reason = submissionBlockReason(platformSubmissionState())
  if (reason) throw new Error(reason)
}
/** Capture before queuing/preparation. Explicit project saves can outlive a project switch. */
export function captureSubmissionBoundary(): () => void {
  const context = storageWriteContext()
  return () => {
    if (context !== storageWriteContext()) throw new Error('存储空间已切换，本次操作已停止，请回到原空间核对。')
    assertSubmissionAvailable()
  }
}
