/**
 * 一键拆书 · 管线编排（B1）。
 *
 * 四个阶段：切分 → **写入正文** → 逐块抽取 → 整理草稿。用 `lib/flow` 的状态机驱动，
 * 好处是中止 / 进度 / 产物保留都是现成的，且与「创意写作」共用同一套。
 *
 * 复用既有能力（不重造）：
 * - 抽取：`aiTasks.aiExtractSettingEntities`（按章抽「人物/势力/地点/种族/物品/术语」+ 原文证据）
 * - 判重：`settingLedger.classify`（登记表比对，确定性字符串运算）
 * - 草稿：`flow/draft.buildDraftBundle`
 * - 落库：`bookbreak/persist.persistSplitToChapters`（写卷/章 + 同步章节台账）
 *
 * 🔴 写库边界（2026-09-18 起）：
 * - **设定草稿不自动落库** —— 仍由用户勾选后经 `flow/commit` 写入；
 * - **原文结构会写库**（卷/章正文），因为老大要求「切分后立刻能在正文编辑看到框架」。
 *   它由 `persistToChapters` 开关控制，默认开；只追加、绝不覆盖已有卷章。
 *
 * ⚠️ B1 的抽取粒度是「专名清单」（name/desc/evidence），不含全字段（身份定位/外貌/境界…）。
 *    B2 会换成「两遍全字段抽取」，届时只需替换 extract 阶段的实现，draft/commit/UI 全不用改。
 */
import { aiExtractSettingEntities } from '../aiTasks'
import { buildDraftBundle, type EntityBatch } from '../flow/draft'
import { createFlow, type StageCtx } from '../flow/pipeline'
import type { DraftBundle, FlowProgress, FlowStage } from '../flow/types'
import { persistSplitToChapters, planVolumes, type PersistResult } from './persist'
import { chunkText, splitNovelText, type RawChapter, type SplitResult } from './split'

/** 阶段声明（weight 按实测耗时给：抽取占绝大部分；写入正文是纯 IO，给 1） */
export const BOOKBREAK_STAGES: FlowStage[] = [
  { id: 'split', label: '切分原文', weight: 1 },
  { id: 'persist', label: '写入正文', weight: 1 },
  { id: 'extract', label: '逐块抽取', weight: 8 },
  { id: 'draft', label: '整理草稿', weight: 1 },
]

export interface BookBreakOptions {
  /** 最多处理多少章 / 块（默认 60，见 split.ts） */
  maxChunks?: number
  /** 单个抽取单元的字符上限（默认 4000）：超出的章节会细分再抽 */
  maxUnitChars?: number
  /** 抽取单元数上限（默认 120）：防止超长篇把模型跑到天亮 */
  maxUnits?: number
  /** 兜底分块的块大小（token） */
  chunkTokens?: number
  /**
   * 是否把切分结果写入正文编辑的卷/章（**默认 true**）。
   * 关掉即退化成旧行为：只抽设定、不动正文。
   */
  persistToChapters?: boolean
  /** 无卷结构时用的卷名（默认「导入原文」） */
  volumeTitle?: string
  /** 中止信号（界面的「中止」按钮接它） */
  signal?: AbortSignal
  /** 进度回调 */
  onProgress?: (p: FlowProgress) => void
  /** 每抽完一个单元回调一次（界面即时显示抽到了什么） */
  onBatch?: (b: EntityBatch) => void
}

export interface BookBreakResult {
  split: SplitResult
  /** 原文写入正文的结果（开关关闭或没有可写内容时为 null） */
  persist: PersistResult | null
  batches: EntityBatch[]
  bundle: DraftBundle
}

const DEFAULT_MAX_UNIT_CHARS = 4000
const DEFAULT_MAX_UNITS = 120

function isAbort(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError'
}

/** 一个抽取单元：章标题 + 该单元文本 + 所属章序号 */
interface Unit {
  chapterTitle: string
  chapterIndex: number
  text: string
}

/** 把章节展开为抽取单元：超长章节按段落边界细分（避免单次输入超本地窗口被静默截断） */
function expandUnits(chapters: RawChapter[], maxUnitChars: number, maxUnits: number): { units: Unit[]; truncated: boolean } {
  const units: Unit[] = []
  let truncated = false
  for (const ch of chapters) {
    if (units.length >= maxUnits) { truncated = true; break }
    if (ch.text.length <= maxUnitChars) {
      units.push({ chapterTitle: ch.title, chapterIndex: ch.index, text: ch.text })
      continue
    }
    for (const c of chunkText(ch.text, { chunkTokens: maxUnitChars })) {
      if (units.length >= maxUnits) { truncated = true; break }
      units.push({ chapterTitle: ch.title, chapterIndex: ch.index, text: c.text })
    }
    if (truncated) break
  }
  return { units, truncated }
}

/**
 * 跑完整拆书管线。
 * @returns 结果；**返回 null 表示被中止**（此时不产出草稿，调用方据此提示）
 */
export async function runBookBreak(raw: string, opts: BookBreakOptions = {}): Promise<BookBreakResult | null> {
  const maxUnitChars = opts.maxUnitChars ?? DEFAULT_MAX_UNIT_CHARS
  const maxUnits = opts.maxUnits ?? DEFAULT_MAX_UNITS

  const flow = createFlow(BOOKBREAK_STAGES, {
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  flow.on('split', async (ctx: StageCtx) => {
    const r = splitNovelText(raw, {
      ...(opts.maxChunks !== undefined ? { maxChunks: opts.maxChunks } : {}),
      ...(opts.chunkTokens !== undefined ? { chunkTokens: opts.chunkTokens } : {}),
    })
    ctx.report(1, r.mode === 'chapters' ? `识别到 ${r.chapters.length} 章` : `未识别到章节，按 ${r.chapters.length} 块处理`)
    return r
  })

  // ② 写入正文：把原文结构同步进「正文编辑」（老大要求"切分后立刻看到卷/章框架"）。
  //    纯 IO、不调模型，所以放在抽取之前 —— 用户马上能在正文编辑里翻着看，
  //    而不是等几十分钟抽完才见到东西。
  flow.on('persist', async (ctx: StageCtx) => {
    const sp = ctx.bag.split as SplitResult
    if (opts.persistToChapters === false) {
      ctx.report(1, '已关闭「写入正文」，跳过')
      return null
    }
    const plan = planVolumes(sp, opts.volumeTitle !== undefined ? { volumeTitle: opts.volumeTitle } : {})
    if (!plan.chapterCount) { ctx.report(1, '没有可写入的正文'); return null }
    const total = plan.chapterCount
    ctx.report(0.05, `准备写入 ${plan.volumes.length} 卷 / ${total} 章…`)
    const r = await persistSplitToChapters(sp, {
      ...(opts.volumeTitle !== undefined ? { volumeTitle: opts.volumeTitle } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      onProgress: (done, n) => ctx.report(done / Math.max(1, n), `已写入 ${done}/${n} 章`),
    })
    if (r.alreadyImported) { ctx.report(1, '检测到已导入过同一本书，已跳过（避免重复建卷）'); return r }
    ctx.report(1, r.aborted ? `已写入 ${r.chaptersCreated} 章（中止）` : `已写入 ${r.volumes.length} 卷 ${r.chaptersCreated} 章`)
    return r
  })

  flow.on('extract', async (ctx: StageCtx) => {
    const sp = ctx.bag.split as SplitResult
    const { units, truncated } = expandUnits(sp.chapters, maxUnitChars, maxUnits)
    // 同章被细分成多块时，合并进同一个 EntityBatch（章标题/章号一致）
    const perChapter = new Map<number, EntityBatch>()
    let entityCount = 0

    for (let i = 0; i < units.length; i++) {
      if (ctx.signal.aborted) break
      const u = units[i]
      ctx.report(i / Math.max(1, units.length), `${u.chapterTitle}（${i + 1}/${units.length}）`)
      let entities: Awaited<ReturnType<typeof aiExtractSettingEntities>> = []
      try {
        entities = await aiExtractSettingEntities(u.text, u.chapterTitle, { signal: ctx.signal })
      } catch (e) {
        if (isAbort(e) || ctx.signal.aborted) throw e
        entities = [] // 单块失败不中断整本书——记不到就跳过，最后界面会显示"共抽到 N 条"
      }
      entityCount += entities.length
      if (entities.length) {
        const b = perChapter.get(u.chapterIndex)
        if (b) b.entities.push(...entities)
        else {
          const nb: EntityBatch = { source: u.chapterTitle, index: u.chapterIndex, entities: [...entities] }
          perChapter.set(u.chapterIndex, nb)
        }
        opts.onBatch?.(perChapter.get(u.chapterIndex) as EntityBatch)
      }
    }

    const batches = [...perChapter.values()].sort((a, b) => a.index - b.index)
    const note = truncated ? `（已达到上限 ${maxUnits} 块，剩余未处理）` : ''
    ctx.report(1, `共抽到 ${entityCount} 条实体${note}`)
    return batches
  })

  flow.on('draft', async (ctx: StageCtx) => {
    const batches = (ctx.bag.extract as EntityBatch[]) ?? []
    ctx.report(0.2)
    const bundle = await buildDraftBundle(batches, { rawText: raw })
    ctx.report(1, `整理出 ${bundle.stats.total} 条草稿`)
    return bundle
  })

  const res = await flow.run()
  if (res.status === 'cancelled') return null
  if (res.status === 'error') throw new Error(res.error ?? '拆书失败')

  return {
    split: res.bag.split as SplitResult,
    persist: (res.bag.persist as PersistResult | null) ?? null,
    batches: (res.bag.extract as EntityBatch[]) ?? [],
    bundle: res.bag.draft as DraftBundle,
  }
}

/**
 * 只做切分（供界面「预览切分」按钮用）—— 不消耗任何模型调用。
 * 让用户在真正开抽之前先看「识别到几章、多少字」，避免粘错文本白跑一轮。
 */
export function previewSplit(raw: string, opts: { maxChunks?: number } = {}): SplitResult {
  return splitNovelText(raw, opts)
}

/** 估算抽取调用次数（界面在开抽前告诉用户"要跑 N 次"，避免过程中莫名等待） */
export function estimateCalls(sp: SplitResult, maxUnitChars = DEFAULT_MAX_UNIT_CHARS, maxUnits = DEFAULT_MAX_UNITS): number {
  let n = 0
  for (const ch of sp.chapters) n += Math.max(1, Math.ceil(ch.text.length / maxUnitChars))
  return Math.min(n, maxUnits)
}
