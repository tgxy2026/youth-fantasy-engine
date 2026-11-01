/**
 * 3.3.3 · B4：灵感素材（ideas）的**重复提示**与**转目标条目**（纯规划层）。
 *
 * 【重复提示】只做提示，不拦输入、不自动合并、不自动改状态 —— 作者写素材时经常故意留近似版本，
 * 软件替他删才是灾难。判据 = 文本归一后逐字相同，或字符二元组相似度 ≥ 0.8 且长度足够。
 *
 * 【转目标条目】作者选一个目标表（伏笔追踪 / 主线支线 / 爽点节奏），确认后才建**一行**：
 *   · 目标行「备注」写 `来源：IDEA0003`，来源行「备注」追加 `→ 已转 F0007（伏笔追踪）`、状态改「已用」；
 *   · 同一个来源重复点同一个目标：目标表里已有 `来源：IDEA0003` 的行 ⇒ 直接回报"已转过"，**不再建**；
 *   · 目标缺失 / 取消 / 建行失败：来源行一个字段都不改（失败保留来源）；
 *   · 预览列出"会写进目标哪几列、哪些列留空"，不预览就不落库。
 */
import { nextAutoCode } from '@/lib/ai/autoCode'
import type { TableRow } from '@/lib/types'

// ── 重复提示 ─────────────────────────────────────────────────────
export const IDEA_DUP_THRESHOLD = 0.8
/** 太短的文本（"雪"、"剑"）谈相似度没有意义，只做逐字相同判定 */
const MIN_SIMILAR_CHARS = 6

/** 归一：去首尾与连续空白、去标点/空白，全半角不统一（中文素材里两者常混用，不该因此判为不同） */
export function normalizeIdeaText(s: string): string {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[，。、；：！？…—·“”‘’《》〈〉【】（）()"'.,;:!?\-]/g, '')
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>()
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

/** 字符二元组 Dice 系数（0~1）。比编辑距离稳：中文素材改几个字仍能认出来 */
export function ideaSimilarity(a: string, b: string): number {
  const x = normalizeIdeaText(a), y = normalizeIdeaText(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.length < MIN_SIMILAR_CHARS || y.length < MIN_SIMILAR_CHARS) return 0
  const ga = bigrams(x), gb = bigrams(y)
  let overlap = 0
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0)
  return (2 * overlap) / (x.length - 1 + y.length - 1)
}

export interface IdeaRowLite {
  id: string
  /** 编号（IDEA0003）；空表示还没编号 */
  code: string
  text: string
}

export interface IdeaDupHint {
  /** 与哪几行重复；同组内所有行都指向彼此，方便两边都提示 */
  peers: string[]
  /** 逐字相同 */
  exact: boolean
}

/**
 * 逐行求重复提示。只跟**同表其它行**比，不跨表（同一个点子出现在伏笔里是正常引用）。
 * O(n²)：灵感库上限是人工素材，几百行以内无感；超过 2000 行时调用方应只对本次编辑行算。
 */
export function findIdeaDuplicates(items: readonly IdeaRowLite[]): Map<string, IdeaDupHint> {
  const out = new Map<string, IdeaDupHint>()
  const valid = items.filter(i => normalizeIdeaText(i.text).length > 0)
  const indexOf = new Map(items.map((r, i) => [r.id, i]))
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i], b = valid[j]
      const score = ideaSimilarity(a.text, b.text)
      if (score < IDEA_DUP_THRESHOLD) continue
      const exact = score === 1
      const labelOf = (r: IdeaRowLite) => r.code || `第 ${(indexOf.get(r.id) ?? 0) + 1} 行`
      const ha = out.get(a.id) ?? { peers: [], exact: true }
      const hb = out.get(b.id) ?? { peers: [], exact: true }
      ha.peers.push(labelOf(b)); hb.peers.push(labelOf(a))
      ha.exact = ha.exact && exact; hb.exact = hb.exact && exact
      out.set(a.id, ha); out.set(b.id, hb)
    }
  }
  return out
}

// ── 转目标条目 ──────────────────────────────────────────────────
export interface IdeaTargetDef {
  tabId: string
  label: string
  /** 目标表里承接素材正文的列 */
  field: string
  /** 建行时一并写死的列（状态类默认值）；留空则不写 */
  defaults: Record<string, string>
  /** 预览时提示"这一列会留空"的关键列（不阻断） */
  important: string[]
}

export const IDEA_TARGETS: readonly IdeaTargetDef[] = [
  {
    tabId: 'foreshadow', label: '伏笔追踪', field: '伏笔内容',
    defaults: { 状态: '未回收', 重要度: '小伏笔' },
    important: ['埋设位置', '计划回收位置', '回收前置条件'],
  },
  {
    tabId: 'subplots', label: '支线剧情', field: '支线目标',
    defaults: { 类别: '其他', 状态: '规划中' },
    important: ['支线名称', '起点', '与主线汇合点'],
  },
  {
    tabId: 'hookpoints', label: '爽点节奏', field: '爽点内容',
    defaults: { 状态: '已排' },
    important: ['章节号', '爽点类型', '章末钩子'],
  },
]

export function ideaTargetOf(tabId: string): IdeaTargetDef | undefined {
  return IDEA_TARGETS.find(t => t.tabId === tabId)
}

/** 目标行备注里的来源标记（同时是"是否已转过"的判据，不依赖额外索引) */
export function ideaSourceRef(code: string): string {
  return `来源：${code.trim() || '（未编号灵感）'}`
}

export interface IdeaPreviewRow {
  column: string
  value: string
}

export interface IdeaConversionPlan {
  ok: boolean
  reason: string
  fields: Record<string, string>
  preview: IdeaPreviewRow[]
  /** 目标表的重要列里会被留空的（只提示，不阻断） */
  emptyImportant: string[]
  /** 同一目标表已有本灵感的行（重复点击）→ 不建行，只回报 */
  reused?: { id: string; code: string }
}

/**
 * 规划一次转换（纯函数）：
 * @param targetRows 目标表现有行（用于编号补缺 + 判"已转过"）
 * @param columns    目标表列名（用于区分"本表没有这一列"）
 */
export function planIdeaConversion(input: {
  source: IdeaRowLite
  target: IdeaTargetDef
  targetRows: readonly TableRow[]
  columns: readonly string[]
}): IdeaConversionPlan {
  const { source, target, targetRows, columns } = input
  const text = String(source.text ?? '').trim()
  if (!text) {
    return { ok: false, reason: '这条灵感没有内容，不能转换', fields: {}, preview: [], emptyImportant: [] }
  }
  if (!columns.includes(target.field)) {
    return { ok: false, reason: `目标表没有「${target.field}」这一列，无法转换`, fields: {}, preview: [], emptyImportant: [] }
  }
  const ref = ideaSourceRef(source.code)
  const existed = targetRows.find(r => String(r.data['备注'] ?? '').includes(ref))
  if (existed) {
    return {
      ok: true, reason: '', fields: {}, preview: [], emptyImportant: [],
      reused: { id: existed.id, code: String(existed.data['编号'] ?? '') },
    }
  }
  const fields: Record<string, string> = {}
  if (columns.includes('编号')) fields['编号'] = nextAutoCode(target.tabId, [...targetRows])
  fields[target.field] = text
  for (const [k, v] of Object.entries(target.defaults)) if (columns.includes(k)) fields[k] = v
  if (columns.includes('备注')) fields['备注'] = ref
  const preview = Object.entries(fields).map(([column, value]) => ({ column, value }))
  const emptyImportant = target.important
    .filter(c => columns.includes(c) && !fields[c])
  return { ok: true, reason: '', fields, preview, emptyImportant }
}

/** 来源行要写的归属：状态=已用、备注追加转换去向；已含同一去向时不重复追加 */
export function planIdeaSourcePatch(
  data: Record<string, string>,
  columns: readonly string[],
  target: { label: string; code: string },
): Record<string, string> {
  const patch: Record<string, string> = {}
  const mark = `→ 已转 ${target.code || '（未编号）'}（${target.label}）`
  if (columns.includes('状态')) patch['状态'] = '已用'
  if (columns.includes('备注')) {
    const old = String(data['备注'] ?? '').trim()
    patch['备注'] = old.includes(mark) ? old : (old ? `${old}\n${mark}` : mark)
  }
  return patch
}

/** 排序号：接在目标表末尾，避免 0 与既有行打架 */
export function ideaTargetOrder(rows: readonly TableRow[]): number {
  let max = 0
  for (const r of rows) max = Math.max(max, Number(r.order) || 0)
  return max + 1
}