import { DESKTOP, getDesktopState } from '@/lib/app/desktop'
import { PORTABLE, getPortableState } from './fileBackend'

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
