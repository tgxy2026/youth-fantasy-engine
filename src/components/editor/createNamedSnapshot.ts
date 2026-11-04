import * as db from '@/lib/db'
import { persistAfterRestore } from '@/lib/db/core'
import { countWords } from '@/lib/editor/textStats'
import { captureOwnedOperation } from '@/lib/storage/ownedOperation'
import type { Chapter } from '@/lib/types'

/** 按点击时的草稿创建命名快照；失败可能已写入，不改变正文。 */
export async function createNamedChapterSnapshot(projectId: string, chapterId: string, text: string, label: string, note: string): Promise<db.Snapshot> {
  const owner = captureOwnedOperation(projectId)
  owner.assertCurrent()
  const chapter = await owner.store.get<Chapter>('chapters', chapterId)
  if (!chapter || chapter.projectId !== projectId) throw new Error('章节已不存在或不属于本作品')
  const snapshot = await db.createSnapshot({ ...chapter, content: text, wordCount: countWords(text) }, 'manual-named', owner, { label, note })
  const verified = await owner.store.get<db.Snapshot>('snapshots', snapshot.id)
  if (!verified || verified.content !== text || verified.label !== label.trim() || verified.note !== note.trim()) throw new Error('快照读回不一致')
  if (!await persistAfterRestore([{ store: 'snapshots', value: verified }])) throw new Error('快照未确认写入本机')
  owner.assertCurrent()
  const final = await owner.store.get<db.Snapshot>('snapshots', snapshot.id)
  if (!final || final.content !== text || final.label !== label.trim() || final.note !== note.trim()) throw new Error('快照已变化或被清理')
  return verified
}
