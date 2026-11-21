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
import { Activity, Gauge, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import * as db from '@/lib/db'
import { listProjectAiRuns } from '@/lib/db'
import { summarizeUsage, type UsageSummary } from '@/lib/ai/aiUsageStats'
import { Button } from '@/components/common/Button'
import HelpPopover from '@/components/common/HelpPopover'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import {
  clearAiMetrics, flushAiMetrics, summarizeAiMetrics,
  type AiMetricFeature, type AiMetricSummary,
} from '@/lib/ai/metrics'

/** 功能名 → 用户看得懂的名字（键是固定枚举，别改成自由字符串） */
const FEATURE_LABEL: Record<AiMetricFeature, string> = {
  candidate: '剧情候选',
  proofread: '审读',
  postprocess: '章后整理',
  reference: '创作参考',
  other: '其他',
}

const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`)

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
  /** 3.6.2 · W5：质量度量（近 30 天接受率）。与上面的"用量"互补：一个看花了多少，一个看有没有用 */
  const [metrics, setMetrics] = useState<AiMetricSummary[] | null>(null)

  const load = useCallback(async () => {
    try {
      // 埋点是异步落库的，先等一拍再读，免得刚点的操作在面板里"没算上"
      await flushAiMetrics().catch(() => {})
      setMetrics(await summarizeAiMetrics({ days: 30 }))
    } catch {
      setMetrics([])
    }
    try {
      const pid = db.getCurrentProjectId() ?? ''
      setSum(summarizeUsage(await listProjectAiRuns(pid)))
    } catch {
      setSum(summarizeUsage([]))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const clearMetrics = async () => {
    const ok = await confirmDialog({
      title: '清空 AI 质量统计？',
      message: '会删除本机记录的「显示 / 采纳 / 放弃 / 撤回」计数，无法恢复。\n\n这些数字只用于你自己观察接受率，清空不影响任何作品内容。',
      danger: true,
    })
    if (!ok) return
    await clearAiMetrics()
    setMetrics([])
    showToast('已清空 AI 质量统计', 'info')
  }

  return (
    <section className="rounded-xl border border-ink-700 bg-ink-850/40 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Activity size={14} className="text-amber" />
        <h2 className="text-14 font-semibold text-ink-100">AI 消耗统计</h2>
        <HelpPopover title="AI 消耗统计怎么算" width="22rem" size={12}>
          <div className="space-y-1.5 text-11 leading-relaxed">
            <p>这里只统计<b>本机</b>发生的调用：调用次数、累计耗时、被内容策略拒绝的次数，按模型与用途分开列。表里的数字来自运行账本，<b>不联网、也不上报</b>。</p>
            <p>「被内容拒绝」是厂商侧拒绝（例如触发安全策略），不是额度用尽；它单列出来，是为了让你分得清"没生成"和"生成失败"。</p>
            <p>换模型或换设备后，历史数字不会跟过来 —— 两份账不在一个地方，不能相加。</p>
          </div>
        </HelpPopover>
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

      {/**
        * 3.6.2 · W5「AI 质量度量」。
        * 🔴 与上面的消耗统计分开：那个回答"花了多少"，这个回答"有没有用"。
        *    换模型 / 改提示词前后各看一次，才有对比可言。
        */}
      <div className="mt-4 border-t border-ink-700 pt-3">
        <div className="flex items-center gap-2 mb-2">
          <Gauge size={13} className="text-amber" />
          <span className="text-12 font-semibold text-ink-100">AI 质量（近 30 天）</span>
          <HelpPopover title="这些数字怎么来的" width="20rem" size={12}>
            <div className="space-y-1.5 text-11 leading-relaxed">
              <p>每次 AI 结果出现算一次<b>显示</b>；你点采纳 / 放弃 / 重新生成 / 撤回各记一次对应事件。</p>
              <p><b>接受率 = 采纳 ÷ 显示</b>。换模型或改提示词前后各看一次，就能对比是否真的更顺手。</p>
              <p>只记事件与功能名，<b>不记任何正文</b>；数据只在本机，不上传、不进备份。</p>
            </div>
          </HelpPopover>
          <span className="text-10 text-ink-500">仅存本机</span>
          <div className="ml-auto">
            <Button variant="bare" size="xs" onClick={() => void clearMetrics()} className="gap-1 text-11 text-ink-400 hover:text-danger">
              <Trash2 size={11} /> 清空
            </Button>
          </div>
        </div>

        {metrics === null ? (
          <p className="text-11 text-ink-500">读取中…</p>
        ) : metrics.length === 0 ? (
          <p className="text-11 text-ink-500 leading-relaxed">
            还没有 AI 质量记录。用一次「剧情候选」并采纳 / 放弃几条，这里就会出现接受率。
          </p>
        ) : (
          <ul className="space-y-1">
            {metrics.map(m => (
              <li key={m.feature} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-11">
                <span className="text-ink-200 w-16 shrink-0">{FEATURE_LABEL[m.feature]}</span>
                <span className="text-ink-400">
                  显示 {m.shown} · 采纳 {m.accepted} · 放弃 {m.rejected} · 重生成 {m.regenerated} · 撤回 {m.undone}
                </span>
                <span className="ml-auto shrink-0 tabular-nums text-ink-300">
                  接受率 <b className="text-amber">{pct(m.acceptanceRate)}</b>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
