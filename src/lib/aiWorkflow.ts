/**
 * 「创意写作」编排器 —— AI 创作工作流的串联层（方案见 `docs/2.2.0-全自动AI小说创作工作流方案.md`）。
 *
 * **两种起点**（2026-09-19 融合「AI 一键续写 + 设定补完」后）：
 * - `scratch`（从一句话想法从零写）：种子 → ①设定奠基 → **闸门①** → ②分卷大纲 → **闸门②** → ③逐章连写
 *   产出目标（`target`）在**起点**就定：「只做大纲规划」到闸门②确认即收工，正文阶段整段跳过。
 * - `continue`（接着项目已有内容往下写）：③逐章连写（设定补完按策略在每章末尾自动进行）
 *
 * 为什么合成一个编排器而不是两套：两条路线的**第③步是同一件事** —— 都是"按已有设定与上一章结尾
 * 往下写一章"，都用 `runAutoContinue`。差别只在前两步要不要跑（从零时需要先立设定与大纲）。
 * 合成一处之后，断点续跑、进度时间线、去 AI 味儿、设定补完策略这些能力两边自动共享。
 *
 * 四条设计要点：
 * 1. **不重造**：逐章连写直接用 `runAutoContinue`，它自带"字数校准 + 落库硬闸门 + 逐章人审回调 +
 *    设定补完"。本文件只负责"把阶段串起来 + 在闸门处停下来等人"。
 * 2. **闸门＝await**：`onBibleGate` / `onOutlineGate` 返回 Promise，编排器就停在那里等用户；
 *    这也是为什么它直接建在 `lib/flow` 的状态机上（状态机不需要感知"暂停"这件事）。
 * 3. **人和 AI 的分工**：闸门之前全是 AI 跑量，闸门处必须人定方向 —— 不接受"全自动无人值守"，
 *    那是方案里明确否掉的（AI 生成设定/大纲的质量波动，必须由人在落库前过一眼）。
 * 4. **按大纲写**：项目里已有《章节细纲》时，连写会自动按章号把当章细纲钉进 prompt 末段，
 *    让正文跟着大纲走而不是自由发挥（`continue` 起点因此也成了"继续推进已规划项目"的入口）。
 *
 * 🔴 写库只发生在两个闸门**通过之后**；用户放弃闸门 = 整条流程中止，不留半成品。
 * 🔴 `continue` 起点没有闸门：它不新建设定与大纲（那些要么已落库、要么由作者自己在表格页维护），
 *    正文落库发生在每章的「初稿采纳」之后。
 */
import { buildProjectContext } from './aiContext'
import { aiExtendOutline, aiGenerateBible, aiGenerateOutline, type OutlineResult } from './aiTasks'
import { sortChapters } from './chapterSeq'
import { writerBudgetFor } from './aiWriterBudget'
import { runAutoContinue, type ChapterDraft, type ContinueStrategy, type DraftDecision } from './autoContinue'
import * as db from './db'
import { commitDraftRows } from './flow/commit'
import { buildDraftBundle, defaultPicked } from './flow/draft'
import { resolveSlot } from './flow/fieldMap'
import { createFlow, firstUnfinishedStage, type StageCtx } from './flow/pipeline'
import type { CommitOutcome, DraftBundle, DraftRow, FlowProgress, FlowStage } from './flow/types'
import { uid } from './id'
import { chapterNoOf, outlineCardName, outlineEventKey } from './outlineCard'
import type { LedgerItem } from './settingLedger'
import type { Volume } from './types'

/** 阶段声明（weight 按实测耗时：连写占绝大部分） */
export const CREATIVE_STAGES: FlowStage[] = [
  { id: 'bible', label: '设定奠基', weight: 3 },
  { id: 'outline', label: '分卷大纲', weight: 2 },
  { id: 'draft', label: '逐章连写', weight: 12 },
]

/**
 * 「接着已有内容写」的阶段表 —— 只有连写这一步。
 *
 * 为什么不复用 CREATIVE_STAGES 再 `skipRest` 掉前两步：`skipRest` 是"跑到一半才发现不用跑"的
 * 表达（如闸门②选「只保存大纲」），而这里**一开始就知道**不用跑 —— 让它们以 `skipped` 出现在
 * 时间线上，作者会以为"这两个阶段被跳过了，是不是出问题了"。阶段表不同，就该用不同的表。
 */
export const CONTINUE_STAGES: FlowStage[] = [
  { id: 'draft', label: '逐章连写', weight: 12 },
]

/**
 * 「接着已有内容写」+ 要排细纲时的阶段表：续排细纲 → 逐章连写。
 *
 * 用它在两种情况下：① 产出目标选「只做大纲规划」（排完细纲即停，正文阶段由 skipRest 砍掉）；
 * ② 选「大纲 + 正文」且勾了「先往下续排细纲」。
 * 不排细纲时仍用 CONTINUE_STAGES（只有连写）—— 那是「作者已有细纲、直接写」的路径。
 */
export const CONTINUE_OUTLINE_STAGES: FlowStage[] = [
  { id: 'outline', label: '续排细纲', weight: 2 },
  { id: 'draft', label: '逐章连写', weight: 12 },
]

/**
 * 组装「续排细纲」的材料：正文进度 + 已有细纲尾部（供接续与模仿风格）+ 设定 / 总纲资料。
 *
 * 为什么要带「正文已写到」：细纲要接的是**正文**的下一章；只给细纲的话，模型会以为
 * 细纲里最后那章就是最新进度。
 */
async function buildExtendMaterial(
  outlines: Map<number, string>, lastTitle: string, fromNo: number,
): Promise<string> {
  const tail = [...outlines.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-6)
    .map(([no, t]) => `第${no}章\n${t}`)
    .join('\n\n')
  const digest = await buildProjectContext({ budget: await writerBudgetFor('outline-generate') })
    .then(r => r.text)
    .catch(() => '')
  return [
    `【正文已写到】${lastTitle || '（还没有正文）'}`,
    `【已有细纲（最后 6 章，供接续与模仿写法）】\n${tail || '（还没有细纲 —— 这是第一次往下排，请按设定资料与正文进度起排）'}`,
    `【设定资料与全书总纲】\n${digest || '（无）'}`,
    `【本次任务】接着往下排第 ${fromNo} 章起的细纲。`,
  ].join('\n\n')
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

/** 创作起点 */
export type CreativeMode = 'scratch' | 'continue'

/**
 * 本次创作的输入。
 * - `scratch`：`seed` 是一句话想法（设定奠基的唯一依据）
 * - `continue`：`intent` 是可选的情节概要（不填则严格承接上一章结尾）
 */
export interface CreativeRunInput {
  mode?: CreativeMode
  seed?: string
  intent?: string
}

export interface CreativeWritingOptions {
  /** 连写多少章（默认 10） */
  chapters?: number
  /** 每章目标字数（默认 2500） */
  targetWords?: number
  /** 分几卷（默认 1；仅 `scratch` 起点的分卷大纲阶段用） */
  volumes?: number
  /**
   * 仅 `continue` 起点：连写前是否先往下续排细纲（默认否＝按已有细纲直接写，即原行为）。
   * 「只做大纲规划」目标下无所谓 —— 那种情况一定会排（然后停在那里）。
   */
  extendOutlineFirst?: boolean
  /**
   * 产出目标（仅「从一句话创作」有意义）：
   *   `'full'`（默认）＝ 设定 → 大纲 → 逐章连写正文；
   *   `'outline'`      ＝ 只做设定与分卷大纲，**正文一个字都不写**。
   *
   * 为什么在起点定、而不是到闸门②再问：作者开跑前就知道自己要什么，不该被逼在
   * 看不到成品的时候猜。闸门只留「确认 / 放弃」。
   */
  target?: 'outline' | 'full'
  /** 连写时的设定更新策略（默认 add-only）。`confirm` 会走 `onSettingsCandidates` 征询作者 */
  strategy?: ContinueStrategy
  /** 连写时生成初稿后自动去 AI 味儿（可选） */
  deAi?: { enabled: boolean; prompt: string }
  /** 连写时是否按已落库的《章节细纲》写（默认是；没有细纲卡时自动退回自由发挥） */
  useOutline?: boolean
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
  const inp: Required<CreativeRunInput> = typeof input === 'string'
    ? { mode: 'scratch', seed: input, intent: '' }
    : { mode: input.mode ?? 'scratch', seed: input.seed ?? '', intent: input.intent ?? '' }
  const mode = inp.mode

  /** 这次总共打算写多少章（同时是续跑校验的基准：参数变了就不给续） */
  const plannedChapters = Math.max(1, Math.min(60, opts.chapters ?? 10))
  /** 续跑起点：已经写好多少章。参数对不上（或没给 resume）就不续，从零写 */
  const baseDone = opts.resume && opts.resume.totalChapters === plannedChapters && opts.resume.doneChapters > 0
    ? opts.resume.doneChapters
    : 0
  let doneChapters = baseDone

  // 阶段表决定这次跑什么：从零创作三步走，接着写只有连写一步。
  // （下面两个阶段执行体照常登记 —— 阶段表里没有它们时状态机根本不会去取，多登记无害。）
  // 阶段表决定这次跑什么：
  //   · 从零创作 → 设定奠基 → 分卷大纲 → 连写（target='outline' 时靠 skipRest 停在闸门②之后）
  //   · 接着写 + 要排细纲（只做大纲规划 / 勾了先排细纲）→ 续排细纲（→ 连写）
  //   · 接着写 + 不排细纲 → 只有连写（作者已有细纲时的路径）
  const stages = mode === 'continue'
    ? ((opts.target === 'outline' || opts.extendOutlineFirst) ? CONTINUE_OUTLINE_STAGES : CONTINUE_STAGES)
    : CREATIVE_STAGES
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

  flow.on('outline', async ctx => {
    // ── 「接着已有内容写」的细纲：**接着往下排**，不是从零排（从零那条走下面的原有实现）──
    if (mode === 'continue') {
      ctx.report(0.15, '读已有细纲与正文进度…')
      const outlines = await loadChapterOutlines()
      const chs = await db.getAllChapters().catch(() => [])
      const vols = await db.getAllVolumes().catch(() => [])
      const lastCh = sortChapters(vols, chs).slice(-1)[0]
      // 🔴 起点看**正文写到哪**，不是看细纲最大章号 —— 要写的是正文的下一章；
      //    细纲可能已经领先（那是作者自己排的），此时不该往后越排越远。
      const writtenNo = Math.max(0, ...chs.map(c => chapterNoOf(c.title) || 0))
      const fromNo = writtenNo + 1
      // 细纲已经盖住下一章 → 无需续排（此时「只做大纲规划」应当如实告诉作者「已经有了」）
      if (outlines.has(fromNo)) {
        ctx.report(1, `第 ${fromNo} 章起已有细纲，无需续排`)
        return { outline: { volumes: [], chapters: [] }, outlineCommit: null, outlineOnly: false, extendSkipped: true }
      }
      const material = await buildExtendMaterial(outlines, lastCh?.title ?? '', fromNo)
      ctx.report(0.45, `往下续排第 ${fromNo} ~ ${fromNo + plannedChapters - 1} 章细纲…`)
      let got = 0
      const result = await aiExtendOutline(material, fromNo, plannedChapters, {
        signal: ctx.signal,
        onToken: d => {
          got += d.length
          if (got % 400 < d.length) ctx.report(0.7, `续排细纲… 已收到 ${got} 字`)
        },
      })
      if (!result.chapters.length) throw new Error('模型没有产出细纲，请重试或换一个更大的模型')
      ctx.report(1, `${result.chapters.length} 章细纲（第 ${fromNo} 章起），等待确认…`)
      const ok = opts.onOutlineGate ? await opts.onOutlineGate(result) : true
      if (!ok) giveUp()
      const outlineCommit = await commitOutline(result, { signal: ctx.signal })
      const onlyOutline = (opts.target ?? 'full') === 'outline'
      if (onlyOutline) ctx.skipRest('（已选择：只做大纲规划）')
      return { outline: result, outlineCommit, outlineOnly: onlyOutline }
    }
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
    // 「只做大纲规划」：设定与大纲照常落库，连写阶段整段跳过。
    // 用 skipRest 而不是"不登记 draft"—— 目标在起点就定好了，阶段表早已定好；
    // 也不能记成 done（界面会谎称正文写完了）。
    const outlineOnly = (opts.target ?? 'full') === 'outline'
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
      },
      {
        signal: ctx.signal,
        onPhase: msg => ctx.report(done / remaining, msg),
        onChapterSaved: ch => {
          done++
          doneChapters = baseDone + done
          ctx.report(done / remaining, `已写 ${doneChapters}/${plannedChapters} 章`)
          opts.onChapterSaved?.(ch)
        },
        ...(opts.onChapterDraft ? { onChapterDraft: opts.onChapterDraft } : {}),
        ...(opts.onSettingsCandidates ? { onSettingsCandidates: opts.onSettingsCandidates } : {}),
        ...(outlines.size ? { outlineFor: (no: number) => outlines.get(no) } : {}),
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
