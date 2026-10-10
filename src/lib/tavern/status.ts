/**
 * 酒馆模式 · 状态一览（批次 8；调研稿 **C2 第一步：只读可视化**）
 *
 * C2 的原始口径：
 *   「第一步只做只读可视化 —— 把六栏记忆里的「关系状态」「关键事实」渲染成面板
 *     （含关系温度、时间线），**不动数据模型**。第二步再考虑「变量 + AI 输出增量」。」
 *
 * 所以本文件**只做提取与计数**：不引入任何新字段、不写库、不让 AI 输出增量。
 *
 * 【关于「关系温度」】
 * 第二步才可能有数值变量。这一步的温度**就是「关系状态」那一栏本身** ——
 * 它是模型每次重写的一句话（`revise`/`summarize` 的定称口径），比任何自造分数都准，
 * 而且作者能直接和记忆对照。自造一个 0–100 的分数只会让人问「这 73 分是怎么算的」。
 *
 * 【关于「时间线」】
 * 六栏里的「纪念日与待办」「最近日记」就是时间线的轻量表达（都有条数上限、都在滚动更新），
 * 所以这里把它们做成计数，而不是另建一套时间轴数据结构。
 */
import { MEMORY_SECTIONS, isPlaceholder, type MemorySectionKey } from '@/lib/tavern/memory'
import {
  isMuted, talkBandOf, talkativityOf,
  type CastDirection, type FreeMemory,
} from '@/lib/tavern/types'

export type MemoryCounts = Record<MemorySectionKey, number>

/**
 * 相对时间文案。**唯一实现** —— 原先只有 TavernFree 里一份局部 copy，
 * 状态栏也要用；两处各写一份必然在某个边界（比如「1 天前」还是显示日期）上分叉。
 */
export function agoText(ts: number, now = Date.now(), emptyText = '还没有记忆'): string {
  if (!ts) return emptyText
  const d = now - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 列表符号与序号前缀（数条目时先剥掉，否则「- 甲」和「甲」会被算成不同写法） */
const LIST_PREFIX = /^\s*(?:[-*•·>]|\d+[.、)]|[（(]\d+[）)])\s*/

function entryLines(text: string): string[] {
  return String(text ?? '')
    .split('\n')
    .map(l => l.replace(LIST_PREFIX, '').trim())
    // 🔴 跳过占位行（「暂无」/「-」/「（还没有发生过任何事）」）—— 否则状态栏会显示
    //    「未爆的雷 1」「纪念日与待办 1」，作者以为真有内容（审计 P0-2 的连带面）。
    .filter(l => l && !isPlaceholder(l))
}

/** 数条目：非空行数。长期摘要那种成段文字通常算 1 条，符合直觉 */
export function countEntries(text: string): number {
  return entryLines(text).length
}

/** 取前 n 条拼成一行摘要（超出截断加省略号）—— 状态栏那种一行位置用 */
export function firstEntries(text: string, n = 2, max = 60): string {
  const items = entryLines(text).slice(0, n)
  if (items.length === 0) return ''
  const joined = items.join('；')
  return joined.length > max ? `${joined.slice(0, max)}…` : joined
}

/** 六栏各自的条目数 */
export function memoryCounts(m: FreeMemory | null | undefined): MemoryCounts {
  const out = {} as MemoryCounts
  for (const s of MEMORY_SECTIONS) out[s.key] = countEntries(m?.[s.key] ?? '')
  return out
}

/** 一整份记忆的条目总数（判断「这份记忆是不是空的」） */
export function memoryEntryTotal(m: FreeMemory | null | undefined): number {
  return MEMORY_SECTIONS.reduce((n, s) => n + countEntries(m?.[s.key] ?? ''), 0)
}

// ==================== 状态一览 ====================

export type CharStatusRow = {
  charId: string
  name: string
  avatar?: string
  /** 用户扮演的角色（不是 AI 的位子） */
  isUser?: boolean
  /** 在场但不发言 */
  muted?: boolean
  /** 非默认健谈度的档位名；均衡时为空（不占位置，也没必要说） */
  talkBand?: string
  /** 关系状态摘要（一行为一段） */
  relation: string
  /** 关系状态原文 —— 悬停时给全的，避免摘要截断后作者没处看 */
  relationFull: string
  facts: number
  mines: number
  anniversaries: number
  /** 六栏全空 —— 界面据此给一句解释，而不是显示一片空白 */
  empty: boolean
}

export type StatusModel = {
  rows: CharStatusRow[]
  facts: number
  mines: number
  anniversaries: number
  /** 最新一份记忆的更新时间（0 = 从未整理过） */
  memoryUpdatedAt: number
}

/**
 * 组装只读状态模型。
 * ⚠️ 不读库 —— 记忆与在场角色由调用方**已经加载好**的传进来（自由对话页本来就为所有参演角色读了记忆）。
 * 这里再读一次会造成两处数据源。
 */
export function buildStatusModel(a: {
  chars: { id: string; name: string; avatar?: string }[]
  /** 在场调度（静音 / 健谈度） */
  direction?: CastDirection | null
  userCharId?: string
  memories?: Record<string, FreeMemory | null | undefined>
}): StatusModel {
  const rows: CharStatusRow[] = (a.chars ?? []).map(c => {
    const m = a.memories?.[c.id] ?? null
    const counts = memoryCounts(m)
    const band = talkBandOf(talkativityOf(a.direction, c.id))
    return {
      charId: c.id,
      name: c.name || '（未命名）',
      avatar: c.avatar,
      isUser: a.userCharId === c.id || undefined,
      muted: isMuted(a.direction, c.id) || undefined,
      talkBand: band.name !== '均衡' ? band.name : undefined,
      relation: firstEntries(m?.relation ?? '', 2, 60),
      relationFull: String(m?.relation ?? '').trim(),
      facts: counts.facts,
      mines: counts.mines,
      anniversaries: counts.anniversaries,
      empty: memoryEntryTotal(m) === 0,
    }
  })

  return {
    rows,
    facts: rows.reduce((n, r) => n + r.facts, 0),
    mines: rows.reduce((n, r) => n + r.mines, 0),
    anniversaries: rows.reduce((n, r) => n + r.anniversaries, 0),
    memoryUpdatedAt: rows.reduce((n, r) => Math.max(n, a.memories?.[r.charId]?.updatedAt ?? 0), 0),
  }
}
