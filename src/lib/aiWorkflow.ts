/**
 * 「创意写作」编排器 —— AI 创作工作流的串联层（方案见 `docs/2.2.0-全自动AI小说创作工作流方案.md`）。
 *
 * **两个阶段，各自可以反复执行**（2026-09-20 长篇分批改造，老大要求）：
 * - **大纲规划**（`target: 'outline'`）：每批产出「N 卷分卷大纲 + N×M 章章节细纲」。
 *   库里没有大纲 → 先跑「设定奠基」把基础设定冷启动出来（闸门①）再排；库里已有 → **接续**往下排。
 * - **正文生成**（`target: 'draft'`；短篇的 `'full'` 也走这里）：按已排好的细纲逐章连写。
 *
 * 🔴 **起点不再由作者手选，改为自动判定**（老大 2026-09-20）：库里没有分卷大纲 / 章节细纲 →
 *    从零（`scratch`）；已有 → 接着写（`continue`）。老大的原话是「项目里没有分卷大纲和章节细纲的
 *    时候，那就默认从第一卷第一章开始生成……已经有了……AI 模型就需要接续」—— 这是**自动**的，
 *    让人每批都去点一次"从一句话创作 / 接着已有内容写"反而多一道无意义的工序。
 *
 * 🔴 **续排起点看「已排到哪」，不看「正文写到哪」**（2026-09-20 改）：长篇是"先把大纲规划完、
 *    再写正文"，此时正文可能一章都没有而细纲已排到第 40 章 —— 按正文算会得到"从第 1 章起"，
 *    再被判"第 1 章已有细纲、无需续排"**直接收工**（旧口径 `writtenNo + 1` 就是这么卡死的）。
 *    现在一律用「已有细纲最大章号 + 1」。
 *
 * 四条设计要点：
 * 1. **不重造**：逐章连写直接用 `runAutoContinue`，它自带"字数校准 + 落库硬闸门 + 逐章人审回调 +
 *    设定补完"。本文件只负责"把阶段串起来 + 在闸门处停下来等人"。
 * 2. **闸门＝await**：`onBibleGate` / `onOutlineGate` 返回 Promise，编排器就停在那里等用户；
 *    这也是为什么它直接建在 `lib/flow` 的状态机上（状态机不需要感知"暂停"这件事）。
 * 3. **人和 AI 的分工**：闸门之前全是 AI 跑量，闸门处必须人定方向 —— 不接受"全自动无人值守"，
 *    那是方案里明确否掉的（AI 生成设定/大纲的质量波动，必须由人在落库前过一眼）。
 * 4. **章号与卷归属由系统算**：章号 ＝ `fromNo + i`；每卷的章号范围 ＝ `fillChapterRanges(...)`。
 *    模型返回的章号一律忽略（它经常从 1 重新数）。
 *
 * 🔴 写库只发生在闸门**通过之后**；用户放弃闸门 = 整条流程中止，不留半成品。
 * 🔴 正文落库发生在每章的「初稿采纳」之后。
 */
import { buildProjectContext } from './aiContext'
import {
  aiGenerateBible, aiPlanOutline,
  MAX_CHAPTERS_PER_VOLUME, MAX_OUTLINE_CHAPTERS, MAX_OUTLINE_VOLUMES,
  type OutlineResult, type OutlineVolume,
} from './aiTasks'
import { sortChapters } from './chapterSeq'
import { nextVolumeOrder } from './freeVolume'
import { getStoryTemplate, formatStructureHint } from './storyStructures'
import { writerBudgetFor } from './aiWriterBudget'
import { runAutoContinue, type ChapterDraft, type ContinueStrategy, type DraftDecision } from './autoContinue'
import * as db from './db'
import { commitDraftRows } from './flow/commit'
import { buildDraftBundle, defaultPicked } from './flow/draft'
import { resolveSlot } from './flow/fieldMap'
import { createFlow, firstUnfinishedStage, type StageCtx } from './flow/pipeline'
import type { CommitOutcome, DraftBundle, DraftRow, FlowProgress, FlowStage } from './flow/types'
import { uid } from './id'
import {
  chapterNoOf, detectVolumeGap, fillChapterRanges, formatChapterRange, isPlaceholderText,
  isVolumeOutlineComplete, outlineCardName, outlineEventKey, parseChapterRange,
  VOLUME_OUTLINE_TAB_ID, volumeBoundTextsOf, volumeRangeKey,
} from './outlineCard'
import type { LedgerItem } from './settingLedger'
import type { Volume } from './types'
import { MAX_CHAPTERS } from './writingPace'

/** 从零创作：设定奠基 → 分卷大纲 → 逐章连写（`target='outline'` 时靠 `skipRest` 停在闸门②之后） */
export const CREATIVE_STAGES: FlowStage[] = [
  { id: 'bible', label: '设定奠基', weight: 3 },
  { id: 'outline', label: '分卷大纲', weight: 2 },
  { id: 'draft', label: '逐章连写', weight: 12 },
]

/**
 * 「接着已有内容写」+「只做大纲规划」的阶段表 —— 只有续排大纲这一步。
 *
 * 为什么不复用 CREATIVE_STAGES 再 `skipRest` 掉其余：`skipRest` 是"跑到一半才发现不用跑"的
 * 表达，而这里**一开始就知道**不用跑 —— 让它们以 `skipped` 出现在时间线上，
 * 作者会以为"这两个阶段被跳过了，是不是出问题了"。阶段表不同，就该用不同的表。
 */
export const CONTINUE_PLAN_STAGES: FlowStage[] = [
  { id: 'outline', label: '续排大纲', weight: 2 },
]

/**
 * 「接着已有内容写」+「只生成正文」的阶段表 —— 只有逐章连写一步。
 *
 * 也用于短篇「大纲 + 正文」在**已有大纲**时的第二次运行（那一档此时退化为"只写正文"）。
 */
export const CONTINUE_DRAFT_STAGES: FlowStage[] = [
  { id: 'draft', label: '逐章连写', weight: 12 },
]

/**
 * 项目现状 —— **起点自动判定**的依据（也给面板状态行用）。
 *
 * 🔴 为什么不再让作者手选起点：库里有没有大纲是**客观事实**。让作者每批点一次
 *    "从一句话创作 / 接着已有内容写"，既多一道工序，又给了他选错的机会
 *    （选错就是重跑设定奠基白花钱，或该接续却从头排）。
 */
export interface CreativeProjectProbe {
  /** 库里有没有大纲（分卷大纲卡或章节细纲卡任一） */
  hasOutline: boolean
  /** 已有分卷大纲卡数（＝已排了几卷） */
  volumeCardCount: number
  /** 已有细纲卡数 */
  outlineCardCount: number
  /** 已有细纲的**最大章号**（没有则 0）—— 续排起点 ＝ 它 + 1 */
  maxOutlineNo: number
  /** 已有正文章数 */
  chapterCount: number
  /** 正文最后一章的标题 */
  lastChapterTitle: string
  /**
   * 已有卷大纲卡的**章号边界候选**（按卡的 order 排好序）—— 缺口检测用。
   *
   * 🔴 面板与编排器共用它 + `maxOutlineNo` + 「每卷章数」去算 `detectVolumeGap`：
   *    两处各算一遍必然漂移（界面说"缺 9 章"、实际排 10 章），所以口径只留一个来源。
   */
  volumeBounds: { name: string; texts: string[] }[]
}

/** 读一眼当前项目的大纲 / 正文现状（面板状态行与起点判定共用同一份口径） */
export async function probeCreativeProject(): Promise<CreativeProjectProbe> {
  const [volCards, chCards, chs, vols] = await Promise.all([
    db.getCardRecords(VOLUME_OUTLINE_TAB_ID).catch(() => []),
    db.getCardRecords('chapter-outline').catch(() => []),
    db.getAllChapters().catch(() => []),
    db.getAllVolumes().catch(() => []),
  ])
  const maxOutlineNo = chCards.reduce((mx, c) => Math.max(mx, chapterNoOf(c.name)), 0)
  const last = sortChapters(vols, chs).slice(-1)[0]
  return {
    hasOutline: volCards.length > 0 || chCards.length > 0,
    volumeCardCount: volCards.length,
    outlineCardCount: chCards.length,
    maxOutlineNo,
    chapterCount: chs.length,
    lastChapterTitle: last?.title ?? '',
    // 按 order 排序：`detectVolumeGap` 是"找到第一个没排满的卷"，卷序错了就会去补错卷
    volumeBounds: [...volCards]
      .sort((a, b) => a.order - b.order)
      .map(c => ({ name: c.name, texts: volumeBoundTextsOf(c) })),
  }
}

/** 读卷大纲卡里的某个语义字段（落点现查 schema；这张表没有该字段时返回空串） */
function volFieldOf(card: { data: Record<string, string> }, fieldName: string): string {
  const key = resolveSlot(VOLUME_OUTLINE_TAB_ID, fieldName)
  return key ? (card.data[key] ?? '') : ''
}

/**
 * 该卷的卷大纲是不是"只有骨架" —— 决定缺口补齐时要不要**顺带把它补全**。
 *
 * 老大 2026-09-20 口径：卷大纲完整就只按它排细纲；不完整就在补细纲的同时把卷大纲补上。
 * ⚠️ 找不到同名卡时返回 `true`（当成需要补）：卡片缺失说明这一卷确实没规划好。
 */
async function volumeOutlineNeedsFill(title: string): Promise<boolean> {
  const cards = await db.getCardRecords(VOLUME_OUTLINE_TAB_ID).catch(() => [])
  const card = cards.find(c => c.name.trim() === title.trim())
  return card ? !isVolumeOutlineComplete(card) : true
}

/**
 * 把一条卷大纲摊成 `语义槽位名 → 值` —— 供 `commitOutline` 按槽位现查真实键后落库。
 *
 * 🔴 刻意**不含「卷名」**（改它等于改卡名，会把卡与卷记录的联系切断）
 *    与「本卷章数预估」（那是作者手写的自由文本，不属于"骨架补齐"的范围）。
 */
function volumeFieldsOf(v: OutlineVolume): Record<string, string> {
  return {
    '本卷一句话定位': v.positioning, '主角境界区间': v.stage, '舞台范围': v.scope,
    '本卷开头（卷首状态）': v.opening, '第一大高潮': v.climax1, '卷中转折': v.turn,
    '卷末高潮': v.climax2, '本卷结尾（卷末状态）': v.ending,
    '事件链（起→承→转→合）': v.events, '支线事件': v.subplots,
  }
}

/** 「已有细纲」里一章的第一行事件（做全书脉络用；取不到由调用方兜底） */
function eventLineOf(text: string): string {
  const line = (text || '').split('\n').find(l => l.startsWith('事件：'))
  return line ? line.slice(3).trim() : ''
}

/**
 * 组装「大纲规划」的资料。
 *
 * 🔴 **接续时必须让模型看见全貌，而不只是尾巴**：排第 3 卷要接住前两卷的卷末钩子、
 *    前 40 章埋下的伏笔。原先只递"最后 6 章细纲"，模型只能顺着最近的语气往下编，
 *    更早的线一律接不上（2026-09-20 修）。现在分三层给：
 *      ① 已有分卷大纲（全部，含章号范围）—— 看卷级走向与卷末钩子；
 *      ② 已有细纲的**全书脉络**（每章一行：章号 + 一句话事件）＋ **尾部 10 章完整字段**
 *         —— 前者回答"故事讲到哪了"，后者回答"接着要模仿的写法与最近状态"；
 *      ③ 正文进度 ＋ 设定资料与全书总纲。
 *
 * @param task 末段的任务陈述（从零 / 接续两种措辞由调用方给）
 */
async function buildPlanMaterial(probe: CreativeProjectProbe, task: string): Promise<string> {
  const parts: string[] = []

  // ① 已有分卷大纲（全部：卷数本来就不多，而"上一卷留了什么钩子"必须看见）
  const volCards = await db.getCardRecords(VOLUME_OUTLINE_TAB_ID).catch(() => [])
  if (volCards.length) {
    const rangeKey = volumeRangeKey()
    const lines = volCards.map((c, i) => {
      const range = rangeKey ? (c.data[rangeKey] ?? '').trim() : ''
      const bits = [
        volFieldOf(c, '本卷一句话定位'),
        volFieldOf(c, '本卷结尾（卷末状态）'),
        volFieldOf(c, '事件链（起→承→转→合）'),
      ].filter(Boolean)
      return `第${i + 1}卷《${c.name}》${range ? `（${range}）` : ''}：${bits.join(' ｜ ')}`
    })
    parts.push(`【已有分卷大纲（${volCards.length} 卷）】\n${lines.join('\n')}`)
  }

  // ② 已有细纲：全书脉络（每章一行）+ 尾部 10 章完整字段
  const outlines = await loadChapterOutlines()
  const nos = [...outlines.keys()].sort((a, b) => a - b)
  const TAIL = 10
  const tailNos = new Set(nos.slice(-TAIL))
  const headNos = nos.filter(n => !tailNos.has(n))
  if (headNos.length) {
    const brief = headNos
      .map(no => `第${no}章：${eventLineOf(outlines.get(no) ?? '') || '（无事件摘要）'}`)
      .join('\n')
    parts.push(`【已有细纲 · 前 ${headNos.length} 章脉络（每章一行，把握全书走向）】\n${brief}`)
  }
  if (tailNos.size) {
    const tail = [...tailNos]
      .sort((a, b) => a - b)
      .map(no => `第${no}章\n${outlines.get(no)}`)
      .join('\n\n')
    parts.push(`【已有细纲 · 最近 ${tailNos.size} 章（完整字段，供接续与模仿写法）】\n${tail}`)
  }

  // ③ 正文进度（只报"写到哪"，不贴正文 —— 正文内容属于正文生成阶段的事）
  parts.push(
    `【正文进度】已写 ${probe.chapterCount} 章` +
    (probe.lastChapterTitle ? `，最新一章是《${probe.lastChapterTitle}》` : '（还没有正文）'),
  )

  // ④ 设定资料与全书总纲
  const digest = await buildProjectContext({ budget: await writerBudgetFor('outline-generate') })
    .then(r => r.text)
    .catch(() => '')
  parts.push(`【设定资料与全书总纲】\n${digest || '（无）'}`)

  // ⑤ 本次任务
  parts.push(`【本次任务】${task}`)
  return parts.join('\n\n')
}

/**
 * 建「章号 → 卷记录 id」的查询 —— 长篇正文按大纲**切卷**用。
 *
 * 🔴 为什么必须查这一层：`createChapterAfter` 默认把新章塞进**锚点所在的卷**，
 *    于是大纲排了卷一（第1-20章）与卷二（第21-40章），写到第 21 章时它仍留在卷一，
 *    卷归属与大纲对不上（2026-09-20 修）。
 *
 * 依据是分卷大纲卡的**「本卷章号范围」**（排纲时由系统写入）。读不到那一列、
 * 或某卷没填范围的老项目，返回的查询对任何章号都答 `undefined` ——
 * 此时静默退回旧行为，**不做任何猜测**（猜错就是整卷正文错位）。
 */
async function buildChapterVolumeIndex(): Promise<(no: number) => string | undefined> {
  const key = volumeRangeKey()
  if (!key) return () => undefined
  const [cards, vols] = await Promise.all([
    db.getCardRecords(VOLUME_OUTLINE_TAB_ID).catch(() => []),
    db.getAllVolumes().catch(() => []),
  ])
  const ranges = cards
    .map(c => {
      const r = parseChapterRange(c.data[key] ?? '')
      // 卡名 ＝ 卷名（`commitOutline` 就是这么写的）→ 按同名去卷记录里找它对应的 id
      const vol = r ? vols.find(v => v.title.trim() === c.name.trim()) : undefined
      return r && vol ? { volId: vol.id, from: r.from, to: r.to } : null
    })
    .filter((x): x is { volId: string; from: number; to: number } => !!x)
    .sort((a, b) => a.from - b.from)
  if (!ranges.length) return () => undefined
  return (no: number) => ranges.find(r => no >= r.from && no <= r.to)?.volId
}

/** 按「语义字段名 → 值」构造卡片数据（落点由 schema 现查，schema 改了字段归属也不会失配） */
function cardDataOf(tabId: string, pairs: [string, string][]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [field, value] of pairs) {
    if (!value) continue
    const key = resolveSlot(tabId, field)
    if (key) out[key] = value
  }
  return out
}

export interface OutlineCommitOutcome {
  volumesCreated: number
  volumeCardsCreated: number
  chapterCardsCreated: number
  /**
   * 回填了「本卷章号范围」的卷数（缺口补齐专用，2026-09-20）。
   *
   * 🔴 只在那一卷原本**没有范围**时才写：正文按大纲切卷的唯一依据就是这一列，
   *    而老数据（如示范项目）的范围只写在「本卷章数预估」的自由文本里 —— 不回填就切不了卷。
   */
  volumeRangesFilled: number
  /**
   * 补全了卷级字段的**处数**（缺口补齐 + 该卷大纲原本只有骨架时）。
   * 🔴 只写「空 / 占位（（待写）之类）」的字段 —— 作者已写实的内容一个字不动。
   */
  volumeFieldsFilled: number
  failed: string[]
}

/**
 * 大纲落库：建卷（同名不重建）+ 分卷大纲卡（一卡一卷）+ 章节细纲卡（一卡一章）。
 * 全是"新增"，**不覆盖已有**（同名则跳过，由作者自己决定要不要改）。
 */
export async function commitOutline(
  result: OutlineResult,
  opts: {
    signal?: AbortSignal
    /**
     * 回填 / 补全卷大纲卡（缺口补齐用，2026-09-20）—— **只写空或占位字段**。
     * 卷名必须与已有卡**完全一致**，找不到同名卡就跳过（绝不新建）。
     */
    volumeFills?: { title: string; range?: string; fields?: Record<string, string> }[]
  } = {},
): Promise<OutlineCommitOutcome> {
  const out: OutlineCommitOutcome = {
    volumesCreated: 0, volumeCardsCreated: 0, chapterCardsCreated: 0,
    volumeRangesFilled: 0, volumeFieldsFilled: 0, failed: [],
  }
  const pid = db.getCurrentProjectId()

  // ① 建卷
  const existingVols = await db.getAllVolumes().catch(() => [] as Volume[])
  // 🔴 起始 order 只数真卷：自由卷 order 是哨兵值（恒排最前），拿 existingVols.length 当基准会盖过它
  let volOrder = nextVolumeOrder(existingVols)
  for (const v of result.volumes) {
    if (opts.signal?.aborted) break
    if (existingVols.some(x => x.title.trim() === v.title.trim())) continue
    const vol: Volume = {
      id: uid(), projectId: pid, order: volOrder++,
      title: v.title, description: v.positioning || '', createdAt: Date.now(),
    }
    try { await db.saveVolume(vol); out.volumesCreated++ }
    catch { out.failed.push(`卷：${v.title}`) }
  }

  // ② 分卷大纲卡
  const volCards = await db.getCardRecords('volume-outline').catch(() => [])
  const hasVolCard = new Set(volCards.map(c => c.name.trim()))
  for (const v of result.volumes) {
    if (opts.signal?.aborted) break
    if (hasVolCard.has(v.title.trim())) continue
    const data = cardDataOf('volume-outline', [
      ['卷名', v.title], ['本卷一句话定位', v.positioning], ['主角境界区间', v.stage],
      ['舞台范围', v.scope], ['本卷开头（卷首状态）', v.opening], ['第一大高潮', v.climax1],
      ['卷中转折', v.turn], ['卷末高潮', v.climax2], ['本卷结尾（卷末状态）', v.ending],
      ['事件链（起→承→转→合）', v.events], ['支线事件', v.subplots],
      // 🔴 章号范围由系统算好填进来（见 `fillChapterRanges`）——
      //    它是「正文按大纲切卷」的唯一依据，不要让它空着落库。
      ['本卷章号范围', v.chapterRange],
    ])
    try {
      await db.saveCardRecord({
        id: uid(), projectId: pid, tabId: 'volume-outline', name: v.title, data,
        order: volCards.length + out.volumeCardsCreated,
      })
      out.volumeCardsCreated++
    } catch { out.failed.push(`大纲：${v.title}`) }
  }

  // ②.5 回填 / 补全卷大纲卡（缺口补齐专用，2026-09-20）
  //   🔴 两条铁律：
  //     ① 「本卷章号范围」只在原本**为空 / 占位**时写 —— 作者手填过的范围是他的判断，
  //        覆盖它等于篡改他的规划。而这一列是正文按大纲切卷的**唯一依据**：
  //        老数据（如示范项目）的卷卡没有它（范围只写在「本卷章数预估」的自由文本里），
  //        不回填这一批正文就切不了卷。
  //     ② 卷级字段**只填空 / 占位**（「（待写）」之类）—— 骨架补齐不等于重写，
  //        作者已写实的内容一个字不动（老大 2026-09-20 口径）。
  //   ⚠️ 卷名必须精确匹配已有卡：模型写错卷名时宁可跳过，也绝不能凭空建出一张新卡。
  const rangeKey = volumeRangeKey()
  if (opts.volumeFills?.length) {
    for (const vf of opts.volumeFills) {
      if (opts.signal?.aborted) break
      const card = volCards.find(c => c.name.trim() === vf.title.trim())
      if (!card) continue
      const patch: Record<string, string> = {}
      if (rangeKey && vf.range && isPlaceholderText(card.data[rangeKey] ?? '')) patch[rangeKey] = vf.range
      for (const [slot, value] of Object.entries(vf.fields ?? {})) {
        if (!value.trim()) continue
        const key = resolveSlot('volume-outline', slot)
        if (!key || !isPlaceholderText(card.data[key] ?? '')) continue
        patch[key] = value
      }
      if (!Object.keys(patch).length) continue
      try {
        await db.saveCardRecord({ ...card, data: { ...card.data, ...patch } })
        if (rangeKey && patch[rangeKey]) out.volumeRangesFilled++
        out.volumeFieldsFilled += Object.keys(patch).length - (rangeKey && patch[rangeKey] ? 1 : 0)
      } catch { out.failed.push(`卷大纲：${vf.title}`) }
    }
  }

  // ③ 章节细纲卡
  const chCards = await db.getCardRecords('chapter-outline').catch(() => [])
  const hasChName = new Set(chCards.map(c => c.name.trim()))
  for (const c of result.chapters) {
    if (opts.signal?.aborted) break
    const fullName = outlineCardName(c.no, c.title)
    if (hasChName.has(fullName)) continue
    const data = cardDataOf('chapter-outline', [
      ['章节号/标题', fullName], ['本章一句话事件', c.event], ['本章功能', c.fn],
      ['出场人物', c.cast], ['章末钩子', c.hook],
      ['场景1', c.scenes[0] ?? ''], ['场景2', c.scenes[1] ?? ''], ['场景3', c.scenes[2] ?? ''],
    ])
    try {
      await db.saveCardRecord({
        id: uid(), projectId: pid, tabId: 'chapter-outline', name: fullName, data, order: c.no - 1,
      })
      out.chapterCardsCreated++
    } catch { out.failed.push(`细纲：${fullName}`) }
  }

  return out
}

/** 读《章节细纲》卡 → `章号 → 细纲文本`，供 `runAutoContinue` 的 `outlineFor` 注入 */
export async function loadChapterOutlines(): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  const cards = await db.getCardRecords('chapter-outline').catch(() => [])
  const evKey = outlineEventKey()
  const hookKey = resolveSlot('chapter-outline', '章末钩子')
  const fnKey = resolveSlot('chapter-outline', '本章功能')
  const sceneKeys = [1, 2, 3]
    .map(i => resolveSlot('chapter-outline', `场景${i}`))
    .filter((k): k is string => !!k)
  for (const c of cards) {
    const no = chapterNoOf(c.name)
    if (!no) continue
    const lines = [
      evKey && c.data[evKey] ? `事件：${c.data[evKey]}` : '',
      fnKey && c.data[fnKey] ? `功能：${c.data[fnKey]}` : '',
      ...sceneKeys.map((k, i) => (c.data[k] ? `场景${i + 1}：${c.data[k]}` : '')),
      hookKey && c.data[hookKey] ? `章末钩子：${c.data[hookKey]}` : '',
    ].filter(Boolean)
    if (lines.length) map.set(no, lines.join('\n'))
  }
  return map
}

/**
 * 续跑信息 —— 中止时交回界面，界面原样存住；下次点「继续」把它传回 `resume` 即可接着写。
 *
 * 🔴 创意写作的断点粒度是**章**：连写 10 章写到第 4 章中止，续跑就只补剩下的 6 章，
 *    已写好的 4 章一个字都不动（它们已经落库，重跑不但白花钱还会重复建章）。
 */
export interface CreativeResume {
  /** 已完成阶段的产物（续跑时预置进 bag，设定奠基 / 分卷大纲那些阶段不必重跑） */
  bag: Record<string, unknown>
  /** 从哪个阶段继续（中止时正在跑的那个） */
  from: string
  /** 已经写好的章节数 */
  doneChapters: number
  /** 这次总共打算写多少章 —— 校验用：参数改了就不给续（否则"剩余章数"算不对） */
  totalChapters: number
  /** 给界面显示的一行说明 */
  label: string
}

/**
 * 创作起点。🔴 由编排器**自动判定**（库里有没有大纲），不再是界面上的手选项（2026-09-20）。
 * 保留它是因为返回值与断点信息都要如实说明"这一次是从零还是接着写"。
 */
export type CreativeMode = 'scratch' | 'continue'

/**
 * 产出目标（「这一次要产出什么」）：
 * - `'outline'` ＝ **只做大纲规划**：排 / 续排卷大纲与章节细纲，正文一个字不写；
 * - `'full'`    ＝ **大纲 + 正文**：短篇一次跑完；库里已有大纲时自动退化为"只生成正文"；
 * - `'draft'`   ＝ **只生成正文**：中长篇的第二阶段，按已排好的大纲逐章写。
 */
export type CreativeTarget = 'outline' | 'full' | 'draft'

/**
 * 本次创作的输入。
 * - `seed`：一句话想法 —— 只在**库里还没有大纲**时用得上（设定奠基的唯一依据）
 * - `intent`：可选的情节概要（正文生成阶段用；不填则严格承接上一章结尾）
 *
 * ⚠️ 没有 `mode` 字段（2026-09-20）：起点由 `probeCreativeProject()` 自动判定。
 */
export interface CreativeRunInput {
  seed?: string
  intent?: string
}

export interface CreativeWritingOptions {
  /**
   * 产出目标（默认 `'full'`）。
   *
   * 为什么开跑前就定、而不是到闸门再问：作者开跑前就知道自己要什么，不该被逼在
   * 看不到成品的时候猜。闸门只留「确认 / 放弃」。
   */
  target?: CreativeTarget
  /** **本批要排几卷**（大纲规划用，默认 1；1 ~ `MAX_OUTLINE_VOLUMES`） */
  volumes?: number
  /**
   * **每卷多少章**（硬指标，默认 20；1 ~ `MAX_CHAPTERS_PER_VOLUME`）。
   * 本批总量 ＝ 卷数 × 它，且受 `MAX_OUTLINE_CHAPTERS` 约束。
   */
  chaptersPerVolume?: number
  /** 本次写多少章正文（正文生成用，默认 10；1 ~ `MAX_CHAPTERS`） */
  chapters?: number
  /** 每章目标字数（默认 2500） */
  targetWords?: number
  /** 连写时的设定更新策略（默认 add-only）。`confirm` 会走 `onSettingsCandidates` 征询作者 */
  strategy?: ContinueStrategy
  /** 连写时生成初稿后自动去 AI 味儿（可选） */
  deAi?: { enabled: boolean; prompt: string }
  /** 连写时是否按已落库的《章节细纲》写（默认是；没有细纲卡时自动退回自由发挥） */
  useOutline?: boolean
  /**
   * 本批选中的**作者灵感**（2.5.2 · A2，来自灵感夹；启动时快照的文本数组）。
   * 有则逐章 prompt 注入「作者灵感」段（供参考、不要求全部体现，细纲优先）。
   * 空 / 不传 = 完全不注入。
   */
  inspirations?: string[]
  /**
   * 🔴 **正文缺口优先**（默认**开**，2026-09-20）：开写新章之前，先把**最后一章**补到目标字数。
   *
   * 长篇是分批写的：上一批可能因模型收尾过早只落库半章（实测 4000 字目标只写了 2200），
   * 不补就会在第 22 章读到情绪断层。只补最后一章、只动正文与字数（见 `runAutoContinue`）。
   * 传 `false` 关闭。
   */
  topUpLast?: boolean
  /**
   * 结构模板 id（2.5.0 · A1）：大纲规划时注入「全书结构参考」。
   * `''`/缺省 = 不使用；🔴 **缺口补齐（sealing）模式不注入**——本批只补几章，
   * 全书尺度的节拍表对它没有意义（见 `storyStructures.ts` 说明）。
   */
  structureId?: string
  /** 闸门①：设定草稿审阅。返回用户勾选的条目；**返回 null = 放弃整条流程** */
  onBibleGate?: (bundle: DraftBundle) => Promise<DraftRow[] | null>
  /**
   * 闸门②：大纲审阅。`true` = 落库大纲并继续；`false` = 放弃整条流程（不留半成品）。
   *
   * 🔴 「要不要正文」**不在这里问**（2026-09-19 起）：它是起点的产出目标（`opts.target`），
   *    开跑前就定了。原先放在这里让作者「看完大纲再选」，等于把目标决策塞进确认动作里 ——
   *    确认框只该做确认 / 放弃两件事。
   */
  onOutlineGate?: (outline: OutlineResult) => Promise<boolean>
  onProgress?: (p: FlowProgress) => void
  onChapterSaved?: (ch: { id: string; title: string; no: number }) => void
  /**
   * 连写过程中的**逐章日志**（保存成功 / 失败原因 / 丢弃重试）。
   *
   * 🔴 为什么必须存在（2026-09-19 复现用例抓到）：`runAutoContinue` 把失败原因全部交给
   *    `cb.onLog`，而这里原先**没有把它转发出去** —— 于是「一章都没写出来」时，作者
   *    在界面上只能看到一句绿色的「创作完成：写了 0 章」，模型为什么失败一个字都看不到
   *    （真实数据里那条会话的 `log` 是空数组，就是被这个黑洞吃掉的）。
   */
  onRunLog?: (line: string) => void
  onChapterDraft?: (d: ChapterDraft) => Promise<DraftDecision>
  /** `strategy='confirm'` 时：把待补登的设定候选交作者勾选；返回 null = 本次跳过补登 */
  onSettingsCandidates?: (cands: LedgerItem[]) => Promise<LedgerItem[] | null>
  /** 续跑：把上次中止时拿到的 `CreativeResume` 原样传回来 */
  resume?: CreativeResume
  /** 中止时回头交一份续跑信息（界面存住即可显示「继续」） */
  onResume?: (r: CreativeResume) => void
  signal?: AbortSignal
}

export interface CreativeWritingResult {
  mode: CreativeMode
  seed: string
  /**
   * 设定奠基产物。🔴 **可为 null**：`continue` 起点没有这个阶段，续跑时也不会重跑它
   * （产物早已落库）。调用方展示统计时必须判空，别假设它一定在。
   */
  bible: DraftBundle | null
  bibleCommit: CommitOutcome | null
  /** 分卷大纲产物。同上，`continue` 起点为 null */
  outline: OutlineResult | null
  outlineCommit: OutlineCommitOutcome | null
  chapters: { id: string; title: string; no: number }[]
  /**
   * 起点选了「只做大纲规划」—— 正文一个字没写，`chapters` 必为空。
   * 单独立一个字段而不是让调用方靠 `chapters.length === 0` 猜：那两种情况
   * （"只要大纲"与"想写但一章都没成功"）在结果里长得一模一样，界面文案必须分开。
   */
  outlineOnly: boolean
}

/**
 * 跑完整条「创意写作」流程。
 * @param input 起点与输入。可传字符串（等价于 `{ mode:'scratch', seed }`，兼容旧调用）
 * @returns 结果；**返回 null 表示被中止或用户在闸门处放弃**（此时不留任何半成品）
 */
export async function runCreativeWriting(
  input: CreativeRunInput | string,
  opts: CreativeWritingOptions = {},
): Promise<CreativeWritingResult | null> {
  const inp = typeof input === 'string'
    ? { seed: input, intent: '' }
    : { seed: input.seed ?? '', intent: input.intent ?? '' }

  // ① 探测项目现状 → **起点自动判定**（2026-09-20：不再让作者手选"从一句话创作 / 接着已有内容写"）
  const probe = await probeCreativeProject()
  const mode: CreativeMode = probe.hasOutline ? 'continue' : 'scratch'
  const target: CreativeTarget = opts.target ?? 'full'

  // ② 规模参数
  /** 本批要排几卷 */
  const plannedVolumes = Math.max(1, Math.min(MAX_OUTLINE_VOLUMES, Math.round(opts.volumes ?? 1) || 1))
  /** 每卷多少章（硬指标） */
  const perVolume = Math.max(1, Math.min(MAX_CHAPTERS_PER_VOLUME, Math.round(opts.chaptersPerVolume ?? 20) || 1))
  /** 本批大纲的总章数（＝ 卷数 × 每卷章数，受单批上限约束） */
  const planTotalChapters = Math.min(plannedVolumes * perVolume, MAX_OUTLINE_CHAPTERS)
  /** 这次总共打算写多少章正文（同时是续跑校验的基准：参数变了就不给续） */
  const plannedChapters = Math.max(1, Math.min(MAX_CHAPTERS, Math.round(opts.chapters ?? 10) || 1))

  // ③ 「只生成正文」的前提是**已经有排好的大纲** —— 没有就是自相矛盾的操作，
  //    **如实报错**而不是静默改成"先排大纲"（那会让作者以为点错了按钮却跑了别的流程）。
  if (target === 'draft' && !probe.hasOutline) {
    throw new Error('这个项目里还没有分卷大纲与章节细纲 —— 请先做「大纲规划」，再生成正文。')
  }

  /** 续跑起点：已经写好多少章。参数对不上（或没给 resume）就不续，从零写 */
  const baseDone = opts.resume && opts.resume.totalChapters === plannedChapters && opts.resume.doneChapters > 0
    ? opts.resume.doneChapters
    : 0
  let doneChapters = baseDone

  // ④ 阶段表决定这次跑什么：
  //   · 从零创作（库里没大纲）→ 设定奠基 → 分卷大纲 → 连写（target='outline' 时靠 skipRest 停在闸门②之后）
  //   · 接着写 + 只做大纲规划 → 续排大纲
  //   · 接着写 + 只生成正文   → 逐章连写
  // （下面三个阶段执行体照常登记 —— 阶段表里没有它们时状态机根本不会去取，多登记无害。）
  const stages = mode === 'scratch'
    ? CREATIVE_STAGES
    : (target === 'outline' ? CONTINUE_PLAN_STAGES : CONTINUE_DRAFT_STAGES)
  const flow = createFlow(stages, {
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    // 续跑：预置已完成阶段的产物（设定奠基 / 分卷大纲就不会被重跑一遍）
    ...(baseDone > 0 && opts.resume?.bag ? { bag: opts.resume.bag } : {}),
  })
  /** 用户放弃：先 abort（让状态机归为 cancelled）再抛，避免后续阶段继续跑 */
  let gaveUp = false
  function giveUp(): never {
    gaveUp = true
    flow.abort()
    throw new Error('用户放弃了本次创作')
  }

  // —— 阶段①：设定奠基（仅「从零创作」的阶段表里有它；登记着但不会被执行）——
  flow.on('bible', async ctx => {
    // 走到这里说明库里**还没有大纲**（阶段表决定的）—— 此时一句话想法是唯一的依据，必须给
    if (!inp.seed.trim()) {
      throw new Error('这个项目里还没有大纲 —— 请先用一句话说清你想写什么，基础设定要据此冷启动。')
    }
    ctx.report(0.15, '生成设定草稿…')
    // 收字回调：一来给作者"正在生成"的实时反馈，二来它同时就是**流式开关**
    // （不传的话非流式请求会撞 180s 总超时墙，见 aiTasks 的 longStream 注释）
    let got = 0
    const entities = await aiGenerateBible(inp.seed, {
      signal: ctx.signal,
      onToken: d => {
        got += d.length
        if (got % 400 < d.length) ctx.report(0.5, `生成设定草稿… 已收到 ${got} 字`)
      },
    })
    if (!entities.length) {
      throw new Error('模型没有产出任何设定 —— 请把想法写得更具体些（题材 / 主角 / 核心冲突）')
    }
    // source 传空串：生成型入口没有原文，「首次出场」这种字段不该被填上"设定奠基"
    const bundle = await buildDraftBundle([{ source: '', index: 1, entities }])
    ctx.report(1, `生成 ${bundle.stats.total} 条设定草稿，等待确认…`)
    const picked = opts.onBibleGate
      ? await opts.onBibleGate(bundle)
      : bundle.rows.filter(defaultPicked)
    if (!picked) giveUp()
    const bibleCommit = picked.length
      ? await commitDraftRows(picked, { conflict: 'fill-empty' })
      : null
    return { bundle, bibleCommit }
  })

  // —— 阶段②：大纲规划（从零排 / 接续排 / 补缺口 共用这一个执行体）——
  flow.on('outline', async ctx => {
    // 🔴 缺口优先（2026-09-20，老大拍板）：库里已有卷大纲、而**当前那一卷还没排满**时，
    //    本批只补缺口，**不另开新卷** —— 否则作者规划好的卷会变成残卷
    //    （示范项目：规划每卷 10 章、细纲排到第 21 章 ⇒ 先补第 22-30 章，而不是排第四卷）。
    //    补满之后下一批才轮到新卷。
    const gap = detectVolumeGap(probe.volumeBounds, probe.maxOutlineNo, perVolume)
    const filling = gap && target === 'outline' ? gap : null
    // 🔴 这一卷的卷大纲是否"只有骨架"？（老大 2026-09-20 口径）
    //    完整 → 只按它排细纲，卷大纲卡一个字不动；不完整 → 补细纲时把它一并补全。
    const needVolumeOutline = filling ? await volumeOutlineNeedsFill(filling.title) : false
    const sealing = filling
      ? {
          volumeTitle: filling.title,
          volumeFrom: filling.from,
          // 卷的**目标上界**（原值）—— 回填「本卷章号范围」用它，不受本批上限影响
          volumeTo: filling.to,
          doneTo: probe.maxOutlineNo,
          gapFrom: filling.gapFrom,
          // 🔴 本批只排到**单批上限**为止：规划「每卷 100 章」却只排到第 21 章时缺口是 79 章，
          //    一次排不完（模型也会截断）。夹住后本批排 22-81，剩下的下次继续；
          //    卷范围仍按"实际排到哪"收敛（`volumeFills` 那段），不会落出「第21-100章」的假范围。
          gapTo: Math.min(filling.gapTo, filling.gapFrom + MAX_OUTLINE_CHAPTERS - 1),
          needVolumeOutline,
        }
      : undefined
    // 🔴 起点看「**已排到哪**」，不看「正文写到哪」（2026-09-20 改，老大确认）：
    //    长篇是"先把大纲规划完、再写正文"，此时正文可能一章都没有，而细纲已经排到第 40 章。
    //    旧口径按正文算会得到"从第 1 章起"，紧接着被判"第 1 章已有细纲、无需续排"直接收工 ——
    //    纯排大纲这条路完全跑不通。缺口模式下起点＝缺口起点（＝已有细纲最大章号 + 1）。
    const fromNo = sealing ? sealing.gapFrom : probe.maxOutlineNo + 1
    const fromVolumeNo = probe.volumeCardCount + 1
    const extending = probe.hasOutline
    /** 本批要排多少章（缺口模式＝缺口章数，「卷数 × 每卷章数」不参与） */
    const planCount = sealing ? sealing.gapTo - sealing.gapFrom + 1 : planTotalChapters

    ctx.report(0.15, extending ? '读已有卷大纲与细纲脉络…' : '组装设定资料…')
    const task = sealing
      ? `【补完已有卷】作者已经规划了《${sealing.volumeTitle}》（全书第 ${sealing.volumeFrom} ~ ${sealing.volumeTo} 章），`
        + `其中第 ${sealing.volumeFrom} ~ ${sealing.doneTo} 章已有细纲。本次只补第 ${sealing.gapFrom} ~ ${sealing.gapTo} 章，共 ${planCount} 章；`
        + `**不要新建卷**，接着第 ${sealing.doneTo} 章的结尾往下走。`
      : extending
        ? `接着往下排：从全书第 ${fromVolumeNo} 卷起，本批共 ${plannedVolumes} 卷、每卷 ${perVolume} 章（对应第 ${fromNo} 章起）。`
        : `产出分卷大纲与逐章细纲：本批共 ${plannedVolumes} 卷、每卷 ${perVolume} 章。`
    const material = await buildPlanMaterial(probe, task)

    ctx.report(0.45, sealing
      ? `补完《${sealing.volumeTitle}》第 ${sealing.gapFrom} ~ ${sealing.gapTo} 章（共 ${planCount} 章）…`
      : extending
        ? `续排第 ${fromVolumeNo} 卷（第 ${fromNo} 章起，本批 ${planTotalChapters} 章）…`
        : `规划 ${plannedVolumes} 卷 × ${perVolume} 章…`)
    // 收字回调同时就是**流式开关**（不传会撞 180s 总超时墙，见 aiTasks 的 longStream 注释）
    let got = 0
    // 2.5.0 · A1 结构模板：作者选了模板且**不是缺口补齐**时，注入「全书结构参考」当骨架约束。
    // 🔴 缺口补齐不注入（见 CreativeWritingOptions.structureId 注释）。
    const structureTpl = sealing ? null : getStoryTemplate(opts.structureId)
    const raw = await aiPlanOutline(material, {
      volumes: plannedVolumes,
      chaptersPerVolume: perVolume,
      fromNo,
      fromVolumeNo,
      extending,
      ...(sealing ? { sealing } : {}),
      ...(structureTpl ? { structureHint: formatStructureHint(structureTpl) } : {}),
      signal: ctx.signal,
      onToken: d => {
        got += d.length
        if (got % 400 < d.length) ctx.report(0.7, `生成大纲… 已收到 ${got} 字`)
      },
    })
    if (!raw.chapters.length) throw new Error('模型没有产出章节细纲，请重试或换一个更大的模型')

    // 🔴 每卷的章号范围由**系统**按硬指标算好再交闸门 —— 让作者在确认时就看见
    //    "本卷含第几章到第几章"，而不是等正文写完才发现章落错了卷。
    //    ⚠️ 必须把**实际排出的章数**一起传进去：模型偶尔写一半就收尾（实测线上 27B：
    //    2 卷 × 10 章只给 10 章），若仍按承诺的每卷章数算，后一卷会拿到
    //    「第32-41章」而**那 10 章根本不存在** —— 作者以为排到 41 章，正文写到那里会找不到细纲。
    // 🔴 缺口模式**不产出卷**：这一卷已存在（作者规划的），本批只补它缺的章 ——
    //    卷大纲卡一个字不动（作者可能已手写很多内容，模型重写会覆盖掉）。
    const outline: OutlineResult = sealing
      ? { volumes: [], chapters: raw.chapters }
      : { ...raw, volumes: fillChapterRanges(raw.volumes, fromNo, perVolume, raw.chapters.length) }

    // 产出不足**如实说明**，不静默：少排的章会让下一批从更早的位置接续。
    const short = planCount - outline.chapters.length
    if (short > 0) {
      ctx.report(0.95, sealing
        ? `注意：本次只补了 ${outline.chapters.length} 章（应为 ${planCount} 章），还差 ${short} 章 —— 已按实际数量回填卷范围，下次可以继续补。`
        : `注意：本次只排了 ${outline.chapters.length} 章，比承诺的 ${planCount} 章少了 ${short} 章 —— 已按实际数量收敛卷范围`)
    }
    ctx.report(1, sealing
      ? `补完第 ${fromNo} ~ ${fromNo + outline.chapters.length - 1} 章（《${sealing.volumeTitle}》），等待确认…`
      : `${outline.volumes.length} 卷 / ${outline.chapters.length} 章（第 ${fromNo} 章起），等待确认…`)
    const ok = opts.onOutlineGate ? await opts.onOutlineGate(outline) : true
    if (!ok) giveUp()
    // 🔴 缺口补齐要把**推算出的卷边界**回填给卷卡（见 commitOutline ②.5：只在该列原本为空时写）——
    //    正文按大纲切卷依赖它，而老数据的卷卡里根本没有这一列。
    //    ⚠️ 写的是「该卷完整目标区间」（含本次之前已排的章）：第 21 章已排且属于第三卷，
    //       卷范围就该是 21-30；但模型少排时按**实际**排到的章收敛，避免又落出幽灵范围。
    // 🔴 该卷大纲原本只有骨架时（needVolumeOutline），模型这一批已顺带产出完整卷大纲
    //    （sealing 模式下 volumes 只放这一卷）——一并交给 commitOutline 按字段补全，
    //    它只填空 / 占位字段，作者已写实的内容不动。
    const filledTo = Math.min(sealing?.volumeTo ?? 0, fromNo + outline.chapters.length - 1)
    const vol0 = raw.volumes[0]
    const volumeFills = sealing && outline.chapters.length
      ? [{
          title: sealing.volumeTitle,
          range: formatChapterRange(sealing.volumeFrom, Math.max(sealing.volumeFrom, filledTo)),
          ...(needVolumeOutline && vol0 ? { fields: volumeFieldsOf(vol0) } : {}),
        }]
      : undefined
    const outlineCommit = await commitOutline(outline, {
      signal: ctx.signal, ...(volumeFills ? { volumeFills } : {}),
    })
    // 「只做大纲规划」：大纲照常落库，连写阶段整段跳过。
    // 用 skipRest 而不是"不登记 draft"—— 目标在开跑前就定好了，阶段表早已定好；
    // 也不能记成 done（界面会谎称正文写完了）。
    const outlineOnly = target === 'outline'
    if (outlineOnly) ctx.skipRest('（已选择：只做大纲规划）')
    return { outline, outlineCommit, outlineOnly }
  })

  // ---- 阶段③：逐章连写（**两种起点共用同一实现**，这是融合的关键）----
  flow.on('draft', async (ctx: StageCtx) => {
    // 续跑：已经写好的章不再写，只补剩下的（`plannedChapters` 是**总共**要多少章）
    const remaining = Math.max(0, plannedChapters - doneChapters)
    if (remaining === 0) { ctx.report(1, '章数已写满，跳过连写'); return [] }
    // 按大纲写：从零创作刚落了细纲、「接着写」可能早就有一律现查一次。
    // 有细纲就按章号钉进本章 prompt 末段；没有则退回"自由发挥"（仍能跑通，只是不保证贴合大纲）
    const outlines = opts.useOutline === false ? new Map<number, string>() : await loadChapterOutlines()
    let done = 0
    const res = await runAutoContinue(
      {
        chapters: remaining,
        targetWords: opts.targetWords ?? 2500,
        // 设定补完策略（融合前写死 add-only）。默认仍是最稳的 add-only；
        // 「候选确认」会经 `onSettingsCandidates` 把待补登项交作者勾选
        strategy: opts.strategy ?? 'add-only',
        ...(inp.intent.trim() ? { intent: inp.intent.trim() } : {}),
        ...(opts.deAi ? { deAi: opts.deAi } : {}),
        // 🔴 正文缺口优先（默认开）：先把最后一章补到目标字数，再往下写新章。
        //    库里还没有正文时 `last` 为 null，那段自然跳过（从零创作不受影响）。
        ...(opts.topUpLast === false ? {} : { topUpLast: {} }),
      },
      {
        signal: ctx.signal,
        /**
         * 🔴 必须传 `onBodyToken`（哪怕是空回调）——它是**流式开关**，不是"要不要显示"。
         *    非流式请求的响应头要等**整段正文生成完**才回来，4000 字/章的云端生成必然撞
         *    `CHAT_TIMEOUT_MS`（180s）的总超时；流式只要首字节到达就把那个定时器清掉。
         *    同一条红线在 `aiTasks/stream.ts` 的 `longStream` 注释里写着，但这里原来漏了 ——
         *    2026-09-19 复现：用可控假模型跑「接着写」，第 1 章就失败、0 章落库，界面却报「已完成」。
         */
        onBodyToken: () => {},
        // 逐章日志（保存 / 失败原因）—— 原先不转发 ⇒ 「0 章」时界面上一条线索都没有
        onLog: line => opts.onRunLog?.(line),
        onPhase: msg => ctx.report(done / remaining, msg),
        onChapterSaved: ch => {
          done++
          doneChapters = baseDone + done
          ctx.report(done / remaining, `已写 ${doneChapters}/${plannedChapters} 章`)
          opts.onChapterSaved?.(ch)
        },
        ...(opts.onChapterDraft ? { onChapterDraft: opts.onChapterDraft } : {}),
        // 2.5.2 · A2：作者灵感注入（🔴 必须在 cb——autoContinue 从回调对象读）
        ...(opts.inspirations?.length ? { inspirationsFor: () => opts.inspirations as string[] } : {}),
        ...(opts.onSettingsCandidates ? { onSettingsCandidates: opts.onSettingsCandidates } : {}),
        ...(outlines.size ? { outlineFor: (no: number) => outlines.get(no) } : {}),
        // 🔴 按大纲**切卷**（2026-09-20）：读分卷大纲卡的「本卷章号范围」，建"章号 → 卷 id"查询。
        //    没有它，第 21 章会被塞进卷一 —— 卷归属与大纲对不上（正文看起来"少了一卷"）。
        volumeIdFor: await buildChapterVolumeIndex(),
      },
    )
    ctx.report(1, `写完 ${res.created.length} 章`)
    return res.created
  })

  const res = await flow.run(baseDone > 0 ? opts.resume?.from : undefined)
  if (res.status === 'cancelled') {
    // 🔴 闸门处主动「放弃」≠ 被中止：放弃是作者的终态决定，不该再递一个「继续」入口
    //    （否则界面上会冒出一个"要继续写吗"，看起来像系统没听懂他放弃）。
    if (!gaveUp) {
      // 交回续跑信息：写到第几章 + 已完成阶段的产物（已落库的章不会重写）
      opts.onResume?.({
        bag: res.bag,
        from: firstUnfinishedStage(res.progress),
        doneChapters,
        totalChapters: plannedChapters,
        label: `已写 ${doneChapters}/${plannedChapters} 章`,
      })
    }
    return null
  }
  if (res.status === 'error') throw new Error(res.error ?? '创作流程失败')

  const bibleBag = res.bag.bible as { bundle: DraftBundle; bibleCommit: CommitOutcome | null } | undefined
  const outlineBag = res.bag.outline as
    { outline: OutlineResult; outlineCommit: OutlineCommitOutcome; outlineOnly: boolean } | undefined
  // 🔴 产物缺失只在「从零创作的首次运行」算异常 —— 那条路必然跑过设定奠基与分卷大纲。
  //    「接着写」与续跑（前序阶段本就没跑 / 不必重跑）都允许缺失：那两阶段的成果在数据库里、
  //    不在 bag 里，硬要求它们反而会让续跑误报「内部错误」。
  if (mode === 'scratch' && baseDone === 0 && (!bibleBag || !outlineBag)) {
    throw new Error('流程产物缺失（内部错误）')
  }
  return {
    mode,
    seed: inp.seed,
    bible: bibleBag?.bundle ?? null,
    bibleCommit: bibleBag?.bibleCommit ?? null,
    outline: outlineBag?.outline ?? null,
    outlineCommit: outlineBag?.outlineCommit ?? null,
    chapters: (res.bag.draft as { id: string; title: string; no: number }[]) ?? [],
    outlineOnly: outlineBag?.outlineOnly === true,
  }
}
