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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { EMPTY_CHAPTER_HINT } from '@/lib/constants'
import { Activity, Loader2, Sparkles, Eye } from 'lucide-react'
import * as db from '@/lib/db'
import type { Chapter, Volume } from '@/lib/types'
import { Button } from '@/components/common/Button'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { useAIReady } from '@/lib/ai/useAIReady'
import { useAcpWriting } from '@/lib/agentHost/useAcpWriting'
import { acpGateMessage, acpGatedText } from '@/lib/agentHost/acpGate'
import { AI_DISABLED_HINT } from '@/lib/ai/aiScope'
import { buildProjectContext } from '@/lib/ai/aiContext'
import { writerBudgetFor } from '@/lib/ai/aiWriterBudget'
import { aiPaceAnalysis } from '@/lib/ai/aiTasks'
import { requireProviderFor } from '@/lib/ai'
import { paceLogged, trendOf, type CheckTrend } from '@/lib/audit/checkLog'
import CheckTrendNote from '@/components/audit/CheckTrendNote'
import { HOOK_ZONE_RATIO, PACE_SEGMENTS, PACE_SEG_UNKNOWN, type PaceReport } from '@/lib/outline/paceAnalysis'
import { countWords } from '@/lib/editor/textStats'
// 🔴 章节顺序真源（卷序 → 章序）：Chapter.order 是卷内序号，裸 sort 跨卷必串号
import { sortChapters, chapterSeqMap } from '@/lib/outline/chapterSeq'
import { computePaceSeries, samplePoints, type PacePoint } from '@/lib/outline/paceMetrics'
import type { TableRow } from '@/lib/types'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import HelpPopover from '@/components/common/HelpPopover'
import { markTaskSeen, startTask, useAiTask } from '@/lib/ai/aiTaskCenter'

/** 本面板在任务中心里的身份（`ownerTab` 需与 TABS 里的页签 id 一致 —— 指示器靠它跳回来） */
const OWNER_TAB = 'check-tools'
const TASK_KIND = 'pace'

/**
 * 任务产物 / 进度。
 *
 * 🔴 **两者都带章节 id**：任务跑在 store 里、可跨页签存活，界面必须能判断
 *    「这份报告是不是当前这一章的」—— 否则切了章还会拿 A 章的爆点看 B 章的正文。
 *    进度里也放一份，是为了**失败时也认得出是哪一章**（失败没有 result）。
 */
interface PaceTaskResult { chapterId: string; report: PaceReport }
interface PaceTaskProgress { chapterId: string }

export default function PaceAnalysisPanel() {
  // ⚠️ 它返回的是 { ready, label } 对象，不是布尔 —— 写成 `const aiReady = useAIReady()`
  //    会让 canRun 恒真、按钮永不禁用、禁用提示永不显示（写这版时踩过，实机抓出来的）。
  const { ready: aiReady } = useAIReady()
  // 3.5.6：ACP 就绪时走 Agent（引文定位、不评分口径与趋势记账都不变）
  const acpWriting = useAcpWriting()
  const writingReady = aiReady || !!acpWriting?.ready
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [vols, setVols] = useState<Volume[]>([])
  const [hookRows, setHookRows] = useState<TableRow[]>([])
  /** 3.7.0 · W5：曲线切换的指标（纯事实指标，不含任何合成分） */
  const [metric, setMetric] = useState<'words' | 'dialogue' | 'paragraph' | 'gap'>('words')
  const [activeId, setActiveId] = useState('')
  const [loading, setLoading] = useState(true)
  /** ④（2.9.2）：本章的节奏趋势 —— 只统计**同一个模型**的历史（换模型输出不可比） */
  const [trend, setTrend] = useState<CheckTrend | null>(null)

  /**
   * 🔴 2.6.3 · 跨页签任务存活：**运行态与结果都在任务中心**，本组件只是「提交 + 订阅 + 展示」。
   *    原实现把结果存在本组件 `useState`、并在卸载时 `abort()` —— 切去别的页签整理设定，
   *    分析要么被当场杀掉、要么请求跑完却把结果写进**已卸载组件**（白烧一次额度）。
   *    现在切页签不影响分析，切回来结果原样还在。
   */
  const task = useAiTask<PaceTaskResult, PaceTaskProgress>(OWNER_TAB, TASK_KIND)
  const running = task?.status === 'running'
  /** 这份任务属于哪一章（成功看 result，失败看 progress —— 失败没有 result） */
  const taskChapter = task?.result?.chapterId ?? task?.progress?.chapterId ?? ''
  /** 🔴 只显示**本章**的报告：换了章不显示（与迁移前一致）；切回来还在（迁移前会永久丢） */
  const d = task?.status === 'done' && taskChapter === activeId ? task.result?.report : undefined
  const err = task?.status === 'failed' && taskChapter === activeId ? task.error : ''
  const taskId = task?.id ?? ''
  const taskUnread = task?.unread ?? false
  const taskStatus = task?.status

  const load = useCallback(async () => {
    const [chs, volumes, hooks] = await Promise.all([
      db.getAllChapters().catch(() => [] as Chapter[]),
      db.getAllVolumes().catch(() => [] as Volume[]),
      db.getTableRows('hookpoints').catch(() => [] as TableRow[]),
    ])
    // 与「本章体检」同源修正：原先裸按 order 排 ⇒ 跨卷串号（第1章 / 第11章 / 第21章 …）
    const sorted = sortChapters(volumes, chs)
    setVols(volumes)
    setHookRows(hooks)
    setChapters(sorted)
    setActiveId(prev => prev || (sorted.find(c => (c.wordCount || 0) > 0) ?? sorted[0])?.id || '')
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  // 结果被看到即清「未查看」标记（指示器上的「待查看 N」据此收敛）
  useEffect(() => {
    if (taskId && taskStatus === 'done' && taskUnread && taskChapter === activeId) markTaskSeen(taskId)
  }, [taskId, taskStatus, taskUnread, taskChapter, activeId])

  /**
   * ④ 趋势行：切章 / 任务落地后重取本章（同模型）的历史快照。
   * 🔴 带 `cancelled` 守卫 —— 取数是异步的，组件可能在这期间卸载或已换章。
   * 🔴 依赖里放 `taskStatus`：任务转 done 时重取，才能看到**刚落的这一条**。
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!activeId) { if (!cancelled) setTrend(null); return }
      const model = await requireProviderFor('review').then(c => c.model).catch(() => '')
      // 🔴 拿不到模型名 ⇒ **不出趋势**，而不是退化成「不过滤」——
      //    不过滤会把不同模型的快照混在一起算，「趋势」就成了假的。宁可没有（2026-10-09 审计修）。
      if (!model) { if (!cancelled) setTrend(null); return }
      const t = await trendOf('pace', activeId, model).catch(() => null)
      if (!cancelled) setTrend(t)
    })()
    return () => { cancelled = true }
  }, [activeId, taskStatus, taskChapter])

  const active = useMemo(() => chapters.find(c => c.id === activeId), [chapters, activeId])
  const content = active?.content ?? ''
  const words = useMemo(() => (content ? countWords(content) : 0), [content])
  /** 3.7.0 · W5：全书逐章指标（本地计算，抽稀到 ≤500 点） */
  const paceSeries = useMemo(() => {
    const seq = chapterSeqMap(vols, chapters)
    const input = chapters.map(c => ({ id: c.id, no: seq.get(c.id) ?? 0, title: c.title || '', content: c.content ?? '' }))
    const hooks = hookRows.map(r => {
      const raw = String(r.data['章节号'] ?? '')
      const no = Number(raw.match(/(\d+)/)?.[1] ?? 0)
      return { chapterNo: no, strength: String(r.data['爽点强度'] ?? '') }
    })
    const series = computePaceSeries(input, hooks)
    return { ...series, points: samplePoints(series.points) }
  }, [chapters, vols, hookRows])
  const curve = useMemo(() => {
    const pts = paceSeries.points
    if (!pts.length) return { path: '', max: 0 }
    const valueOf = (q: PacePoint) => metric === 'words' ? q.words : metric === 'dialogue' ? q.dialogueRatio : metric === 'paragraph' ? q.avgParagraph : (q.hookGap ?? 0)
    // 「距上个爽点」：首个爽点之前的章是 null（不知道），不能画成 0（与「本章有爽点」混淆）——断线跳过
    const usable = metric === 'gap' ? pts.filter(q => q.hookGap !== null) : pts
    const max = Math.max(1, ...usable.map(valueOf))
    const step = pts.length > 1 ? 100 / (pts.length - 1) : 0
    let penDown = false
    const path = pts.map((q, i) => {
      if (metric === 'gap' && q.hookGap === null) { penDown = false; return '' }
      const cmd = penDown ? 'L' : 'M'
      penDown = true
      return `${cmd}${(i * step).toFixed(2)},${(36 - (valueOf(q) / max) * 32).toFixed(2)}`
    }).filter(Boolean).join(' ')
    return { path, max }
  }, [paceSeries, metric])
  const gapUnknown = metric === 'gap' && !paceSeries.points.some(q => q.hookGap !== null)

  const run = () => {
    if (!writingReady) { showToast('还没接入模型、也没有可用的 ACP 连接，无法分析', 'info'); return }
    if (running) return
    if (!content.trim()) { showToast('这一章还没有正文', 'info'); return }
    // 🔴 输入在发起时**快照**进闭包：任务跑在 store 里，跑的过程中组件可能已经卸载
    const chapterId = activeId
    const text = content
    const acp = acpWriting?.ready ? { generation: acpWriting.generation, name: acpWriting.name } : null
    startTask<PaceTaskResult, PaceTaskProgress>({
      ownerTab: OWNER_TAB,
      kind: TASK_KIND,
      title: '节奏与章末钩子',
      run: async ctx => {
        // 先把章节记进进度：失败时面板仍能认出这份失败属于哪一章
        ctx.progress({ chapterId })
        const pctx = await buildProjectContext({ budget: await writerBudgetFor('pace-analysis'), focusChapterId: chapterId })
        const report = await aiPaceAnalysis(pctx.text, text, {
          signal: ctx.signal,
          ...(acp ? {
            acpText: acpGatedText({
              task: 'pace',
              generation: acp.generation,
              title: '发送章节资料至 ACP Agent',
              message: acpGateMessage(acp.name, '本章正文与设定资料', '观察节奏与章末钩子'),
              agentName: acp.name,
              ask: confirmDialog,
              signal: ctx.signal,
            }),
          } : {}),
        })
        // ④（2.9.2）：落一条台账做「这一章比上次」的趋势。
        //    🔴 **先 await 写盘再 return** —— 任务转 done 时订阅趋势的 effect 才会读到刚落的这条，
        //       顺序反了趋势会永远落后一轮（"上次检查"显示的还是上一次）。
        //    🔴 记 `model`：AI 输出带随机性，趋势只比同模型（见 lib/checkLog.trendOf）。
        //    ACP 下记 Agent 名 —— 换 Agent 同样不可比，不能与前一个模型的历史混算。
        const model = acp ? `ACP ${acp.name}` : await requireProviderFor('review').then(c => c.model).catch(() => '')
        await paceLogged(chapterId, report, model)
        return { chapterId, report }
      },
      // 失败要说出来（作者可能已经切走了，面板上的红字他看不到）；成功不弹 —— 结果就在本页
      notify: ({ status, error }) => (status === 'failed'
        ? { text: '节奏分析失败：' + (error || '未知原因'), kind: 'error' }
        : null),
    })
  }

  if (loading) {
    return <div className="rounded-xl border border-ink-700 bg-ink-850/40 px-4 py-6 text-center text-11 text-ink-500">
      <Loader2 size={14} className="inline animate-spin" /> 正在读取…
    </div>
  }

  const canRun = writingReady && !!content.trim() && !running

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
            + '· 每次分析会记一条台账：标题行显示「这一章」的趋势，且只和同一个模型的历史比 —— 换模型的输出不可比。\n'
            + '· 只给结构观察，不给分、不排名 —— 要不要改、怎么改，由你判断。'}
        </HelpPopover>
        <div className="ml-auto flex items-center gap-2">
          <AIDataSourceNote feature="pace-analysis" compact />
          <Button variant="secondary" size="sm" disabled={!canRun} onClick={() => void run()}>
            {running ? <><Loader2 size={12} className="animate-spin" /> 分析中…</> : <><Sparkles size={12} /> 分析本章</>}
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
        {!writingReady && <span className="text-10 text-ink-500">{AI_DISABLED_HINT}</span>}
        {trend && (
          <span className="ml-auto">
            <CheckTrendNote trend={trend} neutral noun="个观察点" />
          </span>
        )}
      </div>

      {/* 3.7.0 · W5：全书节奏曲线 —— 只呈现事实分布（不加合成分、不做名次、不标区间） */}
      <div className="px-4 py-3 border-b border-ink-700" data-pace-curve>
        <div className="flex flex-wrap items-center gap-2 text-11">
          <span className="text-ink-200 font-medium">全书逐章曲线</span>
          <span className="text-10 text-ink-500">本地计算 · 每章一个点（超 500 章自动抽稀）</span>
          <select value={metric} onChange={e => setMetric(e.target.value as typeof metric)}
            className="ml-auto rounded border border-ink-700 bg-ink-950 px-2 py-1 text-11 text-ink-200 outline-none focus:border-amber">
            <option value="words">字数</option>
            <option value="dialogue">对话占比</option>
            <option value="paragraph">平均段长</option>
            <option value="gap">距上个爽点（章）</option>
          </select>
        </div>
        {paceSeries.points.length === 0 ? (
          <div className="mt-1.5 text-10 text-ink-500">还没有可画曲线的章节。</div>
        ) : (
          <div className="mt-1.5">
            <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-16 w-full" role="img" aria-label="逐章节奏曲线（事实分布）">
              <line x1="0" y1="36" x2="100" y2="36" style={{ stroke: 'rgb(var(--ink-700))' }} strokeWidth="0.4" />
              <path d={curve.path} fill="none" style={{ stroke: 'rgb(var(--amber))' }} strokeWidth="0.7" />
              {paceSeries.points.map((q, i) => q.hooks > 0 ? (
                <circle key={q.chapterNo}
                  cx={(paceSeries.points.length > 1 ? i * (100 / (paceSeries.points.length - 1)) : 0).toFixed(2)}
                  cy={(36 - (q.hookWeight / Math.max(1, ...paceSeries.points.map(x => x.hookWeight))) * 32).toFixed(2)}
                  r={0.6 + q.hookWeight * 0.3} style={{ fill: 'rgb(var(--amber))' }} />
              ) : null)}
            </svg>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-10 text-ink-500">
              {gapUnknown
                ? <span>还没有登记爽点，「距上个爽点」没有可画的事实（首个爽点前的章不画成 0）。</span>
                : <span>最高值：{metric === 'dialogue' ? `${(curve.max * 100).toFixed(0)}%` : curve.max}</span>}
              <span>按登记强度打点（点越大档越高）</span>
            </div>
            {paceSeries.observations.map(o => <div key={o} className="mt-0.5 text-10 text-ink-400">{o}</div>)}
          </div>
        )}
      </div>

      {/* 结果区 */}
      <div className="px-4 py-3">
        {words === 0 && <div className="text-11 text-ink-500">{EMPTY_CHAPTER_HINT}</div>}

        {words > 0 && err && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-11 text-danger">
            分析失败：{err}
          </div>
        )}

        {words > 0 && !d && !err && !running && (
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
                  d.hookPresent ? 'border-amber/40 text-amber bg-amber/15' : 'border-ink-600 text-ink-400 bg-ink-800'
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
                  <div key={seg} className="rounded-lg border border-ink-700 yfe-surface-3 px-3 py-2 text-center">
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
