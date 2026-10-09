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
import { writerBudgetFor } from '../lib/aiWriterBudget'
import { useEffect, useRef, useState } from 'react'
import { buildProjectContext } from '../lib/aiContext'
import { styleContextForAI } from '../lib/styleAudit'
import { aiEditorDiagnosis, aiChapterReview, aiOocCheck, aiRewritePassage, aiContinuationAdvice, aiPleasureCheck, aiOpeningCheck, aiProofreadText, aiProofreadLogic, aiBriefing, aiExtractSettingEntities, EditorDiagnosis, ChapterReview, OocFinding, RewriteResult, ContinuationAdvice, PleasureReport, OpeningReport, ProofreadIssue, BriefingReport } from '../lib/aiTasks'
import { loadRegistry, classify, commitEntities, CARD_TABS, LedgerItem } from '../lib/settingLedger'
import { useAIReady } from '../lib/useAIReady'
import { LS_SPRITE_ENABLED } from '../lib/constants'
import { useTaskRunner, chapterOwned, taskChapter, type ChOwned, type ChProgress } from '../lib/aiTaskCenter'
import { showToast } from './dialogs'
import type { Props } from './jieWenJiParts'
import { Mode, ProofScope, PROOF_ORDER, PROOF_META, ProofState, blankProof } from './jieWenJiParts'

/** 校对返回（文字层 / 逻辑层同形状）：逐条问题 + 已扫 / 跳过数 */
type ProofreadOutcome = { issues: ProofreadIssue[]; scanned: number; skipped: number }
/** 校对进度（喂给 `onProgress`） */
type ProofProgress = ChProgress & { done: number; total: number }

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
      const r = await commitEntities(picked, chapterTitle ?? '')
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
      return { ch, v: await aiOocCheck(ctx.text, content, { signal: job.signal }) }
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
    selText, instruction, setInstruction, detail, setDetail, targetWords, setTargetWords, rewrite, runRewrite, applyAdvice,
    rev, ooc, adv, plea, open, runReview, runOoc, runAdvice, runPleasure, runOpening,
    brief, runBrief, aiBtnCls, scoreCls,
  }
}

export type JieWenJiModel = ReturnType<typeof useJieWenJiModel>
