/**
 * 作品分析（只分析，不写入项目）—— 3.6.0 · B 包首期界面
 *
 * 定位（规划 §4）：给「外部参考作品」与「先摸清写法再决定要不要拆」两种场景用。
 * 🔴 它**不写正文、不写设定、不建关系**：产物只有分析卡，作者点「保存为成果」后才以
 *    `state: 'draft'` 进入 A1 的作者成果（可审阅、可导出、可清理），永远不会自动进正文。
 *
 * 交付边界（如实）：
 *  · 本版**未接任务中心**：关掉弹窗即中止，已完成的单元不会丢（再次开始会按单元键复用）；
 *  · 长文请一次跑完，界面会显示单元进度与覆盖统计。
 */
import { useMemo, useState } from 'react'
import { BookOpenCheck, Loader2, Save, Square } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'
import {
  ANALYSIS_DIMENSIONS, analysisCardsToArtefacts, analyzeBook,
  type AnalysisDimension, type AnalysisResult,
} from '@/lib/bookbreak/analysis'
import { loadArtefacts, saveArtefacts, withUpserted } from '@/lib/artefacts/store'
import { getCurrentProjectId } from '@/lib/db/core'

const DIM_LABEL = new Map(ANALYSIS_DIMENSIONS.map(d => [d.id, d.label]))

export default function BookAnalysisDialog({ onClose }: { onClose: () => void }) {
  const [raw, setRaw] = useState('')
  const [dims, setDims] = useState<AnalysisDimension[]>(ANALYSIS_DIMENSIONS.map(d => d.id))
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [abort, setAbort] = useState<AbortController | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [saving, setSaving] = useState(false)

  const failedUnits = useMemo(
    () => (result?.units ?? []).filter(u => u.state === 'failed').map(u => u.index),
    [result],
  )

  const run = async (opts: { previous?: AnalysisResult; retryUnits?: number[] } = {}) => {
    if (!raw.trim()) { showToast('请先粘贴要分析的原文', 'info'); return }
    if (!dims.length) { showToast('至少选一个分析维度', 'info'); return }
    const ctl = new AbortController()
    setAbort(ctl)
    setRunning(true)
    setProgress('准备切分…')
    try {
      const res = await analyzeBook(raw, {
        dimensions: dims,
        signal: ctl.signal,
        ...(opts.previous ? { previous: opts.previous } : {}),
        ...(opts.retryUnits?.length ? { retryUnits: opts.retryUnits } : {}),
        onProgress: p => setProgress(`${p.label}（${p.done}/${p.total}）`),
      })
      setResult(res)
      const c = res.coverage
      showToast(
        `分析${res.aborted ? '已中止' : '完成'}：${c.completedUnits}/${c.plannedUnits} 个单元，${res.cards.length} 张卡`
        + (c.failedUnits ? `；${c.failedUnits} 个单元失败` : '')
        + (c.truncated ? '；超出上限的部分未处理' : ''),
        c.failedUnits ? 'error' : 'success', 6000,
      )
    } catch (e) {
      showToast('分析失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally {
      setRunning(false)
      setAbort(null)
      setProgress('')
    }
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
      showToast(`已保存 ${records.length} 张分析卡为成果（草稿，可在成果里审阅/清理）`, 'success', 6000)
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

  return (
    <Modal open onClose={() => { abort?.abort(); onClose() }} title="作品分析（只分析，不写入项目）"
      icon={<BookOpenCheck size={16} />} width={820} maxHeight="86vh"
      footer={<>
        <span className="text-10 text-ink-500">只产出分析卡：不改正文、不建设定、不建关系；保存为成果后才进项目包。</span>
        <Button variant="secondary" size="sm" onClick={() => { abort?.abort(); onClose() }}>关闭</Button>
      </>}>
      <div className="space-y-3">
        <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2 text-11 text-ink-400 leading-relaxed">
          适合两类场景：① 外部参考作品——只想学写法，<b className="text-ink-200">不希望原文进你的项目</b>；
          ② 先摸清结构再决定要不要一键拆书。分析只读原文，不落任何正式数据。
        </div>

        <label className="block">
          <span className="text-11 text-ink-400">原文（粘贴或从文件读入后粘贴；{raw.length.toLocaleString()} 字）</span>
          <textarea
            value={raw}
            onChange={e => setRaw(e.target.value)}
            placeholder="把要分析的作品粘贴到这里（支持多章；识别不到章节标题时按字数分块）"
            className="mt-1 w-full text-11 px-2 py-1.5 rounded-lg bg-ink-900 border border-ink-700 text-ink-100 outline-none focus:border-amber/50 h-40 resize-none"
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
                  <input type="checkbox" className="hidden" checked={on}
                    onChange={() => setDims(prev => prev.includes(d.id) ? prev.filter(x => x !== d.id) : [...prev, d.id])} />
                  {d.label}
                </label>
              )
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" solid size="md" disabled={running || !raw.trim()} onClick={() => void run()}>
            {running ? <Loader2 size={13} className="animate-spin" /> : <BookOpenCheck size={13} />}
            {running ? '分析中…' : result ? '重新分析（复用已完成单元）' : '开始分析'}
          </Button>
          {running && (
            <Button variant="secondary" size="md" onClick={() => abort?.abort()}>
              <Square size={12} /> 中止
            </Button>
          )}
          {running && <span className="text-10 text-ink-500">{progress}</span>}
          {!running && failedUnits.length > 0 && result && (
            <Button variant="secondary" size="md"
              onClick={() => void run({ previous: result, retryUnits: failedUnits })}>
              只重试失败的 {failedUnits.length} 个单元
            </Button>
          )}
          {!running && result && result.cards.length > 0 && (
            <Button variant="secondary" size="md" disabled={saving} onClick={() => void saveAsArtefact()}>
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} 保存为成果（草稿）
            </Button>
          )}
        </div>

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

        {result && result.cards.length === 0 && result.coverage.completedUnits > 0 && (
          <div className="text-11 text-ink-500">
            这一次没有产出卡片 —— 可能是维度选得太窄，或模型没有按格式回答；可以换维度重跑。
          </div>
        )}
      </div>
    </Modal>
  )
}
