/**
 * 剧情候选（3.6.0 · F 包首期界面）
 *
 * 规划 §6 / §16 F：首版候选**只在创意写作页**展示与保存；应用目标限定为
 * 「已有章节细纲卡的字段」，每个字段分别列旧值与新值，确认时重读比较，
 * 部分失败如实展示，撤销只在能核验目标未变时提供。
 */
import { useEffect, useMemo, useState } from 'react'
import { GitBranch, Loader2, RefreshCw, Undo2, X } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'
import { getCurrentProjectId } from '@/lib/db/core'
import * as db from '@/lib/db'
import { OUTLINE_TAB, type PlotCandidate } from '@/lib/creative/plotCandidates'
import {
  applyPlotCandidate, discardPlotCandidate, generatePlotCandidates, loadPlotCandidates,
  outlineFieldKeys, outlineFingerprintNow, reportLines, revertPlotCandidate,
} from '@/lib/creative/plotCandidateStore'
import { chapterNoOf } from '@/lib/outline/outlineCard'
import type { CardRecord } from '@/lib/types'

function fmt(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const STATUS_LABEL: Record<PlotCandidate['status'], string> = {
  pending: '待应用',
  applied: '已应用',
  partial: '部分应用',
  discarded: '已放弃',
  stale: '已过期',
}

export default function PlotCandidatePanel({ onClose }: { onClose: () => void }) {
  const [cards, setCards] = useState<CardRecord[] | null>(null)
  const [cardId, setCardId] = useState('')
  const [cands, setCands] = useState<PlotCandidate[]>([])
  const [keysInfo, setKeysInfo] = useState<{ resolved: { slot: string; key: string; label: string }[]; missing: { slot: string; reason: string }[] } | null>(null)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [lastReport, setLastReport] = useState<string[]>([])

  const pid = getCurrentProjectId()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const all = await db.getCardRecords(OUTLINE_TAB).catch(() => [])
      const sorted = [...all].sort((a, b) => chapterNoOf(a.name) - chapterNoOf(b.name))
      if (cancelled) return
      setCards(sorted)
      if (sorted.length && !cardId) setCardId(sorted[sorted.length - 1].id)
      const loaded = await loadPlotCandidates(pid)
      if (cancelled) return
      setCands(loaded.list)
      if (loaded.error) setErr(loaded.error)
      const info = await outlineFieldKeys(pid)
      if (!cancelled) setKeysInfo(info)
    })()
    return () => { cancelled = true }
    // cardId 变化时单独刷新指纹
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid])

  useEffect(() => {
    if (!cardId) { setFingerprint(null); return }
    let cancelled = false
    void outlineFingerprintNow(pid, cardId).then(fp => { if (!cancelled) setFingerprint(fp) })
    return () => { cancelled = true }
  }, [cardId, pid, cands.length])

  const mine = useMemo(() => cands.filter(c => c.outlineCardId === cardId), [cands, cardId])
  const canWrite = (keysInfo?.resolved.length ?? 0) > 0

  const generate = async () => {
    if (!cardId) { showToast('先选一张章节细纲卡', 'info'); return }
    setBusy(true)
    setErr('')
    setLastReport([])
    try {
      const r = await generatePlotCandidates(pid, cardId)
      if (!r.ok) { setErr(r.error ?? '生成失败'); return }
      showToast(`已生成 ${r.created} 条候选（只保存候选，细纲未改动）`, 'success')
      setCands((await loadPlotCandidates(pid)).list)
    } finally {
      setBusy(false)
    }
  }

  const apply = async (c: PlotCandidate) => {
    const r = await applyPlotCandidate(pid, c.id)
    setLastReport(reportLines(r.report))
    setCands((await loadPlotCandidates(pid)).list)
    if (r.ok) showToast(`已写入 ${r.report.okCount} 个字段`, 'success')
    else setErr(r.error ?? '没有写入任何字段')
  }

  const revert = async (c: PlotCandidate) => {
    const r = await revertPlotCandidate(pid, c.id)
    setCands((await loadPlotCandidates(pid)).list)
    if (r.ok) { showToast(`已撤销 ${r.reverted} 个字段`, 'success'); setLastReport([]) }
    else {
      setErr(r.error ?? '撤销失败')
      setLastReport(r.blocked.map(b => `${b.label}：当前「${b.current}」，应用后应为「${b.expected}」`))
    }
  }

  const discard = async (c: PlotCandidate) => {
    const ok = await discardPlotCandidate(pid, c.id, '作者在面板里放弃')
    if (ok) { setCands((await loadPlotCandidates(pid)).list); showToast('已放弃（保留记录）', 'info') }
  }

  return (
    <Modal open onClose={onClose} title="剧情候选（只改细纲字段）" icon={<GitBranch size={16} />}
      width={820} maxHeight="84vh"
      footer={<>
        <span className="text-10 text-ink-500">
          不建卷/章、不改正文与设定；只对已有细纲卡的字段做条件写入，确认时重读比较。
        </span>
        <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
      </>}>
      <div className="space-y-3">
        {!canWrite && keysInfo && (
          <div className="rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-11 text-amber">
            当前模板里解析不到可写的细纲字段（{keysInfo.missing.map(m => `${m.slot}:${m.reason === 'ambiguous' ? '映射不唯一' : '未找到'}`).join('；')}）
            —— 按规划口径，这种情况**只保存候选供参考，不提供应用**。
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={cardId}
            onChange={e => { setCardId(e.target.value); setErr(''); setLastReport([]) }}
            className="text-11 px-2 py-1 rounded-lg bg-ink-900 border border-ink-700 text-ink-100 outline-none">
            {(cards ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            {cards !== null && cards.length === 0 && <option value="">（项目里还没有章节细纲卡）</option>}
          </select>
          <Button variant="primary" solid size="sm" disabled={busy || !cardId} onClick={() => void generate()}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <GitBranch size={12} />} 生成 2~3 条候选
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void loadPlotCandidates(pid).then(r => { setCands(r.list); if (r.error) setErr(r.error) })}>
            <RefreshCw size={12} /> 重新读取
          </Button>
          {busy && <span className="text-10 text-ink-500">生成中（只保存候选，不动细纲）…</span>}
        </div>

        {err !== '' && <div role="alert" className="text-11 text-danger">{err}</div>}

        {lastReport.length > 0 && (
          <section className="rounded-lg border border-ink-700 bg-ink-900/50 px-3 py-2">
            <div className="text-11 text-ink-200 mb-1">本次逐字段结果</div>
            <ul className="space-y-0.5">{lastReport.map((l, i) => <li key={i} className="text-10 text-ink-400">{l}</li>)}</ul>
          </section>
        )}

        {mine.length === 0 && keysInfo?.resolved.length ? (
          <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-6 text-center text-12 text-ink-500">
            这张细纲卡还没有候选。点「生成 2~3 条候选」—— 生成只保存候选，不会改细纲。
          </div>
        ) : null}

        <ul className="space-y-2">
          {mine.map(c => {
            const stale = fingerprint !== null && c.outlineFingerprint !== fingerprint
            const shown = stale ? 'stale' as const : c.status
            const disabled = busy || stale || c.status === 'applied' || c.status === 'discarded' || !canWrite
            return (
              <li key={c.id} data-plot-candidate={c.id}
                className="rounded-xl border border-ink-700/60 bg-ink-900/40 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-12 font-medium text-ink-100">{c.title}</span>
                  <span className="text-10 text-ink-500">第 {c.chapterNo} 章</span>
                  <span className={`text-10 ${shown === 'stale' ? 'text-amber' : shown === 'applied' ? 'text-success' : 'text-ink-400'}`}>
                    {STATUS_LABEL[shown]}
                  </span>
                  <span className="ml-auto text-10 text-ink-500 tabular-nums">{fmt(c.createdAt)}</span>
                </div>
                <div className="mt-0.5 text-11 text-ink-300">分歧点：{c.branchPoint}</div>
                {c.rationale && <div className="mt-0.5 text-10 text-ink-500">{c.rationale}</div>}

                <ul className="mt-1.5 space-y-1">
                  {c.fields.map(f => (
                    <li key={f.key} className="text-11 leading-relaxed">
                      <span className="text-ink-400">{f.label}：</span>
                      <span className="text-ink-500 line-through">{f.before || '（空）'}</span>
                      <span className="mx-1 text-ink-600">→</span>
                      <span className="text-ink-100">{f.after}</span>
                      <span className="ml-1 text-10 text-ink-600">（{f.source}）</span>
                    </li>
                  ))}
                </ul>

                {c.applyReport && c.status !== 'applied' && (
                  <div className="mt-1.5 text-10 text-ink-500">
                    上次应用：成功 {c.applyReport.okCount} / 跳过 {c.applyReport.skippedCount}
                    {c.applyReport.error ? ` · ${c.applyReport.error}` : ''}
                  </div>
                )}
                {stale && (
                  <div className="mt-1 text-10 text-amber">
                    细纲在这条候选生成后被改过，已禁止应用（避免覆盖你的修改）；需要的话重新生成。
                  </div>
                )}

                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <Button variant="secondary" size="sm" disabled={disabled} onClick={() => void apply(c)}
                    title={disabled ? '当前状态不可应用（过期 / 已应用 / 已放弃 / 字段不可写）' : '逐字段核对当前值后写入'}>
                    应用到细纲
                  </Button>
                  {c.status === 'applied' || c.status === 'partial' ? (
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void revert(c)}
                      title="只在字段仍等于应用后的值时才回滚">
                      <Undo2 size={11} /> 撤销
                    </Button>
                  ) : null}
                  <Button variant="secondary" size="sm" disabled={busy || c.status === 'discarded'} onClick={() => void discard(c)}>
                    <X size={11} /> 放弃
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </Modal>
  )
}
