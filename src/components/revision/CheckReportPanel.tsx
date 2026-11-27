/**
 * 3.2.0 · W4 检查报告回看（「创作轨迹」入口）
 *
 * 🔴 为什么需要这块界面：报告留存是**A 策略**（有问题才存 + 双闸淘汰），
 *    存下来的目的就是让作者能回头翻「当时到底报了哪三条」。
 *    没有界面，那些报告只能通过「加入工单」间接看到 —— 等于存了但查不到。
 *
 * 三条界面纪律：
 *   ① **只呈现留档的内容**：不重新检查、不推断。全绿的检查**本来就不落库**，
 *      所以这里看不到它们不是 bug —— 空态要把这句话说清楚。
 *   ② **说清来源**：本地诊断 / 改后复检 / AI 自检，三者的可信度与下一步不同。
 *   ③ **淘汰如实**：配额到了会删最旧的（每章 5 份 / 每项目 200 份），删了就是删了，
 *      不写"已清理"以外的说法，也不假装还在。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { FileWarning, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { Modal } from '@/components/dialogs/Modal'
import { candidateApplyContext } from '@/lib/ai/candidateContext'
import { getStorageContextEpoch, subscribeStorageContext } from '@/lib/storage/contextEpoch'
import { useRevisionRead } from './useRevisionRead'
import {
  listCheckReportViews, reportSourceLabel, summarizeReportViews, type CheckReportView,
} from '@/lib/revision/checkReports'
import { getCurrentProjectId } from '@/lib/db/core'
import { getAllChapters } from '@/lib/db'
import { hashOf } from '@/lib/semantic/chunk'
import { copyText, showToast } from '@/components/dialogs/dialogs'
import {
  clearReviewIgnore, ignoreIndex, loadReviewIgnores, revisionRequestOf, setReviewIgnore,
  type ReviewIgnoreRecord,
} from '@/lib/revision/reviewIgnore'
import { REVIEW_SUMMARY_LIMIT, type ReviewCheckState, type ReviewRunSummary } from '@/lib/revision/reviewSummary'
import { loadReviewSummaries } from '@/lib/revision/reviewSummaryStore'
import { requirementFromReport, setPendingRevisionFromCheck } from '@/lib/revision/checkToCandidate'

/** 运行摘要的状态人话（`skipped` 必须说"未执行"，不能说"通过"） */
const SUMMARY_STATE: Record<ReviewCheckState, { label: string; cls: string }> = {
  completed: { label: '已检完', cls: 'text-success' },
  partial: { label: '部分完成', cls: 'text-amber' },
  failed: { label: '检查失败', cls: 'text-danger' },
  cancelled: { label: '已取消', cls: 'text-ink-400' },
  skipped: { label: '未执行', cls: 'text-amber' },
  incomplete: { label: '未完整', cls: 'text-amber' },
}
const RUN_STATE_LABEL: Record<string, string> = {
  completed: '已检', partial: '部分', failed: '失败', cancelled: '取消', skipped: '未检', incomplete: '未完整',
}

function fmt(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const levelCls = (level?: string): string =>
  level === '严重' ? 'text-danger'
    : level === '中等' ? 'text-amber'
      : 'text-ink-400'

export default function CheckReportPanel({ onClose }: { onClose: () => void }) {
  useSyncExternalStore(subscribeStorageContext, getStorageContextEpoch)
  return <ReportWorkspace key={candidateApplyContext()} onClose={onClose} />
}

function ReportWorkspace({ onClose }: { onClose: () => void }) {
  const { rows, titles, err, reading, load } = useRevisionRead(listCheckReportViews)
  /**
   * 3.6.0 · D：运行摘要（每次自检都留一条，含全绿/失败/未执行）。
   * 🔴 报告是「有问题才存」，所以 0 份报告**不能**推断成没问题 —— 这一块就是补这个歧义。
   */
  const [summaries, setSummaries] = useState<ReviewRunSummary[] | null>(null)
  const [sumErr, setSumErr] = useState('')
  /** 3.6.0 · D：「忽略并说明」记录（本机偏好，键 = reportId::index） */
  const [ignores, setIgnores] = useState<Map<string, ReviewIgnoreRecord>>(new Map())
  const [ignoreEditing, setIgnoreEditing] = useState<string | null>(null)
  const [ignoreDraft, setIgnoreDraft] = useState('')
  /** 3.7.0 · W2：落档后正文又改过的报告（只提示，不改报告内容） */
  const [staleReports, setStaleReports] = useState<Set<string>>(new Set())

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    let cancelled = false
    void loadReviewSummaries(getCurrentProjectId()).then(r => {
      if (cancelled) return
      setSummaries(r.list)
      setSumErr(r.error ?? '')
    })
    void loadReviewIgnores(getCurrentProjectId()).then(list => {
      if (!cancelled) setIgnores(ignoreIndex(list))
    })
    return () => { cancelled = true }
  }, [])

  // 3.7.0 · W2：报告记了基准正文摘要的就现算一次 —— 不一致 ⇒ 「报告基于旧稿」；老报告没有摘要 ⇒ 不提示
  useEffect(() => {
    if (!rows?.length) { setStaleReports(new Set()); return }
    let cancelled = false
    void getAllChapters().then(chapters => {
      if (cancelled) return
      const bodies = new Map(chapters.map(c => [c.id, hashOf(c.content ?? '')]))
      const next = new Set<string>()
      for (const r of rows) {
        if (!r.bodyDigest || !r.chapterId) continue
        const now = bodies.get(r.chapterId)
        if (now !== undefined && now !== r.bodyDigest) next.add(r.id)
      }
      setStaleReports(next)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [rows])

  const saveIgnore = async (reportId: string, index: number, title: string | undefined) => {
    const pid = getCurrentProjectId()
    if (!pid) return
    const reason = ignoreDraft.trim().slice(0, 200)
    await setReviewIgnore(pid, { reportId, index, ...(title ? { title } : {}), reason, at: Date.now() })
    setIgnores(ignoreIndex(await loadReviewIgnores(pid)))
    setIgnoreEditing(null)
    setIgnoreDraft('')
    showToast(reason ? '已记录忽略与理由（只影响这台设备）' : '已忽略（未填理由，只影响这台设备）', 'info')
  }
  const undoIgnore = async (reportId: string, index: number) => {
    const pid = getCurrentProjectId()
    if (!pid) return
    await clearReviewIgnore(pid, reportId, index)
    setIgnores(ignoreIndex(await loadReviewIgnores(pid)))
  }
  const copyRevision = async (chapterName: string, f: { level?: string; title?: string; detail?: string; where?: string }) => {
    await copyText(revisionRequestOf({ chapterName, ...f }), '修订要求已复制，可粘贴到编辑器里的 AI 面板')
  }

  const sum = rows ? summarizeReportViews(rows) : null
  const chapterName = (r: CheckReportView): string => {
    // 3.2.0 · T3-06：优先用落档时的章名 —— 之后改名 / 删章，历史报告仍说当时的名字
    if (r.chapterTitle) return r.chapterTitle
    if (r.chapterId) return titles[r.chapterId] ?? '（这一章已不在项目里）'
    if (r.chapterNo !== undefined) return `第 ${r.chapterNo} 章`
    return '（未记录章节）'
  }

  return (
    <Modal open onClose={onClose} title="检查报告" icon={<FileWarning size={16} />} width={760} maxHeight="80vh"
      footer={<><span className="text-10 text-ink-500">留档有配额（每章 5 份 / 全书 200 份），更早的报告可能已不在。</span>
        <Button variant="secondary" size="sm" disabled={reading} onClick={() => void load()}><RefreshCw size={13} /> 重试读取</Button></>}>
        <div data-revision-reports>
          {sumErr !== '' && <div role="alert" className="text-11 text-amber py-1">运行摘要读取失败：{sumErr}（不影响下面的留档报告）</div>}
          {summaries !== null && summaries.length > 0 && (
            <section data-review-summaries className="mb-4 rounded-xl border border-ink-700 yfe-surface-3 px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-12 font-semibold text-ink-200">最近自检</span>
                <span className="text-10 text-ink-500">每次自检都留一条（含「没查」与「没发现问题」），只保留最近 {REVIEW_SUMMARY_LIMIT} 次</span>
              </div>
              <ul className="mt-2 space-y-1.5">
                {summaries.slice(0, 3).map(s => {
                  const st = SUMMARY_STATE[s.state]
                  return (
                    <li key={s.id} data-summary-id={s.id} className="text-11 leading-relaxed">
                      <span className={`mr-1.5 ${st.cls}`}>· {st.label}</span>
                      <span className="text-ink-300">
                        {s.chapterId ? (titles[s.chapterId] ?? '（已不在项目中）') : s.chapterNo !== undefined ? `第 ${s.chapterNo} 章` : '（未绑章）'}
                      </span>
                      <span className="ml-1.5 text-ink-500 tabular-nums">{fmt(s.at)}</span>
                      {s.corrected && <span className="ml-1.5 text-ink-500" title="摘要针对自动修正前的正文">（修正前）</span>}
                      <div className="mt-0.5 text-10 text-ink-400">
                        {s.runs.map(r => `${r.source.replace('章节自检 · ', '')} ${RUN_STATE_LABEL[r.state] ?? r.state}${r.findings ? ` ${r.findings} 条` : ''}`).join(' · ')}
                      </div>
                      {s.reason && <div className="mt-0.5 text-10 text-ink-500">{s.reason}</div>}
                      {s.revision && (
                        <div className="mt-0.5 text-10 text-ink-500">
                          修正对照：{s.revision.beforeWords} 字
                          {s.revision.afterWords !== undefined ? ` → ${s.revision.afterWords} 字` : '（未产生可用修正）'}
                          <span className="ml-1 text-ink-600" title="只记指纹与字数，不复制正文；正文本身在章节版本里">
                            指纹 {s.revision.beforeFingerprint.slice(0, 8)}
                            {s.revision.afterFingerprint ? ` → ${s.revision.afterFingerprint.slice(0, 8)}` : ''}
                          </span>
                        </div>
                      )}
                      {s.reportWrite && (
                        <div className="mt-0.5 text-10 text-ink-500">
                          报告：落档 {s.reportWrite.saved} 份
                          {s.reportWrite.pruned ? ` · 淘汰 ${s.reportWrite.pruned} 份更早的` : ''}
                          {s.reportWrite.error ? <span className="text-danger"> · 写入失败：{s.reportWrite.error}</span> : ''}
                        </div>
                      )}
                      {s.reportIds?.length ? (
                        <div className="mt-0.5 text-10 text-ink-500">关联报告 {s.reportIds.length} 份（见下方列表）</div>
                      ) : (
                        <div className="mt-0.5 text-10 text-ink-600">本轮没有落档报告（全绿或未执行，不等于「有问题但没存」）</div>
                      )}
                    </li>
                  )
                })}
              </ul>
              {summaries.length > 3 && (
                <div className="mt-1.5 text-10 text-ink-600">另有 {summaries.length - 3} 次更早的自检记录（未展开）</div>
              )}
            </section>
          )}
          {rows === null && (
            <div className="flex items-center justify-center py-10 gap-2 text-ink-400">
              <Loader2 size={18} className="animate-spin text-amber" />
              <span className="text-13">读取中…</span>
            </div>
          )}
          {err !== '' && <div role="alert" className="text-12 text-danger py-4">{err}</div>}
          {reading && rows !== null && <div role="status" className="text-11 text-ink-400 py-2">正在更新留档…</div>}
          {rows !== null && err === '' && rows.length === 0 && (
            <div className="h-full flex items-center justify-center py-8">
              <div className="text-13 text-ink-500 text-center">
                还没有留档的检查报告。
                <div className="text-11 mt-1.5">
                  只有查到「冲突 / 注意」级问题时才会留档；全绿的检查不占这份额度，
                  但每次自检都会在上面「最近自检」留一行状态 —— 0 份报告不等于「查过没问题」。
                </div>
              </div>
            </div>
          )}

          {rows !== null && rows.length > 0 && sum && (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-11 text-ink-400">
                <span>共 <b className="text-ink-200 tabular-nums">{sum.total}</b> 份</span>
                <span>涉及 <b className="text-ink-200 tabular-nums">{sum.chapters}</b> 章</span>
                {sum.serious > 0 && <span className="text-danger">冲突 {sum.serious}</span>}
                {sum.minor > 0 && <span className="text-amber">注意 {sum.minor}</span>}
                <span className="text-ink-500">最近 {fmt(sum.latestAt ?? 0)}</span>
              </div>

              <ul className="space-y-2.5">
                {rows.map(r => (
                  <li key={r.id} data-report-id={r.id} className="min-w-0 rounded-xl yfe-surface-3 border border-ink-700/60 px-4 py-3 [overflow-wrap:anywhere]">
                    <div className="flex items-center gap-2">
                      <span className="text-11 px-1.5 py-0.5 rounded bg-ink-800 text-ink-300">
                        {reportSourceLabel(r.source)}
                      </span>
                      <span className="text-13 text-ink-100 truncate">{chapterName(r)}</span>
                      <span className="ml-auto text-10 text-ink-500 tabular-nums shrink-0">{fmt(r.createdAt)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 text-11 text-ink-500 tabular-nums">
                      {r.serious > 0 && <span className="text-danger">冲突 {r.serious}</span>}
                      {r.minor > 0 && <span className="text-amber">注意 {r.minor}</span>}
                      {r.info > 0 && <span>提示 {r.info}</span>}
                      <span>{r.checkId}</span>
                      {staleReports.has(r.id) && (
                        <span className="text-amber" title="报告是在当时那版正文上跑出来的；之后正文又改过，结论可能已经不对应当前正文">报告基于旧稿</span>
                      )}
                      {/* 落库那一刻的证据快照：回答"当时到底有没有证据"，与工单侧按当前正文的定位是两回事 */}
                      {r.evidence && r.evidence.total > 0 && (
                        <span title="落库时按被检查的正文逐字定位；定位不到不代表问题不存在，只代表当时没有可引用的原句">
                          引文 {r.evidence.located}/{r.evidence.total} 可定位
                        </span>
                      )}
                    </div>

                    {/* 3.6.0 · 审计项 12：检查报告 → 修订候选 的唯一入口。
                        原先把「复制修订要求」交给作者手动粘到编辑器，链条到这里就断了 ——
                        候选里永远没有 checkPayloadIds，日后也无法回答"这稿按哪份报告改的"。 */}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Button variant="secondary" size="xs" disabled={!r.chapterId}
                        onClick={() => {
                          const pid = getCurrentProjectId()
                          if (!pid) { showToast('先打开一个项目', 'error'); return }
                          if (!r.chapterId) { showToast('这份报告没有章节归属，无法发起修订', 'error'); return }
                          setPendingRevisionFromCheck({
                            projectId: pid,
                            chapterId: r.chapterId,
                            checkPayloadIds: [r.id],
                            requirement: requirementFromReport({
                              chapterTitle: titles[r.chapterId] ?? r.chapterTitle,
                              summary: r.summary,
                              findings: r.findings,
                            }),
                          })
                          showToast('已带入「创意写作 → 章节改写」：切过去点「开始改写」即可，要求还能再改', 'success')
                          onClose()
                        }}>
                        以此发起修订
                      </Button>
                      <span className="text-10 text-ink-500">
                        {r.chapterId ? '会把这份报告关联到产生的候选上（候选审阅里可追溯）' : '老报告缺章节归属，只能复制要求手填'}
                      </span>
                    </div>

                    <details className="mt-2">
                      <summary className="cursor-pointer text-11 text-ink-200">查看完整发现（{r.findings.length} 条）</summary>
                    <ul className="mt-2 space-y-1.5">
                      {r.findings.map((f, i) => {
                        const ikey = `${r.id}::${i}`
                        const ignored = ignores.get(ikey)
                        return (
                        <li key={i} className="text-11 leading-relaxed">
                          <span className={`mr-1.5 ${levelCls(f.level)}`}>· {f.level ?? '提示'}</span>
                          <span className="text-ink-100">{f.title ?? '（无标题）'}</span>
                          {f.detail ? <span className="text-ink-400 whitespace-pre-wrap"> —— {f.detail}</span> : null}
                          {f.where
                            ? <span className="ml-1 text-ink-500 whitespace-pre-wrap" title="可定位的原文片段（工单拿它算段号）">〔{f.where}〕</span>
                            : <span className="ml-1 text-ink-600" title="这条发现没有带可引用的原句">〔无引文〕</span>}
                          {/* 3.6.0 · D：每条问题都能「忽略并说明」或复制成修订要求 —— 只读回看不够用 */}
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-10">
                            {ignored ? (
                              <>
                                <span className="text-ink-500">已忽略{ignored.reason ? `：${ignored.reason}` : '（未填理由）'} · 仅本机</span>
                                <button type="button" onClick={() => void undoIgnore(r.id, i)}
                                  className="text-ink-400 hover:text-amber transition-colors">撤销</button>
                              </>
                            ) : (
                              <>
                                <button type="button"
                                  onClick={() => { setIgnoreEditing(ikey); setIgnoreDraft('') }}
                                  className="text-ink-400 hover:text-amber transition-colors"
                                  title="记下「这条不用改」及理由；不影响其它设备，也不删除报告">忽略并说明</button>
                                <button type="button"
                                  onClick={() => void copyRevision(chapterName(r), f)}
                                  className="text-ink-400 hover:text-amber transition-colors"
                                  title="复制成一段修订要求，可粘贴到编辑器里的 AI 面板（本版不自动跨页跳转）">复制修订要求</button>
                              </>
                            )}
                          </div>
                          {ignoreEditing === ikey && (
                            <div className="mt-1.5 space-y-1">
                              <textarea
                                value={ignoreDraft}
                                maxLength={200}
                                onChange={e => setIgnoreDraft(e.target.value)}
                                placeholder="为什么这条不用改（例如：这是角色口癖 / 有意留的伏笔），可留空"
                                className="w-full text-11 px-2 py-1.5 rounded-lg bg-ink-900 border border-ink-700 text-ink-100 outline-none focus:border-amber/50 h-14 resize-none"
                              />
                              <div className="flex items-center gap-2">
                                <button type="button" onClick={() => void saveIgnore(r.id, i, f.title)}
                                  className="px-2 py-0.5 rounded border border-amber/40 bg-amber/10 text-amber">保存忽略</button>
                                <button type="button" onClick={() => { setIgnoreEditing(null); setIgnoreDraft('') }}
                                  className="px-2 py-0.5 rounded border border-ink-700 text-ink-400">取消</button>
                              </div>
                            </div>
                          )}
                        </li>
                        )
                      })}
                      {r.findings.length === 0 && (
                        <li className="text-11 text-ink-500">（这份报告没有留下条目）</li>
                      )}
                    </ul>
                    </details>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

    </Modal>
  )
}
