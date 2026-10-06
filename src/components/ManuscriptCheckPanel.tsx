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
 * 【数据来源】全部本地：`auditContinuity()` / `auditForeshadow()`（既有引擎，规则判定）+ `manuscriptCheck`（纯统计）。
 * 本面板**不发任何 AI 请求**（按钮文案里也如实写明）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { EMPTY_CHAPTER_HINT } from '../lib/constants'
import { ClipboardCheck, Loader2, RefreshCw, FileDown } from 'lucide-react'
import * as db from '../lib/db'
import type { Chapter } from '../lib/types'
import { Button } from './Button'
import { showToast } from './dialogs'
import { downloadText } from '../lib/zip'
import { auditContinuity } from '../lib/continuityCheck'
import { auditForeshadow } from '../lib/foreshadowEngine'
import {
  analyzeStyle, toObservations, analyzePacing, buildCheckReportText,
  type StyleFingerprint, type PacingReport,
} from '../lib/manuscriptCheck'

export default function ManuscriptCheckPanel() {
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [daily, setDaily] = useState<{ date: string; words: number }[]>([])
  const [activeId, setActiveId] = useState('')
  const [bookName, setBookName] = useState('')
  const [loading, setLoading] = useState(true)

  // 引擎结果（跑一次后缓存；与"行文指纹"分开，因为前者较慢）
  const [engine, setEngine] = useState<{ continuity: number; foreshadowOpen: number } | null>(null)
  const [engineLoading, setEngineLoading] = useState(false)

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

  const active = useMemo(() => chapters.find(c => c.id === activeId), [chapters, activeId])
  // 行文指纹是纯统计、算得很快 → 直接随选中章即时算，不需要"跑"按钮
  const fp: StyleFingerprint | null = useMemo(
    () => (active ? analyzeStyle(active.content ?? '') : null),
    [active],
  )
  const pacing: PacingReport = useMemo(() => analyzePacing(chapters, daily), [chapters, daily])
  const observations = useMemo(() => (fp ? toObservations(fp) : []), [fp])

  const runEngine = async () => {
    setEngineLoading(true)
    try {
      const [c, f] = await Promise.all([auditContinuity(), auditForeshadow()])
      setEngine({
        continuity: c.length,
        foreshadowOpen: f.board.filter(b => b.status !== '已回收').length,
      })
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
        <span className="text-10 text-ink-500">行文分布 · 节奏 · 结构（全部本地统计，不发 AI 请求）</span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={engineLoading} onClick={() => void runEngine()}>
            {engineLoading ? <><Loader2 size={12} className="animate-spin" /> 自检中…</> : <><RefreshCw size={12} /> 跑结构与伏笔</>}
          </Button>
          <Button variant="secondary" size="sm" disabled={!fp} onClick={exportReport}>
            <FileDown size={12} /> 导出报告
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
