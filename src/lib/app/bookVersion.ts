/**
 * 作品版本冻结 · 判据层（3.0 · W3-1 · §10.3 #7）
 *
 * 三块**纯函数**（不发 AI、不读库、好测）：
 *   1. `bookStats`     —— 「完成检查」的确定性部分：字数 / 章数 / 已写章 / 空章清单。
 *   2. `bookFingerprint` —— **作品级指纹**：把各章 `chapterFingerprint` 按顺序拼起来再哈希。
 *      决定「这一版是不是同一版稿」—— 正文改一字即变。§10.3 #7 的「审校记录绑定手稿指纹」就落在这里。
 *   3. `evaluatePublishGate` —— **发布闸门**：缺章 / 空书 / 未分卷 / 空卷，分 blocker / warn 两档。
 *
 * 🔴 三条口径（改前先读）：
 *   · **不判优劣、不评分** —— 与「投稿前自检」（`manuscriptCheck`）同一条红线：只摆确定性事实。
 *   · **闸门不硬拦** —— 返回 blockers 供界面提示；作者看到代价后仍可强制冻结（「AI 只辅助、作者裁决」）。
 *   · **零成本判据** —— 只看 `chapters` / `volumes` 两个数组，不跑引擎、不读伏笔 / 连续性（那些是既有面板的事）。
 */
import type { Chapter, Volume } from '@/lib/types'
import { chapterFingerprint } from '@/lib/ai/aiRunLedger'
import { hashOf } from '@/lib/semantic/chunk'
import { orphanChapters } from '@/lib/outline/chapterSeq'

// ============ 一、完成检查（确定性统计）============

export interface BookStats {
  /** 卷数（不含系统「自由卷」—— 它托管未归类章节，不是真正的分卷） */
  volumes: number
  /** 章节总数（含空章） */
  chapters: number
  /** 已有正文的章数（`content` 去空白后非空） */
  writtenChapters: number
  /** 已有正文的总字数（按 `wordCount` 求和；空章不计） */
  totalWords: number
  /** 平均每已写章字数（无已写章时为 0） */
  avgWordsPerWritten: number
  /** 空章（有章节行、正文为空）的 id，按 order 升序 */
  emptyChapterIds: string[]
  /** 空章标题（供界面列前几条，按 order 升序） */
  emptyChapterTitles: string[]
  /** 全书最后一次改动时间（无章时为 null） */
  lastUpdatedAt: number | null
}

/** 判定「这一章算不算有正文」—— 与全站口径一致：`content.trim()` 非空 */
function hasBody(ch: Chapter): boolean {
  return typeof ch.content === 'string' && ch.content.trim().length > 0
}

/** 按 order 升序；order 相同时用 id 兜底，保证同一批数据每次排序结果一致（指纹要稳定） */
function byOrder(a: Chapter, b: Chapter): number {
  return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export function bookStats(chapters: readonly Chapter[], volumes: readonly Volume[]): BookStats {
  const sorted = [...chapters].sort(byOrder)
  const written = sorted.filter(hasBody)
  const totalWords = written.reduce((s, c) => s + (Number.isFinite(c.wordCount) ? c.wordCount : 0), 0)
  const empty = sorted.filter(c => !hasBody(c))
  const realVolumes = volumes.filter(v => !v.isFree)
  const lastUpdatedAt = sorted.length ? Math.max(...sorted.map(c => c.updatedAt || 0)) : null
  return {
    volumes: realVolumes.length,
    chapters: sorted.length,
    writtenChapters: written.length,
    totalWords,
    avgWordsPerWritten: written.length ? Math.round(totalWords / written.length) : 0,
    emptyChapterIds: empty.map(c => c.id),
    emptyChapterTitles: empty.map(c => c.title || '（未命名）'),
    lastUpdatedAt,
  }
}

// ============ 二、作品级指纹（版本绑定的判据）============

/**
 * 作品级指纹：各章 `chapterFingerprint` 按叙事顺序拼接后哈希。
 *
 * 🔴 复用章级指纹（含 `title` / `content` / `wordCount` / `updatedAt`）—— 不另造一套算法；
 *    `updatedAt` 在里头意味着「改坏又改回原样」也判「变了」（宁严勿松，与 W1-1 同口径）。
 * 🔴 先按 order 排序再拼 —— 否则同一本书换个存储顺序就得到不同指纹。
 */
export function bookFingerprint(chapters: readonly Chapter[]): string {
  const parts = [...chapters].sort(byOrder).map(c => chapterFingerprint(c))
  return hashOf(parts.join('\u0001'))
}

/** 指纹短号（列表里显示用，取前 8 位） */
export function shortFingerprint(fp: string): string {
  return (fp || '').split('-')[0] || '—'
}

// ============ 三、发布闸门 ============

export type GateLevel = 'blocker' | 'warn'

export interface GateItem {
  key: string
  level: GateLevel
  /** 一句话说清是什么（界面标题） */
  title: string
  /** 为什么会被拦、怎么办（界面副文案） */
  detail: string
}

export interface PublishGate {
  blockers: GateItem[]
  warnings: GateItem[]
  /** 无任何 blocker ⇒ 视为通过（warnings 不阻断） */
  ok: boolean
}

/** 闸门里最多列几章标题（再多界面也没法读） */
const MAX_LISTED = 5

/**
 * 发布闸门 —— 确定性判据，零成本。
 *
 * 判据表：
 *   · **blocker** 全书没有任何正文（空书何谈定稿）
 *   · **blocker** 存在「有章节行但正文为空」的章（对方 §10.3 #7「缺失章节 …阻止发布」）
 *   · warn     存在未归入任何卷的章节（脏数据，建议整理）
 *   · warn     存在整卷无章（排除系统「自由卷」）
 *
 * 🔴 只报**事实**，不评分、不判「能不能过审」。是否放行由作者决定（见本文件顶部口径）。
 */
export function evaluatePublishGate(
  stats: BookStats,
  chapters: readonly Chapter[],
  volumes: readonly Volume[],
): PublishGate {
  const blockers: GateItem[] = []
  const warnings: GateItem[] = []

  if (stats.writtenChapters === 0) {
    blockers.push({
      key: 'empty-book',
      level: 'blocker',
      title: '整本书还没有任何正文',
      detail: '一个字的正文都没有，没有可定稿的内容。先写至少一章再冻结。',
    })
  } else if (stats.emptyChapterIds.length > 0) {
    const n = stats.emptyChapterIds.length
    const shown = stats.emptyChapterTitles.slice(0, MAX_LISTED).join('、')
    const tail = n > MAX_LISTED ? ` 等 ${n} 章` : ''
    blockers.push({
      key: 'empty-chapters',
      level: 'blocker',
      title: `有 ${n} 章还是空的`,
      detail: `${shown}${tail} —— 这些章有标题但没正文。补齐、或把这些章删掉，再冻结。`,
    })
  }

  // warn：未归入任何卷（volumeId 找不到对应卷）—— 判定走唯一真源 chapterSeq.orphanChapters
  const orphan = orphanChapters(volumes, chapters)
  if (orphan.length > 0) {
    warnings.push({
      key: 'orphan-chapters',
      level: 'warn',
      title: `有 ${orphan.length} 章没有归属到任何卷`,
      detail: '这些章的卷记录可能已被删除。不影响冻结，但建议先整理归卷。',
    })
  }

  // warn：整卷无章（排除系统「自由卷」—— 它是托管未归类章节的容器，本就可能为空）
  const emptyVols = volumes.filter(v => !v.isFree && !chapters.some(c => c.volumeId === v.id))
  if (emptyVols.length > 0) {
    warnings.push({
      key: 'empty-volumes',
      level: 'warn',
      title: `有 ${emptyVols.length} 个空卷`,
      detail: emptyVols.slice(0, MAX_LISTED).map(v => v.title || '（未命名卷）').join('、') + ' —— 卷下没有任何章。',
    })
  }

  return { blockers, warnings, ok: blockers.length === 0 }
}
