/**
 * 颉文姬 · 状态与 AI 链路（C1 · 2.4.2 自 JieWenJi.tsx 拆出。
 *   2026-09-30 · 2.6.3 接入「跨页签任务中心」，见下）
 *
 * 🔴 纯搬家（C1）：state / handler 一字未改，只是把「组件体」搬成了 hook。
 *    组件侧 `const m = useJieWenJiModel(props)`；五个模式面板只收 `m`。红线段照旧：无模型时 AI 入口全部 disabled。
 *
 * 🔴🔴 2026-09-30（清单 #009 · 跨页签任务存活）：
 *    原先 11 个 AI 入口**共用一个 `abortRef`**，且 `useEffect(() => () => abortRef.current?.abort(), [])`
 *    —— 面板一卸载就 abort ⇒ 切页签 = 任务当场被杀（A 类失败模式的教科书案例）。
 *    现在全部改走 `useTaskRunner`（`lib/aiTaskCenter`）：
 *      · 任务在 **store 里**执行，与组件是否挂载无关 —— **切页签绝不中止**；
 *      · 结果落在任务中心，切回来（或重开面板）**照样在**，不会蒸发；
 *      · 只有作者点「停止」才 `stop()`。
 *    ⚠️ **对外形状零改动**：`m` 上暴露的字段名与类型与迁移前完全一致，5 个面板组件一字未改。
 *    ⚠️ `proofs` / `ledger` 仍是本地 state（它们要被 `replaceOne` / `setLedgerTargetTab` 就地改写），
 *       由 effect 把任务状态**按块**同步进来；同步按「任务引用是否变化」判定，避免 A 块进度
 *       更新时把 B 块 `replaceOne` 的重锚定结果覆盖掉。
 */
import { writerBudgetFor } from '@/lib/ai/aiWriterBudget'
import { useEffect, useRef, useState } from 'react'
import { buildProjectContext, getContinuationSources } from '@/lib/ai/aiContext'
import { checkContinuationFocus, formatGap } from '@/lib/audit/evidenceGate'
import { styleContextForAI } from '@/lib/ai/styleAudit'
import { activeFingerprintNote } from '@/lib/ai/styleFingerprint'
import { aiEditorDiagnosis, aiChapterReview, aiOocCheckWithStatus, aiRewritePassage, aiContinuationAdvice, aiContinuePassage, aiPleasureCheck, aiOpeningCheck, aiProofreadText, aiProofreadLogic, aiBriefing, aiExtractSettingEntities, EditorDiagnosis, ChapterReview, OocFinding, RewriteResult, ContinuationAdvice, PleasureReport, OpeningReport, ProofreadIssue, BriefingReport } from '@/lib/ai/aiTasks'
import { loadRegistry, classify, commitEntities, CARD_TABS, LedgerItem } from '@/lib/settings/settingLedger'
import * as db from '@/lib/db'
import { collectPostProcess, applyPostProcess, type PostProcessItem } from '@/lib/outline/chapterPostProcess'
import { readImpact, clearImpact, type ImpactMark } from '@/lib/outline/futureImpact'
import { useAIReady } from '@/lib/ai/useAIReady'
import { LS_SPRITE_ENABLED } from '@/lib/constants'
import { useTaskRunner, chapterOwned, taskChapter, type ChOwned, type ChProgress } from '@/lib/ai/aiTaskCenter'
import { showToast } from '@/components/dialogs/dialogs'
import type { Props } from '@/components/jiewenji/jieWenJiParts'
import { Mode, ProofScope, PROOF_ORDER, PROOF_META, ProofState, blankProof, CONTINUE_PICKS } from '@/components/jiewenji/jieWenJiParts'

/** 校对返回（文字层 / 逻辑层同形状）：逐条问题 + 已扫 / 跳过数 */
type ProofreadOutcome = { issues: ProofreadIssue[]; scanned: number; skipped: number }
/** 校对进度（喂给 `onProgress`） */
type ProofProgress = ChProgress & { done: number; total: number }

/**
 * 续写（2.9.2 · ③）：本章正文只带**末尾**这么多字做衔接 ——
 * 续写要的是「接着最后一句往下写」，整章发过去既费预算又没必要。
 */
const CONT_BODY_TAIL_CHARS = 3000
/** 续写面板默认勾选的资料（与 `CONTINUE_PICKS.def` **同源**，杜绝两处各写一份） */
const CONT_DEFAULT_PICKS = CONTINUE_PICKS.filter(p => p.def).map(p => p.key)

export function useJieWenJiModel(props: Props) {
  const { content, openingText, getSelectionText, getSelectionRange, onApplyAdvice, onApplyContent, summary, chapterTitle, onLedgerCommitted, focusChapterId } = props
  const { ready: aiReady } = useAIReady()
  /**
   * 🔴🔴 章节归属键（2026-10-01 六维审计 P1）：`useTaskRunner` 按 (ownerTab, kind) 取**最近一条**任务
   *    （任务中心不支持按业务键取历史）—— 于是 A 章跑完诊断再切到 B 章，B 章面板会把 A 章的报告
   *    当成本章的（跨章串报告）。对策：**发起时把章节戳盖进 progress/result**，取值只放行「归属
   *    == 当前章」的那份。`focusChapterId` 即 `active.id`（本章），单章场景恒定 ⇒ 零变化。
   *    ⚠️ 中途上报进度必须带上 `ch`，否则会把章节戳冲掉（见 aiTaskCenter 的「章节归属」段）。
   */
  const ch = focusChapterId ?? ''
  // 右侧 Q 版精灵开关（全局，localStorage 持久化 + 事件通知 App）
  const [spriteOn, setSpriteOn] = useState(() => localStorage.getItem(LS_SPRITE_ENABLED) !== '0')
  const toggleSprite = () => {
    const next = !spriteOn
    setSpriteOn(next)
    localStorage.setItem(LS_SPRITE_ENABLED, next ? '1' : '0')
    window.dispatchEvent(new CustomEvent('jiewenji:sprite-setting', { detail: next }))
    showToast(next ? '右侧精灵已显示' : '右侧精灵已隐藏（仍可从工具栏打开 AI 编辑）', 'success')
  }
  const [mode, setMode] = useState<Mode>('clinic')
  /** 校对模式：完整=喂全文（准/慢/费 token）；简略=只喂「章节压缩摘要」（快/省 token） */
  /** 校对范围恒为完整正文（喂压缩摘要的简略模式会误替换正文，已移除） */
  /** 综合诊断模式：同上，简略模式也用压缩摘要，避免长文反复烧 token */
  const [diagMode, setDiagMode] = useState<'full' | 'brief'>('full')

  // ============ 诊室：AI 综合诊断 ============
  const diagT = useTaskRunner<ChOwned<EditorDiagnosis>, ChProgress>({ ownerTab: 'editor', kind: 'jiewenji-diagnosis', title: '颉文姬 · AI 综合诊断' })
  const diag: { loading: boolean; data?: EditorDiagnosis; error?: string } = chapterOwned(diagT, ch)

  const runDiag = () => {
    if (!aiReady || diagT.running) return
    const useBrief = diagMode === 'brief'
    const diagText = useBrief ? (summary?.trim() || '') : content
    let brief = useBrief
    if (useBrief && !diagText) {
      showToast('本章还没填「章节压缩摘要」，已自动改用完整正文诊断', 'info')
      setDiagMode('full')
      brief = false // 已回退到完整正文，后续按 full 处理，不能用已被异步改掉的 useBrief
    }
    showToast('AI 综合诊断已启动，耗时 30–90 秒属正常，并非卡死，请耐心等待', 'info')
    const text = brief ? diagText : content
    const textKind: 'summary' | 'full' = brief ? 'summary' : 'full'
    diagT.run(async job => {
      job.progress({ ch })
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('jiewenji-diagnosis'), focusChapterId })
      return { ch, v: await aiEditorDiagnosis(ctx.text, text, { signal: job.signal, textKind }) }
    })
  }

  // ============ 诊室：AI 校对（文字层 / 逻辑层两块） ============
  // 两块结果各存一份：分别跑、分别看，一块的进度与报错不影响另一块。
  // 迁移前「同一时刻只跑一块」是因为共用 `abortRef`；现在每块自带独立任务，互不干扰。
  const [proofs, setProofs] = useState<Record<ProofScope, ProofState>>({
    text: blankProof(), logic: blankProof(),
  })
  const textProofT = useTaskRunner<ChOwned<ProofreadOutcome>, ProofProgress>({ ownerTab: 'editor', kind: 'jiewenji-proof-text', title: '颉文姬 · 文字校对' })
  const logicProofT = useTaskRunner<ChOwned<ProofreadOutcome>, ProofProgress>({ ownerTab: 'editor', kind: 'jiewenji-proof-logic', title: '颉文姬 · 逻辑审校' })
  const propsRunning = textProofT.running || logicProofT.running

  /**
   * 把两块校对任务的状态**按块**同步进 `proofs`。
   * 🔴 只在「该块任务引用变化」时才重写那一块 —— 否则 A 块进度更新会把 B 块
   *    `replaceOne` 刚做完的重锚定结果覆盖掉（切到另一块再点就成了「定位失败」）。
   */
  const lastProofTask = useRef<Record<ProofScope, { task: unknown; ch: string }>>({
    text: { task: null, ch: '' }, logic: { task: null, ch: '' },
  })
  const textProofTask = textProofT.task
  const logicProofTask = logicProofT.task
  useEffect(() => {
    const patches: Partial<Record<ProofScope, ProofState>> = {}
    for (const scope of PROOF_ORDER) {
      const task = scope === 'text' ? textProofTask : logicProofTask
      const sig = lastProofTask.current[scope]
      if (sig.task === task && sig.ch === ch) continue
      lastProofTask.current[scope] = { task, ch }
      // 🔴 归属键：不是本章的任务 ⇒ 本块当作没跑过（换章后不显示上一章的结果 / 进度）
      if (!task || taskChapter(task) !== ch) { patches[scope] = blankProof(); continue }
      if (task.status === 'running') {
        patches[scope] = { ...blankProof(), loading: true, progress: (task.progress as ProofProgress | null) ?? { ch, done: 0, total: 0 } }
      } else if (task.status === 'done') {
        const r = task.result?.v
        patches[scope] = { ...blankProof(), done: true, issues: r?.issues ?? [], scanned: r?.scanned ?? 0, skipped: r?.skipped ?? 0 }
      } else if (task.status === 'failed') {
        patches[scope] = { ...blankProof(), done: true, error: task.error }
      } else {
        // 作者主动停止：与迁移前一致 —— 不当作失败（中止时逐条结果本就尚未回传，issues 必为空）
        patches[scope] = { ...blankProof(), done: true, cancelled: true }
      }
    }
    if (Object.keys(patches).length) setProofs(prev => ({ ...prev, ...patches }))
  }, [textProofTask, logicProofTask, ch])

  /**
   * 替换单条校对结果：优先用 AI 标注位置，替换后把**两块**的其余问题都按位移重锚定
   *  （重叠/失效的置空，走全文定位兜底）。只重锚定自己那块的话，切到另一块再点就是"定位失败"。
   */
  const replaceOne = (scope: ProofScope, iss: ProofreadIssue) => {
    let idx = -1
    if (iss.at != null && content.slice(iss.at, iss.at + iss.quote.length) === iss.quote) idx = iss.at
    else idx = content.indexOf(iss.quote)
    if (idx < 0) { showToast('定位失败：原文可能已改动', 'error'); return }
    const delta = iss.fix.length - iss.quote.length
    const next = content.slice(0, idx) + iss.fix + content.slice(idx + iss.quote.length)
    onApplyContent?.(next)
    setProofs(prev => {
      const out = { ...prev }
      for (const k of PROOF_ORDER) {
        out[k] = {
          ...prev[k],
          issues: prev[k].issues
            .filter(i => !(k === scope && i === iss))
            .map(i => {
              if (i.at == null) return i
              // 替换点之后的坐标整体位移；之前或重叠的按新文本校验，失效则置空，下次替换走 indexOf 兜底
              const na = i.at > idx ? i.at + delta : i.at
              return next.slice(na, na + i.quote.length) === i.quote ? { ...i, at: na } : { ...i, at: undefined }
            })
            .sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
        }
      }
      return out
    })
  }

  const runProofread = (scope: ProofScope) => {
    if (!aiReady || propsRunning) return
    // 只校对完整正文。曾经提供过「喂压缩摘要」的简略模式，但校对结果要按 quote
    // 在正文里定位替换，摘要文字在正文里定位不到、还会误替换无辜同文——已移除。
    const text = content
    showToast(`AI 校对已启动（${PROOF_META[scope].label}），篇幅较大时耗时数十秒属正常，并非卡死，请耐心等待`, 'info')
    const tk = scope === 'text' ? textProofT : logicProofT
    tk.run(async job => {
      job.progress({ ch, done: 0, total: 0 }) // 🔴 章节戳第一行盖（失败/中止时没有 result 可查）
      // 🔴 逻辑层才读设定资料；文字层不读 —— 少注入几千字，出结果更快，
      //    也避免模型"拿设定去猜人名是不是写错"这类误报。
      let ctxText = ''
      if (scope === 'logic') {
        try { ctxText = (await buildProjectContext({ budget: await writerBudgetFor('jiewenji-proofread'), focusChapterId })).text } catch { /* 拿不到设定资料就少带一段，不阻断 */ }
      }
      const run = scope === 'text' ? aiProofreadText : aiProofreadLogic
      const res = await run(text, {
        context: ctxText,
        signal: job.signal,
        onProgress: (d, t) => job.progress({ ch, done: d, total: t }), // ⚠️ 带 ch，别把章节戳冲掉
      })
      return { ch, v: res }
    })
  }
  const stopProofread = () => { textProofT.stop(); logicProofT.stop() }

  // ============ 补登：本章新增设定实体 ============
  // AI 只负责「从正文抽候选」，是否已登记一律交给 settingLedger 做确定性比对。
  const ledgerT = useTaskRunner<ChOwned<LedgerItem[]>, ChProgress>({
    ownerTab: 'editor', kind: 'jiewenji-ledger', title: '颉文姬 · 设定补登抽取',
    writes: ['settings'], // 抽出的实体最终会补登进设定表
  })
  const [ledger, setLedger] = useState<{
    loading: boolean; items: LedgerItem[]; error: string; scannedAt: number
  }>({ loading: false, items: [], error: '', scannedAt: 0 })
  /** 勾选准备补登的条目 key（默认只勾「待补登」） */
  const [ledgerPicked, setLedgerPicked] = useState<Set<string>>(new Set())
  const [ledgerSaving, setLedgerSaving] = useState(false)

  /** 任务状态 → `ledger`（只在任务引用变化时写；items 之后可被作者就地改写归属） */
  const lastLedgerTask = useRef<{ task: unknown; ch: string }>({ task: null, ch: '' })
  useEffect(() => {
    const task = ledgerT.task
    const sig = lastLedgerTask.current
    if (sig.task === task && sig.ch === ch) return
    lastLedgerTask.current = { task, ch }
    // 🔴 归属键：不是本章的任务 ⇒ 补登结果当空（换章后不列出上一章抽出的实体）
    if (!task || taskChapter(task) !== ch) {
      setLedger({ loading: false, items: [], error: '', scannedAt: 0 }); setLedgerPicked(new Set()); return
    }
    if (task.status === 'running') { setLedger({ loading: true, items: [], error: '', scannedAt: 0 }); return }
    if (task.status === 'done') {
      const items = task.result?.v ?? []
      // 默认只勾「待补登」：已登记和疑似重复不该被重复写入
      setLedger({ loading: false, items, error: '', scannedAt: Date.now() })
      setLedgerPicked(new Set(items.filter(i => i.status === 'new').map(i => i.key)))
      if (items.length === 0) showToast('本章没有抽出需要登记的设定实体', 'success')
      return
    }
    if (task.status === 'failed') { setLedger({ loading: false, items: [], error: task.error, scannedAt: 0 }); return }
    // 已中止：保留原有条目，仅收掉 loading
    setLedger(s => ({ ...s, loading: false }))
  }, [ledgerT.task, ch])

  const runLedger = () => {
    if (!aiReady || ledgerT.running) return
    if (!content.trim()) { showToast('本章正文还是空的，没有可抽取的内容', 'info'); return }
    const title = chapterTitle ?? ''
    ledgerT.run(async job => {
      job.progress({ ch })
      const entities = await aiExtractSettingEntities(content, title, { signal: job.signal })
      const reg = await loadRegistry()
      return { ch, v: classify(entities, reg) }
    })
  }

  /** 人物专用：改一下要归入哪张角色卡（AI 只是建议，作者说了算） */
  const setLedgerTargetTab = (key: string, tabId: string) =>
    setLedger(s => ({ ...s, items: s.items.map(i => (i.key === key ? { ...i, targetTabId: tabId } : i)) }))

  const commitLedger = async () => {
    const picked = ledger.items.filter(i => ledgerPicked.has(i.key) && i.status === 'new')
    if (picked.length === 0 || ledgerSaving) return
    setLedgerSaving(true)
    try {
      // 3.2.0 · WT2：补登落点按有效模板解析（作者改名/同义自建字段后仍写对字段）
      const r = await commitEntities(picked, chapterTitle ?? '', { pid: db.getCurrentProjectId() })
      if (r.created > 0) {
        showToast(`已补登 ${r.created} 条设定，去对应表里补完细节即可${r.failed.length ? `（${r.failed.length} 条失败）` : ''}`, 'success')
        onLedgerCommitted?.(r.created)
        // 重新比对：刚写入的条目应变为「已登记」
        const reg = await loadRegistry()
        setLedger(s => ({ ...s, items: classify(s.items, reg) }))
        setLedgerPicked(new Set())
      } else if (r.failed.length > 0) {
        showToast(`补登失败：${r.failed.join('、')}`, 'error')
      }
    } finally {
      setLedgerSaving(false)
    }
  }

  /** 跳到已登记条目所在页签核对（角色卡没有行高亮机制，只跳页签） */
  const jumpToEntry = (tabId: string, rowId?: string) => {
    const isCard = (CARD_TABS as readonly string[]).includes(tabId)
    window.dispatchEvent(new CustomEvent('yfe:navigate', {
      detail: isCard || !rowId ? tabId : { tabId, rowId },
    }))
  }

  // ============ 章后整理（3.0 · W2-1）：四类变化 + 未来影响 ============
  // 与「补登」的分工：「补登」只管设定实体（事实）；这里一次过四类，
  // 并显示「未来计划已被上游变化波及」的标记（章纲里本章之后的条目）。
  const postT = useTaskRunner<ChOwned<PostProcessItem[]>, ChProgress>({
    ownerTab: 'editor', kind: 'jiewenji-post', title: '颉文姬 · 章后整理',
    writes: ['settings'], // 采纳后写入设定表 / 角色卡 / 章节总表
  })
  const [post, setPost] = useState<{
    loading: boolean; items: PostProcessItem[]; error: string; scannedAt: number
  }>({ loading: false, items: [], error: '', scannedAt: 0 })
  /** 勾选待整理的条目 key（默认勾「有变化」与「未登记」两类） */
  const [postPicked, setPostPicked] = useState<Set<string>>(new Set())
  const [postSaving, setPostSaving] = useState(false)
  /** 未来影响标记：章纲里「本章之后」的计划被上游变化波及 */
  const [impacts, setImpacts] = useState<ImpactMark[]>([])

  const loadImpacts = () => { readImpact().then(setImpacts).catch(() => setImpacts([])) }
  useEffect(() => { if (mode === 'post') loadImpacts() }, [mode])

  /** 任务状态 → `post`（只在任务引用变化时写；与 ledger 同一套「归属键」纪律） */
  const lastPostTask = useRef<{ task: unknown; ch: string }>({ task: null, ch: '' })
  useEffect(() => {
    const task = postT.task
    const sig = lastPostTask.current
    if (sig.task === task && sig.ch === ch) return
    lastPostTask.current = { task, ch }
    if (!task || taskChapter(task) !== ch) {
      setPost({ loading: false, items: [], error: '', scannedAt: 0 }); setPostPicked(new Set()); return
    }
    if (task.status === 'running') { setPost({ loading: true, items: [], error: '', scannedAt: 0 }); return }
    if (task.status === 'done') {
      const items = task.result?.v ?? []
      setPost({ loading: false, items, error: '', scannedAt: Date.now() })
      setPostPicked(new Set(items.filter(i => i.status === 'changed' || i.status === 'new').map(i => i.key)))
      if (items.length === 0) showToast('本章没有需要整理的条目', 'success')
      return
    }
    if (task.status === 'failed') { setPost({ loading: false, items: [], error: task.error, scannedAt: 0 }); return }
    setPost(s => ({ ...s, loading: false }))
  }, [postT.task, ch])

  const runPost = () => {
    if (!aiReady || postT.running) return
    if (!content.trim()) { showToast('本章正文还是空的，没有可整理的内容', 'info'); return }
    if (!ch) { showToast('没有定位到当前章节，请重新打开这一章', 'info'); return }
    const title = chapterTitle ?? ''
    postT.run(async job => {
      job.progress({ ch })
      // 🔴 用**编辑器里的最新正文**（作者可能还没保存），不读库里的滞后版本
      const report = await collectPostProcess(
        { chapterId: ch, content, chapterTitle: title },
        {
          signal: job.signal,
          // 3.2.0 · WQ7：编辑器助手的后处理**没有父任务**，如实标成独立调用 ——
          // 否则它会被算到「当时恰好有唯一在跑任务」的账上（统计与重试次数都会虚高）。
          request: { scope: 'independent' },
        },
      )
      return { ch, v: report.items }
    })
  }

  /** 采纳：只落库勾选且**可落库**的条目（`registered` 表示无变化，不该写） */
  const commitPost = async () => {
    const picked = post.items.filter(i => postPicked.has(i.key) && i.status !== 'registered')
    if (picked.length === 0 || postSaving || !ch) return
    setPostSaving(true)
    try {
      const r = await applyPostProcess(
        { chapterId: ch, content, chapterTitle: chapterTitle ?? '' }, picked,
      )
      if (r.created > 0) {
        showToast(`已整理 ${r.created} 条${r.failed.length ? `（${r.failed.length} 条失败）` : ''}`, 'success')
        onLedgerCommitted?.(r.created)
      } else if (r.failed.length > 0) {
        showToast(`整理失败：${r.failed.join('、')}`, 'error')
      }
      // 落库过的条目从列表移除（不重扫 —— 重扫要多烧一次 AI，而这批作者已确认过）
      const done = new Set(picked.map(i => i.key))
      setPost(s => ({ ...s, items: s.items.filter(i => !done.has(i.key)) }))
      setPostPicked(new Set())
    } finally {
      setPostSaving(false)
    }
  }

  /** 作者处理完某章的未来计划后清掉它的标记 */
  const dismissImpact = async (chapterNo: number) => {
    await clearImpact(chapterNo)
    loadImpacts()
  }

  // ============ 编辑：选区改稿 → 建议段 ============
  const selText = getSelectionText?.() ?? null
  const [instruction, setInstruction] = useState('润色')
  /**
   * 作者的**额外要求**与**期望字数**（2.9.2 · ②）。
   * 🔴 都**不持久化**（拍板）：记住上次填的，会让它**悄悄影响**这一次的结果，作者难察觉。
   * 🔴 期望字数只写进提示词、不做本地补写循环 —— 一次调用，实际字数以生成为准。
   */
  const [detail, setDetail] = useState('')
  const [targetWords, setTargetWords] = useState<number | undefined>(undefined)
  // 结果连同**选区快照**一起存（写入前要比对，避免 AI 请求期间正文已改、建议段插错位置）
  const rewriteT = useTaskRunner<ChOwned<{ data: RewriteResult; selText: string | null }>, ChProgress>({
    ownerTab: 'editor', kind: 'jiewenji-rewrite', title: '颉文姬 · 选区改稿',
    writes: ['chapters'], // 建议段最终会写进正文
  })
  const rewriteView = chapterOwned(rewriteT, ch)
  const rewrite: { loading: boolean; data?: RewriteResult; error?: string; selText?: string | null } = {
    loading: rewriteView.loading, data: rewriteView.data?.data, error: rewriteView.error, selText: rewriteView.data?.selText,
  }

  const runRewrite = () => {
    if (!aiReady || !selText || rewriteT.running) return
    const snapSel = selText
    // 🔴 要求也在发起时**快照**：任务跑在 store 里，跑的过程中作者可能已经改了额外要求
    const snapAsk = { instruction, detail, targetWords }
    rewriteT.run(async job => {
      job.progress({ ch })
      const styleCtx = await styleContextForAI()
      const data = await aiRewritePassage(snapSel, snapAsk, styleCtx, { signal: job.signal })
      return { ch, v: { data, selText: snapSel } }
    })
  }

  const applyAdvice = () => {
    if (!rewrite.data?.rewritten) { showToast('暂无有效建议可写入，请重新生成', 'info'); return }
    // 选区过期校验：AI 请求期间正文可能已改，写入前比对快照，避免建议段插错位置
    const nowSel = getSelectionText?.() ?? null
    if (rewrite.selText != null && nowSel !== rewrite.selText) {
      showToast('选区内容已变化，请重新选择后再写入', 'info')
      return
    }
    onApplyAdvice?.(rewrite.data.rewritten, getSelectionRange?.() ?? null)
  }

  // ============ 续写（2.9.2 · ③）：接本章末尾往下写 → 建议段 ============
  //
  // 与审读模式的「续写方向」（只给思路、不生成正文）**并存**，职责不同：这里生成正文。
  // 落点仍是建议段 —— 原文一字不动（颉文姬一贯立场）。
  const [contOpen, setContOpen] = useState(false)
  /** 期望续写字数（默认 800；留空＝不限）。🔴 只写进提示词，不做本地补写循环（拍板口径） */
  const [contWords, setContWords] = useState<number | undefined>(800)
  /** 作者指定的主要情节（选填） */
  const [contPlot, setContPlot] = useState('')
  /** 勾选的资料项 */
  const [contPicks, setContPicks] = useState<Set<string>>(() => new Set(CONT_DEFAULT_PICKS))
  /** 「章节摘要」取几章（含本章） */
  const [contSummaryCount, setContSummaryCount] = useState(3)
  /** 「前文章节」取几章（上限 5） */
  const [contPrevTextCount, setContPrevTextCount] = useState(1)
  /** 资料用量预览（勾选变化时防抖重算；**只读、不调模型、不烧额度**） */
  const [contPreview, setContPreview] = useState<{
    loading: boolean
    chars: number
    budget: number
    dropped: string[]
    missingSummaries: number
    droppedPrevTexts: number
    /** 焦点章是否在叙事序里定位到（false ⇒ 只带得到设定资料，UI 要如实说明 —— 未知 ≠ 空） */
    srcFound: boolean
  }>({ loading: true, chars: 0, budget: 0, dropped: [], missingSummaries: 0, droppedPrevTexts: 0, srcFound: true })

  const toggleContPick = (key: string) =>
    setContPicks(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  /**
   * 🔴 只读预估：勾选一变就重算「本次会带多少资料」，让作者在**发请求前**就看见会不会超。
   *    · 防抖 350ms（连点几个勾只算一次）+ `cancelled` 守卫（晚到的结果不许覆盖新状态）；
   *    · 失败就保持旧值、只收掉 loading（预估是辅助，绝不弹错打扰）；
   *    · `contPicks` 是 Set，但只在勾选时换引用 ⇒ 依赖它不会「每渲染必跑」。
   *    · ⚠️ 依赖里**刻意不含 content**：正文只是「末尾约 N 字」这一项固定估算，
   *      写进去会变成每敲一个字都重算一遍资料用量（且毫无意义）。
   */
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const budget = await writerBudgetFor('jiewenji-continue')
          const wantSummaries = contPicks.has('summaries')
          const wantPrevTexts = contPicks.has('prev-texts')
          const src = await getContinuationSources(focusChapterId ?? '', {
            summaryCount: wantSummaries ? contSummaryCount : 0,
            prevTextCount: wantPrevTexts ? contPrevTextCount : 0,
          })
          const tabIds = CONTINUE_PICKS.filter(p => contPicks.has(p.key)).flatMap(p => p.tabIds)
          const ctx = await buildProjectContext({
            budget, onlyTabIds: tabIds, includeChapterList: false, focusChapterId,
          })
          if (cancelled) return
          // 概览 = buildProjectContext 的实际用量 + 我们单独拼的几块 + 正文末尾（按上限估，文案里带「约」）
          // 🔴 必须把「写作文风」的长度也算进去 —— 实际发请求时会多推一个块，漏算会让
          //    「预计占用」偏小：勾了文风档却显示「未超预算」，到真跑时才超（＝预估骗人）。
          const fpLen = contPicks.has('fingerprint') ? (await activeFingerprintNote()).length : 0
          const extra =
            (wantSummaries ? src.summaries.length : 0) +
            (wantPrevTexts ? src.prevTexts.length : 0) +
            fpLen +
            CONT_BODY_TAIL_CHARS
          setContPreview({
            loading: false, chars: ctx.chars + extra, budget,
            dropped: ctx.dropped,
            missingSummaries: wantSummaries ? src.missingSummaries : 0,
            droppedPrevTexts: wantPrevTexts ? src.droppedPrevTexts : 0,
            srcFound: src.found,
          })
        } catch {
          if (!cancelled) setContPreview(p => ({ ...p, loading: false }))
        }
      })()
    }, 350)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [contPicks, contSummaryCount, contPrevTextCount, focusChapterId])

  const contT = useTaskRunner<ChOwned<{ text: string; dropped: string[] }>, ChProgress & { text?: string }>({
    ownerTab: 'editor', kind: 'jiewenji-continue', title: '颉文姬 · 续写',
    writes: ['chapters'], // 续写最终以建议段写进正文
  })
  /**
   * 续写视图。
   * ⚠️ **刻意不用 `chapterOwned()`**：流式文本要挂在 `progress` 上（形状多了 `text`），
   *    而 `chapterOwned` 的签名把进度钉死在 `ChProgress` —— 传过去类型不兼容（逆变位置）。
   *    这里照 `chapterOwned` 的同一口径手写，取值行为一致。
   */
  const contTask = contT.task
  const contOwned = taskChapter(contTask) === ch
  const contDone = contTask?.status === 'done' && contTask.result?.ch === ch
  const contProg = contOwned ? (contTask?.progress as (ChProgress & { text?: string }) | null) : null
  const cont: { loading: boolean; text: string; dropped: string[]; error?: string } = {
    loading: contT.running && contOwned,
    // 跑着 ⇒ 显示流式累积；跑完 ⇒ 取最终结果（已过 cleanChapterOutput，比流式缓冲更干净）
    text: contDone ? (contTask?.result?.v.text ?? '') : (contT.running && contOwned ? (contProg?.text ?? '') : ''),
    dropped: contDone ? (contTask?.result?.v.dropped ?? []) : [],
    error: contTask?.status === 'failed' && contOwned ? (contT.error || undefined) : undefined,
  }

  const runContinuation = () => {
    if (!aiReady || contT.running) return
    // 🔴 输入全部在**发起时快照**：任务跑在 store 里，跑的过程中作者可能已经改了勾选 / 字数 / 情节
    const snap = {
      words: contWords,
      plot: contPlot,
      picks: new Set(contPicks),
      summaryCount: contSummaryCount,
      prevTextCount: contPrevTextCount,
    }
    const title = chapterTitle ?? ''
    // 本章正文只带末尾一段做衔接
    const bodyTail = content.trim().slice(-CONT_BODY_TAIL_CHARS)
    showToast('颉文姬续写已启动，会接在本章末尾往下写；篇幅较大时耗时较久，并非卡死', 'info')
    contT.run(async job => {
      job.progress({ ch, text: '' }) // 🔴 第一行盖章节戳，失败/中止时也判得出归属
      const wantSummaries = snap.picks.has('summaries')
      const wantPrevTexts = snap.picks.has('prev-texts')

      const src = await getContinuationSources(focusChapterId ?? '', {
        summaryCount: wantSummaries ? snap.summaryCount : 0,
        prevTextCount: wantPrevTexts ? snap.prevTextCount : 0,
      })
      // 🔴 3.0 · W1-2b 缺失即停（§10.3 #2）：勾了章节素材却定位不到本章 ⇒ **停止生成**，
      //    不再「提示一句就照发」。`found:false` ＝ 章没定位到（不是「作者没勾素材」），
      //    拿空上下文硬写会让模型凭空编 —— 抛出后任务中心会如实记为失败并说明原因。
      if (wantSummaries || wantPrevTexts) {
        const gap = checkContinuationFocus(src.found)
        if (gap) throw new Error(formatGap(gap))
      }
      // 设定类：只把勾中的页签交给 buildProjectContext
      const tabIds = CONTINUE_PICKS.filter(p => snap.picks.has(p.key)).flatMap(p => p.tabIds)
      const ctx = await buildProjectContext({
        budget: await writerBudgetFor('jiewenji-continue'),
        onlyTabIds: tabIds,
        // 章节清单不整本带：另走「章节摘要」（按章数精确取），否则目录会吃掉大半预算
        includeChapterList: false,
        focusChapterId,
      })
      const fpNote = snap.picks.has('fingerprint') ? await activeFingerprintNote() : ''

      // 拼装资料块（🔴 与上方预览的取数口径**逐块一致**，否则「预计占用」会骗人）
      const blocks: string[] = []
      if (wantSummaries && src.summaries) blocks.push(`【章节摘要】\n${src.summaries}`)
      if (ctx.text) blocks.push(`【设定资料】\n${ctx.text}`)
      if (wantPrevTexts && src.prevTexts) blocks.push(`【前文章节】\n${src.prevTexts}`)
      if (fpNote) blocks.push(`【写作文风】\n${fpNote}`)

      // 🔴 流式：每个 token 都上报会让整棵订阅树重渲染 ⇒ 按 150ms 节流
      let lastFlush = 0
      let buf = ''
      const text = await aiContinuePassage({
        chapterTitle: title,
        bodyTail,
        projectContext: blocks.join('\n\n'),
        plot: snap.plot,
        targetWords: snap.words,
      }, {
        signal: job.signal,
        onToken: delta => {
          buf += delta
          const now = Date.now()
          if (now - lastFlush < 150) return
          lastFlush = now
          job.progress({ ch, text: buf }) // ⚠️ 必须带 ch，否则章节戳被冲掉
        },
      })
      return { ch, v: { text, dropped: ctx.dropped } }
    })
  }

  const applyContinuation = () => {
    if (!cont.text.trim()) { showToast('暂无可写入的续写内容，请先让颉文姬续写', 'info'); return }
    // 🔴 续写落在**本章末尾**：sel 传 null ⇒ `insertAdvice` 取「正文长度」为插入点
    onApplyAdvice?.(cont.text, null)
  }

  // ============ 审读：编辑意见 / OOC / 续写方向 / 爽点毒点 / 黄金三章 ============
  const revT = useTaskRunner<ChOwned<ChapterReview>, ChProgress>({ ownerTab: 'editor', kind: 'jiewenji-review', title: '颉文姬 · 章节编辑意见' })
  const oocT = useTaskRunner<ChOwned<OocFinding[]>, ChProgress>({ ownerTab: 'editor', kind: 'jiewenji-ooc', title: '颉文姬 · OOC 人设检查' })
  const advT = useTaskRunner<ChOwned<ContinuationAdvice>, ChProgress>({ ownerTab: 'editor', kind: 'jiewenji-advice', title: '颉文姬 · 续写方向' })
  const pleaT = useTaskRunner<ChOwned<PleasureReport>, ChProgress>({ ownerTab: 'editor', kind: 'jiewenji-pleasure', title: '颉文姬 · 爽点毒点检查' })
  const openT = useTaskRunner<ChOwned<OpeningReport>, ChProgress>({ ownerTab: 'editor', kind: 'jiewenji-opening', title: '颉文姬 · 黄金三章检查' })

  const rev: { loading: boolean; data?: ChapterReview; error?: string } = chapterOwned(revT, ch)
  const ooc: { loading: boolean; data?: OocFinding[]; error?: string } = chapterOwned(oocT, ch)
  const adv: { loading: boolean; data?: ContinuationAdvice; error?: string } = chapterOwned(advT, ch)
  const plea: { loading: boolean; data?: PleasureReport; error?: string } = chapterOwned(pleaT, ch)
  const open: { loading: boolean; data?: OpeningReport; error?: string } = chapterOwned(openT, ch)

  const runReview = () => {
    if (!aiReady || revT.running) return
    showToast('AI 审读已启动，耗时 30–90 秒属正常，并非卡死，请耐心等待', 'info')
    revT.run(async job => {
      job.progress({ ch })
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('jiewenji-review'), focusChapterId })
      return { ch, v: await aiChapterReview(ctx.text, content, { signal: job.signal }) }
    })
  }
  const runOoc = () => {
    if (!aiReady || oocT.running) return
    oocT.run(async job => {
      job.progress({ ch })
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('jiewenji-ooc'), focusChapterId })
      // WQ1-3：未完整完成（解析失败/截断/取消）一律抛出，让任务中心显示原因；
      // 不再把失败假装成"没人 OOC"（空数组曾是三种语义混一起）
      const r = await aiOocCheckWithStatus(ctx.text, content, { signal: job.signal })
      if (r.state !== 'completed') {
        const n = r.result?.data?.length ?? 0
        throw new Error(`OOC 检查未完整完成（${r.errorCode ?? r.state}）${n ? `，已收到 ${n} 处仅供参考` : ''}，请重试或更换模型`)
      }
      return { ch, v: r.result?.data ?? [] }
    })
  }
  const runAdvice = () => {
    if (!aiReady || advT.running) return
    advT.run(async job => {
      job.progress({ ch })
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('jiewenji-advice'), focusChapterId })
      return { ch, v: await aiContinuationAdvice(ctx.text, content, { signal: job.signal }) }
    })
  }
  const runPleasure = () => {
    if (!aiReady || pleaT.running) return
    pleaT.run(async job => {
      job.progress({ ch })
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('jiewenji-pleasure'), focusChapterId })
      return { ch, v: await aiPleasureCheck(ctx.text, content, { signal: job.signal }) }
    })
  }
  const runOpening = () => {
    if (!aiReady || openT.running) return
    openT.run(async job => {
      job.progress({ ch })
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('jiewenji-opening'), focusChapterId })
      return { ch, v: await aiOpeningCheck(ctx.text, openingText ?? content, { signal: job.signal }) }
    })
  }

  // ============ 简报：开写前本章待办（v1.6.1） ============
  const briefT = useTaskRunner<ChOwned<BriefingReport>, ChProgress>({ ownerTab: 'editor', kind: 'jiewenji-brief', title: '颉文姬 · 本章写作简报' })
  const brief: { loading: boolean; data?: BriefingReport; error?: string } = chapterOwned(briefT, ch)
  const runBrief = () => {
    if (!aiReady || briefT.running) return
    showToast('AI 简报已启动，耗时 30–90 秒属正常，并非卡死，请耐心等待', 'info')
    briefT.run(async job => {
      job.progress({ ch })
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('jiewenji-brief'), focusChapterId })
      return { ch, v: await aiBriefing(ctx.text, content, { signal: job.signal }) }
    })
  }

  const aiBtnCls = 'w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-12 border transition-colors disabled:opacity-45 disabled:cursor-not-allowed'
  const scoreCls = (s: number) => (s >= 75 ? 'bg-success/15 text-success border-success/30' : s >= 60 ? 'bg-amber/15 text-amber border-amber/30' : 'bg-danger/15 text-danger border-danger/30')

  return {
    ...props,
    aiReady, spriteOn, setSpriteOn, toggleSprite, mode, setMode, diagMode, setDiagMode, diag, runDiag,
    proofs, propsRunning, runProofread, stopProofread, replaceOne,
    ledger, ledgerPicked, setLedgerPicked, ledgerSaving, runLedger, setLedgerTargetTab, commitLedger, jumpToEntry,
    post, postPicked, setPostPicked, postSaving, runPost, commitPost, impacts, dismissImpact, loadImpacts,
    selText, instruction, setInstruction, detail, setDetail, targetWords, setTargetWords, rewrite, runRewrite, applyAdvice,
    contOpen, setContOpen, contWords, setContWords, contPlot, setContPlot, contPicks, toggleContPick,
    contSummaryCount, setContSummaryCount, contPrevTextCount, setContPrevTextCount, contPreview, cont, runContinuation, applyContinuation,
    rev, ooc, adv, plea, open, runReview, runOoc, runAdvice, runPleasure, runOpening,
    brief, runBrief, aiBtnCls, scoreCls,
  }
}

export type JieWenJiModel = ReturnType<typeof useJieWenJiModel>
