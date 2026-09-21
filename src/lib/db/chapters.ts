// ============ 存储层 · 章（含时光机快照与回收站）============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
import type { Volume, Chapter, TableRow } from '../types'
import { uid } from '../id'
import { countWords } from '../textStats'
import { ops, currentProjectId, touchProject } from './core'
import { addDailyWords } from './meta'

// ============ 章 ============
export async function getAllChapters(): Promise<Chapter[]> {
  const all = await ops.getAll<Chapter>('chapters')
  return all
    .filter(c => c.projectId === currentProjectId)
    .sort((a, b) => {
      const av = a.volumeId ?? ''
      const bv = b.volumeId ?? ''
      if (av !== bv) return av.localeCompare(bv)
      return a.order - b.order
    })
}
export async function saveChapter(c: Chapter) {
  const old = await ops.get<Chapter>('chapters', c.id)
  await ops.put('chapters', { ...c, projectId: c.projectId || currentProjectId })
  // 记录当日码字增量（正负都记，累加）
  if (old && old.wordCount !== c.wordCount) {
    await addDailyWords(c.wordCount - old.wordCount)
  }
  // 时光机：内容有变化时按策略快照（距上次快照 >5 分钟 或 字数差 >200）
  if (old && old.content !== c.content) {
    const snaps = await ops.getAllByIndex<Snapshot>('snapshots', 'chapterId', c.id)
    const last = snaps.sort((a, b) => b.createdAt - a.createdAt)[0]
    const diff = Math.abs(countWords(c.content) - countWords(old.content))
    if (!last || Date.now() - last.createdAt > 5 * 60 * 1000 || diff > 200) {
      await createSnapshot(c)
    }
  }
  touchProject(currentProjectId)
}

/** 删除章节 → 移入回收站（可恢复），并级联删除总表联动行 */
export async function deleteChapter(id: string) {
  const ch = await ops.get<Chapter>('chapters', id)
  if (ch) {
    await ops.put('trash', { ...ch, deletedAt: Date.now(), kind: 'chapter' })
  }
  await ops.del('chapters', id)
  await ops.del('tableRows', `ch-${id}`)
  // 级联清理该章的「时光机」快照
  const chSnaps = await ops.getAllByIndex<Snapshot>('snapshots', 'chapterId', id)
  if (chSnaps.length) await ops.bulkDel('snapshots', chSnaps.map(s => s.id))
}

// ============ 时光机：章节版本快照 ============
export interface Snapshot {
  id: string
  projectId: string
  chapterId: string
  chapterTitle: string
  content: string
  wordCount: number
  createdAt: number
}

const MAX_SNAPSHOTS_PER_CHAPTER = 12

export async function createSnapshot(ch: Chapter): Promise<Snapshot> {
  const snap: Snapshot = {
    id: uid(), projectId: ch.projectId || currentProjectId, chapterId: ch.id,
    chapterTitle: ch.title, content: ch.content, wordCount: ch.wordCount, createdAt: Date.now(),
  }
  await ops.put('snapshots', snap)
  // 只保留最近 N 版（按 chapterId 索引取，避免全表扫）
  const all = await ops.getAllByIndex<Snapshot>('snapshots', 'chapterId', ch.id)
  if (all.length > MAX_SNAPSHOTS_PER_CHAPTER) {
    const drop = all.sort((a, b) => b.createdAt - a.createdAt).slice(MAX_SNAPSHOTS_PER_CHAPTER)
    await ops.bulkDel('snapshots', drop.map(d => d.id))
  }
  return snap
}
export async function getSnapshots(chapterId: string): Promise<Snapshot[]> {
  return (await ops.getAllByIndex<Snapshot>('snapshots', 'chapterId', chapterId))
    .sort((a, b) => b.createdAt - a.createdAt)
}

// ============ 回收站 ============
export interface TrashItem extends Chapter {
  kind: 'chapter'
  deletedAt: number
  volumeTitle?: string // 删除时记录所属卷名（恢复时提示用）
}
export async function listTrash(): Promise<TrashItem[]> {
  const all = await ops.getAll<TrashItem>('trash')
  return all.filter(t => t.projectId === currentProjectId).sort((a, b) => b.deletedAt - a.deletedAt)
}
/** 恢复章节：原卷还在则放回原卷末尾，否则放入「已恢复章节」卷 */
export async function restoreFromTrash(id: string): Promise<Chapter | null> {
  const item = await ops.get<TrashItem>('trash', id)
  if (!item) return null
  const { kind: _k, deletedAt: _d, ...ch } = item
  let volumeId = ch.volumeId
  const volExists = await ops.get<Volume>('volumes', volumeId)
  if (!volExists) {
    const vols = (await ops.getAll<Volume>('volumes')).filter(v => v.projectId === currentProjectId)
    let vol = vols.find(v => v.title === '已恢复章节')
    if (!vol) {
      vol = { id: uid(), projectId: currentProjectId, order: vols.length, title: '已恢复章节', description: '回收站恢复的章节默认放这里', createdAt: Date.now() }
      await ops.put('volumes', vol)
    }
    volumeId = vol.id
  }
  const sib = (await ops.getAll<Chapter>('chapters')).filter(c => c.projectId === currentProjectId && c.volumeId === volumeId)
  const restored: Chapter = { ...ch, volumeId, order: sib.length, updatedAt: Date.now() }
  await ops.put('chapters', restored)
  // 删除章节时会一并删除「章节台账」中的 ch-<id> 联动行；恢复时必须重建到对应卷台账表，
  // 否则该章在台账中消失，直到再次编辑触发 syncChapterMaster 才回来。
  const masterRows = (await ops.getAll<TableRow>('tableRows')).filter(
    r => r.tabId === `chapter-vol-${volumeId}` && r.projectId === currentProjectId,
  )
  const maxOrder = masterRows.reduce((mx, r) => Math.max(mx, r.order ?? 0), 0)
  await ops.put('tableRows', {
    id: `ch-${restored.id}`,
    projectId: currentProjectId,
    tabId: `chapter-vol-${volumeId}`,
    data: {
      '章节号': '', '章节标题': restored.title,
      '一句话事件': restored.summary, '出场人物': '', '埋设伏笔编号': '',
      '回收伏笔编号': '', '细纲状态': '无', '字数': String(restored.wordCount),
      '发布日期': '', '备注': '',
    },
    order: maxOrder + 1,
  })
  await ops.del('trash', id)
  return restored
}
export async function purgeTrashItem(id: string) {
  await ops.del('trash', id)
}
export async function emptyTrash() {
  const all = await ops.getAll<TrashItem>('trash')
  for (const t of all) {
    if (t.projectId === currentProjectId) await ops.del('trash', t.id)
  }
}
