// ============ 分平台投稿预检（C4 · 2.4.2） ============
//
// 两件事：
//   ① 按平台档位扫敏感词（类别 + 是否重点关注）；
//   ② 算分章事实（字数 / 段数 / 最长段），给出**观察句**。
//
// 🔴 立场（与 B2 / B5 同）：只摆事实与观察，**不评分、不排名、不判定达标**。
//    分章区间是「参考输入」，落在外面只说明"与常见投稿习惯不同"，不代表有问题。
//    ⚠️ tests/platformCheck.test.ts 有立场断言：产物文案里不许出现禁词（含注释也不行）。
import type { Chapter } from './types'
import { BUILTIN_WORDS } from './sensitiveWords'
import { platformRuleOf, isFocused, type PlatformHit, type PlatformId } from './platformRules'
import { splitParagraphs } from './manuscriptCheck'
import { countWords } from './textStats'
import { contextSnippet } from './contextSnippet'

export interface ChapterFact {
  chapterId: string
  title: string
  words: number
  paragraphs: number
  /** 最长段的字数 */
  longestParagraph: number
  /** 相对建议区间：'long' 超上限 / 'short' 低于下限 / null 在区间内 */
  rangeFlag: 'long' | 'short' | null
}

/** 纯函数：逐章算事实（字数口径与看板/编辑器共用 `countWords`） */
export function chapterFacts(chapters: Chapter[], range: [number, number]): ChapterFact[] {
  const [lo, hi] = range
  return chapters.map(c => {
    const content = c.content || ''
    const paras = splitParagraphs(content)
    const lens = paras.map(p => countWords(p))
    const words = countWords(content)
    return {
      chapterId: c.id,
      title: c.title || '（未命名）',
      words,
      paragraphs: paras.length,
      longestParagraph: lens.length > 0 ? Math.max(...lens) : 0,
      rangeFlag: words > hi ? 'long' : words < lo ? 'short' : null,
    }
  })
}

/**
 * 按平台档位扫词。与 `scanText` 的差别：带上**类别**与「是否该平台重点关注」。
 * 自定义词一律归入「自定义」并视为重点关注 —— 作者自己加的词，本来就是他最在意的。
 */
export function scanByPlatform(text: string, platform: PlatformId, customWords: string[] = []): PlatformHit[] {
  const rule = platformRuleOf(platform)
  const hits: PlatformHit[] = []

  for (const [category, words] of Object.entries(BUILTIN_WORDS)) {
    for (const word of words) {
      if (!word) continue
      let count = 0
      let firstIdx = -1
      let idx = text.indexOf(word)
      while (idx !== -1) {
        if (count === 0) firstIdx = idx
        count++
        idx = text.indexOf(word, idx + word.length)
      }
      if (count === 0) continue
      hits.push({
        word, count, category,
        focused: isFocused(rule, category),
        context: contextSnippet(text, firstIdx, word.length),
      })
    }
  }

  for (const w of customWords) {
    const word = w.trim()
    if (!word) continue
    let count = 0
    let firstIdx = -1
    let idx = text.indexOf(word)
    while (idx !== -1) {
      if (count === 0) firstIdx = idx
      count++
      idx = text.indexOf(word, idx + word.length)
    }
    if (count === 0) continue
    hits.push({
      word, count, category: '自定义',
      focused: true,
      context: contextSnippet(text, firstIdx, word.length),
    })
  }

  // 重点关注在前，其次按出现次数降序
  return hits.sort((a, b) => (Number(b.focused) - Number(a.focused)) || (b.count - a.count))
}

export interface PlatformCheckReport {
  platform: PlatformId
  platformName: string
  /** 全书（或所选范围）的命中，按「关注度 + 次数」排序 */
  hits: PlatformHit[]
  facts: ChapterFact[]
  observations: string[]
}

/** 跑一次分平台预检（纯计算；章内容由调用方给，不读库便于单测） */
export function precheckBook(chapters: Chapter[], platform: PlatformId, customWords: string[] = []): PlatformCheckReport {
  const rule = platformRuleOf(platform)
  const facts = chapterFacts(chapters, rule.suggestWordRange)

  const all = chapters.map(c => c.content || '').join('\n')
  const hits = scanByPlatform(all, platform, customWords)

  const observations: string[] = []
  const focusedHits = hits.filter(h => h.focused)
  if (hits.length === 0) {
    observations.push(`全书未检出内置词库与自定义词命中（${rule.name}档）。`)
  } else {
    observations.push(`共检出 ${hits.length} 词、${hits.reduce((s, h) => s + h.count, 0)} 处命中，其中属于「${rule.name}重点关注类别」的 ${focusedHits.length} 词。`)
  }

  const outside = facts.filter(f => f.rangeFlag !== null)
  const longs = outside.filter(f => f.rangeFlag === 'long')
  const shorts = outside.filter(f => f.rangeFlag === 'short')
  if (facts.length > 0) {
    observations.push(
      `${facts.length} 章中，${outside.length} 章字数在你设的参考区间（${rule.suggestWordRange[0]}–${rule.suggestWordRange[1]} 字）之外`
      + `（${longs.length} 章偏长、${shorts.length} 章偏短）。区间是参考输入，落在外面只说明与常见投稿习惯不同，不代表有问题。`,
    )
  }

  const worst = [...facts].sort((a, b) => b.longestParagraph - a.longestParagraph)[0]
  if (worst && worst.longestParagraph >= 500) {
    observations.push(`最长的一段在「${worst.title}」，约 ${worst.longestParagraph} 字 —— 手机上会是一大屏，是否拆段由你定。`)
  }

  return { platform: rule.id, platformName: rule.name, hits, facts, observations }
}
