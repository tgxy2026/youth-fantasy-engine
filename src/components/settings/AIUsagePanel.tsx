/**
 * 3.0 · W1-4 AI 消耗统计（§10.3 #6）—— 挂在「模型设置」页。
 *
 * 把运行账本里的调用账（模型 / 耗时 / 是否被拒）按日·按项目汇总。
 *
 * 🔴 数据全部来自**本机**账本（`aiRuns` 表），不联网、不上报。
 * ⚠️ token 数暂未采集 —— 多数平台的**流式**响应不回 `usage`（长文生成全走流式），
 *    故本面板以「调用次数 / 耗时 / 被拒次数」为主，不假装有 token 数据。
 */
import { useCallback, useEffect, useState } from 'react'
import { Activity, Loader2, RefreshCw } from 'lucide-react'
import * as db from '@/lib/db'
import { listProjectAiRuns } from '@/lib/db'
import { summarizeUsage, type UsageSummary } from '@/lib/ai/aiUsageStats'
import { Button } from '@/components/common/Button'

function fmtMs(ms: number): string {
  if (!ms) return '0 秒'
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} 分钟`
  return `${(ms / 1000).toFixed(1)} 秒`
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2">
      <div className="text-10 text-ink-500">{label}</div>
      <div className={`text-15 font-semibold tabular-nums ${danger ? 'text-danger' : 'text-ink-100'}`}>{value}</div>
    </div>
  )
}

export default function AIUsagePanel() {
  const [sum, setSum] = useState<UsageSummary | null>(null)

  const load = useCallback(async () => {
    try {
      const pid = db.getCurrentProjectId() ?? ''
      setSum(summarizeUsage(await listProjectAiRuns(pid)))
    } catch {
      setSum(summarizeUsage([]))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <section className="rounded-xl border border-ink-700 bg-ink-850/40 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Activity size={14} className="text-amber" />
        <span className="text-13 font-semibold text-ink-100">AI 消耗统计</span>
        <span className="text-11 text-ink-500">本机记录 · 不联网</span>
        <div className="ml-auto">
          <Button variant="secondary" size="xs" onClick={() => void load()} className="gap-1">
            <RefreshCw size={11} /> 刷新
          </Button>
        </div>
      </div>

      {sum === null && (
        <div className="flex items-center gap-2 text-ink-400 text-12 py-3">
          <Loader2 size={13} className="animate-spin" /> 读取中…
        </div>
      )}

      {sum !== null && sum.calls === 0 && (
        <p className="text-12 text-ink-500 py-2">
          这个项目还没有 AI 调用记录。跑一次 AI 功能（如创意写作 / 续写）后回来看看。
        </p>
      )}

      {sum !== null && sum.calls > 0 && (
        <>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <Stat label="调用次数" value={sum.calls.toLocaleString()} />
            <Stat label="累计耗时" value={fmtMs(sum.totalMs)} />
            <Stat label="被内容拒绝" value={sum.refusalCalls.toLocaleString()} danger={sum.refusalCalls > 0} />
          </div>

          {sum.byModel.length > 0 && (
            <div className="mb-3">
              <div className="text-11 text-ink-400 mb-1.5">按模型</div>
              <ul className="space-y-1">
                {sum.byModel.map(m => (
                  <li key={m.model} className="flex items-center gap-2 text-12">
                    <span className="text-ink-200 truncate">{m.model}</span>
                    <span className="ml-auto shrink-0 text-ink-400 tabular-nums">{m.calls} 次 · {fmtMs(m.ms)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {sum.byDay.length > 0 && (
            <div>
              <div className="text-11 text-ink-400 mb-1.5">按日（最近 {Math.min(7, sum.byDay.length)} 天）</div>
              <ul className="space-y-1">
                {sum.byDay.slice(-7).map(d => (
                  <li key={d.day} className="flex items-center gap-2 text-12">
                    <span className="text-ink-300 tabular-nums">{d.day}</span>
                    <span className="ml-auto shrink-0 text-ink-400 tabular-nums">{d.calls} 次 · {fmtMs(d.ms)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <p className="mt-3 text-10 leading-relaxed text-ink-500">
        口径：每次模型调用记一条（模型 / 耗时 / 是否被内容政策拒绝）。费用由服务商按其价目收取，本页只记用量、不折算金额。
        token 数暂未采集（多数平台的流式响应不回 usage）。数据只在本机账本里，随项目导出 / 备份一并带走。
      </p>
    </section>
  )
}
