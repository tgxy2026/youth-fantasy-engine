/**
 * 拆书落库：把切分结果写入「正文编辑」的 **卷 / 章**。
 *
 * 需求背景（2026-09-18 老大提）：拆书不能只抽出设定，要**先把原文结构同步进正文编辑**
 * ——「用户把正文粘贴/导入后，首先应该把内容切分输入到正文编辑里，形成卷章节的框架结构」。
 * 这样拆完就能直接对着一章章正文看/改，而不是只有一堆孤立的设定条目。
 *
 * 三条设计约束：
 * 1. 🔴 **只追加，绝不覆盖**：新建卷接在已有卷之后；已有卷章分毫不动。
 * 2. 🔴 **重复导入要能看出来**：同名卷 + 同章标题集合 + 同章数 → 判定「已导入过」直接跳过，
 *    避免手滑跑两次把整本书复制成两份（真要重导就删掉那个卷再来）。
 * 3. **写一半能停**：中止时返回已写入的部分（`aborted=true`），不留"半截卷"以外的脏数据。
 *
 * ⚠️ 本章概要不在这里填：概要属于「正文 → 卷台账 → 章节细纲卡」那条勾稽链，
 *    与「创意写作」的回填是同一套逻辑，放到下一批统一设计（避免两处口径打架）。
 */
import { syncChapterMaster } from '../chapterMaster'
import { chapterSeqMap, flattenChapters } from '../chapterSeq'
import * as db from '../db'
import { uid } from '../id'
import { countWords } from '../textStats'
import type { Chapter, Volume } from '../types'
import { isVolumeTitle, type SplitResult } from './split'

/** 导入章节的初始状态：原文本来就是写完的文本，标「完稿」最贴切（改这里要同步面板说明） */
export const IMPORTED_CHAPTER_STATUS = '完稿' as const

export interface PlannedChapter {
  title: string
  text: string
  /** 源切分块序号（1 起），用于回指原文区间 */
  sourceIndex: number
}

export interface PlannedVolume {
  title: string
  chapters: PlannedChapter[]
}

export interface PersistPlan {
  volumes: PlannedVolume[]
  chapterCount: number
  words: number
}

export const DEFAULT_IMPORT_VOLUME_TITLE = '导入原文'

/**
 * 剥掉章标题里的「第N章/回/节」「Chapter N」前缀，只留章名。
 *
 * 🔴 为什么必须剥（2026-09-18 实机发现）：导入的章在项目里被系统重新编号
 * （原书「第1章」在这个项目里可能是第 22 章），卷台账会同时显示「第22章」与标题里的「第1章」，
 * **自相矛盾**。项目自身的约定就是"标题只写章名、编号由系统派生"
 * （见 `aiTasks.outlineSys` 铁律 6）。
 * 标题只有编号、没有章名时（如「第一章」）原样保留，否则会变成空标题。
 */
export function stripChapterNumber(title: string): string {
  const t = (title ?? '').trim()
  if (!t) return ''
  const CN = '0-9零一二两三四五六七八九十百千壹贰叁肆伍陆柒捌玖拾佰仟'
  const m = t.match(new RegExp(`^(?:第\\s*[${CN}]+\\s*[章回节]|Chapter\\s*\\d+)\\s*[:：、.·\\-—]?\\s*(.+)$`, 'i'))
  return m && m[1].trim() ? m[1].trim() : t
}

/**
 * 把切分结果排成「卷 → 章」结构（纯函数，零 IO，可单测）。
 *
 * 分层规则：
 * - 条目标题是「卷X」→ 它本身是**卷边界**，开新卷；该条目的正文若非空，作为该卷的「卷首」章
 * - 其它条目 → 当前卷下的一章
 * - 卷边界之前出现的章 → 归入默认卷（`opts.volumeTitle` 或「导入原文」）
 */
export function planVolumes(sp: SplitResult, opts: { volumeTitle?: string } = {}): PersistPlan {
  const defaultTitle = opts.volumeTitle?.trim() || DEFAULT_IMPORT_VOLUME_TITLE
  const volumes: PlannedVolume[] = []
  // 默认卷延迟创建：只有真的出现「卷边界之前的章」时才建，避免空卷
  let cur: PlannedVolume | null = null
  const ensureDefault = (): PlannedVolume => {
    if (!cur) { cur = { title: defaultTitle, chapters: [] }; volumes.push(cur) }
    return cur
  }

  for (const ch of sp.chapters) {
    const text = (ch.text ?? '').trim()
    if (isVolumeTitle(ch.title)) {
      cur = { title: ch.title.trim(), chapters: [] }
      volumes.push(cur)
      // 「卷一」这条自带的正文（下一个章节标题之前的内容）不该丢
      if (text) cur.chapters.push({ title: '卷首', text, sourceIndex: ch.index })
      continue
    }
    if (!text) continue
    ensureDefault().chapters.push({ title: stripChapterNumber(ch.title) || `第${ch.index}章`, text, sourceIndex: ch.index })
  }

  // 丢掉没有正文的空卷（例如原文末尾孤零零一个「卷二」）
  const kept = volumes.filter(v => v.chapters.length > 0)
  return {
    volumes: kept,
    chapterCount: kept.reduce((n, v) => n + v.chapters.length, 0),
    words: kept.reduce((n, v) => n + v.chapters.reduce((m, c) => m + countWords(c.text), 0), 0),
  }
}

export interface PersistOptions {
  /** 无卷结构时用的卷名（默认「导入原文」） */
  volumeTitle?: string
  /** 中止信号 */
  signal?: AbortSignal
  /** 每写完一章回调一次（done 从 1 起） */
  onProgress?: (done: number, total: number) => void
}

export interface PersistedVolume {
  id: string
  title: string
  chapters: number
}

export interface PersistResult {
  /** 本次实际新建的卷 */
  volumes: PersistedVolume[]
  chaptersCreated: number
  words: number
  /** 因中止只写了一部分 */
  aborted: boolean
  /** 检测到「同一本书已经导入过」而整体跳过 */
  alreadyImported: boolean
}

/**
 * 把切分结果写入当前项目的正文编辑。
 * @returns 落库统计；**不会抛**「无卷」之类的前置错误 —— 缺卷时自己建。
 */
export async function persistSplitToChapters(
  sp: SplitResult,
  opts: PersistOptions = {},
): Promise<PersistResult> {
  const plan = planVolumes(sp, opts.volumeTitle !== undefined ? { volumeTitle: opts.volumeTitle } : {})
  const total = plan.chapterCount
  const empty: PersistResult = { volumes: [], chaptersCreated: 0, words: 0, aborted: false, alreadyImported: false }
  if (!total) return empty

  const pid = db.getCurrentProjectId()
  const volumes = await db.getAllVolumes()
  const chapters = await db.getAllChapters()

  // 🔴 重复导入守卫：同名卷 + 章数一致 + 章标题集合一致 → 认为这本书已经导过了
  const dup = volumes.find(v => {
    if (v.title.trim() !== plan.volumes[0]!.title.trim()) return false
    if (plan.volumes.length > 1) return false // 多卷情形不做该判定（宁可重复也不要误判）
    const exist = chapters.filter(c => c.volumeId === v.id)
    if (exist.length !== plan.volumes[0]!.chapters.length) return false
    const a = new Set(exist.map(c => c.title))
    return plan.volumes[0]!.chapters.every(c => a.has(c.title))
  })
  if (dup) return { ...empty, alreadyImported: true }

  // 接在已有内容之后：卷序、章节号（全局连续）、叙事位次
  let volOrder = volumes.length
  let seq = Math.max(0, ...[...chapterSeqMap(volumes, chapters).values()])
  let narrative = flattenChapters(volumes, chapters).length

  const out: PersistedVolume[] = []
  let done = 0
  let words = 0
  let aborted = false

  for (const pv of plan.volumes) {
    if (opts.signal?.aborted) { aborted = true; break }
    const now = Date.now()
    const vol: Volume = {
      id: uid(), projectId: pid, order: volOrder++, title: pv.title, description: '', createdAt: now,
    }
    await db.saveVolume(vol)
    let order = 0
    let created = 0
    for (const pc of pv.chapters) {
      if (opts.signal?.aborted) { aborted = true; break }
      const ch: Chapter = {
        id: uid(), projectId: pid, volumeId: vol.id, order: order++,
        title: pc.title, content: pc.text, summary: '',
        status: IMPORTED_CHAPTER_STATUS,
        wordCount: countWords(pc.text), createdAt: now, updatedAt: now,
      }
      await db.saveChapter(ch)
      // 同步该卷的「章节台账」表（章节总表靠它聚合；不调的话正文有了、台账是空的）
      seq += 1
      narrative += 1
      await syncChapterMaster(ch, seq, narrative - 1)
      words += ch.wordCount
      created += 1
      done += 1
      opts.onProgress?.(done, total)
    }
    out.push({ id: vol.id, title: vol.title, chapters: created })
    if (aborted) break
  }

  return { volumes: out, chaptersCreated: done, words, aborted, alreadyImported: false }
}
