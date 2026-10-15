/**
 * 资料提及反向导航（3.1 P1）
 *
 * 从角色 / 地点 / 术语等资料项反查其在正文章节里的提及：输入主名称 + 别称列表，
 * 直读章节标题 / 摘要 / 正文做包含匹配，按卷序 + 章序返回每章的命中情况。
 *
 * 设计取舍（2026-10-15 方案评审定稿）：
 * 1. **不建倒排索引、不落库**：SearchEngine 的索引构建要 tokenize 全库（慢），
 *    且索引滞后于最新章节；百万字级 `indexOf` 是原生快速路径，直读天然实时，
 *    打开面板即最新数据。结果不落库 ⇒ 不需要任何刷新机制（两个 Sheet 组件
 *    本来就没有 onChange），也不占 CardRecord / TableRow 字段。
 * 2. **别名复用 schema「别称」字段**（`lib/settings/aliases.ts` 的 readAliases）：
 *    角色卡与表格型设定早有该字段且带填写指引，不新增存储 ⇒ 不动 DB 版本 /
 *    迁移 / SYNC_STORES / 桌面 KEY_PATHS / 备份清单（红线「不做平行数据」）。
 * 3. **误报容忍**（规划书口径）：子串包含匹配允许误报，仅对 ≤2 字符的纯英文
 *    词追加单词边界，避免 `ed` 命中 `edition` 类噪声；中文单字名不设边界
 *    （中文无词边界概念，且单字名误报在容忍度内）。
 * 4. **只读**：本模块不写任何数据，也不做实体合并——「不可在未确认时自动合并
 *    同名实体」是规划书红线，所有产物仅作展示。
 */
import * as db from '@/lib/db'
import type { Chapter, Volume } from '@/lib/types'

export interface MentionHit {
  chapterId: string
  chapterTitle: string
  volumeId: string
  volumeTitle: string
  /** 该章命中总次数（主名称 + 各别称合计） */
  hits: number
  /** 本章命中了哪些称法（主名称或别称），用于结果徽标 */
  matchedTerms: string[]
  /** 首次命中处的上下文摘要 */
  firstSnippet: string
}

/** snippet 截取：命中处前后各取 30 字，换行压平 */
const SNIPPET_PAD = 30

function makeSnippet(text: string, pos: number, termLen: number): string {
  const start = Math.max(0, pos - SNIPPET_PAD)
  const end = Math.min(text.length, pos + termLen + SNIPPET_PAD)
  const body = text.slice(start, end).replace(/\n/g, ' ')
  return (start > 0 ? '…' : '') + body + (end < text.length ? '…' : '')
}

/** ≤2 字符的纯 ASCII 词要求单词边界（大小写不敏感） */
function isShortAscii(term: string): boolean {
  return /^[A-Za-z0-9]{1,2}$/.test(term)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 计数与摘要位置共用同一次有效匹配，避免摘要落在被词边界排除的位置。 */
function matchTerm(lower: string, term: string): { count: number; first: number } {
  if (!term) return { count: 0, first: -1 }
  if (isShortAscii(term)) {
    const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi')
    let n = 0
    let first = -1
    let match: RegExpExecArray | null
    while ((match = re.exec(lower)) !== null) {
      if (first < 0) first = match.index
      n++
    }
    return { count: n, first }
  }
  let n = 0
  let idx = lower.indexOf(term)
  const first = idx
  while (idx >= 0) {
    n++
    idx = lower.indexOf(term, idx + term.length)
  }
  return { count: n, first }
}

/**
 * 反查某资料在正文中的提及。
 *
 * @param name    资料主名称（为空直接返回空数组）
 * @param aliases 别称列表（readAliases 的产出；顿号/逗号分隔已由那边拆好）
 * @returns 每章一条命中记录，按**卷序 + 章序**排列（作者找「哪一章写了」，
 *          章序比命中热度更有意义，故不按 hits 排序）
 */
export async function findMentions(name: string, aliases: string[]): Promise<MentionHit[]> {
  const trimmed = name.trim()
  if (!trimmed) return []
  // 去重 + 去空 + 剔除与主名称相同的项（大小写不敏感）
  const seen = new Set<string>([trimmed.toLowerCase()])
  const terms = [trimmed]
  for (const a of aliases) {
    const t = a.trim()
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    terms.push(t)
  }

  const [chapters, volumes] = await Promise.all([
    db.getAllChapters() as Promise<Chapter[]>,
    db.getAllVolumes() as Promise<Volume[]>,
  ])
  const volOrder = new Map(volumes.map(v => [v.id, v.order]))
  const volTitle = new Map(volumes.map(v => [v.id, v.title]))
  // 章序查找表（排序用；300+ 章全命中时 find 会退化成 O(n²)）
  const chapOrder = new Map(chapters.map(c => [c.id, c.order]))

  const hits: MentionHit[] = []
  for (const c of chapters) {
    const text = `${c.title}\n${c.summary}\n${c.content}`
    const lower = text.toLowerCase()
    let count = 0
    const matched: string[] = []
    let firstPos = -1
    let firstTermLen = 0
    for (const t of terms) {
      const result = matchTerm(lower, t.toLowerCase())
      if (result.count > 0) {
        count += result.count
        matched.push(t)
        if (firstPos < 0 || result.first < firstPos) {
          firstPos = result.first
          firstTermLen = t.length
        }
      }
    }
    if (count === 0) continue
    hits.push({
      chapterId: c.id,
      chapterTitle: c.title || '（未命名章节）',
      volumeId: c.volumeId,
      volumeTitle: volTitle.get(c.volumeId) ?? '未知卷',
      hits: count,
      matchedTerms: matched,
      firstSnippet: firstPos >= 0 ? makeSnippet(text, firstPos, firstTermLen) : '',
    })
  }

  hits.sort((a, b) => {
    const va = volOrder.get(a.volumeId) ?? 0
    const vb = volOrder.get(b.volumeId) ?? 0
    if (va !== vb) return va - vb
    return (chapOrder.get(a.chapterId) ?? 0) - (chapOrder.get(b.chapterId) ?? 0)
  })
  return hits
}
