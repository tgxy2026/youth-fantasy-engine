/**
 * 创作参考（3.6.0 · C 包首期）
 *
 * 依据：规划 §5 / §16 C。
 *
 * 🔴 三件事必须守住（都是"看起来能用、其实在骗人"的坑）：
 *  1. **默认不勾选**：没有选择 ⇒ 一段都不发。不做"自动把成果塞进提示词"这种事 ——
 *     参考卡是别的作品的写法结论，自动注入等于让模型把别人的情节当成本项目设定。
 *  2. **过期不发**：带 `stale` 标记的成果（来源变了/来源不明）不得自动发送；
 *     作者要看可以，但"发出去"必须重新确认。
 *  3. **说清是谁的文字**：注入块必须写明「非本项目原文 + 不要照搬情节/人名 + 不是设定」，
 *     否则模型很容易把参考里的桥段当既定事实接着写。
 *
 * 纯逻辑层：只做筛选、裁剪、拼块，不读库（读取在界面侧用 `loadArtefacts`）。
 */
import type { ArtefactKind, ArtefactStore } from '@/lib/artefacts/types'

/** 可作参考的成果类型：分析卡与参考卡 */
export const REFERENCE_KINDS = ['analysis', 'reference'] as const

export interface ReferenceCard {
  artefactId: string
  kind: 'analysis' | 'reference'
  dimension: string
  title: string
  content: string
  claim: 'observed' | 'inferred'
  evidenceVerified: boolean
  /** 来源标签（章名 / 作品名 / 无来源） */
  sourceLabel: string
  /** 已过期：可看，不可自动发送 */
  stale: boolean
  /** 作者是否已确认（kept）；draft 会在界面上标明"未审" */
  kept: boolean
  /**
   * 作者已明确排除（`state === 'excluded'`，3.6.0 · G 审计修正）。
   * 🔴 排除 ≠ 未审：排除是作者的否定决定，不该还能被勾选发送；未审只是还没看。
   */
  excluded?: boolean
}

export const REFERENCE_LIMITS = {
  /** 最多几张卡（再多会挤掉真正重要的上下文） */
  maxCards: 12,
  /** 注入总字符上限 */
  maxChars: 2400,
  /** 单卡正文上限 */
  maxCardChars: 400,
} as const

const DIM_LABEL: Record<string, string> = {
  scene: '场景与冲突',
  turning: '转折与钩子',
  character: '人物动机与变化',
  pacing: '节奏与叙事',
  'character-arc': '人物弧线',
  'pacing-curve': '节奏曲线',
  'clue-thread': '线索与回收',
}

export function dimensionLabelOf(dim: string): string {
  return DIM_LABEL[dim] ?? dim
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** 哪些成果类型可以当参考（唯一判据；别在别处再写一遍 kind 判断） */
const canBeReference = (kind: ArtefactKind): kind is 'analysis' | 'reference' =>
  (REFERENCE_KINDS as readonly string[]).includes(kind)

/** 成果记录 → 参考卡（坏 payload 跳过，不抛） */
export function referenceCardsOf(store: ArtefactStore): ReferenceCard[] {
  const out: ReferenceCard[] = []
  for (const it of store.items) {
    if (!canBeReference(it.kind)) continue
    const p = (it.payload ?? {}) as Record<string, unknown>
    const title = str(p.title, 60)
    const content = str(p.content, 1200)
    if (!title || !content) continue
    const dim = str(p.dimension, 40)
    const claim = p.claim === 'observed' ? 'observed' : 'inferred'
    out.push({
      artefactId: it.id,
      kind: it.kind,
      dimension: dim,
      title,
      content,
      claim,
      evidenceVerified: p.evidenceVerified === true,
      sourceLabel: str(it.source.chapterTitle, 60) || '（无来源标注）',
      stale: !!it.stale,
      kept: it.state === 'kept',
      ...(it.state === 'excluded' ? { excluded: true } : {}),
    })
  }
  return out
}

export type ReferenceDropReason = 'stale' | 'budget' | 'missing' | 'excluded'

export interface ReferenceBlock {
  /** 实际要拼进提示词的文本（空串 = 一段都不发） */
  text: string
  /** 实际用到的卡（界面据此显示"这次带了哪几张"） */
  usedIds: string[]
  /** 被剔除的卡与原因（界面要显示，不能静默丢） */
  dropped: { id: string; reason: ReferenceDropReason }[]
  chars: number
}

export interface ReferenceBudget {
  maxCards?: number
  maxChars?: number
  maxCardChars?: number
}

/**
 * 生成注入块。
 *
 * @param selectedIds 作者勾选的成果 id，**顺序即发送顺序**；空数组 ⇒ 空块（默认不勾选）
 */
export function buildReferenceBlock(
  cards: readonly ReferenceCard[], selectedIds: readonly string[], budget: ReferenceBudget = {},
): ReferenceBlock {
  const maxCards = Math.max(0, budget.maxCards ?? REFERENCE_LIMITS.maxCards)
  const maxChars = Math.max(0, budget.maxChars ?? REFERENCE_LIMITS.maxChars)
  const maxCardChars = Math.max(80, budget.maxCardChars ?? REFERENCE_LIMITS.maxCardChars)
  const byId = new Map(cards.map(c => [c.artefactId, c]))
  const dropped: ReferenceBlock['dropped'] = []
  const usedIds: string[] = []
  const lines: string[] = []
  let chars = 0

  for (const id of selectedIds) {
    const card = byId.get(id)
    if (!card) { dropped.push({ id, reason: 'missing' }); continue }
    if (card.stale) { dropped.push({ id, reason: 'stale' }); continue }
    // 🔴 作者明确排除的，绝不因为「被勾上了」就发出去
    if (card.excluded) { dropped.push({ id, reason: 'excluded' }); continue }
    if (usedIds.length >= maxCards) { dropped.push({ id, reason: 'budget' }); continue }
    const body = card.content.slice(0, maxCardChars)
    const tags = [dimensionLabelOf(card.dimension || '')]
    if (card.claim === 'observed' && card.evidenceVerified) tags.push('有原文依据')
    else tags.push('推测')
    if (!card.kept) tags.push('未审')
    const line = `${usedIds.length + 1}. [${tags.filter(Boolean).join('｜')}] ${card.title}：${body}（来源：${card.sourceLabel}）`
    if (chars + line.length > maxChars) { dropped.push({ id, reason: 'budget' }); continue }
    lines.push(line)
    usedIds.push(id)
    chars += line.length
  }

  if (!usedIds.length) {
    return { text: '', usedIds: [], dropped, chars: 0 }
  }
  const head = '【创作参考（作者选定，非本项目原文）】'
  const tail = '⚠️ 这些是别的作品里的写法结论，只用来借鉴方法：不要照搬其中的情节、人物名与专有名词，也不要把它们当成本项目已经发生的事实或设定。'
  const text = [head, ...lines, tail].join('\n')
  return { text, usedIds, dropped, chars: text.length }
}

/** 给界面用的摘要（"将发送 6 张 / 约 1200 字，剔除 2 张过期"） */
export function describeReferenceBlock(block: ReferenceBlock): string {
  if (!block.usedIds.length) {
    return block.dropped.length
      ? `本次没有可发送的参考（${block.dropped.length} 张被剔除）`
      : '未选择创作参考（默认不发送）'
  }
  const droppedText = block.dropped.length
    ? `，剔除 ${block.dropped.length} 张（${countReasons(block.dropped)}）`
    : ''
  return `将发送 ${block.usedIds.length} 张参考（约 ${block.chars.toLocaleString()} 字）${droppedText}`
}

function countReasons(dropped: readonly { reason: ReferenceDropReason }[]): string {
  const n = { stale: 0, budget: 0, missing: 0, excluded: 0 }
  for (const d of dropped) n[d.reason]++
  const parts: string[] = []
  if (n.stale) parts.push(`过期 ${n.stale}`)
  if (n.budget) parts.push(`超预算 ${n.budget}`)
  if (n.missing) parts.push(`已不在 ${n.missing}`)
  if (n.excluded) parts.push(`已排除 ${n.excluded}`)
  return parts.join(' / ')
}

/** 过期判据的说明（界面 tooltip 用，避免作者以为"卡片坏了"） */
export const REFERENCE_STALE_HINT = '这张参考的来源已变化或无法核对，不会自动发送；需要的话请重新分析 / 重新保存后再选'

