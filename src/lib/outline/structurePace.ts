/**
 * 全书结构配比对照（2.5.0 · A2）—— **纯本地统计，零 AI**。
 *
 * 与竞品「预测分量」对应：把结构模板的理想节拍占比（`storyStructures`，全书百分比口径）
 * 与**实际已写正文的字数占比**逐拍对照，给出三档观察（贴合 / 轻微偏移 / 明显偏移）。
 *
 * 分工边界（面板文案同步写明，勿混淆）：
 *   - 本模块：**全书**卷章结构的字数配比（纯本地）；
 *   - `paceAnalysis`（B5）：**单章**内部的节奏与章末钩子（需 AI）。
 *
 * 🔴 归属语义（2.5.0 定稿，别改回字数轴）：章的**归属**看「章数位置轴」——
 *    第 no/M 章的中点 ((no−0.5)/M)×100 落在哪一拍，整章归那一拍（每章恰归一拍）；
 *    该拍的**实际占比**＝归属章的**字数 share** 之和。
 *    为什么不用字数累计轴的中点归属：那是同义反复——章中点在字数轴上的落点区间宽度，
 *    天然就等于这些章的 share 之和，任何写法都量不出偏差；用章序位置归属 + 字数量度，
 *    才能让「5/20 章的建置承载了 67% 字数」这类真实偏差显现出来。
 * 🔴 立场：只给结构观察与建议（percentage 描述），**不给分、不排名、不判定达标**；
 *    配比本身没有标准答案，作者有意压缩/展开某一拍是完全正当的创作选择。
 * 🔴 字数口径：占比是**相对值**（同系数缩放），与 `wordCountMode` 的显示口径无关，
 *    因此这里直接用落库 `wordCount` —— 不要在本模块再引口径开关。
 * 🔴 舍入：share 以 0.1% 为单位、按**最大余数法**分配，Σshare 恒等于 100.0
 *    （逐章独立 round1 会漂移，20 章可漂 0.6pp，面板「各拍合计」会露馅）。
 */

import type { StoryTemplate } from '@/lib/outline/storyStructures'

/** 面板的最小样本门槛（规划：全书 <10 章时显示引导文案而非硬算）——放在面板层判 */
export const PACE_MIN_CHAPTERS = 10

export interface PaceChapterInput {
  id: string
  /** 展示用章名（正文表的 title；无题时调用方给「第 N 章」兜底） */
  title: string
  /** 落库字数（`wordCount`）—— 0 视为「还没有正文」，不参与占比 */
  words: number
}

export interface ChapterShare extends PaceChapterInput {
  /** 排序后的顺序（1 起）—— 归属用的就是它：位置轴中点 = ((no−0.5)/M)×100 */
  no: number
  /** 占全书已写字数的百分比（一位小数；Σ 恒 = 100.0） */
  share: number
  /** 本章在「字数累计轴」上的区间 [from, to)（百分比）—— 仅面板可视化用，归属不依赖它 */
  from: number
  to: number
}

export type PaceLevel = 'ok' | 'slight' | 'notable'

export const PACE_LEVEL_LABEL: Record<PaceLevel, string> = {
  ok: '贴合',
  slight: '轻微偏移',
  notable: '明显偏移',
}

export interface BeatAlignment {
  name: string
  /** 模板理想占比（拍区间宽度，%） */
  idealPct: number
  /** 实际承载占比（归属章的字数 share 之和，%） */
  actualPct: number
  /** actualPct − idealPct（百分点；正＝实际更多） */
  delta: number
  level: PaceLevel
  /** 一句话观察（自洽描述，不含分数与达标判定） */
  note: string
  /** 归属到这一拍的章（按章序） */
  chapters: { no: number; title: string }[]
}

const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * 按落库字数算每章占比与累计区间；words=0 的章不参与（不算 share、不占轴）。
 * 🔴 share 用最大余数法分配（0.1% 单位）：Σshare 恒 = 100.0，每章与真实值偏差 < 0.1pp。
 */
export function buildChapterShares(chs: PaceChapterInput[]): { shares: ChapterShare[]; totalWords: number } {
  const withWords = chs.filter(c => c.words > 0)
  const totalWords = withWords.reduce((s, c) => s + c.words, 0)
  if (withWords.length === 0 || totalWords <= 0) return { shares: [], totalWords: 0 }

  // 以 0.1% 为单位：先向下取整，再把「取整丢掉的单位」按余数从大到小还给各章
  const units = withWords.map(c => (c.words / totalWords) * 1000)
  const floors = units.map(u => Math.floor(u))
  let leftover = 1000 - floors.reduce((s, x) => s + x, 0)
  if (leftover > 0) {
    const byRemainder = units
      .map((u, i) => ({ i, rem: u - Math.floor(u) }))
      .sort((a, b) => b.rem - a.rem)
    for (const { i } of byRemainder) {
      if (leftover <= 0) break
      floors[i] += 1
      leftover -= 1
    }
  }

  let acc = 0
  const shares = withWords.map((c, i) => {
    const share = floors[i] / 10
    const row: ChapterShare = { ...c, no: i + 1, share, from: acc, to: acc + share }
    acc += share
    return row
  })
  return { shares, totalWords }
}

/**
 * 逐拍对照。`shares` 必须来自 `buildChapterShares`（no 连续 1..M、有序）。
 * 🔴 归属＝**章数位置轴**：第 no/M 章的中点 ((no−0.5)/M)×100 落在哪一拍，整章归那一拍
 *    （位置轴覆盖 [0,100) 与拍区间无缝 ⇒ 每章恰归一拍）；实际占比＝归属章 share 之和。
 */
export function alignBeats(tpl: StoryTemplate, shares: ChapterShare[]): BeatAlignment[] {
  const n = shares.length
  return tpl.beats.map(b => {
    const idealPct = b.to - b.from
    const cover = n > 0
      ? shares.filter(s => {
          const pos = ((s.no - 0.5) / n) * 100
          return pos >= b.from && pos < b.to
        })
      : []
    const actualPct = round1(cover.reduce((s, c) => s + c.share, 0))
    const delta = round1(actualPct - idealPct)
    const abs = Math.abs(delta)
    const level: PaceLevel = abs <= 5 ? 'ok' : abs <= 15 ? 'slight' : 'notable'
    const note = level === 'ok'
      ? `实际承载约 ${actualPct}% 字数，与理想 ${idealPct}% 基本贴合`
      : delta < 0
        ? `实际承载约 ${actualPct}% 字数，比理想 ${idealPct}% 少 ${abs} 个百分点 —— 常见于这一拍的事件被压缩，或实质内容写进了相邻拍`
        : `实际承载约 ${actualPct}% 字数，比理想 ${idealPct}% 多 ${abs} 个百分点 —— 常见于这一拍的事件被展开得比预期更重`
    return {
      name: b.name,
      idealPct,
      actualPct,
      delta,
      level,
      note,
      chapters: cover.map(c => ({ no: c.no, title: c.title })),
    }
  })
}

// ============ 爽点分布逐拍归属（R4b · 2.6.0，竞品调研建议 2 的收尾） ============

/** 爽点行输入（`hookpoints` 爽点节奏表一行的最小信息） */
export interface HookRowInput {
  /** 作者手填「章节号」里解析出的数字（解析失败的行由组件层过滤，不进这里） */
  no: number
  /** 爽点类型（该表「爽点类型」列的原文，如「打脸」「升级」） */
  kind: string
}

export interface HookBeatStat {
  name: string
  /** 归属到这一拍的爽点行数 */
  count: number
  /** 该拍出现过的爽点类型（保序去重） */
  kinds: string[]
  /** 该拍爽点行数占全部爽点行的百分比（一位小数；无行时 0） */
  pct: number
}

/**
 * 爽点分布逐拍归属 —— 纯本地，零 AI。
 *
 * 🔴 与 `alignBeats` 同一**章数位置轴**归属语义（章中点落哪拍归哪拍），但**全书尺度独立**：
 *    M = max(已写章数, 爽点表最大章号)。爽点常在写细纲时就排好（表描述原话），
 *    排到的章号往往领先已写正文 —— 只按已写章数折算会把未写章的爽点全部溢出 >100% 丢掉。
 * 🔴 度量口径是**爽点行数占比**，不是字数 —— 爽点是离散事件，按字数摊没有意义；
 *    与上方两条字数带的刻度差异由面板文案写明（爽点带含「排了还没写」的章）。
 * 🔴 立场同本模块总则：只给分布观察，不给分、不判定「爽点够不够」——间隔预警是爽点节奏表自己的职责。
 */
export function alignHooks(tpl: StoryTemplate, hooks: HookRowInput[], writtenCount: number): HookBeatStat[] {
  const maxHookNo = hooks.reduce((s, h) => Math.max(s, h.no), 0)
  const m = Math.max(writtenCount, maxHookNo, 1)
  const buckets = tpl.beats.map(b => ({ name: b.name, from: b.from, to: b.to, rows: [] as HookRowInput[] }))
  for (const h of hooks) {
    const pos = ((h.no - 0.5) / m) * 100
    const beat = buckets.find(b => pos >= b.from && pos < b.to) ?? buckets[buckets.length - 1]
    beat.rows.push(h)
  }
  const total = hooks.length
  return buckets.map(b => ({
    name: b.name,
    count: b.rows.length,
    kinds: [...new Set(b.rows.map(r => r.kind).filter(Boolean))],
    pct: total > 0 ? round1((b.rows.length / total) * 100) : 0,
  }))
}
