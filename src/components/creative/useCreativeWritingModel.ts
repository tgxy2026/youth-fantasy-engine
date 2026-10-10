/**
 * 创意写作 · 状态与 AI 链路（C1 · 2.4.2 自 CreativeWritingPanel.tsx 拆出）
 *
 * 🔴 纯搬家：state / handler 一字未改，只是把「组件体」搬成了 hook。
 *    组件侧 `const m = useCreativeWritingModel()`；各子区块只收 `m`。
 *    长任务状态本就在 lib/creativeSession 的模块级 store 里（切页签不丢），这里只做组织。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { useAIReady } from '@/lib/ai/useAIReady'
import { loadActiveId, loadProviders, AIProvider } from '@/lib/ai'
import { clearSeed, consumeNotice, hydrateCreativeSession, updateInputs, useCreativeSession, CreativeLength, CreativeTarget } from '@/lib/creative/creativeSession'
import { probeCreativeProject, CreativeProjectProbe } from '@/lib/ai/aiWorkflow'
import { MAX_OUTLINE_CHAPTERS, ChapterRewriteAction } from '@/lib/ai/aiTasks'
import { listRewriteTree, RewriteCandidate } from '@/lib/editor/chapterRewrite'
import { detectVolumeGap } from '@/lib/outline/outlineCard'
import { adviseCapacity, CapacityAdvice } from '@/lib/ai/modelCapacity'
import { getTavernSettings } from '@/lib/tavern/settings'
import { advisePace, PaceAdvice } from '@/lib/outline/writingPace'
import { TARGETS_BY_LENGTH, RewriteTree } from '@/components/creative/creativeWritingParts'

export function useCreativeWritingModel() {
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

  /**
   * 缺口：第一个**没排满**的卷（口径见 lib/outlineCard 的 `detectVolumeGap`）。
   *
   * 🔴 与编排器**用同一份输入、同一个函数**（`probe.volumeBounds` + `maxOutlineNo` + 每卷章数）——
   *    两处各算一遍必然漂移（界面说"还差 9 章"、实际排了 10 章），所以口径只留一个来源。
   */
  const gap = useMemo(
    () => (probe ? detectVolumeGap(probe.volumeBounds, probe.maxOutlineNo, inp.chaptersPerVolume) : null),
    [probe, inp.chaptersPerVolume],
  )
  /**
   * 缺口量（受**单批上限**夹住）—— 界面显示的章数必须与编排器实际会排的一致。
   * 🔴 规划「每卷 100 章」却只排到第 21 章时，缺口是 79 章、一次排不完；
   *    编排器只排前 `MAX_OUTLINE_CHAPTERS` 章，界面就不能说「补第 22-100 章」。
   */
  const gapTotal = gap ? gap.gapTo - gap.gapFrom + 1 : 0
  const gapWillFill = Math.min(MAX_OUTLINE_CHAPTERS, gapTotal)
  const gapFillTo = gap ? gap.gapFrom + gapWillFill - 1 : 0

  /** 项目现状一行 —— 把"AI 会从哪开始"如实讲清楚（这就是起点自动判定的可见性） */
  const probeNote = (() => {
    if (!probe) return ''
    if (!probe.hasOutline) {
      return '这个项目还没有大纲 —— 本次会先做「设定奠基」把基础设定冷启动出来，再从第 1 卷第 1 章起规划。'
    }
    const head = `当前已有 ${probe.volumeCardCount} 卷大纲 · ${probe.outlineCardCount} 章细纲 · ${probe.chapterCount} 章正文`
    // 🔴 缺口优先（老大 2026-09-20）：先把作者规划好的这一卷补满，不另开新卷。
    if (outlineOnlyTarget && gap) {
      return `${head} → 《${gap.title}》（第 ${gap.from}-${gap.to} 章）还差 ${gapTotal} 章，`
        + `本次先补完第 ${gap.gapFrom}-${gapFillTo} 章`
        + (gapWillFill < gapTotal ? `（单批上限 ${MAX_OUTLINE_CHAPTERS} 章，剩下的下次继续）` : '')
    }
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


  return {
    s, inp, interview, setInterview, cap, setCap, aiReady, tree, setTree, rwChapter, setRwChapter, rwAction, setRwAction, rwReq, setRwReq, rwWords, setRwWords, busy, probe, setProbe, refreshProbe, wasRunning, onPickLength, onClearSeed, reloadChapters, flatCands, latestId, pickInfo, pace, outlineOnlyTarget, targets, hasOutline, needSeed, hasOutlineCards, batchTotal, batchOversize, gap, gapTotal, gapWillFill, gapFillTo, probeNote, canStart, startLabel,
  }
}

export type CreativeWritingModel = ReturnType<typeof useCreativeWritingModel>
