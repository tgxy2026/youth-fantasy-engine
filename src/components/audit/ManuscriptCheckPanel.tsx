/**
 * 投稿前自检 · 行文指纹与节奏（2.4.1 · B2）
 *
 * 独立组件而不是塞进 `CheckTools` —— 那边已经 516 行、5 个区块，是既定的"巨型组件收尾"对象，
 * 不该再往上堆。这里只挂一行在该页，逻辑与样式都在本文件内。
 *
 * 🔴 **立场（与 B3 / manuscriptCheck.ts 同一条红线）**：这是**质量自检** ——
 *    把分布事实摆出来供作者判断，**不判定**"像不像机器写的"，也**不给**"怎么改才不被认出来"的建议。
 *    所以界面上全是「参考区间」「值得看一眼」，没有分数、没有排名、没有"避免命中"的说法。
 *
 * 【数据来源】行文指纹 / 重复观察 / 节奏全部本地（`auditContinuity()` / `auditForeshadow()` 既有引擎 +
 * `manuscriptCheck` 纯统计 + `audit/repetition` 纯本地）。**唯一会发 AI 的是「本章变化清单」**：
 * 由作者主动点按钮，明确告知送审字数与 1 次调用，不自动重试、不自动换模型。
 * 其余按钮与文案都如实写明"本地、不发 AI"。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EMPTY_CHAPTER_HINT } from '@/lib/constants'
import { ClipboardCheck, Loader2, RefreshCw, FileUp, Sparkles, X } from 'lucide-react'
import * as db from '@/lib/db'
import type { Chapter } from '@/lib/types'
import { Button } from '@/components/common/Button'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { downloadText } from '@/lib/storage/zip'
// 2.9.1：走 checkLog 的包装（与检查工具 / 编辑器弹窗共用缓存与台账）
import { continuityLogged, foreshadowLogged, manuscriptLogged, repetitionLogged, trendOf, type CheckTrend } from '@/lib/audit/checkLog'
import CheckTrendNote from '@/components/audit/CheckTrendNote'
import {
  analyzeStyle, toObservations, analyzePacing, buildCheckReportText,
  type StyleFingerprint, type PacingReport,
} from '@/lib/audit/manuscriptCheck'
// 3.3.3 · A1：重复与表达观察（本地；候选与事实分开）
import {
  analyzeRepetition, scopeFingerprint, type RepetitionGroup, type RepetitionReport,
} from '@/lib/audit/repetition'
import {
  activeIgnoreKeys, ignoreRepetitionGroup, loadIgnoreRecords, loadRepetitionCache,
  saveRepetitionCache, unignoreRepetitionGroup, type IgnoreRecord,
} from '@/lib/audit/repetitionStore'
// 3.3.3 · A2：本章变化清单（作者主动触发；引文逐字核验）
import {
  CHANGE_CONCLUSION_TEXT, CHANGE_MATERIAL_LIMIT, CHANGE_PROTOCOL_VERSION, buildChangeMaterial,
  concludeChanges, dissentKeyOf, fingerprintText, verifyChangeItems, type ChangeItem, type ChangeListReport,
} from '@/lib/audit/changeList'
import {
  addDissent, isReportCurrent, loadChangeList, loadDissent, removeDissent, saveChangeList,
  type DissentRecord,
} from '@/lib/audit/changeListStore'
import { aiChapterChangeList } from '@/lib/ai/aiTasks'
import { useAIReady } from '@/lib/ai/useAIReady'
import { AI_DISABLED_HINT } from '@/lib/ai/aiScope'

/** 重复组类型的中文标签（报告、忽略记录、界面共用同一口径） */
const REP_KIND_LABEL = { sentence: '句重复', paragraph: '段重复', gram: '词组重复' } as const

export default function ManuscriptCheckPanel() {
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [daily, setDaily] = useState<{ date: string; words: number }[]>([])
  const [activeId, setActiveId] = useState('')
  const [bookName, setBookName] = useState('')
  const [loading, setLoading] = useState(true)

  // 引擎结果（跑一次后缓存；与"行文指纹"分开，因为前者较慢）
  const [engine, setEngine] = useState<{ continuity: number; foreshadowOpen: number } | null>(null)
  const [engineLoading, setEngineLoading] = useState(false)
  /** 2.9.2：投稿前自检台账的「上次检查」（**按章** —— 行文指纹是按章算的） */
  const [trend, setTrend] = useState<CheckTrend | null>(null)

  const load = useCallback(async () => {
    const [chs, stats, proj] = await Promise.all([
      db.getAllChapters().catch(() => [] as Chapter[]),
      db.getDailyStats().catch(() => [] as { date: string; words: number }[]),
      db.getAllProjects().catch(() => []),
    ])
    const sorted = [...chs].sort((a, b) => a.order - b.order)
    setChapters(sorted)
    setDaily(stats)
    const pid = db.getCurrentProjectId?.()
    setBookName((proj.find((p: { id: string }) => p.id === pid) as { name?: string } | undefined)?.name ?? '')
    setActiveId(prev => prev || (sorted.find(c => (c.wordCount || 0) > 0) ?? sorted[0])?.id || '')
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  /**
   * 切章后重取本章趋势。
   * 🔴 少了它，跑完 A 章再切到 B 章，面板显示 B 章的内容、却挂着 **A 章**的「上次检查」
   *    —— 与 `PaceAnalysisPanel` 的同概念实现不一致（那边一直有 activeId 依赖的 effect）。
   *    2026-10-09 审计抓出。跑完引擎时仍会立即刷新一次（见 runEngine）。
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!activeId) { if (!cancelled) setTrend(null); return }
      const t = await trendOf('manuscript', activeId).catch(() => null)
      if (!cancelled) setTrend(t)
    })()
    return () => { cancelled = true }
  }, [activeId])

  const active = useMemo(() => chapters.find(c => c.id === activeId), [chapters, activeId])
  // 行文指纹是纯统计、算得很快 → 直接随选中章即时算，不需要"跑"按钮
  const fp: StyleFingerprint | null = useMemo(
    () => (active ? analyzeStyle(active.content ?? '') : null),
    [active],
  )
  const pacing: PacingReport = useMemo(() => analyzePacing(chapters, daily), [chapters, daily])
  const observations = useMemo(() => (fp ? toObservations(fp) : []), [fp])

  // ── 3.3.3 · A1：重复与表达观察 ─────────────────────────────────────────────
  const [repRange, setRepRange] = useState(10)
  const [rep, setRep] = useState<RepetitionReport | null>(null)
  const [ignored, setIgnored] = useState<IgnoreRecord[]>([])
  const [repLoading, setRepLoading] = useState(false)
  const [showAllGroups, setShowAllGroups] = useState(false)

  /** 换章先清空：上一章的报告带着**旧章节的字符区间**，留着会指错位置 */
  useEffect(() => {
    setRep(null)
    setShowAllGroups(false)
    const pid = db.getCurrentProjectId?.()
    if (pid) void loadIgnoreRecords(pid).then(setIgnored).catch(() => {})
  }, [activeId])

  /**
   * 缓存只在"正文指纹 + 范围 + 当前章"都对得上时才展示。
   * 🔴 改过正文却继续显示旧报告，作者会按旧区间去找已经挪位的那句 —— 必须清掉并提示重扫。
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const pid = db.getCurrentProjectId?.()
      if (!pid || !activeId || chapters.length === 0) { if (!cancelled) setRep(null); return }
      const cache = await loadRepetitionCache(pid).catch(() => null)
      if (cancelled) return
      if (cache && cache.inputFingerprint === scopeFingerprint(chapters, activeId, repRange)) setRep(cache)
      else setRep(null)
    })()
    return () => { cancelled = true }
  }, [activeId, repRange, chapters])

  const runRepetition = async () => {
    const pid = db.getCurrentProjectId?.()
    if (!pid || !activeId) { showToast('先选一章有正文的章节', 'info'); return }
    setRepLoading(true)
    try {
      const records = await loadIgnoreRecords(pid).catch(() => [] as IgnoreRecord[])
      setIgnored(records)
      const report = analyzeRepetition({
        chapters, currentChapterId: activeId, range: repRange, ignoredIds: activeIgnoreKeys(records),
      })
      setRep(report)
      await saveRepetitionCache(pid, report)
      // 摘要进体检台账（只记类型/次数/前 40 字，不复制正文）
      await repetitionLogged(activeId, report)
    } catch {
      showToast('重复扫描失败', 'error')
    } finally {
      setRepLoading(false)
    }
  }

  const ignoreGroup = async (g: RepetitionGroup) => {
    const pid = db.getCurrentProjectId?.()
    if (!pid) return
    try {
      setIgnored(await ignoreRepetitionGroup(pid, g))
      setRep(prev => prev ? {
        ...prev,
        groups: prev.groups.filter(x => x.id !== g.id),
        exactGroups: Math.max(0, prev.exactGroups - (g.candidateOnly ? 0 : 1)),
        candidateGroups: Math.max(0, prev.candidateGroups - (g.candidateOnly ? 1 : 0)),
        ignoredGroups: prev.ignoredGroups + 1,
      } : prev)
      showToast('已忽略这组；可在本区块底部撤销', 'success')
    } catch {
      showToast('忽略失败', 'error')
    }
  }

  const undoIgnore = async (key: string) => {
    const pid = db.getCurrentProjectId?.()
    if (!pid) return
    try {
      setIgnored(await unignoreRepetitionGroup(pid, key))
      showToast('已撤销忽略；重新扫描后会出现', 'info')
    } catch {
      showToast('撤销失败', 'error')
    }
  }

  // ── 3.3.3 · A2：本章变化清单（作者主动触发；一次请求；引文逐字核验） ──────────
  const { ready: aiReady } = useAIReady()
  const [chg, setChg] = useState<ChangeListReport | null>(null)
  const [chgLoading, setChgLoading] = useState(false)
  const [dissent, setDissent] = useState<DissentRecord[]>([])
  const chgAbort = useRef<AbortController | null>(null)
  /** 迟到回包时判断"当前还是不是发起时那一章"（闭包里的 activeId 可能已过期） */
  const getActiveIdNow = () => activeId

  /** 换章读本机缓存（只有正文指纹对得上才展示）；「我不认同」是项目级，一起读 */
  useEffect(() => {
    let cancelled = false
    setChg(null)
    void (async () => {
      const pid = db.getCurrentProjectId?.()
      if (!pid || !activeId || !active) return
      const [cache, dis] = await Promise.all([
        loadChangeList(pid, activeId).catch(() => null),
        loadDissent(pid).catch(() => [] as DissentRecord[]),
      ])
      if (cancelled) return
      setDissent(dis)
      if (cache && isReportCurrent(cache, activeId, active.content ?? '')) setChg(cache)
    })()
    return () => { cancelled = true }
  }, [activeId, active])

  /** 切章/卸载时取消在途请求：迟到结果绝不写进新章 */
  useEffect(() => () => { chgAbort.current?.abort() }, [])

  const runChangeList = async () => {
    if (!active) return
    const pid = db.getCurrentProjectId?.()
    if (!pid) return
    const mat = buildChangeMaterial(active.content ?? '')
    if (mat.chars === 0) { showToast(EMPTY_CHAPTER_HINT, 'info'); return }
    const ok = await confirmDialog({
      title: '生成本章变化清单',
      message: `会把本章${mat.truncated
        ? `前 ${mat.chars.toLocaleString()} 字（本章共 ${mat.totalChars.toLocaleString()} 字，超出 ${CHANGE_MATERIAL_LIMIT.toLocaleString()} 字的部分不会发送）`
        : `全文 ${mat.chars.toLocaleString()} 字`}交给当前模型，只调用 1 次。\n\n`
        + '不会自动重试、不会自动换模型。结果只作线索：每条必须能在正文里逐字找到，否则会被丢弃。',
      confirmText: '生成（1 次调用）',
    })
    if (!ok) return
    const ctrl = new AbortController()
    chgAbort.current = ctrl
    setChgLoading(true)
    try {
      const ai = await aiChapterChangeList({
        material: mat.material,
        chapterTitle: active.title || '',
        signal: ctrl.signal,
      })
      const items = verifyChangeItems(ai.text, active.content ?? '')
      const report: ChangeListReport = {
        chapterId: active.id,
        chapterTitle: active.title || '（未命名章）',
        conclusion: concludeChanges(items, mat.chars > 0),
        items,
        material: mat,
        requestCount: 1,
        ...(ai.modelTag ? { modelTag: ai.modelTag } : {}),
        protocolVersion: CHANGE_PROTOCOL_VERSION,
        inputFingerprint: fingerprintText(active.content ?? ''),
        at: Date.now(),
      }
      // 🔴 迟到回包保护：切了章或正文变了就不写
      if (!isReportCurrent(report, getActiveIdNow(), active.content ?? '')) return
      setChg(report)
      await saveChangeList(pid, report)
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') showToast('已取消这次生成', 'info')
      else showToast(e instanceof Error ? e.message : '生成失败', 'error')
    } finally {
      setChgLoading(false)
      chgAbort.current = null
    }
  }

  const markDissent = async (item: ChangeItem) => {
    const pid = db.getCurrentProjectId?.()
    if (!pid || !active) return
    try {
      setDissent(await addDissent(pid, active.id, item))
      showToast('已记录「我不认同」（只在本机，可撤销）', 'success')
    } catch {
      showToast('记录失败', 'error')
    }
  }

  const clearDissent = async (key: string) => {
    const pid = db.getCurrentProjectId?.()
    if (!pid) return
    try {
      setDissent(await removeDissent(pid, key))
      showToast('已撤销这条「我不认同」', 'info')
    } catch {
      showToast('撤销失败', 'error')
    }
  }

  /** 当前章被「我不认同」否掉的条目（只影响展示，不改正文、不改报告） */
  const chgDissent = chg ? dissent.filter(d => d.chapterId === chg.chapterId) : []
  const chgItems = chg
    ? chg.items.filter(it => !chgDissent.some(d => d.key === dissentKeyOf(chg.chapterId, it)))
    : []
  /** 材料预览（界面显示"会送多少字"；与真正发送用的是同一个函数） */
  const chgMaterial = useMemo(() => buildChangeMaterial(active?.content ?? ''), [active])

  const runEngine = async () => {
    setEngineLoading(true)
    try {
      const [c, f] = await Promise.all([continuityLogged(), foreshadowLogged()])
      setEngine({
        continuity: c.length,
        foreshadowOpen: f.board.filter(b => b.status !== '已回收').length,
      })
      // 2.9.2：把「行文分布」的观察项也记一条台账（按章）。
      // 🔴 只在作者**显式点按钮**时记 —— 行文指纹本身是随渲染即时算的，
      //    若跟着渲染走会变成每次切章都写一次盘。记不上也不影响自检（logSnapshot 内部已吞掉失败）。
      if (activeId) {
        await manuscriptLogged(activeId, observations)
        setTrend(await trendOf('manuscript', activeId))
      }
    } catch {
      showToast('结构与伏笔自检失败', 'error')
    } finally {
      setEngineLoading(false)
    }
  }

  const exportReport = () => {
    if (!fp) return
    const txt = buildCheckReportText(bookName, fp, pacing, {
      continuity: engine?.continuity ?? 0,
      foreshadowOpen: engine?.foreshadowOpen ?? 0,
      chapterTitle: active?.title,
    })
    try {
      downloadText(`投稿前自检-${(bookName || '本书').trim()}.txt`, txt)
    } catch {
      showToast('导出失败', 'error')
    }
  }

  if (loading) {
    return <div className="rounded-xl border border-ink-700 bg-ink-850/40 px-4 py-6 text-center text-11 text-ink-500">
      <Loader2 size={14} className="inline animate-spin" /> 正在读取…
    </div>
  }

  return (
    <section className="rounded-xl border border-ink-700 bg-ink-850/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-700">
        <ClipboardCheck size={14} className="text-amber" />
        <span className="text-13 font-medium text-ink-100">投稿前自检</span>
        <span className="text-10 text-ink-500">行文分布 · 重复观察 · 节奏（本地）· 变化清单（你点击时才调用 1 次模型）</span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={engineLoading} onClick={() => void runEngine()}>
            {engineLoading ? <><Loader2 size={12} className="animate-spin" /> 自检中…</> : <><RefreshCw size={12} /> 跑结构与伏笔</>}
          </Button>
          <Button variant="secondary" size="sm" disabled={!fp} onClick={exportReport}>
            <FileUp size={12} /> 导出报告
          </Button>
        </div>
      </div>

      {/* 结构与伏笔（复用既有引擎） */}
      <div className="px-4 py-3 border-b border-ink-700 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-11">
        <span className="text-ink-400">设定与结构</span>
        {engine === null ? (
          <span className="text-ink-500">还没跑 —— 点右上「跑结构与伏笔」（复用连续性与伏笔引擎，同样不走 AI）</span>
        ) : (
          <>
            <span className="text-ink-200">前后矛盾 / 设定冲突 <b className="text-ink-100">{engine.continuity}</b> 处</span>
            <span className="text-ink-200">尚未回收的伏笔 <b className="text-ink-100">{engine.foreshadowOpen}</b> 条</span>
          </>
        )}
      </div>

      {/* 行文指纹（按章） */}
      <div className="px-4 py-3 border-b border-ink-700">
        <div className="flex items-center gap-2 mb-2.5">
          <span className="text-11 text-ink-400">行文分布（按章）</span>
          <select
            value={activeId}
            onChange={e => setActiveId(e.target.value)}
            className="rounded border border-ink-700 bg-ink-950 px-2 py-1 text-11 text-ink-200 outline-none focus:border-amber"
          >
            {chapters.map(c => (
              <option key={c.id} value={c.id}>{c.title || '（未命名）'}</option>
            ))}
          </select>
          {fp && (
            <span className="text-10 text-ink-500">
              {fp.words} 字 · {fp.sentences} 句 · {fp.paragraphs} 段
            </span>
          )}
          {trend && <span className="ml-auto"><CheckTrendNote trend={trend} /></span>}
        </div>

        {!fp || fp.words === 0 ? (
          <div className="text-11 text-ink-500">{EMPTY_CHAPTER_HINT}</div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {observations.map(o => (
              <div key={o.key}
                className={`rounded-lg border px-3 py-2 ${
                  o.notable ? 'border-amber/30 bg-amber/5' : 'border-ink-700 bg-ink-900/40'
                }`}>
                <div className="flex items-baseline gap-2">
                  <span className="text-11 text-ink-300">{o.label}</span>
                  <span className={`text-13 font-bold tabular-nums ${o.notable ? 'text-amber' : 'text-ink-100'}`}>{o.value}</span>
                  <span className="text-10 text-ink-500">{o.hint}</span>
                </div>
                <p className="mt-1 text-10 leading-relaxed text-ink-400">{o.note}</p>
              </div>
            ))}
          </div>
        )}

        {/* 重复用词清单：只列出来，不逐条标红 */}
        {fp && fp.repeatedGrams.length > 0 && (
          <div className="mt-2.5">
            <div className="text-10 text-ink-500 mb-1">本章出现 3 次以上的三字词组（多为人物名 / 专名，属正常，仅列出供你扫一眼）</div>
            <div className="flex flex-wrap gap-1">
              {fp.repeatedGrams.slice(0, 12).map(g => (
                <span key={g.gram} className="rounded border border-ink-700 bg-ink-900/50 px-1.5 py-0.5 text-10 text-ink-400">
                  {g.gram} ×{g.count}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 重复与表达观察（3.3.3 · A1，本地） */}
      <div className="px-4 py-3 border-b border-ink-700">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="text-11 text-ink-400">重复与表达观察</span>
          <label className="text-10 text-ink-500">
            范围
            <select
              value={repRange}
              onChange={e => setRepRange(Number(e.target.value))}
              className="ml-1 rounded border border-ink-700 bg-ink-950 px-1.5 py-0.5 text-10 text-ink-200 outline-none focus:border-amber"
            >
              {[1, 3, 5, 10, 20, 30].map(n => <option key={n} value={n}>前 {n} 章 + 本章</option>)}
            </select>
          </label>
          <Button variant="secondary" size="sm" disabled={repLoading || !activeId} onClick={() => void runRepetition()}>
            {repLoading ? <><Loader2 size={12} className="animate-spin" /> 扫描中…</> : <><RefreshCw size={12} /> 扫描重复（本地）</>}
          </Button>
          {rep && (
            <span className="text-10 text-ink-500">
              覆盖 {rep.coveredChapters} 章{rep.skippedEmpty > 0 ? `（跳过空章 ${rep.skippedEmpty}）` : ''}
              {' · '}确定重复 {rep.exactGroups} 组 · 近似候选 {rep.candidateGroups} 组
            </span>
          )}
        </div>

        {!rep ? (
          <p className="text-10 leading-relaxed text-ink-500">
            尚未扫描。只比对<b>当前章与前面最多 {repRange} 章</b>（不含后续章；空章跳过），
            报「句 / 段 / 词组」的完全重复与近似候选，均可定位到章内字符区间。不判断是否“注水”。
          </p>
        ) : rep.groups.length === 0 ? (
          <p className="text-10 text-ink-500">范围内没有发现重复（共比对 {rep.coveredChapters} 章）。</p>
        ) : (
          <div className="space-y-1.5">
            {(showAllGroups ? rep.groups : rep.groups.slice(0, 5)).map(g => (
              <div key={g.id} className="rounded border border-ink-700 bg-ink-900/40 px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-10 text-ink-300">{REP_KIND_LABEL[g.kind]} ×{g.count} · 共 {g.chapters} 章</span>
                  {g.candidateOnly && (
                    <span className="rounded border border-ink-600 px-1 py-0.5 text-10 text-ink-500">
                      近似候选 {Math.round((g.similarity ?? 0) * 100)}%（不是确定重复）
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void ignoreGroup(g)}
                    className="ml-auto rounded border border-ink-700 px-1.5 py-0.5 text-10 text-ink-400 hover:text-ink-200"
                  >
                    忽略这组
                  </button>
                </div>
                <p className="mt-1 text-11 leading-relaxed text-ink-200">
                  「{g.text.length > 90 ? `${g.text.slice(0, 90)}…` : g.text}」
                </p>
                <ul className="mt-1 space-y-0.5 text-10 text-ink-500">
                  {g.occurrences.slice(0, 4).map(o => (
                    <li key={`${o.chapterId}-${o.start}`}>
                      {o.chapterTitle} · 第 {o.start + 1}–{o.end} 字
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {rep.groups.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAllGroups(v => !v)}
                className="text-10 text-ink-400 hover:text-ink-200"
              >
                {showAllGroups ? '只看前 5 组' : `展开其余 ${rep.groups.length - 5} 组`}
              </button>
            )}
          </div>
        )}

        {ignored.length > 0 && (
          <details className="mt-2 text-10 text-ink-500">
            <summary className="cursor-pointer">已忽略 {ignored.length} 组（可按组撤销）</summary>
            <ul className="mt-1 space-y-1">
              {ignored.map(r => (
                <li key={r.key} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">「{r.text}」</span>
                  <button
                    type="button"
                    onClick={() => void undoIgnore(r.key)}
                    className="shrink-0 rounded border border-ink-700 px-1.5 py-0.5 text-10 text-ink-400 hover:text-ink-200"
                  >
                    撤销
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}

        <p className="mt-2 text-10 leading-relaxed text-ink-500">
          以上全部本地计算，<b>不发送正文</b>。完全重复与近似候选分开计；专名、口头禅、引用与刻意复沓可用「忽略这组」，
          忽略只在本机、可撤销；正文改动后旧报告与旧忽略会失效，需重新扫描。
        </p>
      </div>

      {/* 本章变化清单（3.3.3 · A2；作者主动触发，最多 1 次调用） */}
      <div className="px-4 py-3 border-b border-ink-700">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="text-11 text-ink-400">本章变化清单</span>
          <span className="text-10 text-ink-500">目标 / 关系 / 信息 / 资源地位 / 处境情绪认知；铺垫与内心变化也算</span>
          <div className="ml-auto flex items-center gap-2">
            {chgLoading && (
              <Button variant="secondary" size="sm" onClick={() => chgAbort.current?.abort()}>
                <X size={12} /> 取消
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={chgLoading || !activeId || !aiReady}
              title={!aiReady ? AI_DISABLED_HINT : undefined}
              onClick={() => void runChangeList()}
            >
              {chgLoading
                ? <><Loader2 size={12} className="animate-spin" /> 生成中…</>
                : <><Sparkles size={12} /> 生成本章变化清单（1 次调用）</>}
            </Button>
          </div>
        </div>

        {!chg ? (
          <p className="text-10 leading-relaxed text-ink-500">
            尚未检测。<b>不会自动调用模型</b>；点上方按钮才会把本章
            {chgMaterial.truncated
              ? `前 ${chgMaterial.chars.toLocaleString()} 字（本章共 ${chgMaterial.totalChars.toLocaleString()} 字，超出 ${CHANGE_MATERIAL_LIMIT.toLocaleString()} 字的部分不会发送）`
              : ` ${chgMaterial.chars.toLocaleString()} 字`}
            交给当前模型，并且只调用 1 次。
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-10 text-ink-500">
              <span className={`rounded border px-1.5 py-0.5 ${
                chg.conclusion === 'found' ? 'border-emerald-500/40 text-emerald-300' : 'border-amber/30 text-amber'
              }`}>
                {CHANGE_CONCLUSION_TEXT[chg.conclusion]}
              </span>
              <span>
                送审 {chg.material.chars.toLocaleString()} 字
                {chg.material.truncated ? `（本章共 ${chg.material.totalChars.toLocaleString()} 字，超出部分未发送）` : ''}
              </span>
              <span>请求 {chg.requestCount} 次{chg.modelTag ? ` · ${chg.modelTag}` : ''}</span>
            </div>

            {chgItems.length > 0 ? (
              <ul className="mt-2 space-y-1.5">
                {chgItems.map(it => (
                  <li key={it.id} className="rounded border border-ink-700 bg-ink-900/40 px-2.5 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded border border-ink-600 px-1 py-0.5 text-10 text-ink-300">{it.type}</span>
                      <span className="text-11 text-ink-200">
                        {it.before ? <>{it.before} → </> : null}{it.after}
                      </span>
                      <button
                        type="button"
                        onClick={() => void markDissent(it)}
                        className="ml-auto rounded border border-ink-700 px-1.5 py-0.5 text-10 text-ink-400 hover:text-ink-200"
                      >
                        我不认同
                      </button>
                    </div>
                    <p className="mt-1 text-10 text-ink-500">「{it.quote}」 · 第 {it.start + 1}–{it.end} 字</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-10 leading-relaxed text-ink-500">
                {chgDissent.length > 0
                  ? '这些线索都被你标了「我不认同」（只在本机记录，可撤销）。'
                  : '没有可核对的变化线索 —— 这不等于「这一章没有推进」，只表示本次材料里没有找到逐字可证的线索。'}
              </p>
            )}

            {chgDissent.length > 0 && (
              <details className="mt-2 text-10 text-ink-500">
                <summary className="cursor-pointer">我不认同 {chgDissent.length} 条（可撤销）</summary>
                <ul className="mt-1 space-y-1">
                  {chgDissent.map(d => (
                    <li key={d.key} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">「{d.quote}」</span>
                      <button
                        type="button"
                        onClick={() => void clearDissent(d.key)}
                        className="shrink-0 rounded border border-ink-700 px-1.5 py-0.5 text-10 text-ink-400 hover:text-ink-200"
                      >
                        撤销
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}

        <p className="mt-2 text-10 leading-relaxed text-ink-500">
          结论只有「发现线索 / 线索较少 / 证据不足 / 未检测」；不判断是否“空转”，也不因地点变化自动算推进。
          每条都必须能在正文里逐字找到，找不到的已被剔除；「我不认同」只在本机记录，不改正文。
        </p>
      </div>

      {/* 节奏（全书） */}
      <div className="px-4 py-3">
        <div className="text-11 text-ink-400 mb-2">节奏（全书）</div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-11 text-ink-300 mb-2.5">
          <span>已有正文 {pacing.written} / {pacing.chapters} 章</span>
          <span>平均 {pacing.avgWords.toLocaleString('zh-CN')} 字/章</span>
          <span>动笔 {pacing.activeDays} 天 · 跨度 {pacing.spanDays} 天</span>
          {pacing.avgPerActiveDay > 0 && <span>{pacing.avgPerActiveDay.toLocaleString('zh-CN')} 字/动笔日</span>}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {pacing.observations.map(o => (
            <div key={o.key}
              className={`rounded-lg border px-3 py-2 ${
                o.notable ? 'border-amber/30 bg-amber/5' : 'border-ink-700 bg-ink-900/40'
              }`}>
              <div className="flex items-baseline gap-2">
                <span className="text-11 text-ink-300">{o.label}</span>
                <span className={`text-13 font-bold tabular-nums ${o.notable ? 'text-amber' : 'text-ink-100'}`}>{o.value}</span>
                <span className="text-10 text-ink-500">{o.hint}</span>
              </div>
              <p className="mt-1 text-10 leading-relaxed text-ink-400">{o.note}</p>
            </div>
          ))}
        </div>
        <p className="mt-2.5 text-10 leading-relaxed text-ink-500">
          以上全部为本地统计与既有规则引擎的结果，<b>不会向任何模型发送你的正文</b>。
          参考区间是经验值、不是评分标准 —— 它只帮你看见平时注意不到的分布。
        </p>
      </div>
    </section>
  )
}
