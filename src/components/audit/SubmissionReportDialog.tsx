/**
 * 投稿体检 · 一页汇总（3.7.0 · W6）
 *
 * 🔴 本页**不跑任何检查**：只汇总已有结果；没有的写「未跑」。
 * 立场：不做全书等级、不做潜力量化；开篇结论引用 AI 原话并注明仅供参考。
 */
import { useEffect, useMemo, useState } from 'react'
import { FileCheck2 } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { copyText } from '@/components/dialogs/dialogs'
import * as db from '@/lib/db'
import { sortChapters, chapterSeqMap } from '@/lib/outline/chapterSeq'
import { computePaceSeries } from '@/lib/outline/paceMetrics'
import { buildTicket } from '@/lib/app/optimizeTicket'
import { buildSubmissionReport, submissionReportJson, type SubmissionReport } from '@/lib/audit/submissionReport'
import { readOpeningSnapshot } from '@/lib/audit/openingSnapshot'
import type { Chapter, Volume, TableRow } from '@/lib/types'

export default function SubmissionReportDialog({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<SubmissionReport | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [chs, vols, hooks, tickets, opening] = await Promise.all([
          db.getAllChapters().catch(() => [] as Chapter[]),
          db.getAllVolumes().catch(() => [] as Volume[]),
          db.getTableRows('hookpoints').catch(() => [] as TableRow[]),
          buildTicket().catch(() => []),
          readOpeningSnapshot(db.getCurrentProjectId()).catch(() => null),
        ])
        const sorted = sortChapters(vols, chs)
        const seq = chapterSeqMap(vols, chs)
        const series = computePaceSeries(
          sorted.map(c => ({ id: c.id, no: seq.get(c.id) ?? 0, title: c.title || '', content: c.content ?? '' })),
          hooks.map(r => {
            const no = Number(String(r.data['章节号'] ?? '').match(/(\d+)/)?.[1] ?? 0)
            return { chapterNo: no, strength: String(r.data['爽点强度'] ?? '') }
          }),
        )
        if (cancelled) return
        const lines = series.observations.length ? series.observations : ['还没有可统计的正文。']
        setReport(buildSubmissionReport({
          ...(opening ? { opening: { conclusion: opening.conclusion, at: opening.at, source: opening.source } } : {}),
          body: { lines, at: Date.now() },
          todo: { tickets, at: Date.now() },
        }))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const json = useMemo(() => (report ? submissionReportJson(report) : ''), [report])

  return (
    <Modal open onClose={onClose} title="投稿体检" icon={<FileCheck2 size={16} />} width={760} maxHeight="80vh"
      footer={<>
        <span className="text-10 text-ink-500">只汇总已跑过的结论；「未跑」不等于通过。</span>
        <Button variant="secondary" size="sm" disabled={!report} onClick={() => void copyText(json, '体检 JSON 已复制')}>
          复制 JSON
        </Button>
      </>}>
      <div data-submission-report>
        {loading && <div className="py-8 text-center text-12 text-ink-400">读取中…</div>}
        {!loading && report && (
          <div className="space-y-2.5">
            {report.sections.map(s => (
              <section key={s.key} data-report-section={s.key} data-report-state={s.state}
                className={`rounded-xl border px-4 py-3 ${s.state === 'ran' ? 'border-ink-700 bg-ink-900/50' : 'border-ink-700/60 bg-ink-900/25'}`}>
                <div className="flex items-center gap-2">
                  <span className="text-12 text-ink-100">{s.title}</span>
                  <span className={`text-10 px-1.5 py-0.5 rounded border ${s.state === 'ran' ? 'border-success/30 text-success bg-success/10' : 'border-ink-600 text-ink-400 bg-ink-800'}`}>
                    {s.state === 'ran' ? '有结果' : '未跑'}
                  </span>
                  <span className="ml-auto text-10 text-ink-500">来源：{s.source}{s.at ? ` · ${new Date(s.at).toLocaleString()}` : ''}</span>
                </div>
                <ul className="mt-1 space-y-0.5">
                  {s.lines.map((line, i) => <li key={i} className="text-11 text-ink-300 leading-relaxed">{line}</li>)}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}