// 投稿广场 · 码字排行榜（3.5.0）
//
// 🔴 口径（与规划一致）：**含标点的正文净增量**；周/月先把周期内各日增减相加再排名，
//    展示值最低为 0，但负数仍参与抵扣。传统计口径写在页面顶部，不让人猜。
// 🔴 匿名条目只显示「匿名用户」，不给编号或稳定标识 —— 否则不同周期一比对就能跨内容关联。

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/common/Button'
import { fetchRank } from '@/lib/community/api'
import { cnDateKey } from '@/lib/community/rankLedger'
import type { RankBoard, RankPeriod } from '@/lib/community/types'
import { Empty, Notice, StatusPill, errorText } from '@/components/community/ui'

const PERIODS: Array<{ id: RankPeriod; label: string }> = [
  { id: 'day', label: '日榜' },
  { id: 'week', label: '周榜' },
  { id: 'month', label: '月榜' },
]

export default function RankPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {PERIODS.map((p) => (
          <Button key={p.id} size="sm" variant="toggle" selected={period === p.id} onClick={() => setPeriod(p.id)}>{p.label}</Button>
        ))}
        <label className="flex items-center gap-1 text-11 text-ink-300">
          参考日期
          <input type="date" value={date} onChange={(e) => setDate(e.target.value || cnDateKey())}
            className="rounded border border-ink-700 bg-ink-900 px-2 py-1 text-11 text-ink-100" />
        </label>
        <Button size="xs" variant="ghost" disabled={loading} onClick={() => void load()}>刷新</Button>
        <Button size="xs" variant="ghost" onClick={onOpenSettings}>参与设置</Button>
      </div>

      <Notice>
        排行按<b>含标点的项目正文净增量</b>计算：新增与删除相抵；
        周榜、月榜先把周期内每天的有符号增减相加再排名（每天不单独截到 0），展示值最低为 0。
        只统计正文，不含标题、设定与其他资料；统计与云同步资格无关，默认关闭。
      </Notice>

      {error && <Notice kind="error">{error}</Notice>}
      {closed && <Notice kind="warn">广场暂时关闭，排行暂不可见。</Notice>}
      {loading && <Notice>正在读取排行…</Notice>}

      {board && board.range && (
        <p className="text-11 text-ink-400">统计区间：{board.range.start} 至 {board.range.end}（北京时间）</p>
      )}

      {board && board.entries.length === 0 && !loading && (
        <Empty title="这个周期还没有公开的排行数据" hint="只有主动开启排行同步的账号会出现在这里。" />
      )}

      <ul className="space-y-1.5">
        {(board?.entries ?? []).map((e, i) => (
          <li key={`${e.rank}-${i}`} className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-900/50 px-3 py-2">
            <span className="w-8 text-12 font-semibold text-amber">{e.rank}</span>
            <span className="min-w-0 flex-1 truncate text-13 text-ink-100">{e.displayName}</span>
            <StatusPill>{e.value.toLocaleString('zh-CN')} 字</StatusPill>
          </li>
        ))}
      </ul>

      <p className="text-11 leading-relaxed text-ink-400">
        排行数据来自各设备上报，服务端会按「账号 + 项目 + 日期」取最新一次上报，多设备尽量去重；
        无法完全合并时可能略有偏差，我们不会把它当作精确账本。代码统计属于用户设备上报，不承诺防作弊。
      </p>
    </div>
  )
}