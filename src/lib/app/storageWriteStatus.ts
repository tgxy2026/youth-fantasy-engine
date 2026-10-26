/** Presentation only: callers supply the authoritative backend facts, never an optimistic page receipt. */
export interface StorageWriteFacts {
  connected: boolean
  dirty: boolean
  saving: boolean
  lastError: string
  lastSavedAt: number
  writeLocked?: boolean
  saveConflict?: boolean
}
export type StorageWriteKind = 'conflict' | 'locked' | 'error' | 'connecting' | 'writing' | 'pending' | 'saved' | 'idle'
export interface StorageWritePresentation {
  kind: StorageWriteKind
  label: string
  tone: 'danger' | 'warning' | 'success' | 'muted'
  canSave: boolean
  description: string
}
export function storageWriteStatus(facts: StorageWriteFacts): StorageWritePresentation {
  const canSave = facts.connected && !facts.saving && !facts.writeLocked && !facts.saveConflict
  const result = (kind: StorageWriteKind, label: string, tone: StorageWritePresentation['tone'], description: string): StorageWritePresentation =>
    ({ kind, label, tone, description, canSave })
  if (facts.saveConflict) return result('conflict', '存在冲突', 'danger', '保存存在冲突，尚未确认当前修改已保存。请先查看存储区的冲突说明，不要直接刷新或覆盖。')
  if (facts.writeLocked) return result('locked', '暂停写入', 'danger', '存储已暂停写入。请先查看存储区的原因和恢复入口；点击保存不能解除写入限制。')
  if (facts.lastError) return result('error', '保存出错', 'danger', '本次写入未确认成功。请保留当前页面，查看存储区的错误说明后重试。')
  if (!facts.connected) return result('connecting', '等待存储', 'muted', '正在等待存储初始化，尚未确认本次写入。')
  if (facts.saving) return result('writing', '正在写入', 'warning', '存储正在写入，尚未确认完成。')
  if (facts.dirty) return result('pending', '待保存', 'warning', '存储中还有待写入的修改，尚未确认完成。')
  if (Number.isFinite(facts.lastSavedAt) && facts.lastSavedAt > 0) return result('saved', '已保存', 'success', '当前存储已确认写入。')
  return result('idle', '暂无保存记录', 'muted', '当前没有已确认的保存时间；这不表示已有内容丢失。')
}
