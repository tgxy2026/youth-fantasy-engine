/**
 * 搜索替换的语料与口径（3.6.1 · 从「全书搜索替换」改成可选范围时抽出）
 *
 * 【为什么单独一支】范围（本章 / 全书）不该由界面各算一遍：
 *   调用方只决定**把哪些章交给它**（本章 = 只传当前章，全书 = 传全部），
 *   命中统计、章名命中标记、替换本身都在这里，界面只负责渲染。
 *
 * 🔴 两个口径必须分清（也是原实现的隐患）：
 *   · 搜索语料 = **正文 + 章名**（章名便于定位）；
 *   · 替换只改**正文** —— 章名不参与替换。
 *   所以「只命中章名」的章 `count === 0`、`titleHit === true`，**不计入**可替换数量；
 *   否则会出现「提示替换 3 处，实际只改了 2 处」。
 *
 * 🔴 替换用 split/join 而不是正则：关键词可能是「（」「.」「*」这类字符，
 *   拼进正则会抛错或者误匹配（作者搜一个括号就炸，等于功能不可用）。
 */
import type { Chapter } from '@/lib/types'
import { contextSnippet } from '@/lib/ai/contextSnippet'

/** 每条命中最多展示几段上下文（多了刷屏，也拖慢大书搜索） */
export const MAX_HIT_CONTEXTS = 5

export interface SearchHit {
  chapter: Chapter
  /** 正文命中处数（= 这条记录里可替换的数量） */
  count: number
  /** 章名是否含关键词：只用于定位与提示，不参与替换 */
  titleHit: boolean
  contexts: string[]
}

/** 在一批章节里搜索关键词（语料 = 正文 + 章名，统计 = 正文） */
export function searchChapters(chapters: readonly Chapter[], keyword: string): SearchHit[] {
  const needle = keyword.trim()
  if (!needle) return []
  const out: SearchHit[] = []
  for (const chapter of chapters) {
    const text = chapter.content || ''
    let index = text.indexOf(needle)
    let count = 0
    const contexts: string[] = []
    while (index !== -1) {
      count++
      if (contexts.length < MAX_HIT_CONTEXTS) contexts.push(contextSnippet(text, index, needle.length))
      index = text.indexOf(needle, index + needle.length)
    }
    const titleHit = (chapter.title || '').includes(needle)
    if (count === 0 && !titleHit) continue
    out.push({ chapter, count, titleHit, contexts })
  }
  return out
}

/** 可替换处数（只算正文命中；只命中章名的章不贡献） */
export function replaceableCount(hits: readonly SearchHit[]): number {
  let total = 0
  for (const hit of hits) total += hit.count
  return total
}

/** 真正会被改写的章（count > 0），替换前据此统计「会动几章」 */
export function replaceTargets(hits: readonly SearchHit[]): SearchHit[] {
  return hits.filter(hit => hit.count > 0)
}

/** 把正文里的关键词全部替换（空替换 = 删除） */
export function replaceAllInContent(content: string, keyword: string, replacement: string): string {
  const needle = keyword.trim()
  if (!needle) return content
  return content.split(needle).join(replacement)
}
