/**
 * 「创意写作」页签 —— AI 创作工作流的界面（**两种起点**）。
 *
 * - **从一句话创作**：设定奠基 →「闸门 · 设定」→ 分卷大纲 →「闸门 · 大纲」→ 逐章连写
 * - **接着已有内容写**：直接逐章连写（设定补完按策略在每章末尾进行，可当"继续推进项目"用）
 *
 * 两个闸门是刻意留的：AI 生成设定/大纲的质量波动必须由人过一眼再落库 —— 人定方向，AI 跑量。
 * 闸门用 Promise 实现（编排器 await 在那里等），所以本组件只需在点击时 resolve 掉它。
 *
 * 🔴 所有会话状态都在 `lib/creativeSession` 那个模块级 store 里，本组件**只订阅与展示**：
 *    切页签会卸载组件，但任务跑在 store 里，回来时进度、日志、闸门、断点原样都在。
 *    这也是"切页签内容就没了"那个问题的根治点（原来状态全在 useState 里）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eraser, Loader2, Play, Save, Sparkles, Square, Wand2 } from 'lucide-react'
import AIDataSourceNote from './AIDataSourceNote'
import { Button } from './Button'
import DraftReviewPanel from './DraftReviewPanel'
import HelpPopover from './HelpPopover'
import InterviewChat from './InterviewChat'
import { Modal } from './Modal'
import NewProjectAdvice from './NewProjectAdvice'
import WorkflowTimeline from './WorkflowTimeline'
import AutoTextarea from './AutoTextarea'
import { confirmDialog, showToast } from './dialogs'
import { useAIReady } from '../lib/useAIReady'
import { aiChatJson, loadActiveId, loadProviders, type AIProvider } from '../lib/ai'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { CREATIVE_SEED_SPEC, seedFromFilled } from '../lib/creativeSeed'
import {
  applyCandidates, applyRewrite, clearCreativeSession, clearSeed, consumeNotice, decideDraft,
  discardRewrite, hydrateCreativeSession, resolveGate, saveInputsNow, startChapterRewrite, startCreativeRun,
  stopChapterRewrite, stopCreativeRun, toggleCandidate,
  updateInputs, useCreativeSession, type CreativeLength, type CreativeTarget,
} from '../lib/creativeSession'
// 起点自动判定的依据（库里有没有大纲）；面板用它渲染状态行、决定输入框显隐
import { probeCreativeProject, type CreativeProjectProbe } from '../lib/aiWorkflow'
import { MAX_CHAPTERS_PER_VOLUME, MAX_OUTLINE_CHAPTERS, MAX_OUTLINE_VOLUMES } from '../lib/aiTasks'
import { DEAI_TEMPLATES, WORD_TOLERANCE, type ContinueStrategy } from '../lib/autoContinue'
import { CHAPTER_REWRITE_META, type ChapterRewriteAction } from '../lib/aiTasks'
import { listRewriteTree, type RewriteCandidate, type RewriteCandidateGroup } from '../lib/chapterRewrite'
import ChapterPicker from './ChapterPicker'
import { countWords } from '../lib/textStats'
import { adviseCapacity, type CapacityAdvice } from '../lib/modelCapacity'
import { getTavernSettings } from '../lib/tavern/settings'
import { MAX_CHAPTERS, advisePace, type PaceAdvice } from '../lib/writingPace'
import { foldVh } from '../lib/theme'
import NumberField from './NumberField'

/** 数值输入框：宽度与高度都对齐面板里那批 toggle（h-8）——
 *  原来只有 py-1（≈28px），和 h-8 的按钮排一行时高矮不齐（老大 2026-09-19 要求统一） */
const NUM_INPUT = 'h-8 w-20 rounded bg-ink-900 border border-ink-700 px-2 text-12 text-ink-100 outline-none focus:border-amber/50'

/**
 * 「已保存 · HH:MM」的时间格式。
 * 只到分钟：秒级数字一直在跳，看起来像界面在抽搐。完整时间放 title 里。
 */
function fmtSavedAt(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  const today = new Date()
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/**
 * 篇幅（老大 2026-09-20 要求）：先选篇幅，再选「这一次要产出什么」。
 * - **短篇**：一次跑完（大纲规划 / 大纲 + 正文），1 卷；
 * - **中长篇**：两阶段分开做（大纲规划 / 只生成正文），每阶段可反复执行。
 *
 * 为什么要有这一档：长篇不可能一次生成完（模型上下文与耗时都不允许），
 * 必须"排一批大纲 → 写一批正文 → 再排一批 → 再写一批"。短篇则没必要拆两趟。
 */
const LENGTH_META: Record<CreativeLength, { label: string; hint: string }> = {
  short: {
    label: '短篇',
    hint: '一次跑完：设定 → 分卷大纲 → 逐章连写（1 卷）。适合十万字以内的单本作品',
  },
  long: {
    label: '中长篇',
    hint: '分两阶段、每阶段可反复执行：先按「本批几卷 × 每卷几章」分批把大纲排完，再按批写正文。几十万到几百万字都走这条路',
  },
}
const LENGTHS: CreativeLength[] = ['short', 'long']

/** 各篇幅下可选「这一次要产出什么」（顺序即界面顺序）—— 中长篇没有"一次跑完"这一档 */
const TARGETS_BY_LENGTH: Record<CreativeLength, CreativeTarget[]> = {
  short: ['outline', 'full'],
  long: ['outline', 'draft'],
}

/**
 * 产出目标文案。
 *
 * 🔴 口径（2026-09-20）：**起点不再由作者选** —— 库里有没有大纲是客观事实，
 *    编排器自己判定（没大纲先跑设定奠基，已有就接着往下排）。
 *    作者要决定的只有"这一次要产出什么"。
 */
const TARGET_META: Record<CreativeTarget, { label: string; hint: string }> = {
  outline: {
    label: '只做大纲规划',
    hint: '排 / 续排分卷大纲与章节细纲，正文一个字不写。库里还没有大纲时会先做「设定奠基」把基础设定冷启动出来；已有则接着往下排',
  },
  full: {
    label: '大纲 + 正文',
    hint: '设定 → 分卷大纲 → 逐章连写，一次跑完（适合短篇）。库里已有大纲时本次只补正文，不会重排大纲',
  },
  draft: {
    label: '只生成正文',
    hint: '按已排好的分卷大纲与章节细纲逐章写正文，从「正文最后一章 + 1」接着写；本次写几章由你定',
  },
}

/** 整章改写的四种动作（顺序即界面顺序） */
const RW_ACTIONS: ChapterRewriteAction[] = ['polish', 'expand', 'condense', 'rewrite']

/**
 * 「整章改写」的选章列表（按卷分组，界面做成可搜索的卷章树）。
 * 空卷不出现在树里（见 listRewriteTree）。
 */
type RewriteTree = RewriteCandidateGroup[]

/**
 * 每章写完之后的「设定同步」策略 —— **两种起点共用同一组档位**（不是「接着写」专属）。
 *
 * 每章固定做三件事：① 抽取本章设定 → ② 新增的补登进设定表 → ③ 已登记且发生了变化的信息做更新。
 * 三个档位只决定 ②③ 的力度，不决定"做不做"。
 */
const STRATEGY_META: Record<ContinueStrategy, { label: string; hint: string }> = {
  'add-only': { label: '仅限新增', hint: '每章抽取后只补登新设定；已登记的设定一律不动（最稳）' },
  'confirm': { label: '候选确认', hint: '新设定与疑似重复项列出供你勾选；已登记项不改动' },
  'auto-update': { label: '自动更新', hint: '新设定自动补登；已登记实体的变化追加到备注类字段（不覆盖属性列）' },
}
const STRATEGIES: ContinueStrategy[] = ['add-only', 'confirm', 'auto-update']

/**
 * 改写纪律提示 —— 由「**动作 × 章位置**」两个维度共同决定，与提示词侧（aiTasks 的两条 RULE）是同一个矩阵。
 *
 * 为什么不能只看"是不是最新章"：润色本来就不增删情节与信息，被当成"可放开改写"是越权；
 * 而历史章的**扩写**最大的污染路径是"把描写升级成设定"（原文"一柄剑"→ 扩写成"师父所赠的断岳剑"），
 * 历史章的**精简**最大的风险是"删掉承载设定的句子"（"得自青云宗的储物戒"→"储物戒"）。
 */
const RW_SCOPE_NOTE: Record<ChapterRewriteAction, { latest: string; history: string }> = {
  polish: {
    latest: '这是项目最新章；但「润色」仍只换字不换事 —— 情节与信息不动，不因是最新章就放开走向。落库后会自动同步设定。',
    history: '这是历史章；「润色」只换字不换事，不动情节与信息，不会影响设定。',
  },
  expand: {
    latest: '这是项目最新章：补细节时可一并补设定信息；落库后会自动抽取 / 补登 / 更新设定表。',
    history: '这是历史章：🔴 描写层可以加（环境 / 动作 / 微表情 / 情绪），但不得新增专名、身份、来历、境界、器物名等设定信息 —— 那是凭空造设定，后文接不上。',
  },
  condense: {
    latest: '这是项目最新章：只删冗余重复与注水过渡，承载设定交代的句子照样保留。落库后会自动同步设定。',
    history: '这是历史章：🔴 只删冗余与注水过渡；承载设定交代的句子（专名 / 来历 / 境界 / 关系 / 器物来源）一律保留 —— 删掉后文就断了。',
  },
  rewrite: {
    latest: '这是项目最新章：四种动作里只有「改写」可以放开手脚（调节奏 / 重排场景 / 强化冲突 / 改写局部走向）。落库后会自动同步设定。',
    history: '这是历史章：只改叙述方式与文字，设定类内容一字不动、不新增剧情事件、不埋伏笔。',
  },
}

export default function CreativeWritingPanel() {
  const s = useCreativeSession()
  const inp = s.inputs
  const [interview, setInterview] = useState(false)
  const [cap, setCap] = useState<CapacityAdvice | null>(null)
  const { ready: aiReady } = useAIReady()
  // ── 整章改写：选章 / 选动作 / 补充要求 / 目标字数 ──
  const [tree, setTree] = useState<RewriteTree>([])
  const [rwChapter, setRwChapter] = useState('')
  const [rwAction, setRwAction] = useState<ChapterRewriteAction>('polish')
  const [rwReq, setRwReq] = useState('')
  const [rwWords, setRwWords] = useState(3000)
  /** 有长任务在跑（创作或改写）—— 互斥，避免两个任务抢模型 */
  const busy = s.running || !!s.rewrite?.running

  /**
   * 项目现状 —— **起点自动判定的依据**（2026-09-20：不再让作者手选起点）。
   * 用它渲染状态行、决定"要不要填一句话想法"，以及跑完之后把进度刷新过来。
   */
  const [probe, setProbe] = useState<CreativeProjectProbe | null>(null)
  const refreshProbe = useCallback(async () => {
    try { setProbe(await probeCreativeProject()) } catch { /* 读不到就不显示状态行，不打扰作者 */ }
  }, [])
  useEffect(() => { void refreshProbe() }, [refreshProbe])
  /** 任务从"在跑"变回"跑完" → 重新探一次（章数 / 细纲数都变了，状态行得跟上） */
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !s.running) void refreshProbe()
    wasRunning.current = s.running
  }, [s.running, refreshProbe])

  /**
   * 清空想法输入框 —— 破坏性（内容不可恢复），所以先确认再清。
   * ⚠️ 确认弹窗必须留在**组件层**：会话层在 lib 层，不得 import 组件（会被 importCycles 闸拦）。
   */
  /**
   * 切篇幅时**顺带把产出目标映射过去** —— 否则会留下一个「当前篇幅下不存在的档」：
   * 短篇选着「大纲 + 正文」，切到中长篇后那一档没了，界面却仍按 `full` 渲染提示文案
   * （hint 取的是 `TARGET_META[inp.target]`，与按钮列表是两套来源）→ 按钮一个都没高亮、
   * 文案却在讲一个不存在的档位。
   *
   * 映射按语义就近：「大纲 + 正文」（一次跑完）↔「只生成正文」（分两阶段跑），
   * 都是"要写正文"的那一档。
   */
  const onPickLength = (l: CreativeLength) => {
    const list = TARGETS_BY_LENGTH[l]
    const mapped: CreativeTarget = list.includes(inp.target)
      ? inp.target
      : inp.target === 'full' ? 'draft' : inp.target === 'draft' ? 'full' : list[0]
    updateInputs({ length: l, target: mapped })
  }

  const onClearSeed = async () => {
    const ok = await confirmDialog({
      title: '清空想法输入框？',
      message: '输入框里的这段想法会被清空，无法撤销。本项目的其它数据（章节 / 设定 / 大纲）不受影响。',
      confirmText: '清空',
      danger: true,
    })
    if (ok) await clearSeed()
  }

  // 读回本项目的上次会话（模块级只读一次；切项目时会自动重置）
  useEffect(() => {
    hydrateCreativeSession()
  }, [])

  /** 整章改写的选章树（新建 / 删除章节后点「刷新章节」重取） */
  const reloadChapters = async () => {
    try {
      const list = await listRewriteTree()
      setTree(list)
      // 选中的那章可能已被删掉 —— 清掉选择，别让作者对着一个不存在的章点开始
      const ids = new Set(list.flatMap(g => g.items.map(c => c.chapter.id)))
      setRwChapter(prev => (prev && ids.has(prev) ? prev : ''))
    } catch { /* 读不到就不铺选项，不打扰作者 */ }
  }
  useEffect(() => {
    void listRewriteTree()
      .then(list => setTree(list))
      .catch(() => { /* 忽略：空树就是「这项目还没章节」 */ })
  }, [])

  /** 展平成叙事顺序 —— 最后一个就是**最新章**（改写纪律不同，界面上要标出来） */
  const flatCands = useMemo(() => tree.flatMap(g => g.items), [tree])
  const latestId = flatCands.length ? flatCands[flatCands.length - 1].chapter.id : ''
  const pickInfo: RewriteCandidate | null = useMemo(
    () => flatCands.find(c => c.chapter.id === rwChapter) ?? null,
    [flatCands, rwChapter],
  )

  // store 里的提示 → 弹完即清（任务跑在 store 里，提示不能依赖本组件挂载）
  useEffect(() => {
    if (!s.notice) return
    showToast(s.notice.text, s.notice.kind)
    consumeNotice()
  }, [s.notice])

  // 模型能力（只读一次）：换算成「推荐章数 + 预计耗时」。
  // 🔴 口径见 writingPace.ts —— 连写是一章一次调用、单章只带设定与最近摘要，
  //    **不受模型窗口限制**，受限的是总耗时。
  useEffect(() => {
    void (async () => {
      try {
        const [providers, activeId, tav] = await Promise.all([
          loadProviders().catch(() => [] as AIProvider[]),
          loadActiveId().catch(() => null),
          getTavernSettings().catch(() => null),
        ])
        const p = providers.find(x => x.id === activeId) ?? null
        setCap(adviseCapacity(p, { numCtx: tav?.common.numCtx ?? 32768, contextBudget: tav?.common.contextBudget ?? 24000 }))
      } catch { /* 拿不到模型信息就不显示推荐，不影响创作本身 */ }
    })()
  }, [])

  const pace: PaceAdvice | null = useMemo(
    () => (cap ? advisePace(cap, { chapters: inp.chapters, targetWords: inp.words }) : null),
    [cap, inp.chapters, inp.words],
  )

  /** 「只做大纲规划」：不写正文，所以字数目标、去 AI 味儿、逐章确认这些连写设置都不该出现 */
  const outlineOnlyTarget = inp.target === 'outline'
  /** 本篇幅下可选的目标（顺序即界面顺序） */
  const targets = TARGETS_BY_LENGTH[inp.length]

  /** 库里有没有大纲 —— 起点、以及"要不要填一句话想法"，全看它 */
  const hasOutline = probe?.hasOutline === true
  /** 库里还没大纲 → 必须先给一句话想法（设定奠基的唯一依据） */
  const needSeed = !hasOutline
  /** 库里有没有章节细纲 —— 决定「按《章节细纲》写」这个开关要不要出现（没细纲时它是空操作） */
  const hasOutlineCards = (probe?.outlineCardCount ?? 0) > 0

  /** 本批大纲要排多少章（短篇＝1 卷，所以就是全书章数） */
  const batchTotal = inp.length === 'short' ? inp.chaptersPerVolume : inp.volumes * inp.chaptersPerVolume
  const batchOversize = batchTotal > MAX_OUTLINE_CHAPTERS

  /** 项目现状一行 —— 把"AI 会从哪开始"如实讲清楚（这就是起点自动判定的可见性） */
  const probeNote = (() => {
    if (!probe) return ''
    if (!probe.hasOutline) {
      return '这个项目还没有大纲 —— 本次会先做「设定奠基」把基础设定冷启动出来，再从第 1 卷第 1 章起规划。'
    }
    const head = `当前已有 ${probe.volumeCardCount} 卷大纲 · ${probe.outlineCardCount} 章细纲 · ${probe.chapterCount} 章正文`
    return outlineOnlyTarget
      ? `${head} → 本次从第 ${probe.maxOutlineNo + 1} 章起接着往下排`
      : `${head} → 本次从第 ${probe.chapterCount + 1} 章接着往下写`
  })()

  /** 可开始的条件：模型就绪；库里还没有大纲时，还得先写清楚想写什么 */
  const canStart = aiReady && (!needSeed || !!inp.seed.trim())
  const startLabel = s.resume
    ? '继续写作'
    : (outlineOnlyTarget
        ? (hasOutline ? '续排大纲' : '开始规划')
        : (hasOutline ? '接着写正文' : '开始创作'))

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="text-15 font-medium text-ink-100">创意写作</h1>
        <HelpPopover title="创意写作怎么用" pin>
          <div className="space-y-1.5 text-11 leading-relaxed text-ink-300">
            <p>这条流水线分<b>两个阶段</b>，各自都可以<b>反复执行</b>；先选<b>篇幅</b>，再选这一次要产出什么。</p>
            <p>· <b>短篇</b> —— 一次跑完：<b>大纲 + 正文</b>（设定奠基 → 分卷大纲 → 逐章连写），或者只做大纲规划。</p>
            <p>· <b>中长篇</b> —— 两阶段分开做（几十万字不可能一次生成完）：<br/>            &nbsp;&nbsp;① <b>只做大纲规划</b>：每批排「本批几卷 × 每卷几章」。库里没有大纲时先做设定奠基、从第 1 卷第 1 章起排；已有则接着往下排（起点＝已有细纲最大章号 + 1）。<br/>            &nbsp;&nbsp;② <b>只生成正文</b>：按已排好的大纲逐章写，从「正文最后一章 + 1」接着写，本次写几章由你定。</p>
            <p>· <b>起点不用你选</b>：库里有没有大纲是客观事实，AI 自己判定 —— 状态行里会写明「本次从第几章起」。</p>
            <p>· <b>两个人工闸门</b>（库里还没有大纲时才有）：设定草稿与大纲都必须你确认后才落库、才继续 —— 人定方向，AI 跑量。</p>
            <p>落库只发生在闸门通过之后（写正文时是在每章初稿<b>被采纳</b>之后）；在任何闸门处「放弃」，都不会留下半成品。</p>
            <p className="text-ink-500">每章流程：读上下文（含上一章结尾）→ 续写初稿 → 字数校准 →（开启时）去 AI 味儿 →（开启时）你确认采纳 → 编辑自检 → 抽取设定并补登 / 更新 → 下一章。项目里有《章节细纲》时，会按章号取当章细纲钉进提示词末段，让正文跟着大纲走。</p>
            <p className="text-ink-500">每卷的章号范围（如「第21-40章」）由系统按「每卷多少章」算好写进《分卷大纲》卡 —— 正文因此能自动落进正确的卷，不会全堆在最后一卷。</p>
            <p className="text-ink-500">想法还说不清时点<b>「对话引导」</b>：AI 按「题材 → 主角 → 冲突 → 世界」一路问，聊完自动把要点填回输入框。</p>
            <p className="text-ink-500">跑长任务时可以随时切去「正文编辑」看稿 —— 任务不会中断，切回来进度与断点都还在。</p>
            <AIDataSourceNote feature="creative-writing" compact />
          </div>
        </HelpPopover>
      </div>

      <NewProjectAdvice kind="creative-writing" />

      <section className="rounded-lg border border-ink-700 bg-ink-800/40 p-4">
        {/* ① 篇幅：短篇一次跑完；中长篇把大纲规划与正文生成分成两趟，各自可反复执行 */}
        <div className="flex flex-wrap items-center gap-1.5">
          {LENGTHS.map(l => (
            <Button key={l} variant="toggle" selected={inp.length === l} disabled={busy}
              title={LENGTH_META[l].hint} onClick={() => onPickLength(l)}
              className="px-3 h-8 rounded-lg text-12">
              {LENGTH_META[l].label}
            </Button>
          ))}
        </div>

        {/* ② 这一次要产出什么（可选项随篇幅变化） */}
        <div className="mt-3 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
          <div className="mb-1.5 text-12 text-ink-300">这一次要产出什么</div>
          <div className="flex flex-wrap gap-1.5">
            {targets.map(k => (
              <Button key={k} variant="toggle" selected={inp.target === k} disabled={busy}
                onClick={() => updateInputs({ target: k })} title={TARGET_META[k].hint}
                className="px-3 h-8 rounded-lg text-12">
                {TARGET_META[k].label}
              </Button>
            ))}
          </div>
          <p className="mt-1 text-10 leading-relaxed text-ink-500">{TARGET_META[inp.target].hint}</p>
          {/* 🔴 起点是自动判定的，所以必须把"AI 会从哪开始"写出来 —— 否则作者无从知道
              这一次到底会重跑设定、还是接着上次往下排。 */}
          {probeNote && <p className="mt-1 text-10 leading-relaxed text-amber">{probeNote}</p>}
        </div>

        {/* ③ 输入：库里还没有大纲 → 必须先给一句话想法（设定奠基的唯一依据）；
               已有大纲且要写正文 → 可以给一句可选的剧情方向 */}
        {needSeed ? (
          <div className="mt-3">
            {/* 一句话想法：给出**显式保存 / 清空**（老大 2026-09-20 要求）——
                原先只有自动防抖落盘：作者既看不到存没存，也没有一个能主动确认的动作。 */}
            <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-13 text-ink-200">一句话想法</span>
              <span className="text-10 text-ink-500"
                title={s.lastSavedAt ? `最近保存：${new Date(s.lastSavedAt).toLocaleString('zh-CN')}` : '改动会自动保存到本项目'}>
                {s.lastSavedAt ? `已保存 · ${fmtSavedAt(s.lastSavedAt)}` : '尚未保存'}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <Button size="sm" variant="secondary" disabled={busy}
                  title="立刻把当前输入保存到本项目（平时改动也会自动保存）"
                  onClick={() => void saveInputsNow()}>
                  <Save size={12} /> 保存
                </Button>
                <Button size="sm" variant="secondary" disabled={busy || !inp.seed.trim()}
                  title="清空输入框，重新写"
                  onClick={() => void onClearSeed()}>
                  <Eraser size={12} /> 清空
                </Button>
              </div>
            </div>
            <textarea
              value={inp.seed}
              onChange={e => updateInputs({ seed: e.target.value })}
              disabled={s.running}
              spellCheck={false}
              placeholder="例：一个靠吞噬他人修为续命的少年，在正道与魔道之间越走越深。"
              className="h-24 w-full resize-y rounded border border-ink-700 bg-ink-900 px-3 py-2 text-12 leading-relaxed text-ink-200 outline-none focus:border-amber/50 disabled:opacity-60"
            />
            <p className="mt-1.5 text-11 leading-relaxed text-ink-500">
              想法按项目保存：切页签、关掉软件再打开都还在。「保存」立刻写入，「清空」清掉重写。
            </p>
          </div>
        ) : inp.target !== 'outline' ? (
          <div className="mt-3">
            <div className="mb-1.5 text-13 text-ink-200">情节概要（可选，不填则严格承接上一章往下写）</div>
            <AutoTextarea
              value={inp.intent}
              onChange={v => updateInputs({ intent: v })}
              minHeight={60}
              maxHeight={160}
              disabled={s.running}
              placeholder="例如：陈渊在秘境深处发现上古遗迹，意外获得一卷残破功法……"
            />
            <p className="mt-1.5 text-11 text-ink-500 leading-relaxed">
              小提示：续写前，若先对前几章正文通读梳理一遍（或在编辑器里重新生成章节压缩摘要），
              能让 AI 更好地承接剧情、衔接更自然流畅。
            </p>
          </div>
        ) : null}

        {/* 规模参数（同一行）：大纲规划档问"排多大"，正文档问"写多少"。
            🔴 尺寸一律 h-8（与本面板其余 toggle 对齐 —— 混着 24/28px 会看着散）。 */}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-11 text-ink-400">
          {outlineOnlyTarget ? (
            <>
              {/* 中长篇才分批：短篇就是 1 卷，不劳作者去设 */}
              {inp.length === 'long' && (
                <label className="flex items-center gap-1.5">本批卷数
                  <NumberField value={inp.volumes} min={1} max={MAX_OUTLINE_VOLUMES} disabled={s.running}
                    title={`本批要排几卷：1 ~ ${MAX_OUTLINE_VOLUMES}（超出范围会调回最近的边界）`}
                    onChange={v => updateInputs({ volumes: v ?? 1 })} className={NUM_INPUT} />
                </label>
              )}
              <label className="flex items-center gap-1.5">{inp.length === 'long' ? '每卷章数' : '全书章数'}
                <NumberField value={inp.chaptersPerVolume} min={1} max={MAX_CHAPTERS_PER_VOLUME} disabled={s.running}
                  title={`每卷多少章：1 ~ ${MAX_CHAPTERS_PER_VOLUME}（硬指标，超出范围会调回最近的边界）`}
                  onChange={v => updateInputs({ chaptersPerVolume: v ?? 20 })} className={NUM_INPUT} />
              </label>
              <span className={batchOversize ? 'text-10 text-amber' : 'text-10 text-ink-500'}>
                本批共 {batchTotal} 章
                {batchOversize ? ` —— 超过单批上限 ${MAX_OUTLINE_CHAPTERS} 章，请拆成几批排` : ''}
              </span>
            </>
          ) : (
            <>
              <label className="flex items-center gap-1.5">本次写几章
                <NumberField value={inp.chapters} min={1} max={MAX_CHAPTERS} disabled={s.running}
                  title={`本次写几章：1 ~ ${MAX_CHAPTERS}（超出范围会调回最近的边界）`}
                  onChange={v => updateInputs({ chapters: v ?? 1 })} className={NUM_INPUT} />
              </label>
              <label className="flex items-center gap-1.5">每章目标字数
                <NumberField value={inp.words} min={800} max={8000} step={100} disabled={s.running}
                  title="每章目标字数：800 ~ 8000（超出范围会调回最近的边界）"
                  onChange={v => updateInputs({ words: v ?? 2500 })} className={NUM_INPUT} />
              </label>
              {/* 「用推荐值」紧跟每章目标字数（推荐值是按字数×模型窗口一起算出来的，
                  按钮文案里也写着调成几章，不会误读成"改字数"） */}
              {pace && inp.chapters !== pace.recommendedChapters && (
                <Button size="sm" variant="secondary" disabled={s.running} title={pace.model}
                  onClick={() => updateInputs({ chapters: pace.recommendedChapters })}>
                  用推荐值（{pace.recommendedChapters} 章）
                </Button>
              )}
            </>
          )}
          {/* 对话引导：只服务「一句话想法」那个输入框（库里已有大纲时用不上） */}
          {needSeed && (
            <Button size="sm" variant="secondary" disabled={s.running} onClick={() => setInterview(true)}>
              <Sparkles size={12} /> 对话引导
            </Button>
          )}
        </div>
        {!outlineOnlyTarget && pace && (
          <p title={pace.model} className={`mt-1 text-10 leading-relaxed ${pace.level === 'ok' ? 'text-ink-500' : 'text-amber'}`}>
            {pace.note}
          </p>
        )}

        {/* 连写设置（两种起点共用 —— 融合点之一：从零创作与接着写用的是同一套连写引擎，
            设定同步策略、去 AI 味儿、逐章确认两边完全一致）
            「只做大纲规划」不写正文，这些设置整块收起来，免得让人以为接下来还要连写 */}
        {!outlineOnlyTarget && (
        <details className="mt-3 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2" open>
          <summary className="cursor-pointer text-12 text-ink-200">连写设置（每章设定同步 · 去 AI 味儿 · 逐章确认）</summary>
          <div className="mt-2.5 space-y-3">
            <div>
              <div className="mb-1.5 text-12 text-ink-300">每章设定同步策略</div>
              <p className="mb-1.5 text-10 leading-relaxed text-ink-500">
                每章写完都会固定做三件事：① 抽取本章设定 → ② 新增的补登进设定表 → ③ 已登记且发生变化的信息做更新。
                下面三档只决定 ②③ 的力度，不决定做不做。
              </p>
              <div className="flex flex-wrap gap-1.5">
                {STRATEGIES.map(k => (
                  <Button key={k} variant="toggle" selected={inp.strategy === k} disabled={s.running}
                    onClick={() => updateInputs({ strategy: k })} title={STRATEGY_META[k].hint}
                    className="px-3 h-8 rounded-lg text-12">
                    {STRATEGY_META[k].label}
                  </Button>
                ))}
              </div>
              <p className="mt-1 text-10 leading-relaxed text-ink-500">{STRATEGY_META[inp.strategy].hint}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="toggle" selected={inp.deAiOn} disabled={s.running}
                onClick={() => updateInputs({ deAiOn: !inp.deAiOn })}
                className="px-3 h-8 rounded-lg text-12"
                title="开启后，AI 每章初稿会先按所选提示词润色一遍，再交你裁决">
                <Wand2 size={12} className="mr-1" />
                去 AI 味儿：{inp.deAiOn ? '已开启' : '已关闭'}
              </Button>
              <Button variant="toggle" selected={inp.reviewEach} disabled={s.running}
                onClick={() => updateInputs({ reviewEach: !inp.reviewEach })}
                className="px-3 h-8 rounded-lg text-12"
                title="开启时每章初稿弹窗让你决定采纳或重写；关闭＝全自动连写">
                逐章确认初稿：{inp.reviewEach ? '已开启' : '已关闭（全自动）'}
              </Button>
              {hasOutlineCards && (
                <Button variant="toggle" selected={inp.useOutline} disabled={s.running}
                  onClick={() => updateInputs({ useOutline: !inp.useOutline })}
                  className="px-3 h-8 rounded-lg text-12"
                  title="项目里存在《章节细纲》卡时，按章号取当章细纲写进提示词，让正文跟着大纲走">
                  按《章节细纲》写：{inp.useOutline ? '已开启' : '已关闭'}
                </Button>
              )}
            </div>

            {inp.deAiOn && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {DEAI_TEMPLATES.map(t => (
                    <Button key={t.id} variant="toggle" selected={inp.deAiTpl === t.id} disabled={s.running}
                      onClick={() => updateInputs({ deAiTpl: t.id })} title={t.desc}
                      className="px-3 h-8 rounded-lg text-12">
                      {t.label}
                    </Button>
                  ))}
                </div>
                {inp.deAiTpl === 'custom' && (
                  <AutoTextarea value={inp.deAiCustom} onChange={v => updateInputs({ deAiCustom: v })}
                    minHeight={50} maxHeight={140}
                    placeholder="粘贴你自己的去 AI 味儿提示词（例如：去掉说教感，多用短句……）" />
                )}
                <p className="text-10 leading-relaxed text-ink-500">
                  内置 3 套去味儿提示词（即网络常见「去 AI 味儿 skill」的本地化版本），可切换或自定义；
                  润色结果异常时自动保留原稿。
                </p>
              </div>
            )}
          </div>
        </details>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" solid disabled={s.running || !canStart}
            onClick={() => void startCreativeRun()}>
            {s.running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            {s.running ? '创作中…' : startLabel}
          </Button>
          {!s.running && s.resume && (
            <Button size="sm" variant="secondary" onClick={() => void startCreativeRun({ fromScratch: true })}>
              从头重写（丢弃断点）
            </Button>
          )}
          {s.running && (
            <Button size="sm" variant="danger" onClick={() => stopCreativeRun()}>
              <Square size={12} /> 中止
            </Button>
          )}
          {!s.running && s.result && (
            <Button size="sm" variant="secondary" onClick={clearCreativeSession}>清空本次记录</Button>
          )}
          {s.running && <span className="text-11 text-ink-400">{s.progress?.message ?? ''}</span>}
          {!aiReady && <span className="text-11 text-amber">{AI_DISABLED_HINT}</span>}
        </div>

        {!s.running && s.resume && (
          <div className="mt-1 text-11 leading-relaxed text-ink-400">
            上次中止在：{s.resume.label}。点「继续写作」从断点接着写，
            <b className="text-ink-300">已落库的章不会重写</b>；
            <span className="text-ink-500">改了「连写章数」会令断点失效（自动从头跑），避免剩余章数算错。</span>
          </div>
        )}
        <div className="mt-1.5 text-10 leading-relaxed text-ink-500">
          {outlineOnlyTarget
            ? (hasOutline
                ? `本次只做大纲规划：从第 ${(probe?.maxOutlineNo ?? 0) + 1} 章起接着往下排 ${batchTotal} 章（不写正文、不抽设定），确认后即收工。`
                : '本次只做大纲规划：先做设定奠基，再排分卷大纲与章节细纲。大纲确认后即收工、不写正文；两个闸门处都可放弃（放弃＝不留半成品）。')
            : (hasOutline
                ? '从项目里最后一章往下写，随时可中止；已落库的章不会被改写，写完去「正文编辑」逐章审阅。'
                : '本次会一次跑完：设定奠基 → 分卷大纲 → 逐章连写；随时可中止，写完去「正文编辑」逐章审阅。')}
        </div>
      </section>

      {/* 阶段进度：竖向节点时间线（跑完保留 —— 事后能看到每一步做了什么、花了多久、产出多少） */}
      <WorkflowTimeline progress={s.progress} running={s.running} summaries={s.summaries} className="mt-2" />

      {/* 闸门 · 设定：设定草稿 */}
      {s.bibleGate && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded border border-amber/30 bg-amber/15 px-1.5 py-0.5 text-11 text-amber">闸门 · 设定</span>
            <span className="text-13 text-ink-100">确认设定草稿</span>
            <span className="text-11 text-ink-500">
              只有勾选的条目会落库；可以改名称、也可以直接舍弃不要的
            </span>
            <div className="flex-1" />
            {/* 与下方 DraftReviewPanel 的「确认设定」（sm）同一决策组 —— 尺寸必须一致 */}
            <Button size="sm" variant="secondary" onClick={() => resolveGate(null)}>放弃本次创作</Button>
          </div>
          <DraftReviewPanel
            bundle={s.bibleGate}
            onConfirm={rows => resolveGate(rows)}
            confirmText="确认设定"
          />
        </div>
      )}

      {/* 闸门 · 大纲 */}
      {s.outlineGate && (
        <section className="mt-4 rounded-lg border border-amber/40 bg-ink-800/40 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded border border-amber/30 bg-amber/15 px-1.5 py-0.5 text-11 text-amber">闸门 · 大纲</span>
            <span className="text-13 text-ink-100">
              确认分卷大纲（{s.outlineGate.volumes.length} 卷 / {s.outlineGate.chapters.length} 章）
            </span>
            <div className="flex-1" />
            <Button size="sm" variant="secondary" onClick={() => resolveGate(false)}>放弃本次创作</Button>
            {/* 「要不要正文」在起点就定了，闸门只做确认 / 放弃 —— 按钮文案跟着目标变 */}
            <Button size="sm" variant="primary" solid onClick={() => resolveGate(true)}>
              {inp.target === 'outline' ? '确认大纲（不写正文）' : '保存大纲并开始连写'}
            </Button>
          </div>

          {/* 🔴 key 用序号而非卷标题（2026-09-19 六维审计 P2-11）：标题是模型产出的，同名卷
              理论上会撞 → React 按名复用节点、内容错位。这份列表是闸门预览、不存在重排，
              序号最稳（顺带避开「标题相同就报 key 重复」的控制台噪音）。 */}
          {s.outlineGate.volumes.map((v, vi) => (
            <div key={`vol-${vi}`} className="mb-2 rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
              <div className="text-12 text-ink-100">《{v.title}》</div>
              {v.positioning && <div className="mt-0.5 text-11 text-ink-300">{v.positioning}</div>}
              {v.events && <div className="mt-0.5 text-10 text-ink-500">事件链：{v.events}</div>}
              {v.ending && <div className="mt-0.5 text-10 text-ink-500">卷末：{v.ending}</div>}
            </div>
          ))}

          <div className="mt-2 max-h-72 overflow-y-auto rounded border border-ink-700 bg-ink-900/40">
            <ul>
              {s.outlineGate.chapters.map((c, ci) => (
                <li key={`ch-${ci}`} className="border-b border-ink-700/40 px-3 py-1.5 last:border-0">
                  <div className="text-11 text-ink-200">第{c.no}章 {c.title}</div>
                  {c.event && <div className="text-10 text-ink-400">{c.event}</div>}
                  {c.hook && <div className="text-10 text-ink-500">章末钩子：{c.hook}</div>}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-2 text-10 leading-relaxed text-ink-500">
            {inp.target === 'outline'
              ? '确认后会建「卷 + 分卷大纲卡 + 章节细纲卡」，本次到此为止（你选的是「只做大纲规划」，不写正文）；之后用「接着已有内容写」就能按细纲把正文补上。'
              : '确认后会建「卷 + 分卷大纲卡 + 章节细纲卡」，然后按细纲逐章连写正文；同名卷/细纲不会重复创建。'}
          </div>
        </section>
      )}

      {/* 连写日志 */}
      {s.log.length > 0 && (
        <div className="mt-3 max-h-40 overflow-y-auto rounded border border-ink-700 bg-ink-900/40 px-3 py-2">
          {s.log.map((l, i) => (
            <div key={i} className="text-11 text-ink-300">{l}</div>
          ))}
        </div>
      )}

      {/* 结果 */}
      {s.result && (
        <section className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="text-13 text-emerald-300">
            {s.result.wrote > 0 || s.result.outlineOnly ? '本次完成' : '本次结束'}
          </div>
          <ul className="mt-1.5 space-y-0.5 text-11 text-ink-300">
            {s.result.mode === 'scratch' && (
              <>
                <li>设定：{s.result.bibleTotal} 条草稿
                  {s.result.bibleCreated > 0 && ` → 新建 ${s.result.bibleCreated} 条`}
                </li>
                <li>大纲：{s.result.volumes} 卷 / {s.result.outlineChapters} 章</li>
              </>
            )}
            <li>
              {s.result.outlineOnly
                ? '正文：按你的选择只出大纲，未写正文'
                : `正文：${s.result.wrote} 章已落库`}
            </li>
          </ul>
          <div className="mt-1.5 text-10 text-ink-500">
            {s.result.outlineOnly
              ? '设定与大纲已落库（角色管理 / 世界构建 / 大纲规划）；想写正文时切到「接着已有内容写」，不必重跑设定与大纲。'
              : '去「正文编辑」看正文；设定与大纲分别在对应页签（角色管理 / 世界构建 / 大纲规划）。'}
          </div>
        </section>
      )}

      {/* 整章改写：对已有章节做整章级的润色 / 扩写 / 精简 / 改写 */}
      <section className="mt-4 rounded-lg border border-ink-700 bg-ink-900/40 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-13 text-ink-100">整章改写</span>
          <HelpPopover title="整章改写怎么用" width="24rem" size={12}>
            <div className="space-y-1.5 text-11 leading-relaxed text-ink-300">
              <p>挑一章，对<b>整章正文</b>做润色 / 扩写 / 精简 / 改写。与颉文姬的「选区改稿」不同 —— 那边面向一段、产出叫「建议段」；这里送进去的是<b>整章</b>，产出先给你过目，确认后才替换正文。</p>
              <p>改写时会一并送<b>上一章结尾</b>（约 1200 字），保证改完仍接得上；上面那栏「补充要求」可以告诉它往哪个方向改（例如「打斗写细一点」「对话再口语些」）。</p>
              <p>点「替换该章正文」之前，旧稿会自动存进<b>「时光机 · 本章版本历史」</b>，随时能恢复。章节标题、状态、所属卷都不会被改动。</p>
              <p>🔴 改写纪律由<b>「动作 × 章位置」</b>共同决定：<b>历史章</b>设定类内容一律冻结（润色只换字不换事；扩写只能加描写、不得新增专名与来历；精简不得删掉承载设定交代的句子；改写只改叙述方式）；<b>最新章</b>只有「改写」档可放开手脚，改完落库会自动抽取 / 补登 / 更新设定表。</p>
              <AIDataSourceNote feature="chapter-rewrite" compact />
            </div>
          </HelpPopover>
          <span className="text-11 text-ink-500">
            挑一章做整章润色 / 扩写 / 精简 / 改写 —— 结果先给你过目，确认后才替换正文（旧稿自动留档）
          </span>
          <div className="flex-1" />
          <Button size="xs" variant="secondary" disabled={busy} onClick={() => void reloadChapters()}>刷新章节</Button>
        </div>

        <div className="mt-2.5 space-y-2">
          <div>
            <div className="mb-1 text-11 text-ink-400">选一章（可搜章号 / 标题，点卷名折叠）</div>
            <ChapterPicker groups={tree} value={rwChapter} onChange={setRwChapter}
              disabled={busy} {...(latestId ? { latestId } : {})} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-11 text-ink-400">
          <div className="flex items-center gap-1.5">动作
            {RW_ACTIONS.map(k => (
              <Button key={k} variant="toggle" selected={rwAction === k} disabled={busy}
                onClick={() => setRwAction(k)} title={CHAPTER_REWRITE_META[k].hint}
                className="px-3 h-8 rounded-lg text-12">
                {CHAPTER_REWRITE_META[k].label}
              </Button>
            ))}
          </div>
          {CHAPTER_REWRITE_META[rwAction].needWords && (
            <label className="flex items-center gap-1.5">目标字数
              <NumberField value={rwWords} min={300} max={20000} step={100} disabled={busy}
                title="目标字数：300 ~ 20000（超出范围会调回最近的边界）"
                onChange={v => setRwWords(v ?? 3000)} className={NUM_INPUT} />
            </label>
          )}
          </div>
        </div>
        <p className="mt-1 text-10 leading-relaxed text-ink-500">{CHAPTER_REWRITE_META[rwAction].hint}</p>
        {/* 改写纪律：由「动作 × 章位置」共同决定（与提示词侧同一矩阵）—— 先说清楚，
            别让作者改完旧章才发现设定对不上，也别让人以为"最新章"就能放开润色 */}
        {pickInfo && (() => {
          const isLatest = pickInfo.chapter.id === latestId
          const tone = isLatest ? 'text-emerald-300' : (rwAction === 'polish' ? 'text-ink-400' : 'text-amber')
          return (
            <p className={`mt-1 text-10 leading-relaxed ${tone}`}>
              {isLatest ? RW_SCOPE_NOTE[rwAction].latest : RW_SCOPE_NOTE[rwAction].history}
            </p>
          )
        })()}

        <div className="mt-2">
          <AutoTextarea
            value={rwReq}
            onChange={setRwReq}
            minHeight={44}
            maxHeight={120}
            disabled={busy}
            placeholder="补充要求（可选）：例如「打斗写细一点」「对话再口语些」「把章末钩子改得更狠」"
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" solid disabled={!aiReady || !rwChapter || busy}
            // 🔴 文案别用「开始改写」：上面那排动作里就有一个叫「改写」，两者撞车 ——
            //    更糟的是选了「润色」时按钮仍说"开始改写"，读起来像要执行另一个动作。
            //    改成「开始生成 / 重新生成」（与 AITemplateFill、颉文姬的措辞一致），
            //    动作名只由上面那排承担，这里只说"开始产出结果"。
            title="按上面选的动作与「补充要求」处理这一章：先出结果给你过目，确认后才替换正文"
            onClick={() => void startChapterRewrite({ chapterId: rwChapter, action: rwAction, requirement: rwReq, words: rwWords })}>
            <Wand2 size={12} /> {s.rewrite ? '重新生成' : '开始生成'}
          </Button>
          {s.rewrite?.running && (
            <Button size="sm" variant="danger" onClick={() => stopChapterRewrite()}>
              <Square size={12} /> 中止
            </Button>
          )}
          {!aiReady && <span className="text-11 text-amber">{AI_DISABLED_HINT}</span>}
        </div>

        {s.rewrite && (
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-2 text-11">
              <span className="text-ink-200">
                {s.rewrite.no > 0 ? `第${s.rewrite.no}章 ` : ''}{s.rewrite.title}
              </span>
              {s.rewrite.running
                ? <span className="text-ink-400"><Loader2 size={11} className="inline animate-spin" /> 正在改写…</span>
                : <span className={s.rewrite.suspect ? 'text-amber' : 'text-emerald-300'}>
                    {s.rewrite.fromWords} → {countWords(s.rewrite.text)} 字{s.rewrite.suspect ? ' · 结果异常' : ''}
                  </span>}
            </div>
            <div className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-ink-700 bg-ink-900 p-3 text-12 leading-[1.9] text-ink-200">
              {s.rewrite.text || '（等待模型输出…）'}
            </div>
            {!s.rewrite.running && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="primary" solid disabled={!!s.rewrite.suspect}
                  onClick={() => void applyRewrite()}>替换该章正文</Button>
                <Button size="sm" variant="secondary" onClick={() => discardRewrite()}>丢弃这次结果</Button>
                {s.rewrite.suspect
                  ? <span className="text-10 text-amber">结果与期望的约 {s.rewrite.expectWords} 字相差过大（实际 {countWords(s.rewrite.text)} 字），已锁住替换 —— 请重新生成。</span>
                  : <span className="text-10 text-ink-500">替换前会自动把旧稿存进「时光机 · 本章版本历史」，可随时恢复。</span>}
              </div>
            )}
          </div>
        )}
      </section>

      {/* 每章初稿裁决（逐章确认开启时） */}
      <Modal
        open={!!s.draftAsk}
        onClose={() => decideDraft('abort')}
        width="2xl"
        title={s.draftAsk ? `第 ${s.draftAsk.d.index}/${s.draftAsk.d.total} 章初稿${s.draftAsk.d.attempt > 1 ? `（第 ${s.draftAsk.d.attempt} 稿）` : ''}` : '本章初稿'}
        footer={
          <>
            <Button variant="secondary" onClick={() => decideDraft('abort')}>停止任务</Button>
            <Button variant="secondary" onClick={() => decideDraft('rewrite')}>重写本章</Button>
            <Button variant="primary" solid onClick={() => decideDraft('accept')}>采纳本章</Button>
          </>
        }
      >
        {s.draftAsk && (() => {
          const d = s.draftAsk.d
          const lo = d.target - WORD_TOLERANCE
          const hi = d.target + WORD_TOLERANCE
          const ok = d.words >= lo && d.words <= hi
          return (
            <>
              <div className="mb-3 flex items-center gap-3 text-12">
                <span className={ok ? 'text-emerald-400' : 'text-amber'}>
                  {d.words} 汉字 {ok ? '· 已达标' : '· 超出容差'}
                </span>
                <span className="text-ink-500">目标 {d.target} ± {WORD_TOLERANCE}（{lo}~{hi}）</span>
                {inp.deAiOn && <span className="text-ink-300 border border-ink-700 rounded px-1.5 py-0.5">已去 AI 味儿</span>}
              </div>
              <p className="text-12 text-ink-400 mb-3">
                采纳后 AI 才会继续做编辑自检、修正与设定补登；点「重写本章」会丢弃本稿重新生成
                （含重新润色，不会留下垃圾章节，也不会写入数据库）。
                不想每章都停一次，可关掉上面的「逐章确认初稿」。
              </p>
              <div className="overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-700 bg-ink-900 p-3.5 text-13 leading-[1.9] text-ink-100"
                style={{ maxHeight: foldVh('52vh') }}>
                {d.body}
              </div>
            </>
          )
        })()}
      </Modal>

      {/* 设定补登确认（策略选「候选确认」时） */}
      <Modal
        open={!!s.candidatesAsk}
        onClose={() => applyCandidates(null)}
        title="设定补登确认"
        width="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => applyCandidates(null)}>跳过</Button>
            <Button variant="primary" onClick={() =>
              applyCandidates((s.candidatesAsk?.cands ?? []).filter(c => s.candidatesSelected.includes(c.key)))
            }>
              确认补登（{s.candidatesSelected.length}）
            </Button>
          </>
        }
      >
        <p className="text-12 text-ink-400 mb-3">
          勾选要补登到设定表 / 角色卡的条目。绿色=新设定，黄色=疑似已存在需你确认；已登记项不会改动。
        </p>
        <div className="max-h-80 overflow-auto space-y-2">
          {s.candidatesAsk?.cands.map(c => (
            <label key={c.key} className="flex items-start gap-2 rounded-lg border border-ink-700 bg-ink-900 p-2 cursor-pointer">
              <input type="checkbox" className="mt-1" checked={s.candidatesSelected.includes(c.key)}
                onChange={e => toggleCandidate(c.key, e.target.checked)} />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-13 text-ink-50 font-medium">{c.name}</span>
                  <span className="text-11 text-ink-400">{c.type}</span>
                  <span className={`text-11 px-1 rounded ${c.status === 'new' ? 'bg-emerald-900/40 text-emerald-300' : 'bg-amber-900/40 text-amber-300'}`}>
                    {c.status === 'new' ? '新设定' : '疑似重复'}
                  </span>
                </div>
                {c.desc && <div className="text-12 text-ink-300 mt-0.5 break-words">{c.desc}</div>}
              </div>
            </label>
          ))}
        </div>
      </Modal>

      {/* 对话引导：聊完把要点拼回「一句话想法」 */}
      {interview && (
        <InterviewChat
          subject={CREATIVE_SEED_SPEC.subject}
          spec={CREATIVE_SEED_SPEC}
          existing={inp.seed.trim() || undefined}
          callChat={(msgs, opts) => aiChatJson(msgs, { signal: opts.signal })}
          onClose={() => setInterview(false)}
          onApply={filled => {
            const text = seedFromFilled(filled)
            if (text) updateInputs({ seed: text })
            setInterview(false)
            showToast('已填入想法 —— 生成的是要点提纲，改完再开始创作')
          }}
          applyLabel="填入想法"
        />
      )}
    </div>
  )
}
