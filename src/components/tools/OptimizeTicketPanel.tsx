/**
 * 全书优化工单（2.8.0 · 台账 #016）—— 三步式：**生成工单 → 勾选执行 → 前后对照**。
 *
 * 【与既有面板的分工】
 *   · 「本章体检」看**一章**（五个引擎，只读不改）；本面板把**全书**所有章的问题汇总成一张可勾选的表，
 *     并且**能直接改**（复用整章改写链）；
 *   · 「AI 一致性深度自查」是语义判断（要 AI）；本面板的**诊断**这一步全部本地确定性检查，零成本。
 *
 * 🔴 成本口径：诊断免费、执行要钱。所以「执行」**必须勾选**才动（不静默全跑），
 *    并且「需手动处理」的条目（连续性 / 伏笔这类根子在设定表的）压根不会进执行队列。
 *
 * 🔴 长任务两条都走任务中心（`optimize-ticket` / `optimize-ticket-run`）：
 *    全书诊断 + 逐章改写可能跑几分钟，切页签不中断、结果留着。
 */
import { useEffect, useMemo, useState } from 'react'
import { ClipboardList, Loader2, Square, Sparkles, Eye, ListChecks } from 'lucide-react'
import Panel from '@/components/common/Panel'
import { Button } from '@/components/common/Button'
import HelpPopover from '@/components/common/HelpPopover'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import DiffView from '@/components/editor/DiffView'
import { Modal } from '@/components/dialogs/Modal'
import { showToast } from '@/components/dialogs/dialogs'
import { useAIReady } from '@/lib/ai/useAIReady'
import { AI_DISABLED_HINT } from '@/lib/ai/aiScope'
import { useTaskRunner } from '@/lib/ai/aiTaskCenter'
import { foldVh } from '@/lib/settings/theme'
import { SEVERITY_LABEL, type IssueSeverity } from '@/lib/audit/audit'
import {
  SOURCE_LABEL, actionLabelOf, buildTicketDetailed, groupByChapter, groupByIssue, runTicketChapter,
  type TicketItem, type TicketDiagnose, type RunRecheck,
} from '@/lib/app/optimizeTicket'

const OWNER_TAB = 'check-tools'
const KIND_GEN = 'optimize-ticket'
const KIND_RUN = 'optimize-ticket-run'

/** 界面态：lib 的条目 + 本地勾选位（勾选是界面概念，不进 lib 类型） */
type Item = TicketItem & { picked: boolean }

/** 诊断结果＝工单条目 + 检查项状态（哪几章没检成，如实说，不装作"全查过了"） */
interface GenResult extends TicketDiagnose {}
interface GenProgress { done: number; total: number }
interface RunChapterOut {
  chapterId: string
  items: TicketItem[]
  beforeText?: string
  afterText?: string
  /** 改完复检（本地引擎，零额度）；没跑成就没有 —— 界面如实说"没跑成"，不装作"已解决" */
  recheck?: RunRecheck
}
interface RunResult { chapters: RunChapterOut[] }
interface RunProgress { done: number; total: number; title?: string }

const sevBadge = (s: IssueSeverity) =>
  s === 'error' ? 'bg-danger/15 text-danger border border-danger/30'
    : s === 'warn' ? 'bg-amber/15 text-amber border border-amber/30'
      : 'bg-ink-700 text-ink-300 border border-ink-600'

/** 条目当前状态的一句话（`manual` 是 action 不是 status，单独说） */
function statusText(i: Item): string {
  if (i.action === 'manual' && i.status === 'pending') return '需手动处理'
  if (i.status === 'done') return '已改写'
  if (i.status === 'failed') return '失败：' + (i.error || '未知原因')
  if (i.status === 'running') return '改写中…'
  if (i.status === 'skipped') return '已跳过'
  return '待处理'
}

export default function OptimizeTicketPanel() {
  const { ready: aiReady } = useAIReady()
  const [items, setItems] = useState<Item[]>([])
  const [onlyError, setOnlyError] = useState(false)
  /** 正在对照的章（空串＝没开弹窗） */
  const [diffChapter, setDiffChapter] = useState('')
  /** 2.9.2：工单视图 —— 「按章」（执行流）／「按类型」（看全局）。默认按章，**原有行为一字不变** */
  const [view, setView] = useState<'chapter' | 'issue'>('chapter')

  const gen = useTaskRunner<GenResult, GenProgress>({ ownerTab: OWNER_TAB, kind: KIND_GEN, title: '生成优化工单' })
  const exe = useTaskRunner<RunResult, RunProgress>({ ownerTab: OWNER_TAB, kind: KIND_RUN, title: '逐章自动修订' })

  // 工单生成结果 → 界面工作副本（勾选位默认全不勾：**绝不静默全跑**）
  useEffect(() => {
    setItems((gen.result?.items ?? []).map(i => ({ ...i, picked: false })))
  }, [gen.result])

  // 执行结果的状态合并回来（切页签后重挂载，靠这一步恢复「哪些已经改过」）。
  // 🔴 两个来源都读：正常跑完看 `result`；**中止**时 `result` 被任务中心清空（有意设计），
  //    已处理章走 `ctx.setResume` 回传（见上面 `executeNow` 里那行注释）。
  useEffect(() => {
    const r = exe.result ?? (exe.task?.resume as RunResult | null | undefined)
    if (!r) return
    setItems(prev => {
      if (!prev.length) return prev
      const patch = new Map<string, TicketItem>()
      for (const ch of r.chapters) for (const it of ch.items) patch.set(it.id, it)
      return prev.map(i => { const p = patch.get(i.id); return p ? { ...p, picked: i.picked } : i })
    })
  }, [exe.result, exe.task?.resume])

  const picked = useMemo(() => items.filter(i => i.picked), [items])
  // 「需手动处理」的不进执行队列（连续性 / 伏笔的根子在设定表，改正文只会掩盖矛盾）
  const runnable = useMemo(() => picked.filter(i => i.action !== 'manual'), [picked])

  const groups = useMemo(() => {
    const shown = onlyError ? items.filter(i => i.severity === 'error') : items
    // `groupByChapter` 归的是 lib 类型（不含勾选位）—— 这里用 id 回查本地副本，把 `picked` 补回来
    const byId = new Map(shown.map(i => [i.id, i]))
    return groupByChapter(shown).map(g => ({
      ...g,
      items: g.items.map(i => byId.get(i.id) ?? { ...i, picked: false }),
    }))
  }, [items, onlyError])

  // 2.9.2：按问题类型聚合（看「哪类问题最普遍」）。与 `groups` 是同一批条目的两种视图。
  // 该视图只做汇总、不提供勾选 ⇒ 不必像 `groups` 那样回查本地副本补 `picked`。
  const issueGroups = useMemo(() => {
    const shown = onlyError ? items.filter(i => i.severity === 'error') : items
    return groupByIssue(shown)
  }, [items, onlyError])

  const doneCount = items.filter(i => i.status === 'done').length
  const errorCount = items.filter(i => i.severity === 'error').length

  const toggle = (id: string, on: boolean) =>
    setItems(prev => prev.map(i => (i.id === id ? { ...i, picked: on } : i)))
  const setGroup = (chapterId: string, on: boolean) =>
    setItems(prev => prev.map(i => (i.chapterId === chapterId && i.action !== 'manual' ? { ...i, picked: on } : i)))
  const setAll = (on: boolean) =>
    setItems(prev => prev.map(i => (i.action === 'manual' ? { ...i, picked: false } : { ...i, picked: on })))

  const genNow = () => {
    if (gen.running) return
    gen.run(async ctx => {
      ctx.progress({ done: 0, total: 0 })
      const r = await buildTicketDetailed({
        signal: ctx.signal,
        onProgress: (done, total) => ctx.progress({ done, total }),
      })
      return r
    }, ({ status, result, error }) => {
      if (status === 'failed') return { text: `生成工单失败：${error || '未知原因'}`, kind: 'error' as const }
      if (status === 'done' && result) {
        // 🔴 有几章没检成时**不能**说"诊断完成，没有问题"—— 那会把漏检说成通过（WQ1 病灶）
        const missed = result.checks.filter(c => c.status === 'failed').length
        if (missed) {
          return { text: `工单已生成：${result.items.length} 条待处理，但 ${missed} 章没检成（这几章等于没查）`, kind: 'info' as const }
        }
        return result.items.length
          ? { text: `优化工单已生成：${result.items.length} 条待处理`, kind: 'info' as const }
          : { text: '诊断完成，没有发现需要处理的问题', kind: 'success' as const }
      }
      return null
    })
  }

  const executeNow = () => {
    if (exe.running) return
    if (!aiReady) { showToast('还没接入模型，无法执行改写', 'info'); return }
    if (!runnable.length) { showToast('先勾选要处理的条目（「需手动处理」的不会自动改）', 'info'); return }
    // 🔴 逐章串行：按章分组合并成一次改写（同章多条绝不反复覆写，见 lib/optimizeTicket 纪律 ①）
    const plan = groupByChapter(runnable)
    exe.run(async ctx => {
      const out: RunChapterOut[] = []
      let done = 0
      ctx.progress({ done, total: plan.length })
      for (const g of plan) {
        if (ctx.isAborted()) break
        const r = await runTicketChapter(g.items, { signal: ctx.signal })
        out.push({
          chapterId: r.chapterId, items: r.items,
          ...(r.beforeText !== undefined ? { beforeText: r.beforeText } : {}),
          ...(r.afterText !== undefined ? { afterText: r.afterText } : {}),
          ...(r.recheck ? { recheck: r.recheck } : {}),
        })
        done++
        // 🔴 每章跑完就把「已完成」的产物写进 resume：任务结束时 `result` 会被清掉
        //    （中止 ⇒ 不留可疑产物，是任务中心的有意设计），但 `resume` 会保留。
        //    不这么做，中止后已改完的章会退回「待处理」，作者再点一次就重复改写、重复烧额度。
        ctx.setResume({ chapters: [...out] } as RunResult)
        ctx.progress({ done, total: plan.length, title: g.chapterTitle })
      }
      return { chapters: out }
    }, ({ status, result, error }) => {
      if (status === 'aborted') {
        // 已改完的章保留在列表里（走 resume 合并），如实说清以免作者以为白跑了
        return { text: '已中止：已改完的章保持「已改」，剩下的没动', kind: 'info' as const }
      }
      if (status === 'failed') return { text: `逐章修订失败：${error || '未知原因'}`, kind: 'error' as const }
      if (status === 'done' && result) {
        const ok = result.chapters.filter(c => c.afterText !== undefined).length
        // 🔴 复检如实带一句：改完不等于改好，有多少章仍有未解决项要说出来
        const stuck = result.chapters.filter(c => c.recheck && c.recheck.stillOpen.length).length
        return {
          text: `逐章修订完成：${ok}/${result.chapters.length} 章已改写`
            + (stuck ? `（其中 ${stuck} 章复检后仍有未解决项，见每章标题旁）` : '')
            + '（旧稿都在「时光机 · 本章版本历史」里）',
          kind: 'success' as const,
        }
      }
      return null
    })
  }

  const runProgress = exe.task?.progress
  const genProgress = gen.task?.progress
  const curDiff = exe.result?.chapters.find(c => c.chapterId === diffChapter)
  /** 改完复检的结论（两个来源都读：`result` 与中止时保留的 `resume`，与上面状态合并同源） */
  const recheckOf = (chapterId: string): RunRecheck | undefined =>
    (exe.result ?? (exe.task?.resume as RunResult | null | undefined))
      ?.chapters.find(c => c.chapterId === chapterId)?.recheck

  return (
    <Panel>
      <h2 className="text-13 font-semibold text-ink-100 mb-1 flex items-center gap-2">
        <ClipboardList size={14} className="text-amber" /> 全书优化工单
        <HelpPopover title="全书优化工单怎么用" width="24rem">
          {'完稿后的闭环，三步走：\n\n'
            + '① 生成工单：跑五个本地引擎（连续性 / 伏笔 / 敏感词 / 错别字 / 文风），把全书的待处理项汇总成一张表 —— 纯本地、不花额度。\n'
            + '② 勾选执行：你要改哪几条就勾哪几条（默认一条不勾）。勾好后点「执行选中」，会按章合并、逐章改写，走的是「整章改写」那条链。\n'
            + '③ 前后对照：改过的章可以点「看对照」逐行看改了什么。\n\n'
            + '几条边界：\n'
            + '· 「需手动处理」的条目不会自动改 —— 连续性与伏笔冲突的根子多在设定表里（比如已死的角色又出场），让模型去糊正文只会把矛盾盖住。\n'
            + '· 历史章只做「润色 / 精简」这两档不改设定的处理；因为要改写全文的那两档（扩写 / 改写）会新增设定，所以历史章里这类条目也会标成「需手动处理」。\n'
            + '· 每改一章都会先自动留一份旧稿（在「时光机 · 本章版本历史」里可回退）。\n'
            + '· 执行中可以随时中止；已改完的章保持已改，没轮到的仍然是待处理。'}
          <AIDataSourceNote feature="chapter-rewrite" />
        </HelpPopover>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={gen.running} onClick={genNow}>
            {gen.running
              ? <><Loader2 size={12} className="animate-spin" /> 诊断中…</>
              : <><ClipboardList size={12} /> {items.length ? '重新生成工单' : '生成工单'}</>}
          </Button>
          <Button variant="primary" size="sm" disabled={!aiReady || exe.running || !runnable.length}
            onClick={executeNow}
            title={!aiReady ? AI_DISABLED_HINT : (runnable.length ? `按章合并改写 ${runnable.length} 条` : '先勾选要处理的条目')}>
            {exe.running
              ? <><Loader2 size={12} className="animate-spin" /> 修订中…</>
              : <><Sparkles size={12} /> 执行选中{runnable.length ? `（${runnable.length}）` : ''}</>}
          </Button>
          {exe.running && (
            <Button variant="danger" size="sm" onClick={exe.stop}><Square size={12} /> 中止</Button>
          )}
        </div>
      </h2>
      <p className="text-11 text-ink-500 mb-3">
        诊断全部本地完成（零额度）；执行走「整章改写」，会消耗额度。历史章只做不改设定的润色 / 精简。
      </p>

      {/* 运行中提示 */}
      {(gen.running || exe.running) && (
        <div className="mb-3 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2 text-11 text-ink-400">
          {gen.running && (
            <div className="flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" />
              正在诊断全书…
              {genProgress && genProgress.total > 0 && <span>已查 {genProgress.done} / {genProgress.total} 章</span>}
            </div>
          )}
          {exe.running && (
            <div className="flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" />
              正在逐章修订…
              {runProgress && <span>已处理 {runProgress.done} / {runProgress.total} 章{runProgress.title ? `（${runProgress.title}）` : ''}</span>}
            </div>
          )}
          <div className="mt-1 text-10 text-ink-500">可以切到别的页签，任务会继续跑；回来看结果仍在。</div>
        </div>
      )}

      {/* 工单为空 */}
      {!items.length && !gen.running && (
        <div className="text-11 text-ink-500">
          <Eye size={11} className="inline -mt-0.5 mr-1" />
          点右上「生成工单」：可可会把全书的问题汇成一张可勾选的表。诊断不发 AI 请求，不花额度。
        </div>
      )}

      {/* 诊断状态（WQ1：漏检如实说 —— 不把"没检成"显示成"没问题"） */}
      {gen.result && !gen.running && (() => {
        const s = gen.result.summary
        const missed = gen.result.checks.filter(c => c.status === 'failed')
        const notReached = gen.result.checks.filter(c => c.status === 'pending')
        const skipped = gen.result.checks.filter(c => c.status === 'skipped')
        return (
          <div className={`mb-2 rounded-lg border px-3 py-1.5 text-11 ${
            missed.length ? 'border-danger/30 bg-danger/10' : 'border-ink-700 bg-ink-900/40'
          }`}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-400">
              <ListChecks size={11} className="shrink-0" />
              <span>已检 <b className="text-ink-200 tabular-nums">{s.done}</b> / {s.total} 章</span>
              {skipped.length > 0 && <span>（{skipped.length} 章空章，跳过）</span>}
              {s.totalFindings > 0 && (
                <span>发现 <b className="text-ink-200 tabular-nums">{s.totalFindings}</b> 个问题
                  {s.criticalFindings > 0 && <>，其中 <b className="text-danger tabular-nums">{s.criticalFindings}</b> 个冲突</>}
                </span>
              )}
              {gen.result.persisted.saved > 0 && (
                <span className="text-ink-500" title="只有「冲突 / 注意」级的发现会留档；同一章重跑不会重复占额度（在「创作轨迹」里可回看）">
                  · 留档 {gen.result.persisted.saved} 份{gen.result.persisted.pruned ? `（淘汰 ${gen.result.persisted.pruned} 份旧报告）` : ''}
                </span>
              )}
              {gen.result.persisted.error && (
                <span className="text-ink-500" title={gen.result.persisted.error}>· 留档未成功（不影响工单）</span>
              )}
            </div>
            {missed.length > 0 && (
              <div className="mt-1 text-danger">
                {missed.length} 章没检成：{missed.slice(0, 3).map(c => c.name).join('、')}
                {missed.length > 3 ? ` 等 ${missed.length} 章` : ''}
                <span className="text-ink-400"> —— 这几章是「没查」，不是「查过没问题」，建议重新诊断。</span>
              </div>
            )}
            {notReached.length > 0 && (
              <div className="mt-1 text-amber">
                还有 {notReached.length} 章没轮到（诊断被中止），它们不在上面这份工单里。
              </div>
            )}
          </div>
        )
      })()}

      {/* 工单表格 */}
      {items.length > 0 && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-11">
            <span className="text-ink-300">共 <b className="text-ink-100 tabular-nums">{items.length}</b> 条</span>
            <span className="text-danger">冲突 {errorCount}</span>
            <span className="text-ink-400">已勾选 <b className="text-ink-200 tabular-nums">{picked.length}</b></span>
            <span className="text-success">已改写 {doneCount}</span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button variant="toggle" size="xs" selected={view === 'chapter'} onClick={() => setView('chapter')}
                title="按章分组 —— 执行改写就是按章进行的">按章</Button>
              <Button variant="toggle" size="xs" selected={view === 'issue'} onClick={() => setView('issue')}
                title="按问题类型汇总 —— 看哪类问题在全书里最普遍">按类型</Button>
              <span className="mx-0.5 h-3.5 w-px bg-ink-700" />
              <Button variant="toggle" size="xs" selected={onlyError} onClick={() => setOnlyError(v => !v)}
                title="只列出「冲突」级的条目">只看冲突</Button>
              <Button variant="secondary" size="xs" onClick={() => setAll(true)}>全选</Button>
              <Button variant="secondary" size="xs" onClick={() => setAll(false)}>清空</Button>
            </div>
          </div>

          {view === 'issue' ? (
            <div className="space-y-2 overflow-y-auto pr-1" style={{ maxHeight: foldVh('60vh') }}>
              {issueGroups.map(g => (
                <div key={g.key} className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-10 ${sevBadge(g.severity)}`}>
                      {SEVERITY_LABEL[g.severity]}
                    </span>
                    <span className="shrink-0 rounded border border-ink-600 bg-ink-800 px-1.5 py-0.5 text-10 text-ink-300">
                      {SOURCE_LABEL[g.source]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-12 text-ink-100">{g.title}</span>
                    <span className="shrink-0 text-10 text-ink-500">
                      出现在 <b className="text-ink-300 tabular-nums">{g.count}</b> 章 · {actionLabelOf(g.action)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {g.chapters.map(c => (
                      <span key={c.id} className="rounded border border-ink-700 bg-ink-900/60 px-1.5 py-0.5 text-10 text-ink-400">
                        {c.no > 0 ? `第${c.no}章` : (c.title || '（未命名）')}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {!issueGroups.length && (
                <div className="text-11 text-ink-500">当前筛选下没有条目。</div>
              )}
              <div className="pt-1 text-10 text-ink-500">
                按类型只做汇总、不提供勾选 —— 执行改写仍在「按章」视图里进行（同章多条会合并成一次改写）。
              </div>
            </div>
          ) : (
            <div className="space-y-3 overflow-y-auto pr-1" style={{ maxHeight: foldVh('60vh') }}>
              {groups.map(g => (
                <div key={g.chapterId} className="rounded-lg border border-ink-700 bg-ink-900/40 overflow-hidden">
                  <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-1.5">
                    <span className="text-12 text-ink-100">
                      {g.chapterNo > 0 ? `第${g.chapterNo}章 · ` : ''}{g.chapterTitle || '（未命名）'}
                    </span>
                    <span className="text-10 text-ink-500">{g.items.length} 条</span>
                    {/* 改完复检：本地引擎、零额度。标"已改写"≠"问题解决了"，这里如实区分 */}
                    {(() => {
                      const rc = recheckOf(g.chapterId)
                      const rewritten = exe.result?.chapters.some(c => c.chapterId === g.chapterId && c.afterText !== undefined)
                        || (exe.task?.resume as RunResult | null | undefined)?.chapters.some(c => c.chapterId === g.chapterId && c.afterText !== undefined)
                      if (!rc) {
                        return rewritten
                          ? <span className="text-10 text-ink-500" title="改完没跑成复检（本地检查，不影响正文）">· 复检没跑成</span>
                          : null
                      }
                      if (rc.stillOpen.length) {
                        return (
                          <span className="text-10 text-amber" title={`改完仍在：${rc.stillOpen.join('；')}`}>
                            · 复检：{rc.stillOpen.length} 条没解决
                          </span>
                        )
                      }
                      return (
                        <span className={`text-10 ${rc.findings ? 'text-ink-400' : 'text-success'}`}>
                          · 复检：原问题已清{rc.findings ? `，还剩 ${rc.findings} 个` : ''}
                        </span>
                      )
                    })()}
                    <Button variant="secondary" size="xs" className="ml-auto"
                      title="勾选本章所有可自动处理的条目"
                      onClick={() => setGroup(g.chapterId, true)}>按章全选</Button>
                  </div>
                  <div className="divide-y divide-ink-700/60">
                    {g.items.map(it => (
                      <div key={it.id} className="flex items-start gap-2 px-3 py-2">
                        <input type="checkbox" className="mt-1 shrink-0 accent-amber"
                          checked={it.picked} disabled={it.action === 'manual'}
                          onChange={e => toggle(it.id, e.target.checked)}
                          title={it.action === 'manual' ? '这条需手动处理，不能自动改' : ''} />
                        <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-10 ${sevBadge(it.severity)}`}>
                          {SEVERITY_LABEL[it.severity]}
                        </span>
                        <span className="mt-0.5 shrink-0 rounded border border-ink-600 bg-ink-800 px-1.5 py-0.5 text-10 text-ink-300">
                          {SOURCE_LABEL[it.source]}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-12 text-ink-100">{it.title}</div>
                          {it.detail && <div className="mt-0.5 text-11 leading-relaxed text-ink-400">{it.detail}</div>}
                          {it.suggestion && <div className="mt-0.5 text-10 text-ink-500">建议：{it.suggestion}</div>}
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-10 text-ink-500">{actionLabelOf(it.action)}</div>
                          <div className={`text-10 ${it.status === 'done' ? 'text-success' : it.status === 'failed' ? 'text-danger' : 'text-ink-500'}`}>
                            {statusText(it)}
                          </div>
                          {exe.result?.chapters.some(c => c.chapterId === it.chapterId && c.afterText !== undefined) && (
                            <Button variant="bare" size="xs" className="mt-0.5 rounded border border-ink-700 px-1.5 text-10 text-ink-400 hover:text-amber hover:border-amber/40 transition-colors"
                              onClick={() => setDiffChapter(it.chapterId)}>
                              看对照
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {!groups.length && (
                <div className="text-11 text-ink-500">当前筛选下没有条目。</div>
              )}
            </div>
          )}

          <div className="mt-2 flex items-center gap-1.5 text-10 text-ink-500">
            <ListChecks size={11} />
            勾选后点右上「执行选中」：按章合并成一次改写，逐章进行；每章改前自动留旧稿。
          </div>
        </>
      )}

      {/* 前后对照 */}
      <Modal
        open={!!diffChapter && !!curDiff}
        onClose={() => setDiffChapter('')}
        title={`修改前后对照 · ${
          items.find(i => i.chapterId === diffChapter)?.chapterTitle || '本章'
        }`}
        width="2xl"
        maxHeight="86vh"
      >
        {curDiff && curDiff.beforeText !== undefined && curDiff.afterText !== undefined
          ? <DiffView before={curDiff.beforeText} after={curDiff.afterText} />
          : <div className="text-11 text-ink-400">这一章还没有可对照的修订结果。</div>}
      </Modal>
    </Panel>
  )
}
