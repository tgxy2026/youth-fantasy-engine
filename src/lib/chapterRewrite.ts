/**
 * 「整章改写」的落库层 —— 把一个改写结果写回某一章。
 *
 * 为什么单独一层：改写会**覆盖作者的正文**，是破坏性操作，安全边界必须集中在一处、
 * 写得明明白白，不与界面逻辑混在一起。三条边界：
 *   1. **只动三个字段**（content / wordCount / updatedAt）：标题、状态、卷属、序号一律不碰
 *      —— 改写是"改文字"，不是"挪动章节"。
 *   2. **写前显式存快照**：`db.saveChapter` 自己也会按阈值存（>5 分钟 或 字数差 >200），
 *      但"5 分钟内连改两次、且两次字数都接近"恰好两条都不满足，旧稿就永久丢了。
 *      这里显式再存一份，界面提示指向「时光机 · 本章版本历史」。
 *   3. **同步章节台账**：不同步的话「章节总表」与项目字数会停在旧值上。
 */
import { chapterSeqMap, flattenChapters } from './chapterSeq'
import { syncChapterMaster } from './chapterMaster'
import * as db from './db'
import { countWords } from './textStats'
import type { Chapter, Volume } from './types'

export interface RewriteCandidate {
  chapter: Chapter
  /** 全局叙事序号（0 = 不计入序号，如序章 / 番外） */
  no: number
}

/**
 * 列出可改写的章节（按真实叙事顺序）。
 * 界面拿它渲染选章下拉；`no` 用来显示「第N章」。
 */
export async function listRewriteCandidates(): Promise<RewriteCandidate[]> {
  const [vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
  const seq = chapterSeqMap(vols, chs)
  return flattenChapters(vols, chs).map(chapter => ({ chapter, no: seq.get(chapter.id) ?? 0 }))
}

/**
 * 按卷分组的候选 —— 供界面的「卷 → 章」树用。
 * 空卷不出现在结果里（树里列一个点开是空的卷没有意义）。
 */
export interface RewriteCandidateGroup {
  volume: Volume
  items: RewriteCandidate[]
}

export async function listRewriteTree(): Promise<RewriteCandidateGroup[]> {
  const [vols, chs] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
  const seq = chapterSeqMap(vols, chs)
  const byVol = new Map<string, RewriteCandidate[]>()
  for (const c of flattenChapters(vols, chs)) {
    const item: RewriteCandidate = { chapter: c, no: seq.get(c.id) ?? 0 }
    const list = byVol.get(c.volumeId)
    if (list) list.push(item)
    else byVol.set(c.volumeId, [item])
  }
  return [...vols]
    .sort((a, b) => a.order - b.order)
    .map(v => ({ volume: v, items: byVol.get(v.id) ?? [] }))
    .filter(g => g.items.length > 0)
}

/**
 * 把改写结果写回该章。
 * @returns 新字数
 * @throws 章节不存在 / 内容为空时抛错（调用方负责提示作者）
 */
export async function applyChapterRewrite(chapterId: string, text: string): Promise<{ words: number }> {
  const body = (text ?? '').trim()
  if (!body) throw new Error('改写结果为空，没有可写入的内容')
  const chs = await db.getAllChapters()
  const ch = chs.find(c => c.id === chapterId)
  if (!ch) throw new Error('这一章已经不在项目里了')
  // 🔴 先留旧稿，再覆盖（顺序不能反：反了就丢原文）
  await db.createSnapshot(ch)
  const words = countWords(body)
  const next: Chapter = { ...ch, content: body, wordCount: words, updatedAt: Date.now() }
  const [vols, all] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
  await db.saveChapter(next)
  await syncChapterMaster(next, chapterSeqMap(vols, all).get(next.id) ?? 0)
  return { words }
}
