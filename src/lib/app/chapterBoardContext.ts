/**
 * 章节规划板 · **可验证的资料关联**（3.4.0 · A.3）
 *
 * 规划 §三.A.3：「利用已有资料关联展示可验证的细纲或资料入口；关联缺失时显示未绑定，
 * **不根据名称猜测关系**。人物、伏笔等信息只有现有数据可可靠关联时才展示，否则保留为后续调研项。」
 *
 * 【唯一事实来源】章节 ↔ 细纲卡的绑定与固定资料，都记在项目设置的
 * `chapterContext32:<章节 id>`（正文「本章资料」抽屉写的那条）。这里只读它，不新增任何映射，
 * 也不拿"章节名 ≈ 细纲名"去猜 —— 同名章节、重复章号正是猜错的典型场景。
 *
 * 【三态而不是两态】`outlineId` 指向的细纲卡可能已被删除 —— 那是「关联已失效」而不是「未绑定」。
 * 把失效说成未绑定，作者会以为自己的绑定丢了；说成已绑定，又会点进一张不存在的卡。
 *
 * 纯函数 + 一次批量读（`db.getSettingsByPrefix`），不逐章打库（300 章 = 300 次 get 会拖慢面板）。
 */
import type { Chapter } from '@/lib/types'

/** 规划板卡片上要做展示的最小信息（由 setting 原文提炼，不携带正文） */
export interface ChapterContextBrief {
  outlineId: string | null
  /** 已固定资料条数（只数结构完整的引用） */
  pinnedCount: number
}

export const EMPTY_CONTEXT_BRIEF: ChapterContextBrief = { outlineId: null, pinnedCount: 0 }

/**
 * 从 `chapterContext32:<id>` 的原始值里提炼展示信息。
 *
 * 🔴 任何畸形输入（旧版本、手工改坏、null）一律降级为「未绑定 0 条」而不是抛错：
 *    规划板是只读概览，不能因为一条脏设置整页打不开。
 */
export function chapterContextBrief(value: unknown): ChapterContextBrief {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_CONTEXT_BRIEF
  const rec = value as Record<string, unknown>
  const outlineId = typeof rec.outlineId === 'string' && rec.outlineId.trim() ? rec.outlineId : null
  const pinned = Array.isArray(rec.pinnedRefs) ? rec.pinnedRefs : []
  const pinnedCount = pinned.filter(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const ref = item as Record<string, unknown>
    return typeof ref.id === 'string' && typeof ref.tabId === 'string'
  }).length
  return { outlineId, pinnedCount }
}

/**
 * 只保留**仍存在的章节**的绑定。
 *
 * 删章后 `chapterContext32:<旧章>` 会留在设置里（本项目不做级联删除，避免误删同 id 的新章），
 * 直接全量塞进面板就是一份只增不减的垃圾；按现有章节过滤后，面板内存与设置条数无关。
 */
export function buildChapterContextIndex(
  chapters: readonly Pick<Chapter, 'id'>[],
  raw: ReadonlyMap<string, unknown>,
): Record<string, ChapterContextBrief> {
  const out: Record<string, ChapterContextBrief> = {}
  for (const chapter of chapters) {
    if (!raw.has(chapter.id)) continue
    const brief = chapterContextBrief(raw.get(chapter.id))
    if (brief.outlineId || brief.pinnedCount > 0) out[chapter.id] = brief
  }
  return out
}

export type ChapterContextKind = 'unbound' | 'bound' | 'stale'

export interface ChapterContextLine {
  kind: ChapterContextKind
  /** 卡片上直接显示的一句话（事实陈述，不含质量判断） */
  text: string
  /** 悬停说明：固定资料条数、失效原因都放在这里，避免卡片挤成三行 */
  title: string
}

/**
 * 卡片上的关联说明。
 *
 * @param brief        该章的绑定（没有就是未绑定）
 * @param outlineNames 当前项目里仍存在的细纲卡 id → 名称
 */
export function describeChapterContext(
  brief: ChapterContextBrief | undefined,
  outlineNames: ReadonlyMap<string, string>,
): ChapterContextLine {
  const pinned = brief?.pinnedCount ?? 0
  const pinnedText = pinned > 0 ? ` · 固定资料 ${pinned} 条` : ''
  const pinnedTitle = pinned > 0 ? `已固定 ${pinned} 条资料；在正文「本章资料」里查看或取消。` : ''

  if (!brief || !brief.outlineId) {
    return {
      kind: 'unbound',
      text: `未绑定细纲${pinnedText}`,
      title: `本章还没有绑定细纲卡。${pinnedTitle}在正文「本章资料 → 细纲」里绑定后，这里会显示卡名。`,
    }
  }
  const name = outlineNames.get(brief.outlineId)
  if (!name) {
    return {
      kind: 'stale',
      text: `绑定的细纲卡已失效${pinnedText}`,
      title: `原先绑定的细纲卡已不在项目中（可能已删除）。${pinnedTitle}请在正文「本章资料」里重新选择。`,
    }
  }
  return {
    kind: 'bound',
    text: `细纲：${name}${pinnedText}`,
    title: `来源：正文「本章资料」记录的绑定。${pinnedTitle}`,
  }
}
