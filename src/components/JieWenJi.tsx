import { useEffect, useRef, useState } from 'react'
import {
  Stethoscope, PenLine, BookOpen, BookOpenCheck, X, Wand2, Loader2, AlertTriangle, CheckCircle2,
  Sparkles, Trash2, Flame, SpellCheck, ClipboardList, RefreshCw, ExternalLink, Save,
} from 'lucide-react'
import { buildProjectContext } from '../lib/aiContext'
import { getFormData } from '../lib/db'
import {
  aiEditorDiagnosis, aiChapterReview, aiOocCheck, aiRewritePassage, aiContinuationAdvice,
  aiPleasureCheck, aiOpeningCheck, aiProofread, aiBriefing, aiExtractSettingEntities,
  type EditorDiagnosis, type ChapterReview, type OocFinding, type RewriteResult, type ContinuationAdvice,
  type PleasureReport, type OpeningReport, type ProofreadIssue, type BriefingReport,
} from '../lib/aiTasks'
import {
  loadRegistry, classify, commitEntities, CARD_TABS,
  type LedgerItem, type SettingEntityType, type MatchStatus,
} from '../lib/settingLedger'
import { TABS } from '../lib/schema'
import { isCancelled } from '../lib/ai'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { showToast } from './dialogs'
import HelpPopover from './HelpPopover'
import { Button } from './Button'

// ============ 颉文姬 · 编辑器 AI 助手（v1.6 收官功能） ============
// 四模式：诊室（AI 深度校对 + AI 综合诊断）/ 编辑（选区改稿 → 建议段）/
// 审读（章节编辑意见 / OOC / 续写方向 / 爽点毒点 / 黄金三章）/ 简报。
// 1.9.1 增第五模式「补登」：抽出本章新出现的设定实体，与已有设定做确定性比对，
// 分「已登记 / 疑似重复 / 待补登」三档，勾选后一键写入对应设定表或角色卡。
// 红线：无模型时 AI 入口全部 disabled；AI 不直接生成正文（续写只给方向）。

/** 建议段标记（NovelEditor 的写入/清除共用） */
export const ADVICE_START = '【颉文姬建议·开始】'
export const ADVICE_END = '【颉文姬建议·结束】'

interface Props {
  content: string
  /** 作品开头（前 3 章）正文，供「黄金三章检查」使用 */
  openingText?: string
  onClose: () => void
  /** 读取当前正文选区文本（由编辑器在选区变化时缓存，面板聚焦也不丢） */
  getSelectionText?: () => string | null
  /** 读取选区起止（供建议段定位） */
  getSelectionRange?: () => { start: number; end: number } | null
  /** 把 AI 改稿写入原文下方的新段落（建议段模式，带标记） */
  onApplyAdvice?: (rewritten: string, sel: { start: number; end: number } | null) => void
  /** 清除正文里全部建议段 */
  onClearAdvice?: () => void
  /** 用新文本整体替换正文（校对"替换此条"用） */
  onApplyContent?: (next: string) => void
  /** 本章「章节压缩摘要」（编辑器顶栏同步过来，约原文 1/10），供校对 / 综合诊断「简略模式」使用 */
  summary?: string
  /** 本章标题（补登写入时填进「首次出场 / 首次出现章节」） */
  chapterTitle?: string
  /** 补登完成后回调（用于提示数据已更新、需要刷新设定表） */
  onLedgerCommitted?: (created: number) => void
  /** #015：当前章节 id，用于 AI 上下文「相关章节召回」（取代从头截断） */
  focusChapterId?: string
}

type Mode = 'clinic' | 'edit' | 'review' | 'brief' | 'ledger'

const INSTRUCTIONS = ['润色', '扩写', '精简', '改语气', '换视角']

/** 轻量 markdown 渲染：支持 ## 小标题 / 数字与 - 列表 / **加粗**，其余按段落展示 */
function renderInline(s: string) {
  const parts = s.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') && p.length > 4
      ? <strong key={i} className="text-amber font-semibold">{p.slice(2, -2)}</strong>
      : <span key={i}>{p}</span>,
  )
}

function renderReport(text: string) {
  if (!text) return null
  return (
    <div className="space-y-1">
      {text.split('\n').map((ln, i) => {
        const t = ln.trim()
        if (!t) return <div key={i} className="h-1" />
        if (t.startsWith('## ')) return <div key={i} className="text-[12px] font-semibold text-amber mt-2 mb-0.5">{renderInline(t.slice(3))}</div>
        if (/^\d+[.、)]/.test(t) || t.startsWith('- ') || t.startsWith('• ') || t.startsWith('* ')) {
          const num = t.match(/^\d+/)?.[0]
          return (
            <div key={i} className="flex gap-1.5 text-[11.5px] text-ink-100 leading-relaxed">
              <span className="text-amber/80 shrink-0">{num ?? '·'}</span>
              <span className="min-w-0">{renderInline(t.replace(/^\d+[.、)]\s*/, '').replace(/^[-•*]\s*/, ''))}</span>
            </div>
          )
        }
        return <div key={i} className="text-[11.5px] text-ink-100 leading-relaxed">{renderInline(t)}</div>
      })}
    </div>
  )
}

/** 补登：实体类型的展示顺序 */
const LEDGER_TYPES: SettingEntityType[] = ['人物', '势力', '地点', '种族', '物品', '术语']

/** 补登：三档比对结果的徽标样式 */
const STATUS_META: Record<MatchStatus, { label: string; cls: string }> = {
  registered: { label: '已登记', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  duplicate: { label: '疑似重复', cls: 'bg-amber/15 text-amber border-amber/30' },
  new: { label: '待补登', cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
}

const SEV_BADGE: Record<string, string> = {
  error: 'bg-red-500/15 text-red-300 border-red-500/30',
  warn: 'bg-amber/15 text-amber border-amber/30',
  info: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  high: 'bg-red-500/15 text-red-300 border-red-500/30',
  medium: 'bg-amber/15 text-amber border-amber/30',
  low: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  '严重': 'bg-red-500/15 text-red-300 border-red-500/30',
  '中等': 'bg-amber/15 text-amber border-amber/30',
  '提示': 'bg-sky-500/15 text-sky-300 border-sky-500/30',
}

function SevBadge({ s }: { s: string }) {
  const cls = SEV_BADGE[s] ?? 'bg-ink-700 text-ink-300 border-ink-600'
  return <span className={`inline-block px-1.5 py-px rounded text-[9.5px] border ${cls}`}>{s}</span>
}

export default function JieWenJi({
  content, openingText, onClose,
  getSelectionText, getSelectionRange, onApplyAdvice, onClearAdvice, onApplyContent, summary,
  chapterTitle, onLedgerCommitted, focusChapterId,
}: Props) {
  const { ready: aiReady } = useAIReady()
  // 右侧 Q 版精灵开关（全局，localStorage 持久化 + 事件通知 App）
  const [spriteOn, setSpriteOn] = useState(() => localStorage.getItem('yfe-sprite-enabled') !== '0')
  const toggleSprite = () => {
    const next = !spriteOn
    setSpriteOn(next)
    localStorage.setItem('yfe-sprite-enabled', next ? '1' : '0')
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
      const ctx = await buildProjectContext({ budget: 8000, focusChapterId })
      const text = brief ? diagText : content
      const r = await withCtrl(signal => aiEditorDiagnosis(ctx.text, text, { signal, textKind: brief ? 'summary' : 'full' }))
      setDiag({ loading: false, data: r })
    } catch (e) {
      setDiag({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // ============ 诊室：AI 深度校对（错别字/语病/逻辑/设定矛盾） ============
  const [proof, setProof] = useState<{
    loading: boolean; issues: ProofreadIssue[]; scanned: number; skipped: number;
    progress: { done: number; total: number }; done: boolean; error: string; cancelled: boolean
  }>({ loading: false, issues: [], scanned: 0, skipped: 0, progress: { done: 0, total: 0 }, done: false, error: '', cancelled: false })
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

  const runProofread = async () => {
    if (!aiReady || proof.loading) return
    // 只校对完整正文。曾经提供过「喂压缩摘要」的简略模式，但校对结果要按 quote
    // 在正文里定位替换，摘要文字在正文里定位不到、还会误替换无辜同文——已移除。
    const text = content
    showToast(`AI 深度校对已启动，篇幅较大时耗时 30–90 秒属正常，并非卡死，请耐心等待`, 'info')
    setProof({ loading: true, issues: [], scanned: 0, skipped: 0, progress: { done: 0, total: 0 }, done: false, error: '', cancelled: false })
    try {
      let ctxText = ''
      try { ctxText = (await buildProjectContext({ budget: 6000, focusChapterId })).text } catch { /* 拿不到设定资料就少带一段，不阻断 */ }
      const res = await withCtrl(signal => aiProofread(text, {
        context: ctxText,
        signal,
        onProgress: (d, t) => setProof(p => ({ ...p, progress: { done: d, total: t } })),
      }))
      setProof(p => ({ ...p, loading: false, issues: res.issues, scanned: res.scanned, skipped: res.skipped, done: true }))
    } catch (e) {
      const cancelled = isCancelled(e)
      setProof(p => ({
        ...p, loading: false, done: true, cancelled,
        error: cancelled ? '' : e instanceof Error ? e.message : String(e),
      }))
    }
  }
  const stopProofread = () => abortRef.current?.abort()

  /** 替换单条校对结果：优先用 AI 标注位置，替换后把其余问题按位移重锚定（重叠/失效的置空走全文定位兜底） */
  const replaceOne = (iss: ProofreadIssue) => {
    let idx = -1
    if (iss.at != null && content.slice(iss.at, iss.at + iss.quote.length) === iss.quote) idx = iss.at
    else idx = content.indexOf(iss.quote)
    if (idx < 0) { showToast('定位失败：原文可能已改动', 'error'); return }
    const delta = iss.fix.length - iss.quote.length
    const next = content.slice(0, idx) + iss.fix + content.slice(idx + iss.quote.length)
    onApplyContent?.(next)
    setProof(prev => ({
      ...prev,
      issues: prev.issues
        .filter(i => i !== iss)
        .map(i => {
          if (i.at == null) return i
          // 替换点之后的坐标整体位移；之前或重叠的按新文本校验，失效则置空，下次替换走 indexOf 兜底
          const na = i.at > idx ? i.at + delta : i.at
          return next.slice(na, na + i.quote.length) === i.quote ? { ...i, at: na } : { ...i, at: undefined }
        })
        .sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
    }))
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
    if (!rewrite.data?.rewritten) return
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
      const ctx = await buildProjectContext({ budget: 8000, focusChapterId })
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
      const ctx = await buildProjectContext({ budget: 10000, focusChapterId })
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
      const ctx = await buildProjectContext({ budget: 8000, focusChapterId })
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
      const ctx = await buildProjectContext({ budget: 8000, focusChapterId })
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
      const ctx = await buildProjectContext({ budget: 8000, focusChapterId })
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
      const ctx = await buildProjectContext({ budget: 8000, focusChapterId })
      const r = await withCtrl(signal => aiBriefing(ctx.text, content, { signal }))
      setBrief({ loading: false, data: r })
    } catch (e) {
      setBrief({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const aiBtnCls = 'w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] border transition-colors disabled:opacity-45 disabled:cursor-not-allowed'
  const scoreCls = (s: number) => (s >= 75 ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : s >= 60 ? 'bg-amber/15 text-amber border-amber/30' : 'bg-red-500/15 text-red-300 border-red-500/30')

  return (
    <div className="absolute right-3 top-14 bottom-10 w-[360px] z-30 bg-ink-850 border border-ink-700 rounded-xl shadow-2xl flex flex-col overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-ink-700 shrink-0">
        <Wand2 size={14} className="text-amber" />
        <span className="text-[12px] font-semibold text-ink-100 flex-1">颉文姬 · AI 编辑</span>
        <HelpPopover title="颉文姬 · AI 编辑" width="24rem" size={12} className="shrink-0">
          {'· 诊室：AI 深度校对（错别字 / 语病 / 逻辑 / 设定矛盾，可逐条「替换此条」）；AI 综合诊断（主编视角：优先级 / 隐藏风险 / 批量建议）。\n· 编辑：先在正文选中一段，选润色 / 扩写 / 精简 / 改语气 / 换视角。改稿以「建议段」标记写入原文下方，你的原文一字不动，取舍后可用「清除全部建议段」一键清理。\n· 审读：章节编辑意见（六维打分）/ OOC 人设检查 / 续写方向（只给思路不生成正文）/ 爽点毒点 / 黄金三章。\n· 简报（v1.6.1）：开写前一键生成「本章写作简报」——未回收伏笔 / 钩子爽点方向 / 角色状态提醒 / 下一章衔接，只给方向不代写正文。\n· 补登（v1.9.1）：扫本章正文，抽出有专名的人物 / 势力 / 地点 / 种族 / 物品 / 术语，与已有设定比对后分「已登记 / 疑似重复 / 待补登」三档；勾选即可一键写入对应设定表或角色卡，只填名称与一句话，其余留空自己补。「是否已登记」由程序按名称与别称精确比对，AI 只负责抽取。\n· 所有 AI 入口需先配置模型；未配置时按钮禁用，原有本地功能不受影响。\n· 底部开关可控制屏幕右侧的 Q 版精灵是否显示。'}
        </HelpPopover>
        <Button variant="icon-muted" onClick={onClose} className="p-1" title="收起"><X size={16} /></Button>
      </div>

      {/* 模式切换 */}
      <div className="flex gap-1 px-2 pt-2 shrink-0">
        {([
          ['clinic', '诊室', Stethoscope],
          ['edit', '编辑', PenLine],
          ['review', '审读', BookOpen],
          ['brief', '简报', Sparkles],
          ['ledger', '补登', ClipboardList],
        ] as [Mode, string, typeof PenLine][]).map(([m, label, Icon]) => (
          <Button variant="bare"
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[11.5px] border transition-colors ${
              mode === m ? 'bg-amber/15 text-amber border-amber/30' : 'text-ink-400 border-transparent hover:bg-ink-800 hover:text-ink-200'
            }`}
          >
            <Icon size={12} /> {label}
          </Button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* ================= 诊室 ================= */}
        {mode === 'clinic' && (
          <>
            {/* 校对只走完整正文：摘要定位不到原文 quote，简略模式会误替换（已移除） */}
            <div className="flex items-center gap-1.5 text-[10.5px] text-ink-500">
              <span>校对范围</span>
              <div className="flex rounded-md overflow-hidden border border-ink-700">
                <Button title="校对结果需在正文中精确定位替换，故恒校对全文；诊断支持用压缩摘要的简略模式" variant="primary" solid size="md">完整（正文）</Button>
              </div>
            </div>
            <Button variant="bare"
              onClick={() => void runProofread()}
              disabled={!aiReady || proof.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : '错别字 / 语病 / 逻辑 / 设定矛盾'}
            >
              {proof.loading ? <Loader2 size={12} className="animate-spin" /> : <SpellCheck size={12} />}
              {proof.loading ? '校对中…' : 'AI 深度校对（错别字 / 语病 / 逻辑 / 设定矛盾）'}
            </Button>
            {proof.loading && (
              <div className="flex items-center gap-2">
                <div className="h-1 rounded bg-ink-700 overflow-hidden flex-1">
                  <div className="h-full bg-amber transition-all" style={{ width: `${proof.progress.total ? (proof.progress.done / proof.progress.total) * 100 : 0}%` }} />
                </div>
                <Button onClick={stopProofread} variant="secondary" size="md" className="text-[11px] shrink-0">
                  停止
                </Button>
              </div>
            )}
            {proof.error && <div className="text-[11px] text-red-300 px-1">{proof.error}</div>}
            {proof.done && !proof.loading && proof.cancelled && (
              <div className="text-[11px] text-ink-300 px-1">已停止校对（保留已查出的 {proof.issues.length} 处）</div>
            )}
            {proof.done && !proof.loading && !proof.cancelled && (
              <div className="text-[10.5px] text-ink-500">
                共校对 {proof.scanned} 字{proof.skipped > 0 ? `，跳过 ${proof.skipped} 字` : ''}，发现 {proof.issues.length} 处
              </div>
            )}
            {proof.issues.length > 0 && (
              <div className="space-y-1.5 max-h-56 overflow-y-auto">
                {proof.issues.map((iss, i) => (
                  <div key={i} className="rounded bg-ink-850 border border-ink-700/70 px-2 py-1.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="inline-block px-1.5 py-px rounded text-[9.5px] border bg-ink-700 text-ink-300 border-ink-600">{iss.type}</span>
                      <span className="text-[11px] text-red-300 line-through">{iss.quote}</span>
                      <span className="text-[10px] text-ink-500">→</span>
                      <span className="text-[11px] text-emerald-300">{iss.fix}</span>
                    </div>
                    {iss.why && <div className="text-[10.5px] text-ink-400 mt-0.5">{iss.why}</div>}
                    <Button variant="bare"
                      onClick={() => replaceOne(iss)}
                      className="mt-1 px-2 py-0.5 rounded-md text-[10.5px] bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 hover:bg-emerald-500/20 transition-colors"
                    >
                      替换此条
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {proof.done && !proof.loading && !proof.cancelled && proof.issues.length === 0 && (
              <div className="text-center text-[11.5px] text-emerald-300 py-1">
                <CheckCircle2 size={13} className="inline mr-1" /> 未发现确定问题
              </div>
            )}

            {/* 诊断范围：完整（正文）/ 简略（压缩摘要） */}
            <div className="flex items-center gap-1.5 text-[10.5px] text-ink-500">
              <span>诊断范围</span>
              <div className="flex rounded-md overflow-hidden border border-ink-700">
                <Button variant="bare"
                  onClick={() => setDiagMode('full')}
                  className={`px-2 py-0.5 transition-colors ${diagMode === 'full' ? 'bg-amber/20 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
                  title="喂入本章全文：诊断最准，但耗时长、费 token"
                >完整（正文）</Button>
                <Button variant="bare"
                  onClick={() => setDiagMode('brief')}
                  className={`px-2 py-0.5 transition-colors ${diagMode === 'brief' ? 'bg-amber/20 text-amber' : 'text-ink-400 hover:text-ink-200'}`}
                  title="只喂「章节压缩摘要」（约原文 1/10）：速度快、省 token"
                >简略（压缩摘要）</Button>
              </div>
            </div>
            <Button variant="bare"
              onClick={() => void runDiag()}
              disabled={!aiReady || diag.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : '主编视角：优先级 / 隐藏风险 / 批量建议'}
            >
              {diag.loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {diag.loading ? '诊断中…' : 'AI 综合诊断（优先级 / 隐藏风险 / 批量建议）'}
            </Button>
            {!aiReady && <div className="text-[10.5px] text-ink-500 leading-relaxed px-1">{AI_DISABLED_HINT}</div>}

            {diag.error && <div className="text-[11px] text-red-300 px-1">{diag.error}</div>}
            {diag.data && (
              <div className="rounded-lg border border-amber/25 bg-amber/5 px-3 py-2.5">
                {renderReport(diag.data.report)}
              </div>
            )}
          </>
        )}

        {/* ================= 编辑（选区改稿 → 建议段） ================= */}
        {mode === 'edit' && (
          <>
            <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10.5px] text-ink-500">当前选区</span>
                {selText && <span className="text-[10px] text-ink-500">{selText.length} 字</span>}
              </div>
              {selText ? (
                <div className="text-[11.5px] text-ink-100 leading-snug max-h-32 overflow-y-auto line-clamp-5">{selText}</div>
              ) : (
                <div className="text-[11px] text-ink-500 leading-relaxed">先在正文中选中一段文字（选中后无需再点任何按钮，选区会自动同步到这里）。</div>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {INSTRUCTIONS.map(ins => (
                <Button variant="toggle" selected={instruction === ins}
                  key={ins}
                  onClick={() => setInstruction(ins)}
                  className="px-2.5 py-1 rounded-full border text-[11px] hover:border-ink-500"
                >
                  {ins}
                </Button>
              ))}
            </div>

            <Button variant="bare"
              onClick={() => void runRewrite()}
              disabled={!aiReady || !selText || rewrite.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : undefined}
            >
              {rewrite.loading ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              {rewrite.loading ? '改稿中…' : `让颉文姬${instruction}选区`}
            </Button>

            {rewrite.error && <div className="text-[11px] text-red-300 px-1">{rewrite.error}</div>}

            {rewrite.data && (
              <div className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2.5 space-y-2">
                <div className="flex items-center gap-1.5 text-[11px] text-amber">
                  <CheckCircle2 size={12} /> 改稿完成{rewrite.data.notes ? `：${rewrite.data.notes}` : ''}
                </div>
                <div className="text-[11.5px] text-ink-100 leading-relaxed whitespace-pre-wrap max-h-52 overflow-y-auto">{rewrite.data.rewritten}</div>
                <Button onClick={applyAdvice} variant="primary" size="md" className="w-full flex items-center justify-center text-[12px]">
                  <PenLine size={12} /> 写入原文下方（建议段）
                </Button>
                <div className="text-[10.5px] text-ink-500 leading-relaxed">
                  建议段以「{ADVICE_START}」标记写入原文下方，不会改动你的原文。请自行取舍：保留的直接并入，不用的删除；下方按钮可一键清除全部建议段。
                </div>
              </div>
            )}

            <Button variant="bare"
              onClick={() => onClearAdvice?.()}
              className={`${aiBtnCls} bg-ink-800 border-ink-600 text-ink-300 hover:border-red-400/40 hover:text-red-300`}
            >
              <Trash2 size={12} /> 清除全部建议段
            </Button>
          </>
        )}

        {/* ================= 审读 ================= */}
        {mode === 'review' && (
          <>
            <Button variant="bare"
              onClick={() => void runReview()}
              disabled={!aiReady || rev.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : undefined}
            >
              {rev.loading ? <Loader2 size={12} className="animate-spin" /> : <BookOpen size={12} />}
              {rev.loading ? '审读中…' : '章节编辑意见（节奏 / 钩子 / 水文 / 对话）'}
            </Button>

            {rev.error && <div className="text-[11px] text-red-300 px-1">{rev.error}</div>}
            {rev.data && (
              <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`text-[15px] font-bold px-2.5 py-0.5 rounded-lg border ${scoreCls(rev.data.score)}`}>{rev.data.score}</span>
                  <span className="text-[11px] text-ink-100 leading-snug flex-1">{rev.data.verdict}</span>
                </div>
                <div className="space-y-1.5">
                  {rev.data.dimensions.map((d, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-[10.5px] text-ink-400 w-16 shrink-0">{d.name}</span>
                      <div className="flex gap-0.5 flex-1">
                        {Array.from({ length: 10 }, (_, j) => (
                          <span key={j} className={`h-1.5 w-2 rounded-sm ${j < d.score ? 'bg-amber' : 'bg-ink-700'}`} />
                        ))}
                      </div>
                      <span className="text-[10px] text-ink-500 w-5 text-right">{d.score}</span>
                    </div>
                  ))}
                </div>
                {rev.data.highlights.length > 0 && (
                  <div>
                    <div className="text-[10.5px] text-emerald-400 mb-1">亮点</div>
                    <ul className="space-y-1">
                      {rev.data.highlights.map((h, i) => <li key={i} className="text-[11px] text-ink-200 leading-snug">· {h}</li>)}
                    </ul>
                  </div>
                )}
                {rev.data.warnings.length > 0 && (
                  <div>
                    <div className="text-[10.5px] text-amber mb-1">需处理</div>
                    <ul className="space-y-1">
                      {rev.data.warnings.map((w, i) => <li key={i} className="text-[11px] text-ink-200 leading-snug">· {w}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <Button variant="bare"
              onClick={() => void runOoc()}
              disabled={!aiReady || ooc.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : undefined}
            >
              {ooc.loading ? <Loader2 size={12} className="animate-spin" /> : <AlertTriangle size={12} />}
              {ooc.loading ? '检查中…' : 'OOC 人设偏离检查'}
            </Button>

            {ooc.error && <div className="text-[11px] text-red-300 px-1">{ooc.error}</div>}
            {ooc.data && (
              <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5">
                {ooc.data.length === 0 ? (
                  <div className="text-center text-[11.5px] text-emerald-300 py-2"><CheckCircle2 size={13} className="inline mr-1" /> 未发现明显 OOC</div>
                ) : (
                  <div className="space-y-2">
                    {ooc.data.map((f, i) => (
                      <div key={i} className="rounded bg-ink-850 border border-ink-700/70 px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <SevBadge s={f.level} />
                          <span className="text-[11px] font-medium text-amber">{f.character}</span>
                        </div>
                        {f.evidence && <div className="text-[10.5px] text-ink-400 mt-1">原文：{f.evidence}</div>}
                        <div className="text-[11px] text-ink-100 mt-0.5 leading-snug">{f.issue}</div>
                        {f.suggestion && <div className="text-[10.5px] text-amber/80 mt-0.5">→ {f.suggestion}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <Button variant="bare"
              onClick={() => void runAdvice()}
              disabled={!aiReady || adv.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : undefined}
            >
              {adv.loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {adv.loading ? '思考中…' : '续写方向（只给思路，不生成正文）'}
            </Button>

            {adv.error && <div className="text-[11px] text-red-300 px-1">{adv.error}</div>}
            {adv.data && (
              <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 space-y-2">
                <div>
                  <div className="text-[10.5px] text-ink-500 mb-1">方向建议</div>
                  <div className="text-[11.5px] text-ink-100 leading-relaxed">{adv.data.direction}</div>
                </div>
                {adv.data.hooks.length > 0 && (
                  <div>
                    <div className="text-[10.5px] text-ink-500 mb-1">可用钩子</div>
                    <ul className="space-y-1">
                      {adv.data.hooks.map((h, i) => <li key={i} className="text-[11px] text-ink-200 leading-snug">· {h}</li>)}
                    </ul>
                  </div>
                )}
                {adv.data.pitfalls.length > 0 && (
                  <div>
                    <div className="text-[10.5px] text-amber mb-1">别踩的坑</div>
                    <ul className="space-y-1">
                      {adv.data.pitfalls.map((p, i) => <li key={i} className="text-[11px] text-ink-200 leading-snug">· {p}</li>)}
                    </ul>
                  </div>
                )}
                {adv.data.foreshadow && (
                  <div>
                    <div className="text-[10.5px] text-ink-500 mb-1">伏笔联动</div>
                    <div className="text-[11px] text-ink-200 leading-snug">{adv.data.foreshadow}</div>
                  </div>
                )}
              </div>
            )}

            <Button variant="bare"
              onClick={() => void runPleasure()}
              disabled={!aiReady || plea.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : '爽点供给 / 毒点预警 / 代入感与金手指 / 期待感'}
            >
              {plea.loading ? <Loader2 size={12} className="animate-spin" /> : <Flame size={12} />}
              {plea.loading ? '检查中…' : '爽点 / 毒点检查（YY·代入感·金手指）'}
            </Button>

            {plea.error && <div className="text-[11px] text-red-300 px-1">{plea.error}</div>}
            {plea.data && (
              <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5">
                {renderReport(plea.data.report)}
              </div>
            )}

            <Button variant="bare"
              onClick={() => void runOpening()}
              disabled={!aiReady || open.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : '按「黄金三章」标准检查作品开头'}
            >
              {open.loading ? <Loader2 size={12} className="animate-spin" /> : <BookOpenCheck size={12} />}
              {open.loading ? '检查中…' : '黄金三章检查（开篇定生死）'}
            </Button>

            {open.error && <div className="text-[11px] text-red-300 px-1">{open.error}</div>}
            {open.data && (
              <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5">
                {renderReport(open.data.report)}
              </div>
            )}

            {!aiReady && <div className="text-[10.5px] text-ink-500 leading-relaxed px-1">{AI_DISABLED_HINT}</div>}
          </>
        )}

        {/* ================= 简报：开写前本章待办（v1.6.1） ================= */}
        {mode === 'brief' && (
          <>
            <Button variant="bare"
              onClick={() => void runBrief()}
              disabled={!aiReady || brief.loading}
              className={`${aiBtnCls} bg-amber/15 border-amber/30 text-amber hover:bg-amber/25`}
              title={!aiReady ? AI_DISABLED_HINT : '基于设定资料生成「本章写作简报」：待办伏笔 / 钩子爽点 / 角色状态 / 下一章衔接'}
            >
              {brief.loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {brief.loading ? '生成中…' : '生成本章写作简报（开写前）'}
            </Button>
            <div className="text-[10.5px] text-ink-500 leading-relaxed px-1">
              写下一章之前点一下：AI 汇总未回收伏笔、可安排的钩子爽点、出场角色状态提醒与上一章衔接建议——只给方向，不代写正文。
            </div>
            {!aiReady && <div className="text-[10.5px] text-ink-500 leading-relaxed px-1">{AI_DISABLED_HINT}</div>}

            {brief.error && <div className="text-[11px] text-red-300 px-1">{brief.error}</div>}
            {brief.data && (
              <div className="rounded-lg border border-amber/25 bg-amber/5 px-3 py-2.5">
                {renderReport(brief.data.report)}
              </div>
            )}
          </>
        )}

        {/* ================= 补登（1.9.1） ================= */}
        {mode === 'ledger' && (
          <div className="space-y-2.5">
            <div className="rounded-lg border border-ink-700 bg-ink-900/40 p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="text-[11px] text-ink-300 leading-relaxed">
                  从本章正文抽出有专名的设定实体，与已有设定比对后分三档。
                  <span className="text-ink-500">「是否已登记」由程序按名称与别称精确比对，AI 只负责抽取，不会凭空编造。</span>
                </div>
                <Button onClick={runLedger}
                  disabled={!aiReady || ledger.loading || !content.trim()}
                  title={!aiReady ? AI_DISABLED_HINT : ledger.scannedAt ? '重新扫描本章正文' : '扫描本章正文'} variant="primary" size="md" className="shrink-0 flex items-center rounded text-[11px]">
                  {ledger.loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  {ledger.loading ? '扫描中' : ledger.scannedAt ? '重新扫描' : '扫描本章'}
                </Button>
              </div>
              {!aiReady && <div className="mt-1.5 text-[10.5px] text-ink-500">{AI_DISABLED_HINT}</div>}
            </div>

            {ledger.error && <div className="text-[11px] text-red-300 px-1">{ledger.error}</div>}

            {!ledger.loading && ledger.scannedAt > 0 && ledger.items.length === 0 && (
              <div className="rounded-lg border border-ink-700 bg-ink-900/30 px-3 py-4 text-center text-[11px] text-ink-500">
                本章没有抽出设定实体
              </div>
            )}

            {LEDGER_TYPES.map(type => {
              const list = ledger.items.filter(i => i.type === type)
              if (list.length === 0) return null
              return (
                <div key={type}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-[11px] text-amber font-medium">{type}</span>
                    <span className="text-[10px] text-ink-500">{list.length} 条</span>
                  </div>
                  <div className="space-y-1">
                    {list.map(it => {
                      const meta = STATUS_META[it.status]
                      return (
                        <div
                          key={it.key}
                          className={`rounded-lg border px-2 py-1.5 ${it.status === 'new' ? 'border-ink-600 bg-ink-900/50' : 'border-ink-700/60 bg-ink-900/20'}`}
                        >
                          <div className="flex items-start gap-1.5">
                            {it.status === 'new' ? (
                              <input
                                type="checkbox"
                                checked={ledgerPicked.has(it.key)}
                                onChange={e => setLedgerPicked(prev => {
                                  const n = new Set(prev)
                                  e.target.checked ? n.add(it.key) : n.delete(it.key)
                                  return n
                                })}
                                className="mt-[3px] shrink-0 accent-amber cursor-pointer"
                                title="勾选后一键补登"
                              />
                            ) : (
                              <span className="mt-[3px] w-3 shrink-0" />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-[12px] text-ink-100">{it.name}</span>
                                <span className={`inline-block px-1 py-px rounded text-[9.5px] border ${meta.cls}`}>{meta.label}</span>
                                {it.status !== 'new' && it.matchedName && it.matchedName !== it.name && (
                                  <span className="text-[10px] text-ink-500">→ 已记为「{it.matchedName}」</span>
                                )}
                              </div>

                              {it.desc && <div className="mt-0.5 text-[11px] text-ink-300 leading-relaxed">{it.desc}</div>}

                              {it.evidence && (
                                <div className="mt-1 text-[10.5px] text-ink-500 border-l-2 border-ink-700 pl-1.5 leading-relaxed">
                                  「{it.evidence}」
                                </div>
                              )}

                              {it.type === '人物' && it.status === 'new' && (
                                <div className="mt-1 flex items-center gap-1">
                                  <span className="text-[10px] text-ink-500">归入</span>
                                  <select
                                    value={it.targetTabId ?? 'char-npc'}
                                    onChange={e => setLedgerTargetTab(it.key, e.target.value)}
                                    className="text-[10px] px-1 py-px rounded bg-ink-900/60 border border-ink-700 text-ink-100 outline-none focus:border-amber/40"
                                  >
                                    {CARD_TABS.map(t => (
                                      <option key={t} value={t}>{TABS.find(x => x.id === t)?.name ?? t}</option>
                                    ))}
                                  </select>
                                </div>
                              )}

                              {it.status !== 'new' && it.matchedTabId && (
                                <Button variant="bare"
                                  type="button"
                                  onClick={() => jumpToEntry(it.matchedTabId!, it.matchedId)}
                                  className="mt-1 flex items-center gap-0.5 text-[10px] text-amber/80 hover:text-amber"
                                >
                                  去核对 <ExternalLink size={9} />
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}

            {ledger.items.length > 0 && (
              <Button onClick={commitLedger}
                disabled={ledgerSaving || ledgerPicked.size === 0} variant="primary" size="md" className="w-full flex items-center justify-center text-[11.5px]">
                {ledgerSaving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                {ledgerSaving ? '写入中' : `补登选中的 ${ledgerPicked.size} 项`}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* 精灵开关 */}
      <div className="px-3 py-1.5 border-t border-ink-700 flex items-center justify-between gap-2 shrink-0">
        <span className="text-[10px] text-ink-500">屏幕右侧 Q 版精灵</span>
        <Button variant="bare"
          onClick={toggleSprite}
          className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${spriteOn ? 'bg-amber' : 'bg-ink-600'}`}
          title={spriteOn ? '点击隐藏右侧精灵' : '点击显示右侧精灵'}
        >
          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-ink-50 shadow transition-all ${spriteOn ? 'left-[18px]' : 'left-0.5'}`} />
        </Button>
      </div>
      {/* 底部状态 */}
      <div className="px-3 py-2 border-t border-ink-700 text-[10px] text-ink-500 flex items-center justify-between gap-2 shrink-0">
        <span>诊室两个入口均需配置模型 · 未配置时按钮禁用</span>
        {!aiReady && <span className="text-amber/70">未配置模型</span>}
      </div>
    </div>
  )
}
