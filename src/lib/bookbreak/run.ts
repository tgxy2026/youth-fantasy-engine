/**
 * 一键拆书 · 管线编排（B1）。
 *
 * 六个阶段：切分 → **写入正文** → 逐块抽取 → 整理草稿 → 汇总全书设定 → 整理关系。
 * 用 `lib/flow` 的状态机驱动，好处是中止 / 进度 / 产物保留都是现成的，且与「创意写作」共用同一套。
 *
 * 复用既有能力（不重造）：
 * - 抽取：`aiTasks.aiExtractSettingEntities`（按章抽「人物/势力/地点/种族/物品/术语」+ 原文证据）
 * - 判重：`settingLedger.classify`（登记表比对，确定性字符串运算）
 * - 草稿：`flow/draft.buildDraftBundle`
 * - 落库：`bookbreak/persist.persistSplitToChapters`（写卷/章 + 同步章节台账）
 * - 关系整理：`bookbreak/relations.buildRelationDrafts`（走 `lib/organizeRows`，
 *   与表格页的「AI 整理」同一套候选值注入 / 判重口径）
 *
 * 🔴 写库边界（2026-09-18 起）：
 * - **设定草稿不自动落库** —— 仍由用户勾选后经 `flow/commit` 写入；
 * - **原文结构会写库**（卷/章正文），因为老大要求「切分后立刻能在正文编辑看到框架」。
 *   它由 `persistToChapters` 开关控制，默认开；只追加、绝不覆盖已有卷章。
 *
 * ⚠️ B1 的抽取粒度是「专名清单」（name/desc/evidence），不含全字段（身份定位/外貌/境界…）。
 *    B2 会换成「两遍全字段抽取」，届时只需替换 extract 阶段的实现，draft/commit/UI 全不用改。
 */
import { aiExtractSettingEntities, aiSummarizeFormSettings } from '../aiTasks'
import { buildDraftBundle, bundleOf, type EntityBatch } from '../flow/draft'
import { formDraftRows } from '../flow/formMap'
import { createFlow, firstUnfinishedStage, type StageCtx } from '../flow/pipeline'
import type { DraftBundle, DraftRow, FlowProgress, FlowStage } from '../flow/types'
import { buildFormMaterial } from './formSummary'
import { persistSplitToChapters, planVolumes, type PersistResult } from './persist'
import { buildRelationDrafts, type RelationDraftResult, type RelationTabOutcome } from './relations'
import { chunkText, splitNovelText, type RawChapter, type SplitResult } from './split'

/** 阶段声明（weight 按实测耗时给：抽取占绝大部分；写入正文是纯 IO，给 1） */
export const BOOKBREAK_STAGES: FlowStage[] = [
  { id: 'split', label: '切分原文', weight: 1 },
  { id: 'persist', label: '写入正文', weight: 1 },
  { id: 'extract', label: '逐块抽取', weight: 8 },
  { id: 'draft', label: '整理草稿', weight: 1 },
  // 末尾**汇总一次**全书级设定（表单型：作品定位 / 世界设定 / 力量体系 …）。
  // 🔴 必须放在最后：它吃的是前面抽出来的实体，而且要"整本书看完再收敛成一份档案"
  //    —— 逐章增量写表单会越写越长、还覆盖作者手改（§3 冲突 3）。
  { id: 'worldview', label: '汇总全书设定', weight: 3 },
  // 末尾**整理关系**（人物关系 / 势力关系 两张表）。
  // 🔴 必须放在最后，且不能换成"逐章抽"：关系是**两两事实**，要同时定住 A、B 两人 + 对齐
  //    已有条目 + 判无序对（A-B 与 B-A 是同一条）。逐章抽只会抽出一地半截关系
  //    （原文写着「师父」——谁的师父在那一段里没有），所以必须整本看完再收一次。
  //    weight 3：它比 worldview 贵（两张表各一次调用），但比逐章抽取便宜得多。
  { id: 'relations', label: '整理关系', weight: 3 },
]

/**
 * 续跑信息 —— 中止时交回界面，界面原样存住；下次点「继续」把它传回 `resume` 即可接着跑。
 *
 * 🔴 为什么不能只靠"从某个阶段重跑"：拆书最耗时的是 `extract`（60 章书就是 60 次模型调用），
 *    而阶段内的循环没有断点 —— 从阶段头重跑等于把已抽的几十章**全部白跑一遍**，
 *    那这个功能就没有意义了。所以这里记的是**阶段内断点**（已完成多少个抽取单元 + 已抽到的批次）。
 */
export interface BookBreakResume {
  /** 状态机已完成的阶段产物（续跑时预置，前序阶段不必重跑） */
  bag: Record<string, unknown>
  /** 从哪个阶段继续（中止时正在跑的那个） */
  from: string
  /** 已完成的抽取单元数 —— `extract` 就从这个下标之后接着跑 */
  doneUnits: number
  /** 上次切分出的单元总数：**用来防止"改了原文还续跑"**（单元数对不上就不给续，避免抽出的内容错位） */
  totalUnits: number
  /** 已抽到的批次（按章合并过的） */
  batches: EntityBatch[]
  /** 给界面显示的一行说明 */
  label: string
}

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
  /**
   * 末尾是否汇总**全书级设定**（表单型：作品定位 / 世界设定 / 力量体系 …，**默认 true**）。
   * 它比逐章抽取多一次模型调用（几十秒），但这是需求里点名要覆盖的四类之一；
   * 不想要就在面板上关掉。
   */
  summarizeForms?: boolean
  /**
   * 末尾是否**整理关系**（人物关系 / 势力关系 两张表，**默认 true**）。
   *
   * 为什么默认开：关系是作者最难手工补的一块 —— 逐章抽取天然产不出来（见 `relations.ts`
   * 与 BOOKBREAK_STAGES 里的说明），而这两张表又是防「关系失忆 / 泄密穿帮」的底座。
   * 代价要如实说：**两张表各一次模型调用**，比逐章抽取便宜但多等一会儿；不想要就关掉。
   */
  organizeRelations?: boolean
  /** 中止信号（界面的「中止」按钮接它） */
  signal?: AbortSignal
  /** 进度回调 */
  onProgress?: (p: FlowProgress) => void
  /** 每抽完一个单元回调一次（界面即时显示抽到了什么） */
  onBatch?: (b: EntityBatch) => void
  /**
   * 续跑：把上次中止时拿到的 `BookBreakResume` 原样传回来。
   * 前序阶段会据此预置产物、`extract` 从已完成的单元之后接着跑。
   */
  resume?: BookBreakResume
  /** 中止时回头交一份续跑信息（界面存住即可显示「继续」） */
  onResume?: (r: BookBreakResume) => void
}

export interface BookBreakResult {
  split: SplitResult
  /** 原文写入正文的结果（开关关闭或没有可写内容时为 null） */
  persist: PersistResult | null
  batches: EntityBatch[]
  bundle: DraftBundle
  /**
   * 末尾汇总出的**全书级设定**草稿行（每张表单一行；关闭汇总或模型没产出时为空）。
   * 它们**同时已并入 `bundle.rows`**（界面统一勾选/落库）—— 这里单列一份是给面板做文案用
   * （如「另汇总了 3 张表的全书设定」），不参与落库判断，别当成"还没并入"。
   */
  formRows: DraftRow[]
  /**
   * 末尾整理出的**关系草稿行**（人物关系 / 势力关系；关闭或没整理出东西时为空）。
   * 与 `formRows` 同理：**同时也已并入 `bundle.rows`**，这里单列只为面板文案。
   */
  relationRows: DraftRow[]
  /** 关系整理逐表结果（哪张表整理出几条、有没有失败）——面板据此如实交代 */
  relationTabs: RelationTabOutcome[]
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
 * 续跑判定（纯函数，便于单测）：这次该从第几个抽取单元开始、要用哪些已有批次。
 *
 * 三种结果：
 * - `fresh`       首次运行（没有断点）→ 从头跑，无种子批次
 * - `resume`      断点有效 → 从 `doneUnits` 之后接着跑，装回上次抽好的批次
 * - `invalidated` 🔴 **断点失效**：上次抽了 N 块、这次切出来的单元数却不是 N —— 说明**原文改过了**。
 *                 继续按旧下标接下去会让抽出的内容与章节整体错位，所以**从零重抽**（宁慢勿错）。
 *
 * 🔴 返回的种子批次是**深拷贝**：直接交出 `resume.batches` 的引用会让抽取过程污染界面存的那份断点，
 *    下次续跑就带着上一次的中间态（表现在"越续越乱"）。
 */
export function planResume(
  unitsLen: number,
  resume?: BookBreakResume,
): { start: number; seedBatches: EntityBatch[]; reason: 'fresh' | 'resume' | 'invalidated' } {
  if (!resume || resume.doneUnits <= 0) return { start: 0, seedBatches: [], reason: 'fresh' }
  if (resume.totalUnits !== unitsLen) return { start: 0, seedBatches: [], reason: 'invalidated' }
  return {
    start: Math.min(resume.doneUnits, unitsLen),
    seedBatches: (resume.batches ?? []).map(b => ({ ...b, entities: [...b.entities] })),
    reason: 'resume',
  }
}

/**
 * 跑完整拆书管线。
 * @returns 结果；**返回 null 表示被中止**（此时不产出草稿，调用方据此提示）
 */
export async function runBookBreak(raw: string, opts: BookBreakOptions = {}): Promise<BookBreakResult | null> {
  const maxUnitChars = opts.maxUnitChars ?? DEFAULT_MAX_UNIT_CHARS
  const maxUnits = opts.maxUnits ?? DEFAULT_MAX_UNITS
  /** 阶段内断点：已完成多少个抽取单元（extract 每处理完一个就更新） */
  let doneUnits = opts.resume?.doneUnits ?? 0
  /** 本次切分出的单元总数 —— 中止时交回界面，用于"改了原文就别续跑"的校验 */
  let totalUnits = 0
  /** 已抽到的批次。跨阶段保留：中止时它就是续跑的起点（阶段没跑完时 bag 里是没有它的） */
  let partialBatches: EntityBatch[] = (opts.resume?.batches ?? []).map(b => ({ ...b, entities: [...b.entities] }))

  const flow = createFlow(BOOKBREAK_STAGES, {
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    // 续跑：把上次已完成阶段的产物预置进 bag，那些阶段就不必重跑
    ...(opts.resume?.bag ? { bag: opts.resume.bag } : {}),
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
    totalUnits = units.length
    // 续跑：决定从哪个单元开始、装回哪些批次（判定逻辑抽成纯函数 planResume，便于单测）
    const plan = planResume(units.length, opts.resume)
    const start = plan.start
    // 断点失效（原文改过）→ 已抽批次一并丢掉，别让上次的旧批次混进这次的结果
    if (plan.reason !== 'resume') { doneUnits = 0; partialBatches = [] }
    // 同章被细分成多块时，合并进同一个 EntityBatch（章标题/章号一致）
    const perChapter = new Map<number, EntityBatch>()
    for (const b of plan.seedBatches) perChapter.set(b.index, b)
    let entityCount = [...perChapter.values()].reduce((n, b) => n + b.entities.length, 0)
    if (start > 0) {
      ctx.report(start / Math.max(1, units.length), `续跑：已完成 ${start}/${units.length} 块，从第 ${start + 1} 块接着抽`)
    }

    for (let i = start; i < units.length; i++) {
      if (ctx.signal.aborted) break
      const u = units[i]
      ctx.report(i / Math.max(1, units.length), `${u.chapterTitle}（${i + 1}/${units.length}）`)
      let entities: Awaited<ReturnType<typeof aiExtractSettingEntities>> = []
      // B2 全字段抽取的输出是 B1 的好几倍，必须走流式（否则撞 180s 总超时墙）；
      // 这里把流式字节数做成「已收到 N 字」显示在节点时间线上，避免一行进度卡住不动。
      // 节流到每 ~120 字报一次：逐 token 上报会把 React 重渲染拖垮。
      let got = 0
      let reported = 0
      try {
        entities = await aiExtractSettingEntities(u.text, u.chapterTitle, {
          signal: ctx.signal,
          onToken: d => {
            got += d.length
            if (got - reported < 120 && got < 4096) return
            reported = got
            ctx.report(
              (i + 0.5) / Math.max(1, units.length),
              `${u.chapterTitle}（${i + 1}/${units.length}）· 已收到 ${got} 字`,
            )
          },
        })
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
      // 阶段内断点：处理完一块就记一块 —— 中途被中止也能从下一块接着跑
      doneUnits = i + 1
      partialBatches = [...perChapter.values()].sort((a, b) => a.index - b.index)
    }

    const batches = [...perChapter.values()].sort((a, b) => a.index - b.index)
    partialBatches = batches
    const note = truncated ? `（已达到上限 ${maxUnits} 块，剩余未处理）` : ''
    ctx.report(1, `${start > 0 ? '续跑后' : ''}共抽到 ${entityCount} 条实体${note}`)
    return batches
  })

  flow.on('draft', async (ctx: StageCtx) => {
    const batches = (ctx.bag.extract as EntityBatch[]) ?? []
    ctx.report(0.2)
    const bundle = await buildDraftBundle(batches, { rawText: raw })
    ctx.report(1, `整理出 ${bundle.stats.total} 条草稿`)
    return bundle
  })

  // ⑤ 汇总全书级设定（表单型）：吃前面抽出的实体 + 开篇样本，末尾**一次**收敛成一份档案。
  //    产出与条目型草稿同构的 DraftRow（每张表一行）→ 复用同一套勾选 / 预览 / 落库界面，
  //    作者不必"在 A 处确认条目、再到 B 处确认世界观"。
  flow.on('worldview', async (ctx: StageCtx) => {
    if (opts.summarizeForms === false) { ctx.report(1, '已关闭「汇总全书级设定」，跳过'); return null }
    const batches = (ctx.bag.extract as EntityBatch[]) ?? []
    const material = buildFormMaterial(batches, raw)
    if (!material.trim()) { ctx.report(1, '没有可用于汇总的材料，跳过'); return null }
    ctx.report(0.15, '汇总全书级设定…')
    let got = 0
    let reported = 0
    const values = await aiSummarizeFormSettings(material, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      // 收字回调同时就是**流式开关**（不传会撞 180s 总超时墙）
      onToken: d => {
        got += d.length
        if (got - reported < 400 && got < 8192) return
        reported = got
        ctx.report(0.6, `汇总全书级设定… 已收到 ${got} 字`)
      },
    })
    const rows = formDraftRows(values)
    ctx.report(1, rows.length ? `汇总出 ${rows.length} 张表的全书设定` : '模型没有产出可用的全书级设定')
    return rows
  })

  // ⑥ 整理关系（人物关系 / 势力关系）：**逐章抽取产不出来的那一块**，末尾一次收敛。
  //    产出的行与其它草稿同构 → 并进同一份 bundle，作者在一个界面里勾选、一次落库。
  flow.on('relations', async (ctx: StageCtx) => {
    if (opts.organizeRelations === false) { ctx.report(1, '已关闭「整理关系」，跳过'); return null }
    const batches = (ctx.bag.extract as EntityBatch[]) ?? []
    if (!batches.length) { ctx.report(1, '没有可依据的实体，跳过'); return null }
    ctx.report(0.05, '整理人物关系与势力关系…')
    const r = await buildRelationDrafts({
      batches,
      rawText: raw,
      ...(opts.signal ? { signal: opts.signal } : {}),
      onProgress: (ratio, detail) => ctx.report(ratio, detail),
    })
    const failed = r.perTab.filter(t => t.note)
    const dropped = r.perTab.reduce((n, t) => n + t.dropped, 0)
    const unproven = r.perTab.reduce((n, t) => n + t.unproven, 0)
    // 失败要如实说，并给出**可走的路**：表格页的「AI 整理」还能再补（那边可以自己指定章节）
    const note = failed.length ? `；${failed.map(t => `《${t.tabName}》失败`).join('、')}（可到该表用「AI 整理」重试）` : ''
    const dnote = dropped + unproven > 0
      ? `；另有 ${dropped + unproven} 条被丢掉（名字不在角色卡 / 势力名单里，或给不出原文依据 —— 多半是模型把势力、地点当成了人物，或凭空编了关系）`
      : ''
    ctx.report(1, r.rows.length ? `整理出 ${r.rows.length} 条关系${dnote}${note}` : `没有可新增的关系${dnote}${note}`)
    return r
  })

  const res = await flow.run(opts.resume?.from)
  if (res.status === 'cancelled') {
    // 交回续跑信息：已完成到哪个阶段 + **阶段内断点**（已抽完多少块、已抽到哪些批次）
    opts.onResume?.({
      bag: res.bag,
      from: firstUnfinishedStage(res.progress),
      doneUnits,
      totalUnits,
      batches: partialBatches,
      label: totalUnits ? `已完成 ${doneUnits}/${totalUnits} 个抽取单元` : '已完成部分阶段',
    })
    return null
  }
  if (res.status === 'error') throw new Error(res.error ?? '拆书失败')

  const base = res.bag.draft as DraftBundle
  const formRows = (res.bag.worldview as DraftRow[] | null) ?? []
  const relationRes = (res.bag.relations as RelationDraftResult | null) ?? null
  const relationRows = relationRes?.rows ?? []
  const merged = [...base.rows, ...formRows, ...relationRows]
  return {
    split: res.bag.split as SplitResult,
    persist: (res.bag.persist as PersistResult | null) ?? null,
    batches: (res.bag.extract as EntityBatch[]) ?? [],
    // 汇总出的表单行与整理出的关系行**并进同一份 bundle**：作者在一个界面里勾选、确认、落库。
    // 顺序＝界面分组顺序：实体 → 全书设定表单 → 人物关系/势力关系（关系天然排在最后读）。
    bundle: merged.length === base.rows.length ? base : bundleOf(merged),
    formRows,
    relationRows,
    relationTabs: relationRes?.perTab ?? [],
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
