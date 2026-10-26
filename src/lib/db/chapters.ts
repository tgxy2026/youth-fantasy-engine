// ============ 存储层 · 章（含时光机快照与回收站）============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
import type { Volume, Chapter, TableRow } from '@/lib/types'
import { uid } from '@/lib/app/id'
import { countWords } from '@/lib/editor/textStats'
import { ops, currentProjectId, touchProject } from '@/lib/db/core'
import { addDailyWords } from '@/lib/db/meta'

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
/** Explicit-owner lookup for navigation. Capture the project before the asynchronous read. */
export async function chapterExistsFor(projectId: string, chapterId: string): Promise<boolean> {
  if (!projectId || !chapterId) return false
  const chapter = await ops.get<Chapter>('chapters', chapterId)
  return chapter?.projectId === projectId
}
export async function saveChapter(c: Chapter) {
  const old = await ops.get<Chapter>('chapters', c.id)
  await ops.put('chapters', { ...c, projectId: c.projectId || currentProjectId })
  await afterChapterWrite(old, c)
}

/**
 * 字段级修补一章：**只覆盖 `patch` 里出现的字段**（读-改-写在同一函数内完成）。
 *
 * 🔴 为什么必须有它（2026-10-17 全量审计 P1）：
 *   `saveChapter` 是**整对象 put**，而调用方手里那一章常常是**渲染闭包里的旧快照** ——
 *   正文自动保存（2s 防抖）与标题/摘要落库（600ms 防抖）交错时，各自拿旧快照组装整章
 *   ⇒ 后写者把前者刚改的字段**写回旧值**（实测路径：改标题后 2s 内自动保存 ⇒ 标题跳回旧值；
 *   反向则正文倒回旧稿，且界面仍显示新稿 ⇒ 库与界面分叉，重启即丢）。
 *   凡「只改一部分字段」的保存一律走本函数：正文路径只带 content/wordCount，
 *   元信息路径只带 patch 里的键，物理上不可能互相覆盖。
 *
 * 返回合并后的整章（供 `syncChapterMaster` 等派生写入使用）；章不存在返回 undefined。
 */
export async function patchChapter(
  id: string,
  patch: Partial<Omit<Chapter, 'id' | 'projectId'>>,
): Promise<Chapter | undefined> {
  const old = await ops.get<Chapter>('chapters', id)
  if (!old) return undefined
  const next: Chapter = { ...old, ...patch, updatedAt: patch.updatedAt ?? Date.now() }
  await ops.put('chapters', { ...next, projectId: old.projectId || currentProjectId })
  await afterChapterWrite(old, next)
  return next
}

/** 落库后的派生动作：当日码字增量 + 时光机快照 + 项目时间戳（saveChapter / patchChapter 共用） */
async function afterChapterWrite(old: Chapter | undefined, next: Chapter) {
  // 记录当日码字增量（正负都记，累加）；addDailyWords 内部已全局串行，跨章并发不会互相覆盖
  if (old && old.wordCount !== next.wordCount) {
    await addDailyWords(next.wordCount - old.wordCount)
  }
  // 时光机：内容有变化时按策略快照（距上次快照 >5 分钟 或 字数差 >200）
  if (old && old.content !== next.content) {
    const snaps = await ops.getAllByIndex<Snapshot>('snapshots', 'chapterId', next.id)
    const last = snaps.sort((a, b) => b.createdAt - a.createdAt)[0]
    const diff = Math.abs(countWords(next.content) - countWords(old.content))
    if (!last || Date.now() - last.createdAt > 5 * 60 * 1000 || diff > 200) {
      await createSnapshot(next)
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

/**
 * 快照来源（2.4.0 · A3）。
 *
 * 为什么要区分：**AI 动笔前留的旧稿**与**写作过程中的定时留档**，价值完全不同 ——
 * 前者是"这一章我是怎么写出来的"的证据（作者事后最想找回来的往往是它），
 * 后者只是过程中的常规留档。两者抢同一个名额时，必须先牺牲后者（见 pruneSnapshots）。
 */
export type SnapshotSource = 'auto' | 'ai-rewrite' | 'ai-continue' | 'ai-generate' | 'manual-restore'

export interface Snapshot {
  id: string
  projectId: string
  chapterId: string
  chapterTitle: string
  content: string
  wordCount: number
  createdAt: number
  /**
   * 来源。⚠️ **可选**：老库里的快照没有这个字段 —— 一律按 `'auto'` 处理，
   * 读取侧统一走 `snapshotSourceOf()`，别直接读 `s.source`（会拿到 undefined）。
   */
  source?: SnapshotSource
}

/** 读快照来源：老数据缺字段时按「自动」处理 */
export function snapshotSourceOf(s: Snapshot): SnapshotSource {
  return s.source ?? 'auto'
}

/** AI 来源的快照（进备份的那一类） */
export function isAISnapshot(s: Snapshot): boolean {
  return snapshotSourceOf(s).startsWith('ai-')
}

/** 每章快照上限：**所有来源共用这一个池子**（老大 2026-09-21 定：不减少现有保护力度） */
export const MAX_SNAPSHOTS_PER_CHAPTER = 12

/**
 * 裁到每章上限。
 *
 * 🔴 策略（2026-09-21）：**优先丢最旧的「自动」快照**。
 *    AI 快照攒不满名额时才轮到它们，且仍从最旧的开始丢 ——
 *    既守住"总数不超过 12 份"的体积账，又尽量保住作者最可能需要的那些版本。
 */
async function pruneSnapshots(chapterId: string): Promise<number> {
  const all = await ops.getAllByIndex<Snapshot>('snapshots', 'chapterId', chapterId)
  const excess = all.length - MAX_SNAPSHOTS_PER_CHAPTER
  if (excess <= 0) return 0
  const byOldest = [...all].sort((a, b) => a.createdAt - b.createdAt)
  const drop = byOldest.filter(s => snapshotSourceOf(s) === 'auto').slice(0, excess)
  if (drop.length < excess) {
    const dropped = new Set(drop.map(d => d.id))
    for (const s of byOldest) {
      if (drop.length >= excess) break
      if (!dropped.has(s.id)) { drop.push(s); dropped.add(s.id) }
    }
  }
  await ops.bulkDel('snapshots', drop.map(d => d.id))
  return drop.length
}

/**
 * 存一版快照。
 * @param source 来源，默认 `'auto'`（写作过程中的定时留档）；
 *               AI 动笔前请显式传 `'ai-rewrite'` / `'ai-continue'` / `'ai-generate'`。
 */
export async function createSnapshot(ch: Chapter, source: SnapshotSource = 'auto'): Promise<Snapshot> {
  const snap: Snapshot = {
    id: uid(), projectId: ch.projectId || currentProjectId, chapterId: ch.id,
    chapterTitle: ch.title, content: ch.content, wordCount: ch.wordCount, createdAt: Date.now(),
    source,
  }
  await ops.put('snapshots', snap)
  await pruneSnapshots(ch.id)
  return snap
}
export async function getSnapshots(chapterId: string): Promise<Snapshot[]> {
  return (await ops.getAllByIndex<Snapshot>('snapshots', 'chapterId', chapterId))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 取当前项目的**全部**快照（一次全表读）。
 *
 * 用途：整书证据包要按章统计「保留了几版」—— 逐章调 {@link getSnapshots} 会打 N 次库
 * （300 章 = 300 次），一次全表读再分组要快得多。
 */
export async function getAllSnapshots(): Promise<Snapshot[]> {
  const all = await ops.getAll<Snapshot>('snapshots')
  return all.filter(s => s.projectId === currentProjectId)
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
      // 🔴 只数真卷：自由卷 order 是哨兵值（恒排最前，见 lib/freeVolume.ts），
      //    拿 vols.length 当基准会让这个兜底卷的序号偏大一位
      const realMax = vols.filter(v => v.isFree !== true).reduce((m, v) => Math.max(m, v.order ?? 0), -1)
      vol = { id: uid(), projectId: currentProjectId, order: realMax + 1, title: '已恢复章节', description: '回收站恢复的章节默认放这里', createdAt: Date.now() }
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
