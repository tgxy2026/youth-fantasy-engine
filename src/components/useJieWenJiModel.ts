/**
 * 颉文姬 · 状态与 AI 链路（C1 · 2.4.2 自 JieWenJi.tsx 拆出）
 *
 * 🔴 纯搬家：state / handler 一字未改，只是把「组件体」搬成了 hook。
 *    组件侧 `const m = useJieWenJiModel(props)`；五个模式面板只收 `m`。
 *    红线段照旧：无模型时 AI 入口全部 disabled。
 */
import { writerBudgetFor } from '../lib/aiWriterBudget'
import { useEffect, useRef, useState } from 'react'
import { buildProjectContext } from '../lib/aiContext'
import { getFormData } from '../lib/db'
import { aiEditorDiagnosis, aiChapterReview, aiOocCheck, aiRewritePassage, aiContinuationAdvice, aiPleasureCheck, aiOpeningCheck, aiProofreadText, aiProofreadLogic, aiBriefing, aiExtractSettingEntities, EditorDiagnosis, ChapterReview, OocFinding, RewriteResult, ContinuationAdvice, PleasureReport, OpeningReport, ProofreadIssue, BriefingReport } from '../lib/aiTasks'
import { loadRegistry, classify, commitEntities, CARD_TABS, LedgerItem } from '../lib/settingLedger'
import { isCancelled } from '../lib/ai'
import { useAIReady } from '../lib/useAIReady'
import { LS_SPRITE_ENABLED } from '../lib/constants'
import { showToast } from './dialogs'
import type { Props } from './jieWenJiParts'
import { Mode, ProofScope, PROOF_ORDER, PROOF_META, ProofState, blankProof } from './jieWenJiParts'

export function useJieWenJiModel(props: Props) {
  const { content, openingText, getSelectionText, getSelectionRange, onApplyAdvice, onApplyContent, summary, chapterTitle, onLedgerCommitted, focusChapterId } = props
  const { ready: aiReady } = useAIReady()
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
  const [diag, setDiag] = useState<{ loading: boolean; data?: EditorDiagnosis; error?: string }>({ loading: false })

  const runDiag = async () => {
    if (!aiReady || diag.loading) return
    const useBrief = diagMode === 'brief'
    const diagText = useBrief ? (summary?.trim() || '') : content
    let brief = useBrief
    if (useBrief && !diagText) {
      showToast('本章还没填「章节压缩摘要」，已自动改用完整正文诊断', 'info')
      setDiagMode('full')
      brief = false // 已回退到完整正文，后续按 full 处理，不能用已被异步改掉的 useBrief
    }
    showToast('AI 综合诊断已启动，耗时 30–90 秒属正常，并非卡死，请耐心等待', 'info')
    setDiag({ loading: true })
    try {
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('jiewenji-diagnosis'), focusChapterId })
      const text = brief ? diagText : content
      const r = await withCtrl(signal => aiEditorDiagnosis(ctx.text, text, { signal, textKind: brief ? 'summary' : 'full' }))
      setDiag({ loading: false, data: r })
    } catch (e) {
      setDiag({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // ============ 诊室：AI 校对（文字层 / 逻辑层两块） ============
  // 两块结果各存一份：分别跑、分别看，一块的进度与报错不影响另一块。
  // ⚠️ 但**同一时刻只允许跑一块** —— 本面板所有 AI 请求共用 `abortRef` 一个取消器
  //    （面板卸载时 abort），并发跑两块会让后发的那次把前一次的 signal 顶掉。
  const [proofs, setProofs] = useState<Record<ProofScope, ProofState>>({
    text: blankProof(), logic: blankProof(),
  })
  const patchProof = (s: ProofScope, patch: Partial<ProofState>) =>
    setProofs(prev => ({ ...prev, [s]: { ...prev[s], ...patch } }))
  const propsRunning = PROOF_ORDER.some(s => proofs[s].loading)
  const abortRef = useRef<AbortController | null>(null)
  /** 统一取消器：所有 AI 请求共用，面板卸载时 abort（省 token、防卸载后 setState） */
  const withCtrl = async <T,>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      return await fn(ctrl.signal)
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null
    }
  }
  // 面板关闭/卸载：中止一切进行中的 AI 请求
  useEffect(() => () => abortRef.current?.abort(), [])

  // ============ 补登：本章新增设定实体 ============
  // AI 只负责「从正文抽候选」，是否已登记一律交给 settingLedger 做确定性比对。
  const [ledger, setLedger] = useState<{
    loading: boolean; items: LedgerItem[]; error: string; scannedAt: number
  }>({ loading: false, items: [], error: '', scannedAt: 0 })
  /** 勾选准备补登的条目 key（默认只勾「待补登」） */
  const [ledgerPicked, setLedgerPicked] = useState<Set<string>>(new Set())
  const [ledgerSaving, setLedgerSaving] = useState(false)

  const runLedger = async () => {
    if (!aiReady || ledger.loading) return
    if (!content.trim()) { showToast('本章正文还是空的，没有可抽取的内容', 'info'); return }
    setLedger({ loading: true, items: [], error: '', scannedAt: 0 })
    try {
      const entities = await withCtrl(signal =>
        aiExtractSettingEntities(content, chapterTitle ?? '', { signal }))
      const reg = await loadRegistry()
      const items = classify(entities, reg)
      // 默认只勾「待补登」：已登记和疑似重复不该被重复写入
      setLedgerPicked(new Set(items.filter(i => i.status === 'new').map(i => i.key)))
      setLedger({ loading: false, items, error: '', scannedAt: Date.now() })
      if (items.length === 0) showToast('本章没有抽出需要登记的设定实体', 'success')
    } catch (e) {
      if (isCancelled(e)) { setLedger(s => ({ ...s, loading: false })); return }
      setLedger({ loading: false, items: [], error: e instanceof Error ? e.message : String(e), scannedAt: 0 })
    }
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

  const runProofread = async (scope: ProofScope) => {
    if (!aiReady || propsRunning) return
    // 只校对完整正文。曾经提供过「喂压缩摘要」的简略模式，但校对结果要按 quote
    // 在正文里定位替换，摘要文字在正文里定位不到、还会误替换无辜同文——已移除。
    const text = content
    showToast(`AI 校对已启动（${PROOF_META[scope].label}），篇幅较大时耗时数十秒属正常，并非卡死，请耐心等待`, 'info')
    patchProof(scope, { ...blankProof(), loading: true })
    try {
      // 🔴 逻辑层才读设定资料；文字层不读 —— 少注入几千字，出结果更快，
      //    也避免模型"拿设定去猜人名是不是写错"这类误报。
      let ctxText = ''
      if (scope === 'logic') {
        try { ctxText = (await buildProjectContext({ budget: await writerBudgetFor('jiewenji-proofread'), focusChapterId })).text } catch { /* 拿不到设定资料就少带一段，不阻断 */ }
      }
      const run = scope === 'text' ? aiProofreadText : aiProofreadLogic
      const res = await withCtrl(signal => run(text, {
        context: ctxText,
        signal,
        onProgress: (d, t) => patchProof(scope, { progress: { done: d, total: t } }),
      }))
      patchProof(scope, { loading: false, issues: res.issues, scanned: res.scanned, skipped: res.skipped, done: true })
    } catch (e) {
      const cancelled = isCancelled(e)
      patchProof(scope, {
        loading: false, done: true, cancelled,
        error: cancelled ? '' : e instanceof Error ? e.message : String(e),
      })
    }
  }
  const stopProofread = () => abortRef.current?.abort()

  /** 替换单条校对结果：优先用 AI 标注位置，替换后把**两块**的其余问题都按位移重锚定
   *  （重叠/失效的置空，走全文定位兜底）。只重锚定自己那块的话，切到另一块再点就是"定位失败"。 */
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

  // ============ 编辑：选区改稿 → 建议段 ============
  const selText = getSelectionText?.() ?? null
  const [instruction, setInstruction] = useState('润色')
  const [rewrite, setRewrite] = useState<{ loading: boolean; data?: RewriteResult; error?: string; selText?: string | null }>({ loading: false })

  const runRewrite = async () => {
    if (!aiReady || !selText || rewrite.loading) return
    setRewrite({ loading: true })
    try {
      const style = await getFormData('style').catch(() => ({} as Record<string, string>))
      const styleCtx = Object.entries(style)
        .map(([k, v]) => `${k.replace(/^.*::/, '')}：${(v ?? '').toString().slice(0, 200)}`)
        .filter(s => s.length > 2)
        .join('\n')
      const r = await withCtrl(signal => aiRewritePassage(selText, instruction, styleCtx, { signal }))
      setRewrite({ loading: false, data: r, selText })
    } catch (e) {
      setRewrite({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
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

  // ============ 审读：编辑意见 / OOC / 续写方向 ============
  const [rev, setRev] = useState<{ loading: boolean; data?: ChapterReview; error?: string }>({ loading: false })
  const [ooc, setOoc] = useState<{ loading: boolean; data?: OocFinding[]; error?: string }>({ loading: false })
  const [adv, setAdv] = useState<{ loading: boolean; data?: ContinuationAdvice; error?: string }>({ loading: false })
  const [plea, setPlea] = useState<{ loading: boolean; data?: PleasureReport; error?: string }>({ loading: false })
  const [open, setOpen] = useState<{ loading: boolean; data?: OpeningReport; error?: string }>({ loading: false })

  const runReview = async () => {
    if (!aiReady || rev.loading) return
    showToast('AI 审读已启动，耗时 30–90 秒属正常，并非卡死，请耐心等待', 'info')
    setRev({ loading: true })
    try {
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('jiewenji-review'), focusChapterId })
      const r = await withCtrl(signal => aiChapterReview(ctx.text, content, { signal }))
      setRev({ loading: false, data: r })
    } catch (e) {
      setRev({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  const runOoc = async () => {
    if (!aiReady || ooc.loading) return
    setOoc({ loading: true })
    try {
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('jiewenji-ooc'), focusChapterId })
      const r = await withCtrl(signal => aiOocCheck(ctx.text, content, { signal }))
      setOoc({ loading: false, data: r })
    } catch (e) {
      setOoc({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  const runAdvice = async () => {
    if (!aiReady || adv.loading) return
    setAdv({ loading: true })
    try {
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('jiewenji-advice'), focusChapterId })
      const r = await withCtrl(signal => aiContinuationAdvice(ctx.text, content, { signal }))
      setAdv({ loading: false, data: r })
    } catch (e) {
      setAdv({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  const runPleasure = async () => {
    if (!aiReady || plea.loading) return
    setPlea({ loading: true })
    try {
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('jiewenji-pleasure'), focusChapterId })
      const r = await withCtrl(signal => aiPleasureCheck(ctx.text, content, { signal }))
      setPlea({ loading: false, data: r })
    } catch (e) {
      setPlea({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  const runOpening = async () => {
    if (!aiReady || open.loading) return
    setOpen({ loading: true })
    try {
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('jiewenji-opening'), focusChapterId })
      const r = await withCtrl(signal => aiOpeningCheck(ctx.text, openingText ?? content, { signal }))
      setOpen({ loading: false, data: r })
    } catch (e) {
      setOpen({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // ============ 简报：开写前本章待办（v1.6.1） ============
  const [brief, setBrief] = useState<{ loading: boolean; data?: BriefingReport; error?: string }>({ loading: false })
  const runBrief = async () => {
    if (!aiReady || brief.loading) return
    showToast('AI 简报已启动，耗时 30–90 秒属正常，并非卡死，请耐心等待', 'info')
    setBrief({ loading: true })
    try {
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('jiewenji-brief'), focusChapterId })
      const r = await withCtrl(signal => aiBriefing(ctx.text, content, { signal }))
      setBrief({ loading: false, data: r })
    } catch (e) {
      setBrief({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const aiBtnCls = 'w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-12 border transition-colors disabled:opacity-45 disabled:cursor-not-allowed'
  const scoreCls = (s: number) => (s >= 75 ? 'bg-success/15 text-success border-success/30' : s >= 60 ? 'bg-amber/15 text-amber border-amber/30' : 'bg-danger/15 text-danger border-danger/30')

  return {
    ...props,
    aiReady, spriteOn, setSpriteOn, toggleSprite, mode, setMode, diagMode, setDiagMode, diag, setDiag, runDiag, proofs, setProofs, patchProof, propsRunning, abortRef, withCtrl, ledger, setLedger, ledgerPicked, setLedgerPicked, ledgerSaving, setLedgerSaving, runLedger, setLedgerTargetTab, commitLedger, jumpToEntry, runProofread, stopProofread, replaceOne, selText, instruction, setInstruction, rewrite, setRewrite, runRewrite, applyAdvice, rev, setRev, ooc, setOoc, adv, setAdv, plea, setPlea, open, setOpen, runReview, runOoc, runAdvice, runPleasure, runOpening, brief, setBrief, runBrief, aiBtnCls, scoreCls,
  }
}

export type JieWenJiModel = ReturnType<typeof useJieWenJiModel>
