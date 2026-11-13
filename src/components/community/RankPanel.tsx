// 投稿广场 · 码字排行榜（3.5.0）
//
// 口径为含标点的正文净增量。负数只抵扣当天，周/月累计已结束日期的正净增量。
// 🔴 匿名条目只显示「匿名用户」，不给编号或稳定标识 —— 否则不同周期一比对就能跨内容关联。
// 🔴 两种形态：`compact` = 宽屏广场右侧竖栏（只显示前十与口径摘要）；
//    完整形态 = 窄屏展开区域/独立查看，含日期与完整说明。

import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { fetchRank } from '@/lib/community/api'
import { cnDateKey } from '@/lib/community/rankLedger'
import type { RankBoard, RankPeriod } from '@/lib/community/types'
import { Empty, Notice, errorText } from '@/components/community/ui'

const PERIODS: Array<{ id: RankPeriod; label: string; short: string }> = [
  { id: 'day', label: '日榜', short: '日' },
  { id: 'week', label: '周榜', short: '周' },
  { id: 'month', label: '月榜', short: '月' },
]

interface Props {
  compact?: boolean
  /** 窄屏展开用：隐藏长篇说明，只留一句口径摘要（避免把正文挤出首屏） */
  dense?: boolean
  /** compact 下最多显示几名（窄屏展开时用更小的值，避免把正文挤出首屏） */
  max?: number
  onOpenSettings: () => void
  /** 3.5.1 · U1：外壳已独占连接/错误状态时，本面板只留一句中性占位，不再叠报错 */
  shellOwnsStatus?: boolean
}

export default function RankPanel({ compact = false, dense = false, max = 8, onOpenSettings, shellOwnsStatus = false }: Props) {
  const [period, setPeriod] = useState<RankPeriod>('day')
  const [date, setDate] = useState(() => cnDateKey())
  const [board, setBoard] = useState<RankBoard | null>(null)
  const [closed, setClosed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await fetchRank(period, date)
      setBoard({ period: r.period, range: r.range ?? null, entries: r.entries })
      setClosed(!!r.closed)
    } catch (e) { setError(errorText(e)); setBoard(null) } finally { setLoading(false) }
  }, [period, date])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const retry = () => { void load() }
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [load])

  // 3.5.1 · U1：连接/错误/关闭状态由外壳独占时，这里只给一句中性占位（非横幅），避免重复报错。
  if (shellOwnsStatus) {
    return <p className="text-11 text-ink-400">广场恢复后显示排行。</p>
  }

  const entries = board?.entries ?? []
  const shown = compact ? entries.slice(0, Math.max(1, max)) : entries

  return (
    <section aria-label="码字排行榜" className={compact ? 'space-y-3' : 'mx-auto w-full max-w-3xl space-y-4'}>
      <header className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className={`${compact ? 'text-13' : 'text-16'} font-semibold text-ink-100`}>码字排行</h3>
          <Button size="sm" variant="ghost" iconOnly aria-label="刷新排行" title="刷新排行" disabled={loading} onClick={() => void load()}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>
        {dense ? (
          <p className="text-11 text-ink-400">删减只抵扣当天，周榜和月榜累计已结束日期的正净增量。</p>
        ) : (
          <p className="text-11 leading-relaxed text-ink-400">
            按<b className="font-medium text-ink-300">含标点的正文净增量</b>统计，删减只抵扣当天。周榜和月榜累计每天结束后的正净增量。
          </p>
        )}
      </header>

      <div className="flex items-center gap-1" role="group" aria-label="排行周期">
        {PERIODS.map((p) => (
          <Button key={p.id} size="sm" variant="toggle" selected={period === p.id} onClick={() => setPeriod(p.id)}>
            {compact ? p.short : p.label}
          </Button>
        ))}
        {!compact && (
          <label className="ml-auto flex items-center gap-1 text-11 text-ink-300">
            参考日期
            <input type="date" value={date} onChange={(e) => setDate(e.target.value || cnDateKey())}
              className="rounded border border-ink-700 bg-ink-900 px-2 py-1 text-11 text-ink-100" />
          </label>
        )}
      </div>

      {board?.range && !compact && (
        <p className="text-11 text-ink-400">统计区间：{board.range.start} 至 {board.range.end}（北京时间）</p>
      )}

      {error && <Notice kind="error">{error}</Notice>}
      {/* 关闭态由外壳独占（square.open=false ⇒ shellOwnsStatus）；加载中用中性文字，不算状态横幅 */}
      {loading && !board && <p className="text-11 text-ink-400">正在读取排行…</p>}
      {!loading && board && entries.length === 0 && !closed && (
        <Empty title="这个周期还没有公开的排行数据" hint="只有主动开启排行同步的账号会出现在这里。" />
      )}

      <ol className="space-y-1">
        {shown.map((e, i) => (
          <li key={`${e.rank}-${i}`}
            className={`flex items-center gap-3 rounded-lg px-2.5 ${compact ? 'py-1.5' : 'py-2.5'} ${e.rank === 1 ? 'bg-amber/10' : 'bg-ink-900/40'}`}>
            <span className={`w-6 shrink-0 text-center text-12 font-semibold ${e.rank <= 3 ? 'text-amber' : 'text-ink-400'}`}>{e.rank}</span>
            <span className="min-w-0 flex-1 truncate text-12 text-ink-100">{e.displayName}</span>
            <span className="shrink-0 text-11 tabular-nums text-ink-300">{e.value.toLocaleString('zh-CN')}</span>
          </li>
        ))}
      </ol>

      {compact && entries.length > shown.length && (
        <p className="text-11 text-ink-400">当前仅显示前 {shown.length} 名；可切换日、周、月查看。</p>
      )}

      <div className="space-y-1.5 border-t border-ink-700/70 pt-2">
        {!dense && (
          <p className="text-11 leading-relaxed text-ink-400">
            排行默认关闭。参与只上传「日期 + 每个项目的净增量」，不上传正文、标题或项目名；
            与云同步资格无关，关闭即撤回已上传数据。
          </p>
        )}
        <Button size="sm" variant="ghost" onClick={onOpenSettings}>
          参与与匿名设置<ChevronRight size={12} />
        </Button>
        {!compact && (
          <p className="text-11 leading-relaxed text-ink-400">
            数据来自各设备上报，服务端按「账号 + 项目 + 日期」取最新一次上报并尽力去重；
            无法完全合并时可能略有偏差，我们不把它当精确账本，也不承诺防作弊。
          </p>
        )}
      </div>
    </section>
  )
}
