/**
 * 节奏与章末钩子（B5 · 2.4.1）
 *
 * 与「投稿前自检」（ManuscriptCheckPanel）的分工：
 *   那个看**全书**的分布与结构（纯本地统计，不发 AI 请求）；
 *   本面板看**单章**的节奏与章末钩子（AI 审读 + 本地定位）。
 *
 * 🔴 位置由本地算：AI 只出「原文引用 + 类型」，段位由 lib/paceAnalysis 拿引文在正文里的
 *    下标换算 —— 位置是**算出来的**，不是模型说了算；引文定位失败会显式标「未定位」。
 * 🔴 立场：只给结构观察与建议，不评分、不排名、不判定"是否达标"。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Loader2, Sparkles, Eye } from 'lucide-react'
import * as db from '../lib/db'
import type { Chapter } from '../lib/types'
import { Button } from './Button'
import { showToast } from './dialogs'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { buildProjectContext } from '../lib/aiContext'
import { writerBudgetFor } from '../lib/aiWriterBudget'
import { isCancelled } from '../lib/ai'
import { aiPaceAnalysis } from '../lib/aiTasks'
import { HOOK_ZONE_RATIO, PACE_SEGMENTS, PACE_SEG_UNKNOWN, type PaceReport } from '../lib/paceAnalysis'
import { countWords } from '../lib/textStats'
import AIDataSourceNote from './AIDataSourceNote'
import HelpPopover from './HelpPopover'

export default function PaceAnalysisPanel() {
  // ⚠️ 它返回的是 { ready, label } 对象，不是布尔 —— 写成 `const aiReady = useAIReady()`
  //    会让 canRun 恒真、按钮永不禁用、禁用提示永不显示（写这版时踩过，实机抓出来的）。
  const { ready: aiReady } = useAIReady()
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [activeId, setActiveId] = useState('')
  const [loading, setLoading] = useState(true)
  const [res, setRes] = useState<{ loading: boolean; data?: PaceReport; error?: string }>({ loading: false })
  const ctrl = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    const chs = await db.getAllChapters().catch(() => [] as Chapter[])
    const sorted = [...chs].sort((a, b) => a.order - b.order)
    setChapters(sorted)
    setActiveId(prev => prev || (sorted.find(c => (c.wordCount || 0) > 0) ?? sorted[0])?.id || '')
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])
  // 卸载时中断在飞的请求（切页签别留着它跑）
  useEffect(() => () => ctrl.current?.abort(), [])

  // 换章就丢掉上一章的结果 —— 否则会拿着 A 章的报告看 B 章的正文
  useEffect(() => { setRes({ loading: false }) }, [activeId])

  const active = useMemo(() => chapters.find(c => c.id === activeId), [chapters, activeId])
  const content = active?.content ?? ''
  const words = useMemo(() => (content ? countWords(content) : 0), [content])

  const run = async () => {
    if (!aiReady) { showToast('还没接入模型，无法分析', 'info'); return }
    if (res.loading) return
    if (!content.trim()) { showToast('这一章还没有正文', 'info'); return }
    ctrl.current?.abort()
    const c = new AbortController()
    ctrl.current = c
    setRes({ loading: true })
    try {
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('pace-analysis'), focusChapterId: activeId })
      const r = await aiPaceAnalysis(ctx.text, content, { signal: c.signal })
      setRes({ loading: false, data: r })
    } catch (e) {
      if (isCancelled(e)) { setRes({ loading: false }); return }
      setRes({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  if (loading) {
    return <div className="rounded-xl border border-ink-700 bg-ink-850/40 px-4 py-6 text-center text-11 text-ink-500">
      <Loader2 size={14} className="inline animate-spin" /> 正在读取…
    </div>
  }

  const d = res.data
  const canRun = aiReady && !!content.trim() && !res.loading

  return (
    <section className="rounded-xl border border-ink-700 bg-ink-850/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-700">
        <Activity size={14} className="text-amber" />
        <span className="text-13 font-medium text-ink-100">节奏与章末钩子</span>
        <span className="text-10 text-ink-500">单章 · 段位由本地定位 · 只给观察不评分</span>
        <HelpPopover title="节奏与章末钩子">
          {'用途：看「单章」的节奏与章末钩子。\n\n'
            + '· 章末钩子区＝正文最后 12%。逐章连载里，这一小块是「读者决定要不要点下一章」的位置。\n'
            + '· 爆点按前 / 中 / 后三段统计：段位不是模型报的，而是拿它引用的原文在正文里查出来算的（查不到会标「未定位」）。\n'
            + '· 只给结构观察，不给分、不排名 —— 要不要改、怎么改，由你判断。'}
        </HelpPopover>
        <div className="ml-auto flex items-center gap-2">
          <AIDataSourceNote feature="pace-analysis" compact />
          <Button variant="secondary" size="sm" disabled={!canRun} onClick={() => void run()}>
            {res.loading ? <><Loader2 size={12} className="animate-spin" /> 分析中…</> : <><Sparkles size={12} /> 分析本章</>}
          </Button>
        </div>
      </div>

      {/* 章节选择 + 本地事实 */}
      <div className="px-4 py-3 border-b border-ink-700 flex flex-wrap items-center gap-x-4 gap-y-2 text-11">
        <select
          value={activeId}
          onChange={e => setActiveId(e.target.value)}
          className="rounded border border-ink-700 bg-ink-950 px-2 py-1 text-11 text-ink-200 outline-none focus:border-amber"
        >
          {chapters.map(c => (
            <option key={c.id} value={c.id}>{c.title || '（未命名）'}</option>
          ))}
        </select>
        <span className="text-ink-400">
          本章 <b className="text-ink-200 tabular-nums">{words}</b> 字
          {words > 0 && <> · 章末钩子区 <b className="text-ink-200 tabular-nums">{Math.max(1, Math.round(words * HOOK_ZONE_RATIO))}</b> 字</>}
        </span>
        {!aiReady && <span className="text-10 text-ink-500">{AI_DISABLED_HINT}</span>}
      </div>

      {/* 结果区 */}
      <div className="px-4 py-3">
        {words === 0 && <div className="text-11 text-ink-500">这一章还没有正文，换一章看看。</div>}

        {words > 0 && res.error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-11 text-red-300">
            分析失败：{res.error}
          </div>
        )}

        {words > 0 && !d && !res.error && !res.loading && (
          <div className="text-11 text-ink-500">
            <Eye size={11} className="inline -mt-0.5 mr-1" />
            点右上「分析本章」看看：爆点落在哪几段、章末有没有留钩子。
          </div>
        )}

        {d && (
          <div className="space-y-3">
            {/* ① 章末钩子 */}
            <div className={`rounded-lg border px-3 py-2.5 ${d.hookPresent ? 'border-amber/30 bg-amber/5' : 'border-ink-700 bg-ink-900/40'}`}>
              <div className="flex items-center gap-2">
                <span className="text-11 text-ink-300">章末钩子</span>
                <span className={`rounded px-1.5 py-0.5 text-10 border ${
                  d.hookPresent ? 'border-amber/40 text-amber bg-amber/10' : 'border-ink-600 text-ink-400 bg-ink-800'
                }`}>
                  {d.hookPresent ? d.hookKind : '未识别到钩子'}
                </span>
                <span className="text-10 text-ink-500">章末 {d.hookZone.chars} 字为钩子区（末 {Math.round(HOOK_ZONE_RATIO * 100)}%）</span>
              </div>
              {d.hookEvidence && (
                <p className="mt-1.5 text-11 text-ink-300">依据：「{d.hookEvidence}」</p>
              )}
              {d.hookNote && <p className="mt-1 text-10 leading-relaxed text-ink-400">{d.hookNote}</p>}
            </div>

            {/* ② 三段分布 */}
            <div>
              <div className="grid grid-cols-3 gap-2">
                {PACE_SEGMENTS.map(seg => (
                  <div key={seg} className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2 text-center">
                    <div className="text-10 text-ink-400">{seg}</div>
                    <div className="text-13 font-bold tabular-nums text-ink-100">{d.distribution[seg]}</div>
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-10 leading-relaxed text-ink-400">
                <b className="text-ink-300">{d.distribution.shape}</b> —— {d.distribution.note}
              </p>
            </div>

            {/* ③ 爆点清单 */}
            {d.beats.length > 0 && (
              <div>
                <div className="mb-1.5 text-11 text-ink-400">爆点（{d.beats.length} 处）</div>
                <div className="space-y-1.5">
                  {d.beats.map((b, i) => (
                    <div key={i} className="flex items-start gap-2 text-11">
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-10 border ${
                        b.segment === PACE_SEG_UNKNOWN
                          ? 'border-ink-600 text-ink-500 bg-ink-800'
                          : 'border-ink-600 text-ink-300 bg-ink-900'
                      }`}>{b.segment}</span>
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-10 border border-ink-600 text-ink-300 bg-ink-900">{b.kind}</span>
                      <span className="min-w-0 flex-1 text-ink-300">
                        「{b.quote}」
                        {b.note && <span className="text-ink-500"> — {b.note}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ④ 信息增量 */}
            {d.increments.length > 0 && (
              <div>
                <div className="mb-1 text-11 text-ink-400">本章信息增量</div>
                <ul className="space-y-0.5 text-11 text-ink-300">
                  {d.increments.map((s, i) => <li key={i}>· {s}</li>)}
                </ul>
              </div>
            )}

            {/* ⑤ 节奏观察 */}
            {d.observations.length > 0 && (
              <div>
                <div className="mb-1 text-11 text-ink-400">节奏观察</div>
                <ul className="space-y-0.5 text-11 text-ink-300">
                  {d.observations.map((s, i) => <li key={i}>· {s}</li>)}
                </ul>
              </div>
            )}

            {d.summary && <p className="text-11 italic text-ink-300">{d.summary}</p>}

            <p className="text-10 leading-relaxed text-ink-500">
              以上是结构观察，不是评分 —— 节奏是为故事服务的，怎么调由你定。
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
