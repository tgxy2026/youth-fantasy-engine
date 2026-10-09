/**
 * 颉文姬 · 「续写」素材挑选（2.9.2 · ③）——**零依赖纯函数**。
 *
 * 为什么单独一层：挑选逻辑（含边界：焦点章在首/末、摘要缺失、超预算）必须能被单测钉住，
 * 而它真正跑起来要读库。照项目惯例（`rewriteAsk` / `modelFilter` 同一套路），
 * 把纯逻辑与 db 取数拆开 —— `lib/aiContext.ts` 的 `getContinuationSources()` 读库后调这里。
 *
 * 🔴 调用方必须传**真实叙事序**的章列表（`chapterSeq.flattenChapters`）：
 *    "上一章 / 前 N 章"全按数组位置算，传了卷内 order 排列就会张冠李戴。
 */

/** 挑选输入的一章（只取必要字段，便于调用方从 Chapter 里摘） */
export interface ChapLike {
  id: string
  title: string
  /** 章节压缩摘要（可为空 —— 作者不一定填） */
  summary: string
  /** 正文（可为空 —— 空章还没写） */
  content: string
}

export interface ContinuationPickOpts {
  /** 章节摘要取几章（**含本章**），默认 3；0 = 不取 */
  summaryCount?: number
  /** 前几章正文取几章，默认 1；0 = 不取（最吃预算的一项） */
  prevTextCount?: number
  /** 「上一章结尾」截多少字，默认 1200（与整章改写的衔接口径一致） */
  tailChars?: number
  /** 前 N 章正文的合计字符上限，默认 6000 */
  prevTextCap?: number
}

export interface ContinuationPick {
  /** 焦点章是否在传入的叙事序里找到（找不到 ⇒ 下面全空，调用方据此提示） */
  found: boolean
  /** 本章及前若干章的摘要（叙事序：旧 → 新）。**只收有摘要的章** */
  summaries: { title: string; summary: string }[]
  /** 区间内有章但未填摘要的数量（「不静默丢」：UI 要如实说出来） */
  missingSummaries: number
  /** 紧邻前一章的正文末尾（衔接参照）；首章 / 上一章为空时为 '' */
  prevTail: string
  /** 当前章之前若干章的正文（叙事序），受 prevTextCap 约束 */
  prevTexts: { title: string; content: string }[]
  /** 勾了但没能带入的章数（空章，或因字符上限被截） */
  droppedPrevTexts: number
}

const EMPTY: ContinuationPick = {
  found: false, summaries: [], missingSummaries: 0, prevTail: '', prevTexts: [], droppedPrevTexts: 0,
}

/**
 * 取续写素材。
 *
 * 🔴 三个「不静默」口径：
 *    · 摘要缺失 ⇒ `missingSummaries` 计数（UI 提示「另有 N 章未填摘要」）；
 *    · 正文超上限 ⇒ `droppedPrevTexts` 计数（UI 列进"本次未带入"）；
 *    · 焦点章找不到 ⇒ `found: false`（调用方必须提示，而不是当空上下文硬发）。
 */
export function pickContinuationSources(
  flat: ChapLike[],
  focusId: string,
  opts: ContinuationPickOpts = {},
): ContinuationPick {
  const summaryCount = Math.max(0, Math.floor(opts.summaryCount ?? 3))
  const prevTextCount = Math.max(0, Math.floor(opts.prevTextCount ?? 1))
  const tailChars = Math.max(0, Math.floor(opts.tailChars ?? 1200))
  const prevTextCap = Math.max(0, Math.floor(opts.prevTextCap ?? 6000))

  const idx = flat.findIndex(c => c.id === focusId)
  if (idx < 0) return { ...EMPTY }

  // ---------- 1) 本章及前若干章的摘要（含本章） ----------
  const summaries: { title: string; summary: string }[] = []
  let missingSummaries = 0
  if (summaryCount > 0) {
    for (const c of flat.slice(Math.max(0, idx - (summaryCount - 1)), idx + 1)) {
      const sum = (c.summary ?? '').trim()
      if (sum) summaries.push({ title: c.title || '未命名章节', summary: sum })
      else missingSummaries++
    }
  }

  // ---------- 2) 上一章结尾（衔接参照，取尾部） ----------
  // 🔴 取**尾部**：衔接靠的就是末尾那几句（整章改写那边踩过取错成开头的坑）
  const prev = idx > 0 ? flat[idx - 1] : null
  const prevTail = prev && tailChars > 0 ? (prev.content ?? '').trim().slice(-tailChars) : ''

  // ---------- 3) 前 N 章正文（按叙事序，受合计上限约束） ----------
  const prevTexts: { title: string; content: string }[] = []
  let droppedPrevTexts = 0
  if (prevTextCount > 0) {
    let used = 0
    for (const c of flat.slice(Math.max(0, idx - prevTextCount), idx)) {
      const body = (c.content ?? '').trim()
      // 空章 / 剩余额度连半句都放不下（留 200 字余量）⇒ 计入未带入，绝不硬塞半句话。
      // 单章超过剩余额度 ⇒ **截断保留开头**（续写参照的是文风语感，开头几百字就够；
      //   整章丢弃等于作者勾了却什么都没拿到），口径与 `getChapterTexts` 一致并在文末注明。
      const room = prevTextCap - used
      if (!body || room <= 200) {
        droppedPrevTexts++
        continue
      }
      const text = body.length > room ? body.slice(0, room) + '…（本章因长度限制截断）' : body
      prevTexts.push({ title: c.title || '未命名章节', content: text })
      used += text.length
    }
  }

  return { found: true, summaries, missingSummaries, prevTail, prevTexts, droppedPrevTexts }
}
