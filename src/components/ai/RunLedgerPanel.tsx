/**
 * 3.0 · W1-1d AI 运行账本查看器
 *
 * 把 `aiRuns` 表里的记录如实列出来 —— 「这本书的 AI 是怎么被调用的」：
 * 任务 / 状态 / 时长 / 候选 / 验收回执 / 失败原因。
 *
 * 🔴 只读：账本是**过程留痕**，本面板不做增删改（延续「AI 只辅助、不越权」）。
 *    数据随项目导出 / 备份一并带走（见 ProjectBundle.aiRuns）。
 */
import { useCallback, useEffect, useState } from 'react'
import { History, Loader2, RefreshCw, X } from 'lucide-react'
import * as db from '@/lib/db'
import { listProjectAiRuns } from '@/lib/db'
import type { AiRun } from '@/lib/ai/aiRunTypes'
import { Button } from '@/components/common/Button'
import { Z } from '@/lib/app/zLayer'
import { foldVh } from '@/lib/settings/theme'
import { manifestGaps } from '@/lib/ai/requestBudget'

const KIND_LABEL: Record<string, string> = {
  creative: '创意写作',
  rewrite: '整章改写',
  continue: '续写',
  ghost: '伴写',
  'tavern-free': '酒馆自由对话',
  other: '其他',
}

const STATUS_STYLE: Record<AiRun['status'], { text: string; cls: string }> = {
  running: { text: '进行中', cls: 'text-info' },
  done: { text: '完成', cls: 'text-success' },
  failed: { text: '失败', cls: 'text-danger' },
  aborted: { text: '已中止', cls: 'text-ink-400' },
}

function fmt(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function RunLedgerPanel({ onClose }: { onClose: () => void }) {
  const [runs, setRuns] = useState<AiRun[] | null>(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const pid = db.getCurrentProjectId() ?? ''
      const list = await listProjectAiRuns(pid)
      setRuns(list.sort((a, b) => b.startedAt - a.startedAt))
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setRuns([])
    }
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <div className="fixed inset-0 flex items-center justify-center p-6 bg-ink-950/70 backdrop-blur-sm" style={{ zIndex: Z.modal }}>
      <div className="w-full max-w-[720px] flex flex-col rounded-2xl bg-ink-850 border border-ink-700 shadow-2xl overflow-hidden" style={{ maxHeight: foldVh('80vh') }}>
        {/* 头部 */}
        <div className="px-6 py-4 border-b border-ink-700/70 flex items-center gap-2">
          <History size={16} className="text-amber" />
          <div className="text-14 font-semibold text-ink-50">AI 运行账本</div>
          <div className="text-11 text-ink-500">这本书的 AI 调用留痕</div>
          <button onClick={onClose} className="ml-auto text-ink-400 hover:text-ink-100" title="关闭">
            <X size={16} />
          </button>
        </div>

        {/* 主体 */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {runs === null && (
            <div className="flex items-center justify-center py-10 gap-2 text-ink-400">
              <Loader2 size={18} className="animate-spin text-amber" />
              <span className="text-13">读取中…</span>
            </div>
          )}
          {runs !== null && err !== '' && (
            <div className="text-12 text-danger py-4">读取失败：{err}</div>
          )}
          {runs !== null && err === '' && runs.length === 0 && (
            <div className="text-13 text-ink-500 py-8 text-center">
              这个项目还没有 AI 运行记录。
              <div className="text-11 mt-1.5">跑一次「创意写作」后回来看看。</div>
            </div>
          )}
          {runs !== null && runs.length > 0 && (
            <ul className="space-y-2.5">
              {runs.map(r => {
                const st = STATUS_STYLE[r.status]
                // 3.2.0 · W3：候选条数**不含已丢弃稿** —— 否则"生成了 3 稿、丢了 2 稿"会显示成
                // "候选 3 条"，作者会以为有 3 条等着他选。丢弃数单独标出来。
                const candCount = r.candidates.filter(c => c.state !== 'discarded').reduce((n, c) => n + c.count, 0)
                const discardedCount = r.candidates.filter(c => c.state === 'discarded').reduce((n, c) => n + c.count, 0)
                // 3.2.0 · WQ4：清单里的「未带入/只带一部分」明细（含原因）；
                // 老记录没有 manifest ⇒ 退回原来的 dropped 列表，不假装有原因。
                const gaps = r.context?.manifest ? manifestGaps(r.context.manifest) : []
                const droppedDetail = gaps.length > 0
                  ? gaps.map(g => `${g.source.ref}（${g.reason ?? (g.scope === 'trimmed' ? '只带了一部分' : '未带入')}）`).join('\n')
                  : (r.context?.dropped ?? []).join('、')
                return (
                  <li key={r.id} className="rounded-xl bg-ink-900/50 border border-ink-700/60 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-11 px-1.5 py-0.5 rounded bg-ink-800 text-ink-300">
                        {KIND_LABEL[r.kind] ?? r.kind}
                      </span>
                      <span className="text-13 text-ink-100">{r.title}</span>
                      <span className={`ml-auto text-11 ${st.cls}`}>{st.text}</span>
                    </div>
                    <div className="mt-1.5 text-11 text-ink-500">
                      {fmt(r.startedAt)}
                      {r.finishedAt > 0 && <> · 用时 {Math.max(0, Math.round((r.finishedAt - r.startedAt) / 1000))} 秒</>}
                    </div>
                    {r.outcome && (
                      <div className="mt-1 text-11 text-ink-400">
                        新建 {r.outcome.created} · 更新 {r.outcome.updated}
                        {r.outcome.failed.length > 0 && <span className="text-danger"> · 失败 {r.outcome.failed.length}</span>}
                      </div>
                    )}
                    {(candCount > 0 || discardedCount > 0) && (
                      <div className="mt-1 text-11 text-ink-500">
                        {candCount > 0 && `候选 ${candCount} 条`}
                        {candCount > 0 && discardedCount > 0 && ' · '}
                        {discardedCount > 0 && <span title="生成了但被丢弃的稿（内容异常或作者选择重写）">丢弃 {discardedCount} 稿</span>}
                      </div>
                    )}
                    {r.calls.length > 0 && (
                      <div className="mt-1 text-11 text-ink-500">
                        模型调用 {r.calls.length} 次
                        {/* 3.2.0 · WQ6：首字耗时（流式才有）。取最快的一次 —— 作者关心的是"最好能多快" */}
                        {(() => {
                          const fb = r.calls
                            .map(c => c.firstByteMs)
                            .filter((v): v is number => typeof v === 'number' && v >= 0)
                          if (fb.length === 0) return null
                          return <span title="从发出请求到第一个字出现（最快的一次）"> · 首字 {(Math.min(...fb) / 1000).toFixed(1)}s</span>
                        })()}
                        {/* 3.2.0 · WQ5：本次调用的协议降级（如"端点不支持推理＋结构"） */}
                        {(() => {
                          const lims = r.calls.flatMap(c => c.protocol?.limitations ?? [])
                          if (lims.length === 0) return null
                          return (
                            <span className="text-amber" title={[...new Set(lims)].join('\n')}>
                              {' '}· {lims.length} 处协议降级
                            </span>
                          )
                        })()}
                        {/* 3.2.0 · WQ7：并行期间被**排除**的调用 —— 少算要说明白，不能悄悄少算 */}
                        {r.excludedCalls && r.excludedCalls.count > 0 && (
                          <span
                            className="text-amber"
                            title={r.excludedCalls.reasons.join('\n')}
                          >
                            {' '}· 另有 {r.excludedCalls.count} 次调用未计入
                          </span>
                        )}
                        {/* 兼容归属：只在**混着**的时候提示（全是兼容归属属于当前常态，标出来只是噪音） */}
                        {r.legacyAttributedCalls !== undefined
                          && r.legacyAttributedCalls > 0
                          && r.legacyAttributedCalls < r.calls.length && (
                          <span
                            className="text-ink-500"
                            title="这些调用当时只有一个任务在跑，按兼容路径归属；调用方补上显式任务 ID 后会变成精确归属"
                          >
                            {' '}· 其中 {r.legacyAttributedCalls} 次为兼容归属
                          </span>
                        )}
                      </div>
                    )}
                    {r.context && (
                      <div className="mt-1 text-11 text-ink-500">
                        上下文：{r.context.sections.length} 段 / {r.context.chars} 字
                        {r.context.dropped.length > 0 && (
                          <span className="text-amber" title={droppedDetail}>
                            {' '}· 预算外未带 {r.context.dropped.length} 段
                          </span>
                        )}
                        {/* 3.1.3 R3：与「完全没带」分开显示 —— 这些带了一部分，作者得知道不能当全集看 */}
                        {(r.context.trimmed?.length ?? 0) > 0 && (
                          <span className="text-amber" title={droppedDetail}>
                            {' '}· 只带了一部分 {(r.context.trimmed ?? []).length} 段
                          </span>
                        )}
                      </div>
                    )}
                    {r.error !== '' && <div className="mt-1 text-11 text-danger">失败原因：{r.error}</div>}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* 底部 */}
        <div className="px-6 py-4 border-t border-ink-700/70 flex items-center justify-between gap-3">
          <span className="text-11 text-ink-500">只读留痕；账本随项目导出 / 备份一并带走。</span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void load()} className="gap-1.5">
              <RefreshCw size={13} /> 刷新
            </Button>
            <Button variant="primary" size="sm" onClick={onClose}>关闭</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
