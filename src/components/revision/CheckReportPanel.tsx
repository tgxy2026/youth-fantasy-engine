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
import { useCallback, useEffect, useState } from 'react'
import { FileWarning, Loader2, RefreshCw, X } from 'lucide-react'
import * as db from '@/lib/db'
import { Button } from '@/components/common/Button'
import { Z } from '@/lib/app/zLayer'
import { foldVh } from '@/lib/settings/theme'
import {
  listCheckReportViews, reportSourceLabel, summarizeReportViews, type CheckReportView,
} from '@/lib/revision/checkReports'

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
  const [rows, setRows] = useState<CheckReportView[] | null>(null)
  const [err, setErr] = useState('')
  const [titles, setTitles] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      const pid = db.getCurrentProjectId() ?? ''
      const [list, chs] = await Promise.all([
        listCheckReportViews(pid),
        db.getAllChapters().catch(() => []),
      ])
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

  const sum = rows ? summarizeReportViews(rows) : null
  const chapterName = (r: CheckReportView): string => {
    // 3.2.0 · T3-06：优先用落档时的章名 —— 之后改名 / 删章，历史报告仍说当时的名字
    if (r.chapterTitle) return r.chapterTitle
    if (r.chapterId) return titles[r.chapterId] ?? '（这一章已不在项目里）'
    if (r.chapterNo !== undefined) return `第 ${r.chapterNo} 章`
    return '（未记录章节）'
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center p-6 bg-ink-950/70 backdrop-blur-sm" style={{ zIndex: Z.modal }}>
      <div
        className="w-full max-w-[760px] flex flex-col rounded-2xl bg-ink-850 border border-ink-700 shadow-2xl overflow-hidden"
        style={{ maxHeight: foldVh('80vh') }}
      >
        <div className="px-6 py-4 border-b border-ink-700/70 flex items-center gap-2">
          <FileWarning size={16} className="text-amber" />
          <div className="text-14 font-semibold text-ink-50">检查报告</div>
          <div className="text-11 text-ink-500">留档的结论，可回看</div>
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
            <div className="h-full flex items-center justify-center py-8">
              <div className="text-13 text-ink-500 text-center">
                还没有留档的检查报告。
                <div className="text-11 mt-1.5">
                  只有查到「冲突 / 注意」级问题时才会留档 —— 全绿的检查不占空间，也不在这里留痕。
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
                  <li key={r.id} className="rounded-xl bg-ink-900/50 border border-ink-700/60 px-4 py-3">
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
                      {/* 落库那一刻的证据快照：回答"当时到底有没有证据"，与工单侧按当前正文的定位是两回事 */}
                      {r.evidence && r.evidence.total > 0 && (
                        <span title="落库时按被检查的正文逐字定位；定位不到不代表问题不存在，只代表当时没有可引用的原句">
                          引文 {r.evidence.located}/{r.evidence.total} 可定位
                        </span>
                      )}
                    </div>

                    <ul className="mt-2 space-y-1.5">
                      {r.findings.map((f, i) => (
                        <li key={i} className="text-11 leading-relaxed">
                          <span className={`mr-1.5 ${levelCls(f.level)}`}>· {f.level ?? '提示'}</span>
                          <span className="text-ink-100">{f.title ?? '（无标题）'}</span>
                          {f.detail ? <span className="text-ink-400"> —— {f.detail}</span> : null}
                          {f.where
                            ? <span className="ml-1 text-ink-500" title="可定位的原文片段（工单拿它算段号）">〔{f.where}〕</span>
                            : <span className="ml-1 text-ink-600" title="这条发现没有带可引用的原句">〔无引文〕</span>}
                        </li>
                      ))}
                      {r.findings.length === 0 && (
                        <li className="text-11 text-ink-500">（这份报告没有留下条目）</li>
                      )}
                    </ul>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="px-6 py-3 border-t border-ink-700/70 flex items-center gap-2">
          <span className="text-10 text-ink-500">
            留档有配额（每章 5 份 / 全书 200 份），超了会删最旧的 —— 更早的报告可能已不在。
          </span>
          <Button variant="secondary" size="sm" className="!ml-auto" onClick={() => void load()}>
            <RefreshCw size={13} /> 刷新
          </Button>
        </div>
      </div>
    </div>
  )
}
