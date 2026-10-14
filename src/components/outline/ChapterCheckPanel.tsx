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
import { ClipboardCheck, Loader2, Eye, CheckCircle2, AlertTriangle } from 'lucide-react'
import * as db from '@/lib/db'
import type { Chapter, Volume } from '@/lib/types'
import type { AuditIssue } from '@/lib/audit/audit'
import { SEVERITY_LABEL } from '@/lib/audit/audit'
import { runChapterCheck, countActionable, type ChapterCheckReport } from '@/lib/outline/chapterCheck'
// 🔴 章节顺序真源 —— Chapter.order 是**卷内**序号，裸 sort 跨卷必串号（见 chapterSeq.ts 顶部禁令）
import { sortChapters } from '@/lib/outline/chapterSeq'
import ChapterTreeSelect from '@/components/outline/ChapterTreeSelect'
// 3.0 · W2-2：按章审计的留痕与失效（结果绑正文指纹；正文改过 ⇒ 标「已过期，需重跑」，不自动重跑）
import { saveChapterAudit, loadChapterAuditStatus, humanAgo, type AuditFreshness } from '@/lib/outline/chapterAudit'
import { Button } from '@/components/common/Button'
import HelpPopover from '@/components/common/HelpPopover'

// 与 CheckTools 的 sevBadge 同款配色（三处局部实现已核对一致，避免为三行样式新建共享模块）
const sevBadge = (s: 'error' | 'warn' | 'info') =>
  s === 'error' ? 'bg-danger/15 text-danger border border-danger/30'
  : s === 'warn' ? 'bg-amber/15 text-amber border border-amber/30'
  : 'bg-ink-700 text-ink-300 border border-ink-600'

function IssueList({ issues }: { issues: AuditIssue[] }) {
  if (issues.length === 0) return <div className="text-11 text-success">本章无相关问题 ✓</div>
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
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [activeId, setActiveId] = useState('')
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<ChapterCheckReport | null>(null)
  /** W2-2：本章的留痕 + 是否还作数（正文改过 ⇒ 过期） */
  const [audit, setAudit] = useState<AuditFreshness | null>(null)

  const load = useCallback(async () => {
    const [chs, vols] = await Promise.all([
      db.getAllChapters().catch(() => [] as Chapter[]),
      db.getAllVolumes().catch(() => [] as Volume[]),
    ])
    // 🔴 排序必须走 sortChapters（卷序 → 章序）。原先的 `[...chs].sort((a,b)=>a.order-b.order)`
    //    把**卷内序号**当全局序号用 ⇒ 跨卷串号，列表成「第1章 / 第11章 / 第21章 / 第2章 …」
    //    （2026-10-14 主人实测报障，根因与 chapterSeq.ts 顶部禁令完全一致）。
    const sorted = sortChapters(vols, chs)
    setVolumes(vols)
    setChapters(sorted)
    setActiveId(prev => prev || (sorted.find(c => (c.wordCount || 0) > 0) ?? sorted[0])?.id || '')
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  // 换章就丢掉上一章的报告 —— 否则会拿着 A 章的报告看 B 章的正文
  useEffect(() => { setReport(null) }, [activeId])

  // W2-2：读本章留痕并判失效（切章 / 章节数据变化时重算）。
  // 🔴 只**读与标注**，绝不自动重跑 —— 方案 §10.3 #4 首条：显式触发、非后台自动跑。
  useEffect(() => {
    if (!activeId) { setAudit(null); return }
    let cancelled = false
    const ch = chapters.find(c => c.id === activeId) ?? null
    loadChapterAuditStatus(activeId, ch)
      .then(s => { if (!cancelled) setAudit(s) })
      .catch(() => { if (!cancelled) setAudit(null) })
    return () => { cancelled = true }
  }, [activeId, chapters])

  const active = useMemo(() => chapters.find(c => c.id === activeId), [chapters, activeId])

  const run = async () => {
    if (!active || running) return
    setRunning(true)
    try {
      const rep = await runChapterCheck(active)
      setReport(rep)
      // 🔴 W2-2：留痕一条（绑定本次正文指纹）。失败静默 —— 绝不能因为写不进台账而让体检失败。
      await saveChapterAudit(rep, active, countActionable(rep))
      setAudit(await loadChapterAuditStatus(active.id, active))
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
        <ClipboardCheck size={14} className="text-success" />
        <span className="text-13 font-medium text-ink-100">本章体检</span>
        <span className="text-10 text-ink-500">单章 · 五项确定性检查 · 全部本地</span>
        <HelpPopover title="本章体检怎么用">
          {'对选中的一章跑五个既有检查引擎，一次看全：\n\n'
            + '· 连续性：只汇报定位在本章的问题（死者复活 / 人名未登记等）；全书性的时间线问题请看「数据体检」；\n'
            + '· 伏笔：本章埋设 / 回收的伏笔及其问题；\n'
            + '· 敏感词：内置词库 + 你的自定义词（与「敏感词检测」共用词库）；\n'
            + '· 错别字：内置常见错别字词典；\n'
            + '· 文风：对照《写作规范》的坏习惯清单与标点规范。\n\n'
            + '全部本地计算，不发 AI 请求；点「体检本章」手动触发，换章后旧结果自动清空。\n\n'
            + '· 结果会留痕（记「哪一章 + 当时正文的指纹 + 各类计数」）。若这一章的正文在上次体检后又被改过，'
            + '面板会提示「结果已过期，请重新体检」—— 旧报告不再作数，不会自动重跑，重跑由你点按钮决定。'}
        </HelpPopover>
        <div className="ml-auto">
          <Button variant="secondary" size="sm" disabled={!activeId || running} onClick={() => void run()}>
            {running ? <><Loader2 size={12} className="animate-spin" /> 体检中…</> : <><ClipboardCheck size={12} /> 体检本章</>}
          </Button>
        </div>
      </div>

      {/* 章节选择 —— 卷 / 章树（可折叠 + 可搜索）
          🔴 2026-10-14：原先是平铺 <select>，顺序因跨卷裸排而乱（第1章 → 第11章 → 第21章）。
          换成树后：卷序分组、章号取全局派生序号、支持折叠与搜索，与正文编辑页左栏观感一致。 */}
      <div className="px-4 py-3 border-b border-ink-700 space-y-1.5">
        <ChapterTreeSelect
          volumes={volumes}
          chapters={chapters}
          value={activeId}
          onChange={setActiveId}
        />
        {!hasContent && <div className="text-10 text-ink-500">这一章还没有正文，体检只覆盖连续性 / 伏笔两项</div>}
      </div>

      {/* W2-2：留痕 + 失效标注（只标注，不自动重跑） */}
      {activeId && audit?.record && (
        <div className={`px-4 py-2 border-b border-ink-700 text-11 flex items-center gap-1.5 ${audit.fresh ? 'text-ink-400' : 'text-amber'}`}>
          {audit.fresh ? (
            <>
              <CheckCircle2 size={11} className="shrink-0" />
              <span>上次体检：{humanAgo(audit.record.at)} · 待处理 {audit.record.actionables} 项</span>
            </>
          ) : (
            <>
              <AlertTriangle size={11} className="shrink-0" />
              <span>⚠️ {audit.reason} —— {humanAgo(audit.record.at)}的那份结果已过期，请重新点「体检本章」</span>
            </>
          )}
        </div>
      )}

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
            <div className={`text-12 ${actionable > 0 ? 'text-amber/80' : 'text-success'}`}>
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
              {report.sensitive.length === 0 ? <div className="text-11 text-success">未命中 ✓</div> : (
                <div className="space-y-1.5">
                  {report.sensitive.map(h => (
                    <div key={h.word} className="text-11 text-ink-300 flex items-start gap-2">
                      <span className="px-1.5 py-0.5 bg-danger/15 text-danger rounded shrink-0">{h.word} ×{h.count}</span>
                      <span className="text-ink-500 min-w-0">{h.context}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ④ 错别字 */}
            <div>
              <div className="mb-1.5 text-11 text-ink-400">错别字</div>
              {report.typos.length === 0 ? <div className="text-11 text-success">未命中 ✓</div> : (
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
