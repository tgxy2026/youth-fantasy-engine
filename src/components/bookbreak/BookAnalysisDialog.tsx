/**
 * 作品分析（只分析，不写入项目）—— 3.6.0 · B 包（首期 + B1/B2/B3）
 *
 * 定位（规划 §4）：给「外部参考作品」与「先摸清写法再决定要不要拆」两种场景用。
 * 🔴 它**不写正文、不写设定、不建关系**：产物只有分析卡；作者点「保存为成果」后才以
 *    `state: 'draft'` 进入 A1 的作者成果（可审阅、可导出、可清理），永远不会自动进正文。
 *
 * 3.6.0 · B3：跑在**任务中心**里 —— 关闭弹窗任务照常继续，重开能接上进度与结果；
 * 中止走任务中心（这个按钮也是同一个动作）。
 */
import { useMemo, useState } from 'react'
import { BookOpenCheck, Layers, Loader2, Save, Square } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'
import { abortTask, startTask, useAiTask } from '@/lib/ai/aiTaskCenter'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import {
  AGGREGATE_DIMENSIONS, ANALYSIS_DIMENSIONS, aggregateAnalysis, analysisCardsToArtefacts, analyzeBook,
  type AggregateCard, type AnalysisAggregateResult, type AnalysisDimension, type AnalysisResult,
} from '@/lib/bookbreak/analysis'
import { loadArtefacts, saveArtefacts, withUpserted } from '@/lib/artefacts/store'
import { getCurrentProjectId } from '@/lib/db/core'

const OWNER_TAB = 'bookbreak'
const KIND_ANALYSIS = 'book-analysis'
const KIND_AGGREGATE = 'book-aggregate'
const DIM_LABEL = new Map(ANALYSIS_DIMENSIONS.map(d => [d.id, d.label]))
const AGG_LABEL = new Map(AGGREGATE_DIMENSIONS.map(d => [d.id, d.label]))

interface AnalysisProgress { done: number; total: number; label: string }

export default function BookAnalysisDialog({ onClose }: { onClose: () => void }) {
  const [raw, setRaw] = useState('')
  const [dims, setDims] = useState<AnalysisDimension[]>(ANALYSIS_DIMENSIONS.map(d => d.id))
  const [saving, setSaving] = useState(false)

  const task = useAiTask<AnalysisResult, AnalysisProgress>(OWNER_TAB, KIND_ANALYSIS)
  const aggTask = useAiTask<AnalysisAggregateResult, AnalysisProgress>(OWNER_TAB, KIND_AGGREGATE)

  const running = task?.status === 'running'
  const result = task?.status === 'done' ? task.result : null
  const aggregate = aggTask?.status === 'done' ? aggTask.result : null
  const aggRunning = aggTask?.status === 'running'

  const failedUnits = useMemo(
    () => (result?.units ?? []).filter(u => u.state === 'failed').map(u => u.index),
    [result],
  )

  const run = (opts: { previous?: AnalysisResult; retryUnits?: number[] } = {}) => {
    if (!raw.trim()) { showToast('请先粘贴要分析的原文', 'info'); return }
    if (!dims.length) { showToast('至少选一个分析维度', 'info'); return }
    const dimensions = [...dims]
    const text = raw
    const started = startTask<AnalysisResult, AnalysisProgress>({
      ownerTab: OWNER_TAB,
      kind: KIND_ANALYSIS,
      title: '作品分析（只分析）',
      // 只分析不改任何项目数据 ⇒ writes 留空（任务中心不会与写正文/设定的任务互相提示冲突）
      writes: [],
      run: async ctx => {
        const res = await analyzeBook(text, {
          dimensions,
          signal: ctx.signal,
          ...(opts.previous ? { previous: opts.previous } : {}),
          ...(opts.retryUnits?.length ? { retryUnits: opts.retryUnits } : {}),
          onProgress: p => ctx.progress(p),
        })
        const c = res.coverage
        // 🔴 一个单元都没跑成时不能说「分析完成」
        const label = res.aborted
          ? '分析已中止'
          : c.failedUnits > 0
            ? (c.completedUnits > 0 ? '分析部分完成' : '分析未完成')
            : '分析完成'
        showToast(
          `${label}：${c.completedUnits}/${c.plannedUnits} 个单元，${res.cards.length} 张卡`
          + (c.failedUnits ? `；${c.failedUnits} 个单元失败` : '')
          + (c.truncated ? '；超出上限的部分未处理' : ''),
          c.failedUnits ? 'error' : 'success', 6000,
        )
        return res
      },
    })
    if (!started) showToast('已有一条作品分析在运行，等它跑完再发起', 'info')
  }

  const runAggregate = () => {
    if (!result) return
    const base = result
    const started = startTask<AnalysisAggregateResult, AnalysisProgress>({
      ownerTab: OWNER_TAB, kind: KIND_AGGREGATE, title: '作品分析 · 跨章归纳', writes: [],
      run: async ctx => {
        ctx.progress({ done: 0, total: 1, label: '归纳人物弧线 / 节奏曲线 / 线索与回收…' })
        const res = await aggregateAnalysis(base, { signal: ctx.signal })
        showToast(
          res.state === 'completed'
            ? `跨章归纳完成：${res.cards.length} 条`
            : res.state === 'skipped' ? '没有可归纳的卡片（先完成章节分析）' : '跨章归纳失败，可重试',
          res.state === 'completed' ? 'success' : 'error', 5000,
        )
        return res
      },
    })
    if (!started) showToast('已有一条跨章归纳在运行', 'info')
  }

  const saveAsArtefact = async () => {
    if (!result || !result.cards.length) return
    const pid = getCurrentProjectId()
    if (!pid) { showToast('当前没有打开的项目', 'error'); return }
    setSaving(true)
    try {
      const loaded = await loadArtefacts(pid)
      if (!loaded.writable) {
        showToast(`成果记录当前不可写：${loaded.error ?? '未知原因'}`, 'error')
        return
      }
      const records = analysisCardsToArtefacts(result, pid)
      let store = loaded.store
      for (const r of records) store = withUpserted(store, r)
      const saved = await saveArtefacts(pid, store, undefined, records)
      if (!saved.ok) { showToast(saved.reason, 'error', 8000); return }
      showToast(`已保存 ${records.length} 张分析卡为成果（草稿，可在创作参考里审阅）`, 'success', 6000)
    } finally {
      setSaving(false)
    }
  }

  const groups = useMemo(() => {
    const map = new Map<AnalysisDimension, NonNullable<AnalysisResult['cards']>>()
    for (const c of result?.cards ?? []) {
      const arr = map.get(c.dimension) ?? []
      arr.push(c)
      map.set(c.dimension, arr)
    }
    return [...map.entries()]
  }, [result])

  const aggGroups = useMemo(() => {
    const map = new Map<string, AggregateCard[]>()
    for (const c of aggregate?.cards ?? []) {
      const arr = map.get(c.dimension) ?? []
      arr.push(c)
      map.set(c.dimension, arr)
    }
    return [...map.entries()]
  }, [aggregate])

  return (
    <Modal open onClose={onClose} title="作品分析（只分析，不写入项目）"
      icon={<BookOpenCheck size={16} />} width={860} maxHeight="86vh"
      footer={<>
        <span className="text-10 text-ink-500">
          只产出分析卡：不改正文、不建设定、不建关系；保存为成果后才进项目包。关闭窗口任务仍会继续。
        </span>
        <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
      </>}>
      <div className="space-y-3">
        <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2 text-11 text-ink-400 leading-relaxed">
          适合两类场景：① 外部参考作品——只想学写法，<b className="text-ink-200">不希望原文进你的项目</b>；
          ② 先摸清结构再决定要不要一键拆书。分析只读原文，不落任何正式数据。
          <div className="mt-1.5"><AIDataSourceNote feature="book-analysis" compact /></div>
        </div>

        <label className="block">
          <span className="text-11 text-ink-400">原文（粘贴；{raw.length.toLocaleString()} 字）</span>
          <textarea
            value={raw}
            onChange={e => setRaw(e.target.value)}
            disabled={running}
            placeholder="把要分析的作品粘贴到这里（支持多章；识别不到章节标题时按字数分块）"
            className="mt-1 w-full text-11 px-2 py-1.5 rounded-lg bg-ink-900 border border-ink-700 text-ink-100 outline-none focus:border-amber/50 h-36 resize-none disabled:opacity-60"
          />
        </label>

        <div>
          <span className="text-11 text-ink-400">分析维度</span>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {ANALYSIS_DIMENSIONS.map(d => {
              const on = dims.includes(d.id)
              return (
                <label key={d.id} title={d.hint}
                  className={`flex items-center gap-1 text-11 px-2 py-1 rounded-lg border transition-colors ${
                    on ? 'border-amber/40 bg-amber/10 text-amber' : 'border-ink-700 bg-ink-800/60 text-ink-300'}`}>
                  <input type="checkbox" className="hidden" checked={on} disabled={running}
                    onChange={() => setDims(prev => prev.includes(d.id) ? prev.filter(x => x !== d.id) : [...prev, d.id])} />
                  {d.label}
                </label>
              )
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" solid size="md" disabled={running || !raw.trim()} onClick={() => run()}>
            {running ? <Loader2 size={13} className="animate-spin" /> : <BookOpenCheck size={13} />}
            {running ? '分析中…' : result ? '重新分析（复用已完成单元）' : '开始分析'}
          </Button>
          {running && task && (
            <Button variant="secondary" size="md" onClick={() => abortTask(task.id)}>
              <Square size={12} /> 中止
            </Button>
          )}
          {running && task?.progress && (
            <span className="text-10 text-ink-500">{task.progress.label}（{task.progress.done}/{task.progress.total}）</span>
          )}
          {!running && failedUnits.length > 0 && result && (
            <Button variant="secondary" size="md"
              onClick={() => run({ previous: result, retryUnits: failedUnits })}>
              只重试失败的 {failedUnits.length} 个单元
            </Button>
          )}
          {!running && result && result.cards.length > 0 && (
            <>
              <Button variant="secondary" size="md" disabled={saving} onClick={() => void saveAsArtefact()}>
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} 保存为成果（草稿）
              </Button>
              <Button variant="secondary" size="md" disabled={aggRunning} onClick={runAggregate}>
                {aggRunning ? <Loader2 size={12} className="animate-spin" /> : <Layers size={12} />} 跨章归纳
              </Button>
            </>
          )}
        </div>

        {task?.status === 'failed' && (
          <div role="alert" className="text-11 text-danger">分析失败：{task.error || '未知原因'}</div>
        )}

        {result && (
          <section className="rounded-xl border border-ink-700 bg-ink-900/40 px-3 py-2.5 space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-11 text-ink-300">
              <span>单元 <b className="text-ink-100 tabular-nums">{result.coverage.completedUnits}</b>/{result.coverage.plannedUnits}</span>
              {result.coverage.failedUnits > 0 && <span className="text-danger">失败 {result.coverage.failedUnits}</span>}
              {result.coverage.skippedUnits > 0 && <span className="text-amber">未处理 {result.coverage.skippedUnits}</span>}
              <span>卡片 {result.cards.length}</span>
              <span className="text-ink-500">已处理 {result.coverage.processedChars.toLocaleString()} / 计划 {result.coverage.plannedChars.toLocaleString()} 字</span>
              {result.coverage.truncated && <span className="text-amber">超出单元上限，后面未处理</span>}
              {result.aborted && <span className="text-amber">已中止（已完成部分有效）</span>}
            </div>
            {result.coverage.failedUnits > 0 && (
              <div className="text-10 text-ink-500">
                失败单元不代表"这一章没有可分析的写法"——只是这次没跑成；可点「只重试失败的单元」。
              </div>
            )}
          </section>
        )}

        {groups.length > 0 && (
          <div className="space-y-3">
            {groups.map(([dim, cards]) => (
              <section key={dim}>
                <h3 className="text-12 font-semibold text-ink-200 mb-1.5 flex items-center gap-2">
                  <span className="w-1 h-3.5 bg-amber rounded-full" />
                  {DIM_LABEL.get(dim) ?? dim}（{cards.length}）
                </h3>
                <ul className="space-y-1.5">
                  {cards.slice(0, 30).map(c => (
                    <li key={c.id} className="rounded-lg border border-ink-700/60 bg-ink-900/40 px-3 py-2 text-11">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-ink-100 font-medium">{c.title}</span>
                        <span className="text-10 text-ink-500">{c.chapterTitle}</span>
                        <span className={`text-10 ${c.claim === 'observed' ? 'text-success' : 'text-amber'}`}
                          title={c.claim === 'observed' ? '有原文依据（引文已在原文里逐字命中）' : '推测：没有原文依据，不能当成事实'}>
                          {c.claim === 'observed' ? '有依据' : '推测'}
                        </span>
                      </div>
                      <div className="mt-0.5 text-ink-300 leading-relaxed whitespace-pre-wrap">{c.content}</div>
                      {c.evidence && (
                        <div className="mt-1 text-10 text-ink-500 whitespace-pre-wrap">
                          〔{c.evidence.quote}〕
                          {!c.evidence.verified && <span className="ml-1 text-amber">（未在原文中命中，已降级为推测）</span>}
                        </div>
                      )}
                    </li>
                  ))}
                  {cards.length > 30 && <li className="text-10 text-ink-600">…另有 {cards.length - 30} 张未展开展示（保存为成果后可完整查看）</li>}
                </ul>
              </section>
            ))}
          </div>
        )}

        {aggTask?.status === 'failed' && (
          <div role="alert" className="text-11 text-danger">跨章归纳失败：{aggTask.error || '未知原因'}</div>
        )}
        {aggregate && aggregate.cards.length > 0 && (
          <section className="rounded-xl border border-amber/30 bg-amber/5 px-3 py-2.5 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-12 font-semibold text-ink-100">跨章归纳</span>
              <span className="text-10 text-ink-500">材料只用了已生成的卡片摘要（{aggregate.materialChars.toLocaleString()} 字），没有重送原文</span>
            </div>
            {aggGroups.map(([dim, cards]) => (
              <div key={dim}>
                <div className="text-11 text-ink-200 mb-1">{AGG_LABEL.get(dim as AggregateCard['dimension']) ?? dim}</div>
                <ul className="space-y-1">
                  {cards.map(c => (
                    <li key={c.id} className="text-11 leading-relaxed">
                      <span className="text-ink-100">{c.title}</span>
                      <span className={`ml-1.5 text-10 ${c.basisVerified ? 'text-success' : 'text-amber'}`}
                        title={c.basisVerified ? '依据章名都能对上下面的分析范围' : '有依据章名对不上分析范围，已按推测处理'}>
                        {c.basisVerified ? '有依据' : '依据待核'}
                      </span>
                      <div className="text-ink-300 whitespace-pre-wrap">{c.content}</div>
                      {c.basis.length > 0 && <div className="text-10 text-ink-500">依据：{c.basis.join('、')}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}

        {result && result.cards.length === 0 && result.coverage.completedUnits > 0 && (
          <div className="text-11 text-ink-500">
            这一次没有产出卡片 —— 可能是维度选得太窄，或模型没有按格式回答；可以换维度重跑。
          </div>
        )}
      </div>
    </Modal>
  )
}
