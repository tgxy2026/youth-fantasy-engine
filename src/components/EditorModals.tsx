import { foldVh } from '../lib/theme'
import { writerBudgetFor } from '../lib/aiWriterBudget'
import { useEffect, useState, useMemo, useRef } from 'react'
import * as db from '../lib/db'
import { countWords } from '../lib/textStats'
import type { Chapter, Volume } from '../lib/types'
import { scanText, replaceHits } from '../lib/sensitiveWords'
import { contextSnippet } from '../lib/contextSnippet'
import { diffLines, diffStats } from '../lib/textDiff'
import { ShieldAlert, History, Trash2, Search, Lock, Eye, EyeOff, Sparkles, AlertCircle, Loader2 } from 'lucide-react'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { aiProofreadText, aiProofreadLogic, type ProofreadIssue } from '../lib/aiTasks'
import { isCancelled } from '../lib/ai'
import { buildProjectContext } from '../lib/aiContext'
import { confirmDialog } from './dialogs'
import { Modal as BaseModal } from './Modal'

// ============ 通用外壳（转发到统一 Modal，保留原 API：title / icon / onClose / children / wide）============
export function ToolModal({ title, icon, onClose, children, wide, help }: {
  title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode; wide?: boolean
  /** C-9 · 2.6.0：问号提示——传了就渲染在标题行紧跟功能名（红线：问号必须紧跟功能名，不得被 flex-1 描述挤到行尾） */
  help?: React.ReactNode
}) {
  return (
    <BaseModal open onClose={onClose} icon={icon} width={wide ? 768 : 560} title={title}
      titleSlot={help ? (
        <span className="flex items-center gap-1.5 min-w-0">
          <h3 className="text-14 font-semibold text-ink-50 truncate">{title}</h3>
          {help}
        </span>
      ) : undefined}
    >
      {children}
    </BaseModal>
  )
}

// ============ 敏感词检测（当前章） ============
export function SensitiveCheck({ content, onApply, onClose }: {
  content: string; onApply: (next: string) => void; onClose: () => void
}) {
  const [customWords, setCustomWords] = useState<string[]>([])
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    db.getSetting<string[]>('customSensitiveWords', []).then(setCustomWords).then(() => setChecked(true))
  }, [])
  const hits = useMemo(() => (checked ? scanText(content, customWords) : []), [content, customWords, checked])
  const [replaced, setReplaced] = useState(false)

  return (
    <ToolModal title="敏感词检测（本章）" icon={<ShieldAlert size={16} />} onClose={onClose}>
      {!checked ? <div className="text-12 text-ink-400">检测中…</div> : hits.length === 0 ? (
        <div className="py-8 text-center text-13 text-success">本章未检出敏感词 ✓（词库可在「检查工具」页扩充）</div>
      ) : (
        <>
          <div className="text-12 text-danger mb-3">
            检出 {hits.length} 个敏感词、共 {hits.reduce((s, h) => s + h.count, 0)} 处：
          </div>
          <div className="space-y-2 mb-4">
            {hits.map(h => (
              <div key={h.word} className="flex items-start gap-2 text-12 bg-ink-800 border border-ink-700 rounded-lg px-3 py-2">
                <span className="px-1.5 py-0.5 bg-danger/15 text-danger rounded shrink-0">{h.word} ×{h.count}</span>
                <span className="text-ink-400 flex-1">{h.context}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="primary" onClick={() => { onApply(replaceHits(content, hits)); setReplaced(true); onClose() }} className="px-4 py-2 rounded-lg text-12 transition-colors">
              一键替换为 ■■（{replaced ? '已' : '未'}替换）
            </Button>
          </div>
        </>
      )}
    </ToolModal>
  )
}

// ============ 校对（本章）：本地错别字词库 + AI 深度校对 ============
import { scanTypos, replaceTypos } from '../lib/typoWords'
import HelpPopover from './HelpPopover'
import AIDataSourceNote from './AIDataSourceNote'
import { Button } from './Button'
import { Z } from '../lib/zLayer'
import NumberField from './NumberField'

/** 各类型对应的色标签 */
const PTF_BADGE: Record<string, string> = {
  错别字: 'bg-amber/15 text-amber border-amber/30',
  语病: 'bg-info/15 text-info border-info/30',
  逻辑: 'bg-danger/15 text-danger border-danger/30',
  设定矛盾: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  标点: 'bg-ink-700 text-ink-300 border-ink-600',
}
const badgeOf = (t: string) => PTF_BADGE[t] ?? 'bg-ink-700 text-ink-300 border-ink-600'

/**
 * 校对的两块（2026-09-20 拆分，老大要求）：文字层 / 逻辑层。
 * 拆开的实际收益：文字层**不读设定资料** —— 每块少注入几千字，出结果明显更快；
 * 逻辑层才读设定（判前后矛盾、设定冲突必须有依据）。
 */
type ProofScope = 'text' | 'logic'
const SCOPE_ORDER: ProofScope[] = ['text', 'logic']
const SCOPE_META: Record<ProofScope, { label: string; running: string; title: string }> = {
  text: {
    label: '查错别字与语病',
    running: '文字校对中',
    title: '错别字 / 语病 / 标点 —— 逐字逐句读本章正文，不读设定资料（更快）',
  },
  logic: {
    label: '查逻辑与设定矛盾',
    running: '逻辑审校中',
    title: '逻辑矛盾 / 时间空间错乱 / 与设定资料冲突 —— 会读项目设定资料',
  },
}
interface ScopeState {
  issues: ProofreadIssue[]
  loading: boolean
  done: boolean
  /** 被作者主动停止（保留已查出的部分结果，不当失败） */
  cancelled: boolean
  progress: { done: number; total: number }
  skipped: number
  scanned: number
  error: string
}
const blankScope = (): ScopeState => ({
  issues: [], loading: false, done: false, cancelled: false,
  progress: { done: 0, total: 0 }, skipped: 0, scanned: 0, error: '',
})

export function ProofreadCheck({ content, onApply, onClose }: {
  content: string; onApply: (next: string) => void; onClose: () => void
}) {
  const { ready: aiReady } = useAIReady()

  // 本地错别字词库（始终可用，无需模型）
  const [checked, setChecked] = useState(false)
  const [typoHits, setTypoHits] = useState<ReturnType<typeof scanTypos>>([])
  useEffect(() => { setTypoHits(scanTypos(content)); setChecked(true) }, [content])

  // AI 校对结果 —— **文字层与逻辑层各存一份**：两块可以分别跑、分别看，
  // 一块的进度与报错不影响另一块（原先一个 aiLoading 盖住全部，跑一块就得等另一块也让路）。
  const [text, setText] = useState(content)
  const [scopes, setScopes] = useState<Record<ProofScope, ScopeState>>({
    text: blankScope(), logic: blankScope(),
  })
  const abortRef = useRef<Partial<Record<ProofScope, AbortController>>>({})

  const patchScope = (s: ProofScope, patch: Partial<ScopeState>) =>
    setScopes(prev => ({ ...prev, [s]: { ...prev[s], ...patch } }))

  const runScope = async (scope: ProofScope) => {
    if (!aiReady || scopes[scope].loading) return
    const ctrl = new AbortController()
    abortRef.current[scope] = ctrl
    patchScope(scope, { ...blankScope(), loading: true })
    try {
      // 🔴 逻辑层才读设定资料；文字层刻意不读 —— 省掉每块几千字的注入，出结果更快，
      //    也避免模型"拿设定去猜人名是不是写错"这类误报（见 aiTasks/proofread.ts 的文字层提示词）。
      let ctxText = ''
      if (scope === 'logic') {
        try { ctxText = (await buildProjectContext({ budget: await writerBudgetFor('proofread') })).text } catch { /* 拿不到设定资料就少带一段，不阻断 */ }
      }
      const run = scope === 'text' ? aiProofreadText : aiProofreadLogic
      const res = await run(text, {
        context: ctxText, signal: ctrl.signal,
        onProgress: (d, t) => patchScope(scope, { progress: { done: d, total: t } }),
      })
      patchScope(scope, { issues: res.issues, scanned: res.scanned, skipped: res.skipped, done: true })
    } catch (e) {
      if (isCancelled(e)) {
        // 用户主动停止：保留已查出的部分结果，不当作失败
        patchScope(scope, { done: true, cancelled: true })
      } else {
        patchScope(scope, { done: true, error: e instanceof Error ? e.message : String(e) })
      }
    } finally {
      patchScope(scope, { loading: false })
      delete abortRef.current[scope]
    }
  }

  const stopScope = (scope: ProofScope) => abortRef.current[scope]?.abort()

  /** 替换单条 AI 校对结果。
   * 优先用 AI 标注的精确位置 iss.at 定位——正文里同一句话重复出现时，
   * 用 indexOf 会永远命中第一个，导致改错位置；定位不到再回退 indexOf。
   * 替换后把**两块**里剩余的问题都按位移重新锚定：正文变了，另一层记录的下标也一起漂，
   * 只重锚定自己那一块的话，切过去再点就是"定位失败"。 */
  const replaceIssue = (scope: ProofScope, iss: ProofreadIssue) => {
    let idx = -1
    if (iss.at != null && text.slice(iss.at, iss.at + iss.quote.length) === iss.quote) {
      idx = iss.at
    } else {
      idx = text.indexOf(iss.quote)
    }
    if (idx < 0) return
    const delta = iss.fix.length - iss.quote.length
    const next = text.slice(0, idx) + iss.fix + text.slice(idx + iss.quote.length)
    setText(next); onApply(next)
    setScopes(prev => {
      const out = { ...prev }
      for (const k of SCOPE_ORDER) {
        out[k] = {
          ...prev[k],
          issues: prev[k].issues
            .filter(i => !(k === scope && i === iss))
            .map(i => (i.at != null && i.at > idx ? { ...i, at: i.at + delta } : i))
            .sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
        }
      }
      return out
    })
  }

  const replaceTypoAll = () => {
    const next = replaceTypos(text, typoHits)
    setText(next); onApply(next)
    setTypoHits([])
  }

  const typoTotal = typoHits.reduce((s, h) => s + h.count, 0)

  return (
    <ToolModal title="校对（本章）" icon={<span className="text-amber">校</span>} onClose={onClose} wide
      help={
        <HelpPopover title="校对怎么用" width="22rem">
          {'· 「本地错别字」：内置常见错别字词典（如「帐号→账号」），无需模型，随时可用，可一键替换。\n· 「查错别字与语病」：接入模型后逐字逐句读本章正文，找错别字、语病、标点问题；不读设定资料，所以更快。\n· 「查逻辑与设定矛盾」：读项目设定资料，判前后矛盾、时间与空间错乱、与既有设定冲突。\n· 两块互相独立：可以只跑一块、分别看结果；点「替换此条」会直接改正文，另一块的定位会自动跟着位移。\n· 未接入模型时两块按钮都禁用，但本地错别字检测与本章所有手动功能不受影响。'}
          <AIDataSourceNote feature="proofread" />
          <AIDataSourceNote feature="proofread-logic" />
        </HelpPopover>
      }
    >
      <div className="mb-3">
        <span className="text-11 text-ink-500">
          错别字由内置词库本地直接查（无需模型）；AI 校验拆成两块 —— 文字层（错别字 / 语病 / 标点）不读设定资料、出结果更快，逻辑层（逻辑 / 设定矛盾）才读设定资料。
        </span>
      </div>

      {/* 本地错别字结果 */}
      <div className="mb-4">
        <div className="text-12 font-semibold text-ink-100 mb-2 flex items-center gap-2">
          本地错别字词库
          <span className="text-10 font-normal text-ink-500">（无需模型）</span>
        </div>
        {!checked ? <div className="text-12 text-ink-400">检测中…</div> : typoHits.length === 0 ? (
          <div className="py-3 text-center text-12 text-success">本章未检出常见错别字 ✓</div>
        ) : (
          <>
            <div className="text-12 text-amber/80 mb-2">检出 {typoHits.length} 类、共 {typoTotal} 处：</div>
            <div className="space-y-2 mb-3">
              {typoHits.map(h => (
                <div key={h.word} className="flex items-start gap-2 text-12 bg-ink-800 border border-ink-700 rounded-lg px-3 py-2">
                  <span className="px-1.5 py-0.5 bg-amber/15 text-amber rounded shrink-0 whitespace-nowrap">「{h.word}」→「{h.suggest}」 ×{h.count}</span>
                  <span className="text-ink-400 flex-1">{h.context}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <Button onClick={replaceTypoAll} variant="primary" size="md" className="text-12">
                一键替换错别字（{typoTotal} 处）
              </Button>
            </div>
          </>
        )}
      </div>

      {/* AI 深度校对 */}
      <div className="border-t border-ink-700 pt-4">
        <div className="text-12 font-semibold text-ink-100 mb-2 flex items-center gap-2">
          AI 校对
          <span className="text-10 font-normal text-ink-500">（需模型 · 两块可分别跑）</span>
        </div>

        <div className="flex items-center gap-2 mb-3">
          {SCOPE_ORDER.map(scope => {
            const st = scopes[scope]
            const meta = SCOPE_META[scope]
            if (!aiReady) {
              return (
                <Button key={scope} disabled title={AI_DISABLED_HINT}
                  variant="secondary" size="md" className="flex items-center text-12 cursor-not-allowed">
                  <Sparkles size={13} /> {meta.label}
                </Button>
              )
            }
            if (st.loading) {
              return (
                <Button key={scope} onClick={() => stopScope(scope)} variant="danger" size="md"
                  className="flex items-center text-12" title="点击停止（已查出的部分会保留）">
                  <AlertCircle size={13} /> 停止{meta.running}（{st.progress.done}/{st.progress.total}）
                </Button>
              )
            }
            return (
              <Button key={scope} onClick={() => void runScope(scope)} variant="primary" size="md"
                className="flex items-center text-12" title={meta.title}>
                <Sparkles size={13} /> {st.done ? `重新${meta.label}` : meta.label}
              </Button>
            )
          })}
          {!aiReady && (
            <span className="text-11 text-ink-500">未接入 AI 模型 —— 两块校对都不可用。</span>
          )}
        </div>

        {SCOPE_ORDER.map(scope => {
          const st = scopes[scope]
          const meta = SCOPE_META[scope]
          // 没跑过的块整段不出现 —— 界面上只留"我点过的那块"，没有空壳标题
          if (!st.loading && !st.done) return null
          return (
            <div key={scope} className="mb-3 last:mb-0">
              <div className="text-11 mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-ink-300">{meta.label}</span>
                {st.loading && (
                  <span className="text-ink-500 flex items-center gap-1">
                    <Loader2 size={11} className="animate-spin" /> 正在逐段校对…
                  </span>
                )}
                {st.done && !st.error && (
                  <span className="text-ink-500">
                    共 {st.issues.length} 处 · 已校对 {st.scanned} 字
                    {st.skipped > 0 ? `（余 ${st.skipped} 字超出上限未校，可分段或精简后重校）` : ''}
                  </span>
                )}
              </div>

              {st.error && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/25 text-11 text-danger mb-2">
                  <AlertCircle size={12} className="mt-0.5 shrink-0" /> <span className="whitespace-pre-wrap">{st.error}</span>
                </div>
              )}
              {st.done && st.cancelled && (
                <div className="px-3 py-2 rounded-lg bg-ink-800/60 border border-ink-700 text-11 text-ink-400">
                  已停止（保留已查出的 {st.issues.length} 处）
                </div>
              )}
              {st.done && !st.error && st.issues.length === 0 && (
                <div className="py-2 text-12 text-success">
                  {scope === 'text' ? '未发现错别字 / 语病 / 标点问题 ✓' : '未发现逻辑矛盾或设定冲突 ✓'}
                </div>
              )}
              {st.issues.length > 0 && (
                <div className="space-y-2">
                  {st.issues.map((iss, i) => (
                    <div key={i} className="flex items-start gap-2 text-12 bg-ink-800 border border-ink-700 rounded-lg px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded border shrink-0 whitespace-nowrap text-10 ${badgeOf(iss.type)}`}>{iss.type}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-ink-200">
                          「<span className="text-amber/90">{iss.quote}</span>」→「<span className="text-success">{iss.fix}</span>」
                        </div>
                        {iss.why && <div className="text-ink-500 mt-0.5">{iss.why}</div>}
                      </div>
                      <Button variant="bare"
                        onClick={() => replaceIssue(scope, iss)}
                        className="shrink-0 px-2 py-1 bg-ink-700 text-ink-200 border border-ink-600 rounded text-11 hover:bg-ink-600 transition-colors"
                        title="在正文中替换这一处"
                      >
                        替换此条
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </ToolModal>
  )
}

// ============ 时光机：版本历史 ============
/** 快照来源标签（2.4.0 · A3）：让作者一眼看出哪几版是 AI 动笔前留的旧稿 */
const SNAP_SOURCE_LABEL: Record<db.SnapshotSource, string> = {
  'auto': '自动留档',
  'ai-rewrite': 'AI 改写前',
  'ai-continue': 'AI 续写前',
  'ai-generate': 'AI 生成前',
  'manual-restore': '回滚前留档',
}

export function VersionHistory({ chapterId, current, onRestore, onClose }: {
  chapterId: string
  /** 当前正文 —— 「与当前稿对比」用它做新版 */
  current: string
  onRestore: (content: string) => void
  onClose: () => void
}) {
  const [snaps, setSnaps] = useState<db.Snapshot[]>([])
  const [preview, setPreview] = useState<db.Snapshot | null>(null)
  const [tab, setTab] = useState<'content' | 'diff'>('content')
  /**
   * 对比基准（2.4.0 · A3 遗留补全）：默认 `'current'`＝当前稿（原行为），也可选**另一个版本**。
   * 此前只能「某版 vs 当前稿」，想看清"这两次改动之间到底动了什么"时没法比 —— 现在可以任意两版互比。
   */
  const [baseId, setBaseId] = useState<'current' | string>('current')
  useEffect(() => { db.getSnapshots(chapterId).then(setSnaps) }, [chapterId])

  const fmt = (t: number) => {
    const d = new Date(t)
    return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  /** 基准正文；基准被删/换成别的章时回落到当前稿（宁可给出对比，也不要空屏） */
  const baseContent = baseId === 'current' ? current : (snaps.find(s => s.id === baseId)?.content ?? current)
  const baseSnap = baseId === 'current' ? null : (snaps.find(s => s.id === baseId) ?? null)
  const baseLabel = baseSnap ? fmt(baseSnap.createdAt) : '当前稿'

  // 差异只在选中版本 / 基准 / 当前正文变化时重算（长篇对比是一次 LCS，别每帧算）
  const diff = useMemo(() => (preview ? diffLines(baseContent, preview.content) : []), [preview, baseContent])
  const stats = useMemo(() => diffStats(diff), [diff])

  return (
    <ToolModal title="时光机 · 本章版本历史（每章保留最近 12 版）" icon={<History size={16} />} onClose={onClose} wide>
      {snaps.length === 0 ? (
        <div className="py-8 text-center text-12 text-ink-500">
          暂无历史版本 —— 写作过程中每 5 分钟或每变化 200 字自动存一版；AI 改写前也会自动留一版旧稿
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            {snaps.map(s => {
              const src = db.snapshotSourceOf(s)
              const isAI = db.isAISnapshot(s)
              return (
                <Button variant="bare"
                  key={s.id}
                  onClick={() => setPreview(s)}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border text-left transition-colors ${preview?.id === s.id ? 'border-amber/40 bg-amber/10' : 'border-ink-700 bg-ink-800 hover:border-ink-600'}`}
                >
                  <span className="text-12 text-ink-200 shrink-0">{fmt(s.createdAt)}</span>
                  <span className={`shrink-0 px-1.5 py-px rounded text-10 ${isAI ? 'bg-amber/15 text-amber' : 'bg-ink-700/60 text-ink-400'}`}>
                    {SNAP_SOURCE_LABEL[src]}
                  </span>
                  <span className="ml-auto text-11 text-ink-500 shrink-0">{s.wordCount} 字</span>
                </Button>
              )
            })}
          </div>
          <div className="bg-ink-800 border border-ink-700 rounded-lg p-3 flex flex-col">
            {preview ? (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-11 text-ink-400">{fmt(preview.createdAt)} · {preview.wordCount} 字</span>
                  <div className="ml-auto flex gap-1">
                    <Button variant="toggle" selected={tab === 'content'} size="xs" onClick={() => setTab('content')}>内容</Button>
                    <Button variant="toggle" selected={tab === 'diff'} size="xs" onClick={() => setTab('diff')}>对比</Button>
                  </div>
                </div>
                {/* 对比基准可选（A3 遗留补全）：默认当前稿；换成另一版就能比"这两次改动之间动了什么" */}
                {tab === 'diff' && (
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-10 text-ink-500 shrink-0">对比基准</span>
                    <select
                      value={baseId}
                      onChange={e => setBaseId(e.target.value)}
                      className="flex-1 min-w-0 bg-ink-900 border border-ink-700 rounded px-1.5 py-0.5 text-11 text-ink-200 outline-none focus:border-amber/40"
                    >
                      <option value="current">当前稿</option>
                      {snaps.filter(s => s.id !== preview.id).map(s => (
                        <option key={s.id} value={s.id}>
                          {fmt(s.createdAt)} · {SNAP_SOURCE_LABEL[db.snapshotSourceOf(s)]}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {tab === 'content' ? (
                  <pre className="flex-1 overflow-y-auto text-12 text-ink-200 whitespace-pre-wrap font-serif max-h-64">{preview.content.slice(0, 2000)}{preview.content.length > 2000 ? '…' : ''}</pre>
                ) : (
                  <div className="flex-1 overflow-y-auto max-h-64 font-serif text-12 leading-relaxed">
                    <div className="mb-1.5 text-11 text-ink-500">
                      {baseLabel} → {fmt(preview.createdAt)}：新增 {stats.added} 行 · 删除 {stats.deleted} 行
                      {stats.added === 0 && stats.deleted === 0 && ' —— 两版完全一致'}
                    </div>
                    {diff.map((l, i) => (
                      <div
                        key={i}
                        className={`whitespace-pre-wrap px-1.5 rounded ${
                          l.kind === 'add' ? 'bg-success/10 text-success'
                            : l.kind === 'del' ? 'bg-danger/10 text-danger/80'
                              : 'text-ink-400'
                        }`}
                      >
                        <span className="select-none text-ink-600 mr-1">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                        {l.text || '\u00a0'}
                      </div>
                    ))}
                  </div>
                )}
                <Button variant="primary" onClick={() => { onRestore(preview.content); onClose() }} className="mt-3 px-3 py-2 rounded-lg text-12 transition-colors">
                  恢复到此版本（当前内容会先自动留档）
                </Button>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-12 text-ink-600">点击左侧版本查看内容或对比</div>
            )}
          </div>
        </div>
      )}
    </ToolModal>
  )
}

// ============ 回收站 ============
export function TrashBin({ onChanged, onClose }: { onChanged: () => void; onClose: () => void }) {
  const [items, setItems] = useState<db.TrashItem[]>([])
  const [volumes, setVolumes] = useState<Volume[]>([])
  useEffect(() => {
    Promise.all([db.listTrash(), db.getAllVolumes()]).then(([t, v]) => { setItems(t); setVolumes(v) })
  }, [])
  const fmt = (t: number) => new Date(t).toLocaleDateString()

  const restore = async (id: string) => {
    await db.restoreFromTrash(id)
    setItems(await db.listTrash())
    onChanged()
  }
  const purge = async (id: string) => {
    if (!await confirmDialog({ title: '彻底删除', message: '彻底删除后无法恢复，确认？', danger: true })) return
    await db.purgeTrashItem(id)
    setItems(await db.listTrash())
  }

  return (
    <ToolModal title={`回收站（${items.length}）`} icon={<Trash2 size={16} />} onClose={onClose}>
      {items.length === 0 ? (
        <div className="py-8 text-center text-12 text-ink-500">回收站是空的——删除的章节会先放到这里，随时可恢复</div>
      ) : (
        <>
          <div className="space-y-1.5">
            {items.map(t => (
              <div key={t.id} className="flex items-center gap-2 px-3 py-2.5 bg-ink-800 border border-ink-700 rounded-lg">
                <div className="flex-1 min-w-0">
                  <div className="text-12 text-ink-100 truncate">{t.title}</div>
                  <div className="text-10 text-ink-500">
                    {t.wordCount} 字 · {fmt(t.deletedAt)}删除
                    {!volumes.some(v => v.id === t.volumeId) && <span className="text-amber ml-1">（原卷已删，恢复后放入「已恢复章节」卷）</span>}
                  </div>
                </div>
                <Button variant="bare" onClick={() => restore(t.id)} className="px-2.5 py-1 bg-success/10 text-success border border-success/25 rounded-md text-11 hover:bg-success/20 transition-colors">恢复</Button>
                <Button variant="bare" onClick={() => purge(t.id)} className="px-2.5 py-1 bg-danger/10 text-danger border border-danger/25 rounded-md text-11 hover:bg-danger/20 transition-colors">彻底删除</Button>
              </div>
            ))}
          </div>
          {items.length > 1 && (
            <div className="mt-4 text-right">
              <Button variant="bare"
                onClick={async () => { if (await confirmDialog({ title: '清空回收站', message: `彻底清空 ${items.length} 个章节？不可恢复！`, danger: true })) { await db.emptyTrash(); setItems([]); } }}
                className="px-3 py-1.5 text-11 text-danger hover:text-danger transition-colors"
              >清空回收站</Button>
            </div>
          )}
        </>
      )}
    </ToolModal>
  )
}

// ============ 全文搜索替换 ============
export function GlobalSearch({ chapters, onOpenChapter, onReplaced, onClose }: {
  chapters: Chapter[]
  onOpenChapter: (id: string) => void
  onReplaced: (id: string, content: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [replacement, setReplacement] = useState('')
  const [results, setResults] = useState<{ ch: Chapter; count: number; contexts: string[] }[]>([])
  const [searched, setSearched] = useState(false)

  const doSearch = () => {
    if (!q.trim()) return
    const out: { ch: Chapter; count: number; contexts: string[] }[] = []
    for (const ch of chapters) {
      const text = `${ch.title}\n${ch.content || ''}`
      let idx = text.indexOf(q)
      if (idx === -1) continue
      let count = 0
      const contexts: string[] = []
      while (idx !== -1 && contexts.length < 5) {
        count++
        contexts.push(contextSnippet(text, idx, q.length))
        idx = text.indexOf(q, idx + q.length)
      }
      while (idx !== -1) { count++; idx = text.indexOf(q, idx + q.length) }
      out.push({ ch, count, contexts })
    }
    setResults(out)
    setSearched(true)
  }

  const replaceAll = async () => {
    if (!q.trim() || results.length === 0) return
    const total = results.reduce((s, r) => s + r.count, 0)
    if (!await confirmDialog({ title: '全书替换', message: `全书将「${q}」替换为「${replacement}」，共 ${total} 处（${results.length} 章）。确认执行？` })) return
    for (const r of results) {
      const next = r.ch.content.split(q).join(replacement)
      onReplaced(r.ch.id, next)
      // 重算字数，避免章节总表与统计面板保留旧字数
      await db.saveChapter({ ...r.ch, content: next, wordCount: countWords(next), updatedAt: Date.now() })
    }
    doSearch()
  }

  return (
    <ToolModal title="全文搜索替换（全书范围）" icon={<Search size={16} />} onClose={onClose} wide>
      <div className="flex gap-2 mb-2">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && doSearch()}
          placeholder="搜索全书正文与章名…"
          className="flex-1 !py-1.5 text-13"
          autoFocus
        />
        <Button onClick={doSearch} variant="primary" size="md" className="text-12">搜索</Button>
      </div>
      <div className="flex gap-2 items-center mb-4">
        <input
          value={replacement}
          onChange={e => setReplacement(e.target.value)}
          placeholder="替换为…（留空即删除）"
          className="flex-1 !py-1.5 text-12"
        />
        <Button onClick={replaceAll}
          disabled={!searched || results.length === 0} variant="secondary" size="md" className="text-12">全部替换</Button>
      </div>
      {searched && (
        results.length === 0 ? (
          <div className="py-8 text-center text-12 text-ink-500">全书未找到「{q}」</div>
        ) : (
          <div className="space-y-2">
            {results.map(r => (
              <div key={r.ch.id} className="bg-ink-800 border border-ink-700 rounded-lg p-3">
                <Button variant="bare" onClick={() => { onOpenChapter(r.ch.id); onClose() }} className="text-12 font-semibold text-amber hover:underline text-left">
                  {r.ch.title}（{r.count} 处）→ 点击跳转
                </Button>
                <div className="mt-1.5 space-y-0.5">
                  {r.contexts.map((c, i) => <div key={i} className="text-11 text-ink-400">{c}</div>)}
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </ToolModal>
  )
}

// ============ 小黑屋（强制锁定专注写作） ============
export function FocusLock({ chapter, initialContent, onSave, onExit }: {
  chapter: Chapter
  initialContent: string
  onSave: (content: string) => void
  onExit: () => void
}) {
  const [text, setText] = useState(initialContent)
  const [mode, setMode] = useState<'none' | 'words' | 'minutes'>('none')
  const [goalWords, setGoalWords] = useState(1000)
  const [goalMinutes, setGoalMinutes] = useState(45)
  const [startCount, setStartCount] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [showPwd, setShowPwd] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval>>()

  useEffect(() => () => clearInterval(timerRef.current), [])

  const start = (m: 'words' | 'minutes') => {
    setMode(m)
    setStartCount(countWords(text))
    const t0 = Date.now()
    setElapsed(0)
    clearInterval(timerRef.current)
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000)
  }

  const written = Math.max(0, countWords(text) - startCount)
  const goalMet =
    mode === 'none' ? true :
    mode === 'words' ? written >= goalWords :
    elapsed >= goalMinutes * 60

  const tryExit = async (force = false) => {
    if (goalMet || force) {
      if (!goalMet && !await confirmDialog({ title: '放弃退出', message: '目标未达成，确定放弃退出小黑屋？' })) return
      clearInterval(timerRef.current)
      onSave(text)
      onExit()
    } else {
      setShowPwd(true)
    }
  }

  const progress = mode === 'words'
    ? Math.min(100, (written / goalWords) * 100)
    : mode === 'minutes'
      ? Math.min(100, (elapsed / (goalMinutes * 60)) * 100)
      : 100

  if (mode === 'none') {
    return (
      <div className="fixed inset-0 bg-ink-950 flex items-center justify-center" style={{ zIndex: Z.modal }}>
        <div className="w-[440px] bg-ink-850 border border-ink-700 rounded-2xl p-8 text-center"
style={{ maxWidth: foldVh('90vw') }}>
          <div className="w-14 h-14 mx-auto rounded-full bg-amber/15 border border-amber/30 flex items-center justify-center mb-4">
            <Lock size={22} className="text-amber" />
          </div>
          <h2 className="text-17 font-bold text-ink-50 mb-1">小黑屋 · 强制码字</h2>
          <p className="text-12 text-ink-400 mb-6">设定目标后进入全屏锁定，不达成不轻易退出（防拖延）</p>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <NumberField value={goalWords} min={100} max={200000} step={500} onChange={v => setGoalWords(v ?? 1000)}
                title="目标字数：100 ~ 200000（超出范围会调回最近的边界）" className="!py-2 text-13 w-32" />
              <Button variant="primary" onClick={() => start('words')} className="flex-1 py-2.5 rounded-lg text-13 transition-colors">按字数锁定</Button>
            </div>
            <div className="flex items-center gap-2">
              <NumberField value={goalMinutes} min={5} max={1440} step={5} onChange={v => setGoalMinutes(v ?? 30)}
                title="目标时长（分钟）：5 ~ 1440（超出范围会调回最近的边界）" className="!py-2 text-13 w-32" />
              <Button variant="bare" onClick={() => start('minutes')} className="flex-1 py-2.5 bg-info/15 text-info border border-info/30 rounded-lg text-13 hover:bg-info/25 transition-colors">按时长锁定（分钟）</Button>
            </div>
            <Button variant="bare" onClick={() => tryExit()} className="w-full py-2 text-12 text-ink-500 hover:text-ink-300 transition-colors">不设目标，直接退出</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-ink-950 flex flex-col" style={{ zIndex: Z.modal }}>
      {/* 顶部进度条 */}
      <div className="h-1 bg-ink-800 shrink-0">
        <div className={`h-full transition-all duration-500 ${goalMet ? 'bg-emerald-400' : 'bg-amber'}`} style={{ width: `${progress}%` }} />
      </div>
      <div className="flex items-center gap-4 px-8 h-14 border-b border-ink-800 shrink-0">
        <span className="text-12 text-ink-300 font-semibold truncate">{chapter.title}</span>
        <span className="text-12 text-ink-500">小黑屋中</span>
        <span className="ml-auto text-13 font-bold text-amber">
          {mode === 'words' ? `+${written} / ${goalWords} 字` : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} / ${goalMinutes}:00`}
        </span>
        {goalMet ? (
          <span className="text-11 text-success">目标达成 ✓</span>
        ) : (
          <span className="text-11 text-ink-500">未达成前退出需确认</span>
        )}
        <Button variant="secondary" onClick={() => tryExit()} className="flex items-center gap-1 px-3 py-1.5 border-ink-700 rounded-lg text-12 hover:border-amber/40 hover:text-amber transition-colors">
          {goalMet ? '保存并退出' : <><Eye size={12} /> 退出</>}
        </Button>
      </div>
      {/* 编辑区 */}
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        className="flex-1 w-full max-w-4xl mx-auto px-8 py-10 bg-transparent outline-none resize-none text-16 leading-9 text-ink-100 font-serif"
        placeholder="专注写作，别碰手机…"
        autoFocus
        spellCheck={false}
      />
      {/* 退出确认遮罩（统一 Modal：修复原 z-[60] 与父层冲突、缺 max-w 小屏溢出） */}
      <BaseModal
        open={showPwd}
        onClose={() => setShowPwd(false)}
        width={360}
        hideHeader
        footer={
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => setShowPwd(false)} className="flex-1 py-2.5 rounded-lg text-13 transition-colors">继续写</Button>
            <Button variant="secondary" onClick={() => { setShowPwd(false); tryExit(true) }} className="flex-1 py-2.5 text-ink-400 border-ink-700 rounded-lg text-13 hover:text-ink-200 transition-colors flex items-center justify-center gap-1">
              <EyeOff size={12} /> 放弃目标
            </Button>
          </div>
        }
      >
        <div className="text-14 font-bold text-ink-50 mb-2">目标还没完成哦</div>
        <div className="text-12 text-ink-400">
          {mode === 'words' ? `还差 ${Math.max(0, goalWords - written)} 字` : `还剩 ${Math.max(0, goalMinutes * 60 - elapsed)} 秒`}
        </div>
      </BaseModal>
    </div>
  )
}
