/**
 * 读者视角审问（C5 · 2.4.2）
 *
 * 与同页几个 AI 功能的分工：
 *   · 投稿前自检（B2）：全书分布，纯本地；
 *   · 节奏与章末钩子（B5）：单章结构，AI 审读 + 本地定位；
 *   · 本章体检（C3）：单章确定性五引擎，全本地；
 *   · **本面板**：让 AI **扮成一个具体读者**读这一章，回答三问 —— 主观反应，不是审稿意见。
 *
 * 🔴 段号由本地算：AI 只出「逐字引文 + 读者反应」，段号拿引文在正文里查出来（查不到标「未定位」）。
 * 🔴 立场：读者反应天然主观，这里不出分数、不出等级、不判"能不能发"。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { EMPTY_CHAPTER_HINT } from '@/lib/constants'
import { Copy, Eye, Loader2, Sparkles, UserRound } from 'lucide-react'
import * as db from '@/lib/db'
import type { Chapter } from '@/lib/types'
import { Button } from '@/components/common/Button'
import { showToast, copyText } from '@/components/dialogs/dialogs'
import { useAIReady } from '@/lib/ai/useAIReady'
import { AI_DISABLED_HINT } from '@/lib/ai/aiScope'
import { buildProjectContext } from '@/lib/ai/aiContext'
import { writerBudgetFor } from '@/lib/ai/aiWriterBudget'
import {
  aiReaderProbe, groupNotes, questionsOf, readerLensOf, readerProbeToText, READER_LENSES,
  type ReaderProbeResult,
} from '@/lib/ai/aiTasks'
import { countWords } from '@/lib/editor/textStats'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import HelpPopover from '@/components/common/HelpPopover'
import { markTaskSeen, startTask, useAiTask } from '@/lib/ai/aiTaskCenter'

/** 本面板在任务中心里的身份（`ownerTab` 需与 TABS 里的页签 id 一致 —— 指示器靠它跳回来） */
const OWNER_TAB = 'check-tools'
const TASK_KIND = 'reader-probe'

/**
 * 任务产物 / 进度：**都带上「章节 + 读者身份」**。
 *
 * 🔴 两者都要带：换章、换身份都必须丢弃上一份结果 —— 否则会拿 A 章读者三问的结果
 *    套在导师四问的分组上（key 对不上，全变「没提」）。任务跨页签存活，归属只能由界面自己判断。
 *    进度里也放一份，是为了**失败时也认得出属于哪一章 / 哪个身份**（失败没有 result）。
 */
interface ReaderProbeTaskResult { chapterId: string; lensKey: string; result: ReaderProbeResult }
interface ReaderProbeTaskProgress { chapterId: string; lensKey: string }

export default function ReaderProbePanel() {
  // ⚠️ 它返回 { ready, label } 对象，不是布尔 —— 写成布尔会让按钮永不禁用、提示永不显示。
  const { ready: aiReady } = useAIReady()
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [activeId, setActiveId] = useState('')
  const [lensKey, setLensKey] = useState(READER_LENSES[0].key)
  const [loading, setLoading] = useState(true)

  /**
   * 🔴 2.6.3 · 跨页签任务存活：**运行态与结果都在任务中心**，本组件只是「提交 + 订阅 + 展示」。
   *    原实现把结果存在本组件 `useState`、并在卸载时 `abort()` —— 切去别的页签整理设定，
   *    审问要么被当场杀掉、要么请求跑完却把结果写进已卸载组件（白烧一次额度）。
   */
  const task = useAiTask<ReaderProbeTaskResult, ReaderProbeTaskProgress>(OWNER_TAB, TASK_KIND)
  const running = task?.status === 'running'
  /** 这份任务属于哪一章 / 哪个身份（成功看 result，失败看 progress —— 失败没有 result） */
  const taskChapter = task?.result?.chapterId ?? task?.progress?.chapterId ?? ''
  const taskLens = task?.result?.lensKey ?? task?.progress?.lensKey ?? ''
  /** 🔴 只显示**当前章 + 当前身份**的结果（与迁移前一致）；切回来还在（迁移前会永久丢） */
  const owned = taskChapter === activeId && taskLens === lensKey
  const d = task?.status === 'done' && owned ? task.result?.result : undefined
  const err = task?.status === 'failed' && owned ? task.error : ''
  const taskId = task?.id ?? ''
  const taskUnread = task?.unread ?? false
  const taskStatus = task?.status

  const load = useCallback(async () => {
    const chs = await db.getAllChapters().catch(() => [] as Chapter[])
    const sorted = [...chs].sort((a, b) => a.order - b.order)
    setChapters(sorted)
    setActiveId(prev => prev || (sorted.find(c => (c.wordCount || 0) > 0) ?? sorted[0])?.id || '')
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  // 结果被看到即清「未查看」标记（指示器上的「待查看 N」据此收敛）
  useEffect(() => {
    if (taskId && taskStatus === 'done' && taskUnread && owned) markTaskSeen(taskId)
  }, [taskId, taskStatus, taskUnread, owned])

  const active = useMemo(() => chapters.find(c => c.id === activeId), [chapters, activeId])
  const content = active?.content ?? ''
  const words = useMemo(() => (content ? countWords(content) : 0), [content])
  const lens = readerLensOf(lensKey)
  const isMentor = lensKey === 'mentor'
  const questions = questionsOf(lens)
  const canRun = aiReady && !!content.trim() && !running

  const run = () => {
    if (!aiReady) { showToast('还没接入模型，无法审问', 'info'); return }
    if (running) return
    if (!content.trim()) { showToast('这一章还没有正文', 'info'); return }
    // 🔴 输入在发起时**快照**进闭包：任务跑在 store 里，跑的过程中组件可能已经卸载
    const chapterId = activeId
    const lensK = lensKey
    const text = content
    startTask<ReaderProbeTaskResult, ReaderProbeTaskProgress>({
      ownerTab: OWNER_TAB,
      kind: TASK_KIND,
      title: '读者视角审问',
      run: async ctx => {
        // 先把章节 / 身份记进进度：失败时面板仍能认出这份失败属于谁
        ctx.progress({ chapterId, lensKey: lensK })
        const pctx = await buildProjectContext({ budget: await writerBudgetFor('reader-probe'), focusChapterId: chapterId })
        const result = await aiReaderProbe(pctx.text, text, lensK, { signal: ctx.signal })
        return { chapterId, lensKey: lensK, result }
      },
      // 失败要说出来（作者可能已经切走了，面板上的红字他看不到）；成功不弹 —— 结果就在本页
      notify: ({ status, error }) => (status === 'failed'
        ? { text: '读者视角审问失败：' + (error || '未知原因'), kind: 'error' }
        : null),
    })
  }

  const copyAll = async () => {
    if (!d) return
    // 🔴 走 dialogs.copyText 而非裸 navigator.clipboard：后者在非安全上下文（file:// 便携版）
    //    直接不可用且无 execCommand 兜底，而「复制这一份」是这个面板唯一的对外出口 —— 失败等于整块作废。
    await copyText(readerProbeToText(d, active?.title || '（未命名）', lens.name, questions), '已复制这一份反馈')
  }

  if (loading) {
    return <div className="rounded-xl border border-ink-700 bg-ink-850/40 px-4 py-6 text-center text-11 text-ink-500">
      <Loader2 size={14} className="inline animate-spin" /> 正在读取…
    </div>
  }

  return (
    <section className="rounded-xl border border-ink-700 bg-ink-850/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-700">
        <UserRound size={14} className="text-amber" />
        <span className="text-13 font-medium text-ink-100">读者视角审问</span>
        <span className="text-10 text-ink-500">单章 · 扮一个具体身份来读 · 主观反应</span>
        <HelpPopover title="读者视角审问怎么用">
          {'用途：让 AI 扮成一个具体身份把这一章读一遍，逐条给出反应与依据。\n\n'
            + '· 和「审稿」不是一回事：读者身份不说语法、标点、设定矛盾（那些交给校对、文风体检、本章体检）。'
            + '它说的是「有人读到这里会走神 / 会停下来 / 会被勾住」。\n'
            + '· 「以谁的身份读」会改变结论：追更读者盯着爽感与钩子，新读者盯着有没有讲清楚，老书虫盯着是不是又走老路；'
            + '「写作导师」则不谈口味，用编剧的尺子看主题句、核心冲突、人物弧光、代价这四样 —— 想判断这一章立不立得住时用它。\n'
            + '· 提到的每一处都会标出段号 —— 段号不是模型报的，是拿它引用的原文在正文里查出来算的（查不到会标「未定位」）。\n'
            + '· 只呈现反应与依据，不给分、不排名、不说"能不能发"。改不改、怎么改，由你判断。'}
          <AIDataSourceNote feature="reader-probe" />
        </HelpPopover>
        <div className="ml-auto flex items-center gap-2">
          <AIDataSourceNote feature="reader-probe" compact />
          <Button variant="secondary" size="sm" disabled={!canRun} onClick={() => void run()}>
            {running
              ? <><Loader2 size={12} className="animate-spin" /> 读这一章…</>
              : <><Sparkles size={12} /> 请{isMentor ? '导师' : '读者'}读一遍</>}
          </Button>
        </div>
      </div>

      {/* 章节 + 读者身份 */}
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
        <div className="flex items-center gap-1.5">
          <span className="text-ink-500">以谁的身份读</span>
          {READER_LENSES.map(l => (
            <Button key={l.key} variant="toggle" size="xs" selected={lensKey === l.key}
              onClick={() => setLensKey(l.key)} title={l.care}
              className="rounded-md border px-2"
            >
              {l.name}
            </Button>
          ))}
        </div>
        <span className="text-ink-400">
          本章 <b className="text-ink-200 tabular-nums">{words}</b> 字
        </span>
        {!aiReady && <span className="text-10 text-ink-500">{AI_DISABLED_HINT}</span>}
      </div>

      <div className="px-4 py-3">
        <div className="mb-2 text-10 text-ink-500">{lens.care}</div>

        {words === 0 && <div className="text-11 text-ink-500">{EMPTY_CHAPTER_HINT}</div>}

        {words > 0 && err && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-11 text-danger">
            审问失败：{err}
          </div>
        )}

        {words > 0 && !d && !err && !running && (
          <div className="text-11 text-ink-500">
            <Eye size={11} className="inline -mt-0.5 mr-1" />
            点右上「请{isMentor ? '导师' : '读者'}读一遍」，看看这一章在「{lens.name}」眼里是什么样。
          </div>
        )}

        {d && (
          <div className="space-y-3">
            {groupNotes(d.notes, questions).map(({ q, items }) => (
              <div key={q.key} className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-11 font-medium text-ink-200">{q.label}</span>
                  <span className="text-10 text-ink-600">{items.length ? `${items.length} 处` : '没提'}</span>
                </div>
                {items.length === 0
                  ? <div className="mt-1 text-11 text-ink-500">{isMentor ? '导师没提这一项（在这一项上没话说）。' : '读者没提这一项（这一章在这一项上没让他有话想说）。'}</div>
                  : (
                    <div className="mt-1.5 space-y-2">
                      {items.map((it, i) => (
                        <div key={`${q.key}-${i}`} className="text-11 leading-relaxed">
                          {it.quote && (
                            <div className="flex items-start gap-1.5">
                              <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-10 border ${
                                it.paragraph > 0
                                  ? 'border-ink-600 text-ink-400 bg-ink-800'
                                  : 'border-amber/30 text-amber/80 bg-amber/5'
                              }`}>
                                {it.paragraph > 0 ? `第 ${it.paragraph} 段` : '未定位'}
                              </span>
                              <span className="text-ink-300">「{it.quote}」</span>
                            </div>
                          )}
                          <div className="mt-0.5 text-ink-200">{it.comment}</div>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
            ))}

            {d.summary && (
              <div className="rounded-lg border border-amber/30 bg-amber/5 px-3 py-2.5 text-11 text-ink-200 leading-relaxed">
                <span className="text-10 text-amber mr-1.5">读完这一章</span>
                {d.summary}
              </div>
            )}

            {/* 模型没按结构回：把原文整段兜住，不显示空白 */}
            {d.raw && (
              <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2.5">
                <div className="mb-1 text-10 text-ink-500">这次没按结构回（原文照录，未做定位）</div>
                <pre className="whitespace-pre-wrap text-11 leading-relaxed text-ink-300 font-sans">{d.raw}</pre>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button variant="secondary" size="xs" onClick={() => void copyAll()}>
                <Copy size={11} /> 复制这份反馈
              </Button>
              <span className="text-10 text-ink-600">换个身份再读一遍，对比着看更有用</span>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
