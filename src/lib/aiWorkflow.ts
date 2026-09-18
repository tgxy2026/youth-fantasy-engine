/**
 * 「创意写作」编排器 —— 全自动创作工作流的串联层（方案见 `docs/2.2.0-全自动AI小说创作工作流方案.md`）。
 *
 * 全链路：种子 → ①设定奠基 → **闸门①** → ②分卷大纲 → **闸门②** → ③逐章连写 → （④审校闭环留给阶段二）
 *
 * 三条设计要点：
 * 1. **不重造**：逐章连写直接用 `runAutoContinue`（一键续写那套），它自带"字数校准 + 落库硬闸门 +
 *    逐章人审回调"。本文件只负责"把阶段串起来 + 在两个闸门处停下来等人"。
 * 2. **闸门＝await**：`onBibleGate` / `onOutlineGate` 返回 Promise，编排器就停在那里等用户；
 *    这也是为什么它直接建在 `lib/flow` 的状态机上（状态机不需要感知"暂停"这件事）。
 * 3. **人和 AI 的分工**：闸门之前全是 AI 跑量，闸门处必须人定方向 —— 不接受"全自动无人值守"，
 *    那是方案里明确否掉的（AI 生成设定/大纲的质量波动，必须由人在落库前过一眼）。
 *
 * 🔴 写库只发生在两个闸门**通过之后**；用户放弃闸门 = 整条流程中止，不留半成品。
 */
import { buildProjectContext } from './aiContext'
import { aiGenerateBible, aiGenerateOutline, type OutlineResult } from './aiTasks'
import { writerBudgetFor } from './aiWriterBudget'
import { runAutoContinue, type ChapterDraft, type DraftDecision } from './autoContinue'
import * as db from './db'
import { commitDraftRows } from './flow/commit'
import { buildDraftBundle, defaultPicked } from './flow/draft'
import { resolveSlot } from './flow/fieldMap'
import { createFlow } from './flow/pipeline'
import type { CommitOutcome, DraftBundle, DraftRow, FlowProgress, FlowStage } from './flow/types'
import { uid } from './id'
import type { Volume } from './types'

/** 阶段声明（weight 按实测耗时：连写占绝大部分） */
export const CREATIVE_STAGES: FlowStage[] = [
  { id: 'bible', label: '设定奠基', weight: 3 },
  { id: 'outline', label: '分卷大纲', weight: 2 },
  { id: 'draft', label: '逐章连写', weight: 12 },
]

/** 从卡名（「第3章 风云」）里取章号；取不到返回 0 */
function chapterNoOf(name: string): number {
  const m = (name ?? '').match(/第\s*(\d+)\s*章/)
  return m ? parseInt(m[1], 10) : 0
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
  failed: string[]
}

/**
 * 大纲落库：建卷（同名不重建）+ 分卷大纲卡（一卡一卷）+ 章节细纲卡（一卡一章）。
 * 全是"新增"，**不覆盖已有**（同名则跳过，由作者自己决定要不要改）。
 */
export async function commitOutline(
  result: OutlineResult,
  opts: { signal?: AbortSignal } = {},
): Promise<OutlineCommitOutcome> {
  const out: OutlineCommitOutcome = { volumesCreated: 0, volumeCardsCreated: 0, chapterCardsCreated: 0, failed: [] }
  const pid = db.getCurrentProjectId()

  // ① 建卷
  const existingVols = await db.getAllVolumes().catch(() => [] as Volume[])
  for (const v of result.volumes) {
    if (opts.signal?.aborted) break
    if (existingVols.some(x => x.title.trim() === v.title.trim())) continue
    const vol: Volume = {
      id: uid(), projectId: pid, order: existingVols.length + out.volumesCreated,
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
    ])
    try {
      await db.saveCardRecord({
        id: uid(), projectId: pid, tabId: 'volume-outline', name: v.title, data,
        order: volCards.length + out.volumeCardsCreated,
      })
      out.volumeCardsCreated++
    } catch { out.failed.push(`大纲：${v.title}`) }
  }

  // ③ 章节细纲卡
  const chCards = await db.getCardRecords('chapter-outline').catch(() => [])
  const hasChName = new Set(chCards.map(c => c.name.trim()))
  for (const c of result.chapters) {
    if (opts.signal?.aborted) break
    const fullName = `第${c.no}章 ${c.title}`.trim()
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
  const evKey = resolveSlot('chapter-outline', '本章一句话事件')
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

export interface CreativeWritingOptions {
  /** 连写多少章（默认 10） */
  chapters?: number
  /** 每章目标字数（默认 2500） */
  targetWords?: number
  /** 分几卷（默认 1） */
  volumes?: number
  /** 闸门①：设定草稿审阅。返回用户勾选的条目；**返回 null = 放弃整条流程** */
  onBibleGate?: (bundle: DraftBundle) => Promise<DraftRow[] | null>
  /** 闸门②：大纲审阅。返回 false = 放弃整条流程 */
  onOutlineGate?: (outline: OutlineResult) => Promise<boolean>
  onProgress?: (p: FlowProgress) => void
  onChapterSaved?: (ch: { id: string; title: string; no: number }) => void
  onChapterDraft?: (d: ChapterDraft) => Promise<DraftDecision>
  signal?: AbortSignal
}

export interface CreativeWritingResult {
  seed: string
  bible: DraftBundle
  bibleCommit: CommitOutcome | null
  outline: OutlineResult
  outlineCommit: OutlineCommitOutcome | null
  chapters: { id: string; title: string; no: number }[]
}

/**
 * 跑完整条「创意写作」流程。
 * @returns 结果；**返回 null 表示被中止或用户在闸门处放弃**（此时不留任何半成品）
 */
export async function runCreativeWriting(
  seed: string,
  opts: CreativeWritingOptions = {},
): Promise<CreativeWritingResult | null> {
  const flow = createFlow(CREATIVE_STAGES, {
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  /** 用户放弃：先 abort（让状态机归为 cancelled）再抛，避免后续阶段继续跑 */
  function giveUp(): never {
    flow.abort()
    throw new Error('用户放弃了本次创作')
  }

  flow.on('bible', async ctx => {
    ctx.report(0.15, '生成设定草稿…')
    // 收字回调：一来给作者"正在生成"的实时反馈，二来它同时就是**流式开关**
    // （不传的话非流式请求会撞 180s 总超时墙，见 aiTasks 的 longStream 注释）
    let got = 0
    const entities = await aiGenerateBible(seed, {
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

  flow.on('outline', async ctx => {
    ctx.report(0.2, '组装设定摘要…')
    const digest = await buildProjectContext({ budget: await writerBudgetFor('outline-generate') })
      .then(r => r.text)
      .catch(() => '')
    ctx.report(0.45, '生成分卷大纲…')
    let got = 0
    const outline = await aiGenerateOutline(digest, {
      signal: ctx.signal,
      ...(opts.volumes !== undefined ? { volumes: opts.volumes } : {}),
      ...(opts.chapters !== undefined ? { chapters: opts.chapters } : {}),
      onToken: d => {
        got += d.length
        if (got % 400 < d.length) ctx.report(0.7, `生成分卷大纲… 已收到 ${got} 字`)
      },
    })
    if (!outline.chapters.length) throw new Error('模型没有产出章节细纲，请重试或换一个更大的模型')
    ctx.report(1, `${outline.volumes.length} 卷 / ${outline.chapters.length} 章，等待确认…`)
    const ok = opts.onOutlineGate ? await opts.onOutlineGate(outline) : true
    if (!ok) giveUp()
    const outlineCommit = await commitOutline(outline, { signal: ctx.signal })
    return { outline, outlineCommit }
  })

  flow.on('draft', async ctx => {
    const n = Math.max(1, Math.min(60, opts.chapters ?? 10))
    const outlines = await loadChapterOutlines()
    let done = 0
    const res = await runAutoContinue(
      { chapters: n, targetWords: opts.targetWords ?? 2500, strategy: 'add-only' },
      {
        signal: ctx.signal,
        onPhase: msg => ctx.report(done / n, msg),
        onChapterSaved: ch => {
          done++
          ctx.report(done / n, `已写 ${done}/${n} 章`)
          opts.onChapterSaved?.(ch)
        },
        ...(opts.onChapterDraft ? { onChapterDraft: opts.onChapterDraft } : {}),
        // 有细纲就按大纲写；没有则退回"自由发挥"（仍能跑通，只是不保证贴合大纲）
        ...(outlines.size ? { outlineFor: (no: number) => outlines.get(no) } : {}),
      },
    )
    ctx.report(1, `写完 ${res.created.length} 章`)
    return res.created
  })

  const res = await flow.run()
  if (res.status === 'cancelled') return null
  if (res.status === 'error') throw new Error(res.error ?? '创作流程失败')

  const bibleBag = res.bag.bible as { bundle: DraftBundle; bibleCommit: CommitOutcome | null } | undefined
  const outlineBag = res.bag.outline as { outline: OutlineResult; outlineCommit: OutlineCommitOutcome } | undefined
  if (!bibleBag || !outlineBag) throw new Error('流程产物缺失（内部错误）')
  return {
    seed,
    bible: bibleBag.bundle,
    bibleCommit: bibleBag.bibleCommit,
    outline: outlineBag.outline,
    outlineCommit: outlineBag.outlineCommit,
    chapters: (res.bag.draft as { id: string; title: string; no: number }[]) ?? [],
  }
}
