/**
 * 3.2.0 · W3 候选审阅面板（「创作轨迹」入口）
 *
 * 🔴 为什么需要这块界面：候选的存储（256 KiB 拒绝不截断、回读校验、配额）与
 *    应用内核（条件提交 → 记意图 → 严格写盘 → 回读比对 → 回执 → 崩溃恢复）
 *    全部就绪，但**作者看不见它们** —— 那就等于没有。
 *
 * 三条界面纪律（改之前先读）：
 *   ① **不做二次确认弹窗**：项目禁原生 `confirm`。放弃走「点一下变确认态」的内联二段按钮。
 *   ② **失败要说清原因码**：不把 `stale` / `readback-mismatch` 一律显示成「失败」——
 *      作者需要知道是"正文被改过"还是"写盘出问题"，两者的下一步完全不同。
 *   ③ **应用后不自动重跑**：沿用 `isSuspectRewrite` 的克制口径，由作者决定。
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, FileDiff, Loader2, RefreshCw, Trash2, X } from 'lucide-react'
import * as db from '@/lib/db'
import { Button } from '@/components/common/Button'
import { Z } from '@/lib/app/zLayer'
import { foldVh } from '@/lib/settings/theme'
import { listProjectCandidates } from '@/lib/revision/candidateStore'
import { saveCandidate } from '@/lib/revision/candidateStore'
import { runApplyCandidate } from '@/lib/revision/candidateRunner'
import { discardCandidate } from '@/lib/revision/revisionCommit'
import { diffStats, type RevisionDiffStats } from '@/lib/revision/revisionDiff'
import type { RevisionCandidate, RevisionCandidateStatus } from '@/lib/revision/revisionCandidate'
import { countWords } from '@/lib/editor/textStats'

const STATUS_LABEL: Record<RevisionCandidateStatus, { text: string; cls: string }> = {
  pending: { text: '待审阅', cls: 'text-info' },
  applying: { text: '上次中断', cls: 'text-warn' },
  applied: { text: '已应用', cls: 'text-success' },
  stale: { text: '已过期', cls: 'text-ink-400' },
  discarded: { text: '已放弃', cls: 'text-ink-500' },
  'needs-reconcile': { text: '需人工核对', cls: 'text-danger' },
}

/** 失败原因码 → 作者看得懂的一句（含「下一步」） */
function failureText(code: string, detail: string): string {
  const hint: Record<string, string> = {
    state: '这份候选当前状态不允许应用，请重新生成。',
    stale: '这一章在你产出后又被改动过 —— 直接替换会覆盖你的编辑，已停止。请重新生成改写结果。',
    'write-failed': '写盘失败，正文没有被改动。可以重试一次；仍失败请检查磁盘与项目状态。',
    'readback-mismatch': '写下去和读回来的内容不一致，已停止（绝不当作成功）。请重试，或重启后回来核对。',
    'needs-reconcile': '上次可能中断过，且正文既不是改前也不是改后 —— 需要你人工确认后再处理。',
  }
  return hint[code] ? `${hint[code]}（${detail}）` : detail
}

function fmt(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function CandidatePanel({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<RevisionCandidate[] | null>(null)
  const [err, setErr] = useState('')
  const [busyId, setBusyId] = useState('')
  const [confirmId, setConfirmId] = useState('')
  const [note, setNote] = useState<{ id: string; ok: boolean; text: string } | null>(null)
  const [titles, setTitles] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      const pid = db.getCurrentProjectId() ?? ''
      const [list, chs] = await Promise.all([listProjectCandidates(pid, { onlyReviewable: true }), db.getAllChapters()])
      const map: Record<string, string> = {}
      for (const c of chs) map[c.id] = c.title
      setTitles(map)
      setRows(list)
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setRows([])
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const apply = useCallback(async (c: RevisionCandidate) => {
    setBusyId(c.id)
    setNote(null)
    try {
      const r = await runApplyCandidate(c)
      if (r.ok) {
        const d: RevisionDiffStats = r.diff
        setNote({
          id: c.id, ok: true,
          text: r.resumed
            ? `上次已经写过，这次只补回了回执（新增 ${d.added} / 删去 ${d.removed} / 改动 ${d.changed}）`
            : `已应用（新增 ${d.added} / 删去 ${d.removed} / 改动 ${d.changed}）`,
        })
      } else {
        setNote({ id: c.id, ok: false, text: failureText(r.code, r.detail) })
      }
    } catch (e) {
      setNote({ id: c.id, ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusyId('')
      await load()
    }
  }, [load])

  const discard = useCallback(async (c: RevisionCandidate) => {
    setBusyId(c.id)
    try {
      const r = discardCandidate(c, '作者在候选审阅里放弃')
      if (r.ok && r.candidate) await saveCandidate(r.candidate)
      setNote({ id: c.id, ok: true, text: '已放弃，正文没有任何改动。' })
      setConfirmId('')
    } finally {
      setBusyId('')
      await load()
    }
  }, [load])

  return (
    <div className="fixed inset-0 flex items-center justify-center p-6 bg-ink-950/70 backdrop-blur-sm" style={{ zIndex: Z.modal }}>
      <div
        className="w-full max-w-[720px] flex flex-col rounded-2xl bg-ink-850 border border-ink-700 shadow-2xl overflow-hidden"
        style={{ maxHeight: foldVh('80vh') }}
      >
        <div className="px-6 py-4 border-b border-ink-700/70 flex items-center gap-2">
          <FileDiff size={16} className="text-amber" />
          <div className="text-14 font-semibold text-ink-50">候选审阅</div>
          <div className="text-11 text-ink-500">AI 产出、等你决定的稿子</div>
          <button onClick={onClose} className="ml-auto text-ink-400 hover:text-ink-100" title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {rows === null && (
            <div className="flex items-center justify-center py-10 gap-2 text-ink-400">
              <Loader2 size={18} className="animate-spin text-amber" />
              <span className="text-13">读取中…</span>
            </div>
          )}
          {rows !== null && err !== '' && <div className="text-12 text-danger py-4">读取失败：{err}</div>}
          {rows !== null && err === '' && rows.length === 0 && (
            <div className="text-13 text-ink-500 py-8 text-center">
              还没有待审阅的候选。
              <div className="text-11 mt-1.5">跑一次「整章改写」后，产出的稿子会先放在这里等你决定。</div>
            </div>
          )}

          {rows !== null && rows.length > 0 && (
            <ul className="space-y-2.5">
              {rows.map(c => {
                const st = STATUS_LABEL[c.status]
                const before = countWords(c.beforeText)
                const after = countWords(c.text)
                const title = c.chapterId ? (titles[c.chapterId] ?? '（这一章已不在项目里）') : '（未记录章节）'
                const d = diffStats(c.beforeText, c.text)
                const busy = busyId === c.id
                return (
                  <li key={c.id} className="rounded-xl bg-ink-900/50 border border-ink-700/60 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-11 px-1.5 py-0.5 rounded bg-ink-800 ${st.cls}`}>{st.text}</span>
                      <span className="text-13 text-ink-100 truncate">{title}</span>
                      <span className="ml-auto text-10 text-ink-500 tabular-nums shrink-0">{fmt(c.createdAt)}</span>
                    </div>
                    <div className="mt-1 text-11 text-ink-400">
                      {c.summary || '（无摘要）'}
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-11 text-ink-500 tabular-nums">
                      <span>{before} → {after} 字</span>
                      <span title="与原文逐行比对">+{d.added} / −{d.removed} / ~{d.changed}</span>
                      {c.staleReasons?.length ? <span title={c.staleReasons.join('；')}>{c.staleReasons.length} 条过期原因</span> : null}
                    </div>

                    {note?.id === c.id && (
                      <div className={`mt-2 text-11 ${note.ok ? 'text-success' : 'text-danger'}`}>{note.text}</div>
                    )}

                    <div className="mt-2.5 flex items-center gap-2">
                      {c.status === 'pending' || c.status === 'applying' || c.status === 'needs-reconcile' ? (
                        <>
                          <Button variant="primary" size="sm" disabled={busy} onClick={() => void apply(c)}>
                            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                            应用到正文
                          </Button>
                          {confirmId === c.id ? (
                            <>
                              <Button variant="danger" size="sm" disabled={busy} onClick={() => void discard(c)}>
                                <Trash2 size={13} /> 确认放弃
                              </Button>
                              <button className="text-11 text-ink-400 hover:text-ink-100" onClick={() => setConfirmId('')}>
                                取消
                              </button>
                            </>
                          ) : (
                            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmId(c.id)}>
                              <Trash2 size={13} /> 放弃
                            </Button>
                          )}
                        </>
                      ) : (
                        <span className="text-11 text-ink-500">这条已处理完，正文不会再被它改动。</span>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="px-6 py-3 border-t border-ink-700/70 flex items-center gap-2">
          <span className="text-10 text-ink-500">
            应用前会先比对正文：若这一章在你产出后又被改过，会直接拒绝，不会覆盖你的编辑。
          </span>
          <Button variant="secondary" size="sm" className="ml-auto" onClick={() => void load()}>
            <RefreshCw size={13} /> 刷新
          </Button>
        </div>
      </div>
    </div>
  )
}
