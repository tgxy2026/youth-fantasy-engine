import { useEffect, useState } from 'react'
import { writerBudgetFor } from '../lib/aiWriterBudget'
import { ToolModal } from './EditorModals'
import AuditPanel from './AuditPanel'
import HelpPopover from './HelpPopover'
import AIDataSourceNote from './AIDataSourceNote'
import { GitBranch, Link2, Feather, Sparkles, Loader2, AlertCircle } from 'lucide-react'
import { auditForeshadow } from '../lib/foreshadowEngine'
import type { ForeshadowBoardItem, ForeshadowStatus } from '../lib/foreshadowEngine'
import { auditContinuity } from '../lib/continuityCheck'
import { auditStyle } from '../lib/styleAudit'
import type { AuditIssue } from '../lib/audit'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { buildProjectContext, getRecentChapterTexts } from '../lib/aiContext'
import { aiForeshadowReview, aiContinuityAudit, aiStyleCheck } from '../lib/aiTasks'
import { getFormData } from '../lib/db'
import { Button } from './Button'

// ============ 伏笔闭环看板 ============
export function ForeshadowBoard({ onNavigateTab, onClose }: { onNavigateTab: (tabId: string) => void; onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [board, setBoard] = useState<ForeshadowBoardItem[]>([])
  const [issues, setIssues] = useState<AuditIssue[]>([])
  const { ready: aiReady } = useAIReady()
  const [aiFindings, setAiFindings] = useState<{ level: string; title: string; detail: string; where: string }[]>([])
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  const runAiReview = async () => {
    setAiLoading(true); setAiError(null); setAiFindings([])
    try {
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('foreshadow-review'), onlyTabIds: ['foreshadow', 'chapter-master', 'timeline'] })
      const r = await aiForeshadowReview(ctx.text)
      setAiFindings(r)
    } catch (e) { setAiError(e instanceof Error ? e.message : String(e)) }
    finally { setAiLoading(false) }
  }

  useEffect(() => {
    let cancelled = false
    auditForeshadow().then(r => {
      if (cancelled) return
      setBoard(r.board)
      setIssues(r.issues)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const columns: { status: ForeshadowStatus; label: string; cls: string }[] = [
    { status: '埋设中', label: '埋设中', cls: 'border-t-sky-500' },
    { status: '进行中', label: '进行中', cls: 'border-t-amber' },
    { status: '已回收', label: '已回收', cls: 'border-t-emerald-500' },
    { status: '孤儿', label: '孤儿', cls: 'border-t-red-500' },
  ]
  const countBy = (s: ForeshadowStatus) => board.filter(b => b.status === s).length

  return (
    <ToolModal title="伏笔闭环看板" icon={<GitBranch size={16} />} onClose={onClose} wide
      help={
        <HelpPopover title="伏笔闭环怎么用" width="22rem">
          {'章节总表每章的「埋设/回收伏笔编号」是引擎的数据源；伏笔追踪是登记面。\n\n· 看板按状态分列：埋设中 / 进行中 / 已回收 / 孤儿；\n· 某条伏笔在总表埋了、在追踪表也标了，闭环就完整；\n· 标红的「孤儿」=追踪表有、但总表从没埋设，读者无从知晓；\n· 「状态未同步」=总表已登记回收，追踪表却还写着未回收。\n建议：每写完一卷，打开本看板点检一次，防烂尾。'}
          <AIDataSourceNote feature="foreshadow-review" />
        </HelpPopover>
      }
    >
      <div className="mb-3">
        <span className="text-11 text-ink-500">
          从「章节总表」反推每条伏笔的生命周期，对照「伏笔追踪」状态，自动发现跨度过大、孤儿、前置未铺就、状态未同步等问题。
        </span>
      </div>

      {loading ? <div className="text-12 text-ink-400 py-8 text-center">分析伏笔网络…</div> : (
        <>
          <div className="flex gap-2 mb-3 text-11">
            {columns.map(c => (
              <span key={c.status} className="px-2 py-0.5 rounded bg-ink-800 text-ink-300 border border-ink-700">{c.label} {countBy(c.status)}</span>
            ))}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            {columns.map(col => (
              <div key={col.status} className={`flex flex-col bg-ink-800/60 border border-ink-700 rounded-lg border-t-2 ${col.cls} p-2 min-h-[120px]`}>
                <div className="text-11 font-semibold text-ink-200 mb-1.5">{col.label}</div>
                <div className="space-y-1.5">
                  {board.filter(b => b.status === col.status).map(b => (
                    <div key={b.code} className="rounded bg-ink-850 border border-ink-700 px-2 py-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-11 font-semibold text-amber">{b.code}</span>
                        <span className="text-9 text-ink-500">{b.importance}</span>
                      </div>
                      <div className="text-10 text-ink-300 mt-0.5 truncate" title={b.content}>{b.content}</div>
                      {b.span != null && (
                        <div className="text-9 text-ink-500 mt-0.5">跨度 {b.span} 章</div>
                      )}
                    </div>
                  ))}
                  {board.filter(b => b.status === col.status).length === 0 && (
                    <div className="text-10 text-ink-600 text-center py-2">—</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 pt-3 border-t border-ink-700">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-12 font-semibold text-ink-200">可定位问题（点击跳转修正）</span>
              <Button onClick={runAiReview}
                disabled={!aiReady || aiLoading}
                
                title={!aiReady ? AI_DISABLED_HINT : '让 AI 从伏笔追踪 + 章节总表审视伏笔闭环健康度（跨度/悬空/失衡）'} variant="secondary" size="md" className="ml-auto flex items-center rounded text-11">
                {aiLoading ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                AI 深度分析
              </Button>
            </div>
            <AuditPanel issues={issues} emptyText="伏笔网络健康 ✓ 无跨度/孤儿/状态异常" onNavigateTab={onNavigateTab} />
            {aiError && (
              <div className="mt-2 flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/25 text-12 text-danger">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <span>{aiError}</span>
              </div>
            )}
            {aiFindings.length > 0 && (
              <div className="mt-3 space-y-1.5">
                <div className="text-11 text-ink-500">AI 伏笔健康审查</div>
                {aiFindings.map((f, i) => (
                  <div key={i} className="flex items-start gap-2 text-12">
                    <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${f.level === '严重' ? 'bg-red-400' : f.level === '中等' ? 'bg-amber' : 'bg-sky-400'}`} />
                    <span>
                      <span className="text-ink-200">{f.title}</span>
                      {f.detail ? <span className="text-ink-400"> —— {f.detail}</span> : null}
                      {f.where ? <span className="text-ink-500">（{f.where}）</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </ToolModal>
  )
}

// ============ 连续性校验器 ============
export function ContinuityCheck({ onNavigateTab, onOpenChapter, onClose }: {
  onNavigateTab: (tabId: string) => void
  onOpenChapter: (chapterId: string) => void
  onClose: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [issues, setIssues] = useState<AuditIssue[]>([])
  const { ready: aiReady } = useAIReady()
  const [aiFindings, setAiFindings] = useState<{ level: string; title: string; detail: string; where: string }[]>([])
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  const runAiAudit = async () => {
    setAiLoading(true); setAiError(null); setAiFindings([])
    try {
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('continuity-audit') })
      // 喂最近 6 章正文：一致性冲突最常出现在临近章节；空串时 prompt 会自动退化为仅查设定内部矛盾
      const texts = await getRecentChapterTexts(6).catch(() => '')
      const r = await aiContinuityAudit(ctx.text, texts)
      setAiFindings(r)
    } catch (e) { setAiError(e instanceof Error ? e.message : String(e)) }
    finally { setAiLoading(false) }
  }

  useEffect(() => {
    let cancelled = false
    auditContinuity().then(r => {
      if (cancelled) return
      setIssues(r)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  return (
    <ToolModal title="连续性校验器" icon={<Link2 size={16} />} onClose={onClose} wide
      help={
        <HelpPopover title="连续性校验怎么用" width="22rem">
          {'全书级静态体检，覆盖 10 类常见问题：\n\n1. 时间倒流（时间线日期前后矛盾）\n2. 境界回退（主角境界不升反降）\n3. 死者复活（已死亡角色仍出场）\n4. 人名未登记（出场人物不在角色卡）\n5. 伏笔编号孤儿（章节引用了不存在的伏笔）\n6. 伏笔状态不一致（已回收但表未同步）\n7. 术语重复（同一名词定义了两次）\n8. 章节缺时间脉络登记\n9. 爽点断档（相邻爽点间隔超 3 章）\n10. 存稿缓冲告急（低于 3 章预警线）\n\n点击问题可跳转到对应章节或设定表修正。'}
          <AIDataSourceNote feature="continuity-audit" />
        </HelpPopover>
      }
    >
      <div className="mb-3">
        <span className="text-11 text-ink-500">
          基于章节总表 / 时间脉络 / 伏笔追踪 / 名词术语 / 角色卡 / 爽点节奏 / 写作进度，做 10 类确定性冲突与节奏检测。
        </span>
      </div>
      {loading ? <div className="text-12 text-ink-400 py-8 text-center">逐表对账中…</div> : (
        <>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-12 font-semibold text-ink-200">本地确定性冲突</span>
            <Button onClick={runAiAudit}
              disabled={!aiReady || aiLoading}
              
              title={!aiReady ? AI_DISABLED_HINT : '让 AI 基于全部设定与最近 6 章正文，做一遍深度一致性审计'} variant="secondary" size="md" className="ml-auto flex items-center rounded text-11">
              {aiLoading ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
              AI 深度审计
            </Button>
          </div>
          <AuditPanel
            issues={issues}
            emptyText="未发现连续性冲突 ✓ 时间脉络 / 境界 / 伏笔引用均自洽"
            onNavigateTab={onNavigateTab}
            onOpenChapter={onOpenChapter}
          />
          {aiError && (
            <div className="mt-2 flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/25 text-12 text-danger">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{aiError}</span>
            </div>
          )}
          {aiFindings.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <div className="text-11 text-ink-500">AI 一致性审计</div>
              {aiFindings.map((f, i) => (
                <div key={i} className="flex items-start gap-2 text-12">
                  <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${f.level === '严重' ? 'bg-red-400' : f.level === '中等' ? 'bg-amber' : 'bg-sky-400'}`} />
                  <span>
                    <span className="text-ink-200">{f.title}</span>
                    {f.detail ? <span className="text-ink-400"> —— {f.detail}</span> : null}
                    {f.where ? <span className="text-ink-500">（{f.where}）</span> : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </ToolModal>
  )
}

// ============ 文风体检 ============
export function StyleAudit({ content, onClose }: { content: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [issues, setIssues] = useState<AuditIssue[]>([])
  const { ready: aiReady } = useAIReady()
  const [aiStyle, setAiStyle] = useState<{ type: string; quote: string; issue: string; suggestion: string; level: string }[]>([])
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  const runAiStyle = async () => {
    setAiLoading(true); setAiError(null); setAiStyle([])
    try {
      const style = await getFormData('style').catch(() => ({} as Record<string, string>))
      const styleCtx = Object.entries(style)
        .map(([k, v]) => `${k.replace(/^.*::/, '')}：${(v ?? '').toString().slice(0, 200)}`)
        .filter(s => s.length > 2)
        .join('\n')
      const r = await aiStyleCheck(content, styleCtx)
      setAiStyle(r)
    } catch (e) { setAiError(e instanceof Error ? e.message : String(e)) }
    finally { setAiLoading(false) }
  }

  useEffect(() => {
    let cancelled = false
    auditStyle(content).then(r => {
      if (cancelled) return
      setIssues(r)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [content])

  return (
    <ToolModal title="文风体检（本章）" icon={<Feather size={16} />} onClose={onClose}
      help={
        <HelpPopover title="文风体检怎么用" width="22rem">
          {'建立在《写作规范》数据模型之上（竞品普遍缺失）：\n\n· 坏习惯词：自动抽取你「已知坏习惯清单」里的词（如「顿时」「瞬间」），统计本章命中次数；\n· 省略号：检测正文是否误用三个英文句点「...」代替中文「……」；\n· 视角规则：列出你立的视角切换规则，提醒人工核对（正文视角无法直接自动分析）。\n\n提示：先去《写作规范》填好你的坏习惯清单，本体检才精准。'}
          <AIDataSourceNote feature="style-check" />
        </HelpPopover>
      }
    >
      <div className="mb-3">
        <span className="text-11 text-ink-500">
          读取《写作规范》表的「个人坏习惯清单」与「标点规范」，对本章正文做静态体检。
        </span>
      </div>
      {loading ? <div className="text-12 text-ink-400 py-8 text-center">对照写作规范…</div> : (
        <>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-12 font-semibold text-ink-200">本地文风体检</span>
            <Button onClick={runAiStyle}
              disabled={!aiReady || aiLoading}
              
              title={!aiReady ? AI_DISABLED_HINT : '让 AI 对照《写作规范》体检本章文风（坏习惯词 / 视角 / 标点 / 节奏）'} variant="secondary" size="md" className="ml-auto flex items-center rounded text-11">
              {aiLoading ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
              AI 文风体检
            </Button>
          </div>
          <AuditPanel issues={issues} emptyText="本章文风体检通过 ✓" />
          {aiError && (
            <div className="mt-2 flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/25 text-12 text-danger">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{aiError}</span>
            </div>
          )}
          {aiStyle.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="text-11 text-ink-500">AI 文风体检</div>
              {aiStyle.map((f, i) => (
                <div key={i} className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`px-1.5 py-px rounded text-10 ${f.level === '严重' ? 'bg-danger/15 text-danger' : f.level === '中等' ? 'bg-amber/15 text-amber' : 'bg-info/15 text-info'}`}>{f.level}</span>
                    <span className="text-11 text-ink-400">{f.type}</span>
                  </div>
                  {f.quote && <div className="text-12 text-ink-200 mb-0.5">「{f.quote}」</div>}
                  <div className="text-12 text-ink-300">{f.issue}</div>
                  {f.suggestion && <div className="text-11 text-amber/80 mt-0.5">建议：{f.suggestion}</div>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </ToolModal>
  )
}
