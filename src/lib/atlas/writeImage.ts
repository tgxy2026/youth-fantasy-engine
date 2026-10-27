import { saveTableRow } from '@/lib/db'
import type { TableRow } from '@/lib/types'
import type { AtlasImage } from './types'
import { beginRecordOperation } from '@/lib/storage/recordOperation'

/** The factory belongs to a mounted record owner, not the library active after image preparation. */
export function createTableImageWriter(options: {
  projectId: string; tabId: string; current: () => boolean
  read: () => readonly TableRow[]; committed: (row: TableRow) => void
}) {
  return async (rowId: string, image: AtlasImage | null) => {
    const owner = beginRecordOperation(options.projectId, options.current)
    const row = options.read().find(value => value.id === rowId)
    if (!row || row.projectId !== owner.projectId || row.tabId !== options.tabId) throw new Error('原资料条目已不存在，请重新选择主图')
    const next: TableRow = { ...row }
    if (image) next.atlasImage = image
    else delete next.atlasImage
    await saveTableRow(next)
    owner.assertCurrent()
    options.committed(next)
  }
}
