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
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Check, FileDiff, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Modal } from '@/components/dialogs/Modal'
import { candidateApplyContext } from '@/lib/ai/candidateContext'
import { getStorageContextEpoch, subscribeStorageContext } from '@/lib/storage/contextEpoch'
import { useRevisionRead } from './useRevisionRead'
import RevisionTextPreview from './RevisionTextPreview'
import { captureOwnedOperation } from '@/lib/storage/ownedOperation'
import { serializeRevision } from '@/lib/revision/revisionOperation'
import { listProjectCandidates } from '@/lib/revision/candidateStore'
import { saveCandidate, loadCandidate, sameCandidateRevision } from '@/lib/revision/candidateStore'
import { runApplyCandidate } from '@/lib/revision/candidateRunner'
import { discardCandidate } from '@/lib/revision/revisionCommit'
import { diffStats, type RevisionDiffStats } from '@/lib/revision/revisionDiff'
import type { RevisionCandidate, RevisionCandidateStatus } from '@/lib/revision/revisionCandidate'
import { countWords } from '@/lib/editor/textStats'

const STATUS_LABEL: Record<RevisionCandidateStatus, { text: string; cls: string }> = {
  pending: { text: '待审阅', cls: 'text-info' },
  applying: { text: '上次中断', cls: 'text-amber' },
  applied: { text: '已应用', cls: 'text-success' },
  stale: { text: '已过期', cls: 'text-ink-400' },
  discarded: { text: '已放弃', cls: 'text-ink-500' },
  'needs-reconcile': { text: '需人工核对', cls: 'text-danger' },
}

/** 失败原因码 → 作者看得懂的一句（含「下一步」） */
function failureText(code: string): string {
  const hint: Record<string, string> = {
    state: '这份候选已变化或当前不能应用，请刷新并核对后再决定是否重新生成。',
    stale: '这一章在你产出后又被改动过 —— 直接替换会覆盖你的编辑，已停止。请重新生成改写结果。',
    'write-failed': '未能确认写入成功，已停止。请检查磁盘与项目状态，并核对当前正文后重试。',
    'readback-mismatch': '写下去和读回来的内容不一致，已停止（绝不当作成功）。请重试，或重启后回来核对。',
    'needs-reconcile': '应用过程尚未完成核对，请先查看当前正文，再重试或人工处理。',
  }
  return hint[code] ?? '未能确认应用结果。请检查存储状态，并核对当前正文与候选后再处理。'
}

function fmt(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function CandidatePanel({ onClose }: { onClose: () => void }) {
  useSyncExternalStore(subscribeStorageContext, getStorageContextEpoch)
  return <CandidateWorkspace key={candidateApplyContext()} onClose={onClose} />
}

function CandidateWorkspace({ onClose }: { onClose: () => void }) {
  const [showAll, setShowAll] = useState(false)
  const read = useCallback((pid: string) => listProjectCandidates(pid, { onlyReviewable: !showAll }), [showAll])
  const { rows, titles, err, reading, load, current } = useRevisionRead(read)
  const [busyId, setBusyId] = useState('')
  const busyRef = useRef(false)
  const [confirmId, setConfirmId] = useState('')
  const [note, setNote] = useState<{ id: string; ok: boolean; partial?: boolean; text: string; facts?: string } | null>(null)

  useEffect(() => { void load() }, [load])

  const apply = useCallback(async (c: RevisionCandidate) => {
    if (!current() || busyRef.current || reading || err) return
    busyRef.current = true
    setBusyId(c.id)
    setNote(null)
    try {
      const r = await runApplyCandidate(c)
      if (!current()) return
      if (r.ok) {
        const d: RevisionDiffStats = r.diff
        const unconfirmed = r.invalidated.length - r.invalidatedSaved
        setNote({
          id: c.id, ok: true, partial: unconfirmed > 0,
          text: (r.resumed
            ? `上次已经写过，这次只补回了回执（新增 ${d.added} / 删去 ${d.removed} / 改动 ${d.changed}）`
            : `已应用（新增 ${d.added} / 删去 ${d.removed} / 改动 ${d.changed}）`)
            + (unconfirmed > 0 ? `。另有 ${unconfirmed} 份同批候选未能确认标记过期，请刷新后逐条核对；正文已应用，不要重复替换。` : ''),
          // 实体保留自检（WQ8 方案 A）：只报告不判定，跑不成就没有这句
          facts: r.facts?.summary,
        })
      } else {
        setNote({ id: c.id, ok: false, text: failureText(r.code) })
      }
    } catch {
      if (current()) setNote({ id: c.id, ok: false, text: '未能确认应用结果。请检查存储状态，并核对当前正文与候选后再处理。' })
    } finally {
      busyRef.current = false
      if (current()) { setBusyId(''); await load() }
    }
  }, [load, current, reading, err])

  const discard = useCallback(async (c: RevisionCandidate) => {
    if (!current() || busyRef.current || reading || err) return
    busyRef.current = true
    setBusyId(c.id)
    try {
      const owner = captureOwnedOperation(c.projectId)
      await serializeRevision(candidateApplyContext(), c.chapterId ?? c.id, async () => {
        owner.assertCurrent()
        const latest = await loadCandidate(c.id, owner)
        if (!latest || !sameCandidateRevision(c, latest)) throw new Error('候选已变化或不存在。')
        const r = discardCandidate(latest, '作者在候选审阅里放弃')
        if (!r.ok || !r.candidate) throw new Error('当前状态不能放弃，请刷新后核对。')
        const saved = await saveCandidate(r.candidate, owner, latest)
        if (!saved.ok) throw new Error(saved.detail)
      })
      if (!current()) return
      setNote({ id: c.id, ok: true, text: '已放弃，正文没有任何改动。' })
      setConfirmId('')
    } catch {
      if (current()) setNote({ id: c.id, ok: false, text: '未能确认放弃状态已保存。请检查存储状态并刷新核对，再决定是否重试；不会自动重复操作。' })
    } finally {
      busyRef.current = false
      if (current()) { setBusyId(''); await load() }
    }
  }, [load, current, reading, err])

  return (
    <Modal open onClose={onClose} title="候选审阅" icon={<FileDiff size={16} />} width={720} maxHeight="80vh"
      footer={<><span className="text-10 text-ink-500">应用前会先比对正文，已改动的原稿不会被旧候选直接覆盖。</span>
        <Button variant="secondary" size="sm" disabled={reading || !!busyId} onClick={() => void load()}><RefreshCw size={13} /> 重试读取</Button></>}>
        <div data-revision-candidates>
          <div className="mb-3 flex flex-wrap gap-2">
            <Button variant="toggle" size="sm" selected={!showAll} disabled={!!busyId} onClick={() => setShowAll(false)}>待处理候选</Button>
            <Button variant="toggle" size="sm" selected={showAll} disabled={!!busyId} onClick={() => setShowAll(true)}>全部留档</Button>
          </div>
          {/*
            🔴 结果提示放在**列表外面**（3.2.0 实机 2026-10-21 发现）：
               原先它渲染在对应条目的 <li> 里，而应用成功后 `load()` 会把这条从
               待审阅列表里移走 —— 提示跟着条目一起消失，作者只看到面板变空，
               根本不知道"到底应用成功了没有"，只能去正文里数字数。
               放弃同理（那条也离开了列表）。提示属于"刚才发生了什么"，不该挂在条目上。
          */}
          {note && (
            <div role={note.ok && !note.partial ? 'status' : 'alert'} data-candidate-feedback={note.partial ? 'partial' : note.ok ? 'success' : 'error'} className={`mb-3 rounded-lg px-3 py-2 text-11 border ${note.partial
              ? 'text-amber bg-amber/5 border-amber/30' : note.ok ? 'text-success bg-success/5 border-success/30'
              : 'text-danger bg-danger/5 border-danger/30'}`}>
              {note.text}
              {note.ok && note.facts && (
                <div className="mt-1 text-amber" title="只是参考：改写后少提一个名字常常是正常润色，请自行判断">
                  {note.facts}
                </div>
              )}
            </div>
          )}

          {rows === null && (
            <div className="flex items-center justify-center py-10 gap-2 text-ink-400">
              <Loader2 size={18} className="animate-spin text-amber" />
              <span className="text-13">读取中…</span>
            </div>
          )}
          {err !== '' && <div role="alert" className="text-12 text-danger py-4">{err}</div>}
          {reading && rows !== null && <div role="status" className="text-11 text-ink-400 py-2">正在更新列表，暂不允许应用或放弃。</div>}
          {rows !== null && err === '' && rows.length === 0 && (
            <div className="text-13 text-ink-500 py-8 text-center">
              {showAll ? '还没有留档的候选。' : '还没有待审阅的候选。'}
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
                  <li key={c.id} data-candidate-id={c.id} data-candidate-status={c.status} className="min-w-0 rounded-xl bg-ink-900/50 border border-ink-700/60 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-11 px-1.5 py-0.5 rounded bg-ink-800 ${st.cls}`}>{st.text}</span>
                      <span className="text-13 text-ink-100 truncate">{title}</span>
                      <span className="ml-auto text-10 text-ink-500 tabular-nums shrink-0">{fmt(c.createdAt)}</span>
                    </div>
                    <div className="mt-1 text-11 text-ink-400 [overflow-wrap:anywhere]">
                      {c.summary || '（无摘要）'}
                    </div>
                    {c.staleReasons?.length ? <div className="mt-2 text-11 text-ink-400 [overflow-wrap:anywhere]">过期原因：{c.staleReasons.join('；')}。请先核对当前正文，再回到原生成入口重新生成；此处不会自动重跑。</div> : null}
                    {c.status === 'needs-reconcile' && <div className="mt-2 text-11 text-danger">上次应用未能确认。请先核对当前正文与下方完整候选；这里不会再次覆盖正文或自动重跑。</div>}
                    <RevisionTextPreview before={c.beforeText} after={c.text} />
                    <div className="mt-1.5 flex items-center gap-3 text-11 text-ink-500 tabular-nums">
                      <span>{before} → {after} 字</span>
                      <span title="与原文逐行比对">+{d.added} / −{d.removed} / ~{d.changed}</span>
                      {c.staleReasons?.length ? <span title={c.staleReasons.join('；')}>{c.staleReasons.length} 条过期原因</span> : null}
                    </div>

                    {/*
                      结果提示已提到列表外面（见上方注释）：应用成功后这条会离开列表，
                      挂在条目上的提示会跟着消失。
                    */}

                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      {c.status !== 'applied' && c.status !== 'discarded' ? (
                        <>
                          {(c.status === 'pending' || c.status === 'applying') &&
                          <Button variant="primary" size="sm" disabled={!!busyId || reading || !!err} onClick={() => void apply(c)}>
                            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                            {c.status === 'applying' ? '核对上次应用' : '应用到正文'}
                          </Button>}
                          {confirmId === c.id ? (
                            <>
                              <Button variant="danger" size="sm" disabled={!!busyId || reading || !!err} onClick={() => void discard(c)}>
                                <Trash2 size={13} /> 确认放弃
                              </Button>
                              <button className="text-11 text-ink-400 hover:text-ink-100" onClick={() => setConfirmId('')}>
                                取消
                              </button>
                            </>
                          ) : (
                            <Button variant="secondary" size="sm" disabled={!!busyId || reading || !!err} onClick={() => setConfirmId(c.id)}>
                              <Trash2 size={13} /> 放弃
                            </Button>
                          )}
                        </>
                      ) : (
                        <span className="text-11 text-ink-500">此处仅供回看，不会再次写入正文。</span>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

    </Modal>
  )
}
