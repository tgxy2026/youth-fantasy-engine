/**
 * 本章体检（C3 · 2.4.2）
 *
 * 与同页其他面板的分工：
 *   · 投稿前自检（ManuscriptCheckPanel）—— 全书分布，纯本地；
 *   · 节奏与章末钩子（PaceAnalysisPanel）—— 单章节奏，需 AI；
 *   · 本面板 —— **单章**的确定性体检：串连续性 / 伏笔 / 敏感词 / 错别字 / 文风
 *     五个既有引擎，全部本地计算，**不发 AI 请求**。
 *
 * 🔴 默认手动触发（不进页面自动跑）—— 体检结果与章节内容强相关，自动跑容易展示过期结果。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ClipboardCheck, Loader2, Eye } from 'lucide-react'
import * as db from '../lib/db'
import type { Chapter } from '../lib/types'
import type { AuditIssue } from '../lib/audit'
import { SEVERITY_LABEL } from '../lib/audit'
import { runChapterCheck, countActionable, type ChapterCheckReport } from '../lib/chapterCheck'
import { Button } from './Button'
import HelpPopover from './HelpPopover'

// 与 CheckTools 的 sevBadge 同款配色（三处局部实现已核对一致，避免为三行样式新建共享模块）
const sevBadge = (s: 'error' | 'warn' | 'info') =>
  s === 'error' ? 'bg-red-500/15 text-red-300 border border-red-500/30'
  : s === 'warn' ? 'bg-amber/15 text-amber border border-amber/30'
  : 'bg-ink-700 text-ink-300 border border-ink-600'

function IssueList({ issues }: { issues: AuditIssue[] }) {
  if (issues.length === 0) return <div className="text-11 text-emerald-400">本章无相关问题 ✓</div>
  return (
    <div className="space-y-1.5">
      {issues.map(issue => (
        <div key={issue.id} className="bg-ink-800 border border-ink-700 rounded-lg p-2.5">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`px-1.5 py-0.5 rounded border text-10 shrink-0 ${sevBadge(issue.severity)}`}>{SEVERITY_LABEL[issue.severity]}</span>
            <span className="text-12 font-semibold text-ink-100">{issue.title}</span>
          </div>
          {issue.detail && <div className="text-11 text-ink-400 leading-relaxed whitespace-pre-wrap">{issue.detail}</div>}
        </div>
      ))}
    </div>
  )
}

export default function ChapterCheckPanel() {
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [activeId, setActiveId] = useState('')
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<ChapterCheckReport | null>(null)

  const load = useCallback(async () => {
    const chs = await db.getAllChapters().catch(() => [] as Chapter[])
    const sorted = [...chs].sort((a, b) => a.order - b.order)
    setChapters(sorted)
    setActiveId(prev => prev || (sorted.find(c => (c.wordCount || 0) > 0) ?? sorted[0])?.id || '')
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  // 换章就丢掉上一章的报告 —— 否则会拿着 A 章的报告看 B 章的正文
  useEffect(() => { setReport(null) }, [activeId])

  const active = useMemo(() => chapters.find(c => c.id === activeId), [chapters, activeId])

  const run = async () => {
    if (!active || running) return
    setRunning(true)
    try {
      setReport(await runChapterCheck(active))
    } finally {
      setRunning(false)
    }
  }

  if (loading) {
    return <div className="rounded-xl border border-ink-700 bg-ink-850/40 px-4 py-6 text-center text-11 text-ink-500">
      <Loader2 size={14} className="inline animate-spin" /> 正在读取…
    </div>
  }

  const actionable = report ? countActionable(report) : 0
  const hasContent = !!(active?.content || '').trim()

  return (
    <section className="rounded-xl border border-ink-700 bg-ink-850/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-700">
        <ClipboardCheck size={14} className="text-emerald-400" />
        <span className="text-13 font-medium text-ink-100">本章体检</span>
        <span className="text-10 text-ink-500">单章 · 五项确定性检查 · 全部本地</span>
        <HelpPopover title="本章体检怎么用">
          {'对选中的一章跑五个既有检查引擎，一次看全：\n\n'
            + '· 连续性：只汇报定位在本章的问题（死者复活 / 人名未登记等）；全书性的时间线问题请看「数据体检」；\n'
            + '· 伏笔：本章埋设 / 回收的伏笔及其问题；\n'
            + '· 敏感词：内置词库 + 你的自定义词（与「敏感词检测」共用词库）；\n'
            + '· 错别字：内置常见错别字词典；\n'
            + '· 文风：对照《写作规范》的坏习惯清单与标点规范。\n\n'
            + '全部本地计算，不发 AI 请求；点「体检本章」手动触发，换章后旧结果自动清空。'}
        </HelpPopover>
        <div className="ml-auto">
          <Button variant="secondary" size="sm" disabled={!activeId || running} onClick={() => void run()}>
            {running ? <><Loader2 size={12} className="animate-spin" /> 体检中…</> : <><ClipboardCheck size={12} /> 体检本章</>}
          </Button>
        </div>
      </div>

      {/* 章节选择 */}
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
        {!hasContent && <span className="text-10 text-ink-500">这一章还没有正文，体检只覆盖连续性 / 伏笔两项</span>}
      </div>

      {/* 结果区 */}
      <div className="px-4 py-3">
        {!activeId && <div className="text-11 text-ink-500">这个项目还没有章节。</div>}

        {activeId && !report && !running && (
          <div className="text-11 text-ink-500">
            <Eye size={11} className="inline -mt-0.5 mr-1" />
            点右上「体检本章」：连续性 / 伏笔 / 敏感词 / 错别字 / 文风，一次看全。
          </div>
        )}

        {report && (
          <div className="space-y-4">
            <div className={`text-12 ${actionable > 0 ? 'text-amber/80' : 'text-emerald-400'}`}>
              {actionable > 0
                ? `检出 ${actionable} 处需关注，逐组确认后发布更稳`
                : '本章干净，五项检查均无需处理 ✓'}
            </div>

            {/* ① 连续性 */}
            <div>
              <div className="mb-1.5 text-11 text-ink-400">连续性（定位在本章）</div>
              <IssueList issues={report.continuity} />
            </div>

            {/* ② 伏笔 */}
            <div>
              <div className="mb-1.5 text-11 text-ink-400">
                伏笔{report.foreshadow.codes.length > 0 && `（本章涉及 ${report.foreshadow.codes.join('、')}）`}
              </div>
              <IssueList issues={report.foreshadow.issues} />
            </div>

            {/* ③ 敏感词 */}
            <div>
              <div className="mb-1.5 text-11 text-ink-400">敏感词</div>
              {report.sensitive.length === 0 ? <div className="text-11 text-emerald-400">未命中 ✓</div> : (
                <div className="space-y-1.5">
                  {report.sensitive.map(h => (
                    <div key={h.word} className="text-11 text-ink-300 flex items-start gap-2">
                      <span className="px-1.5 py-0.5 bg-red-500/15 text-red-300 rounded shrink-0">{h.word} ×{h.count}</span>
                      <span className="text-ink-500 min-w-0">{h.context}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ④ 错别字 */}
            <div>
              <div className="mb-1.5 text-11 text-ink-400">错别字</div>
              {report.typos.length === 0 ? <div className="text-11 text-emerald-400">未命中 ✓</div> : (
                <div className="space-y-1.5">
                  {report.typos.map(h => (
                    <div key={h.word} className="text-11 text-ink-300 flex items-start gap-2">
                      <span className="px-1.5 py-0.5 bg-amber/15 text-amber rounded shrink-0">{h.word} ×{h.count}</span>
                      <span className="text-ink-500 min-w-0">建议改为「{h.suggest}」｜{h.context}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ⑤ 文风 */}
            <div>
              <div className="mb-1.5 text-11 text-ink-400">文风（对照《写作规范》）</div>
              <IssueList issues={report.style} />
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
