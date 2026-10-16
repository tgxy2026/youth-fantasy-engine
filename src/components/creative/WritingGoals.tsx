import { useEffect, useState, useMemo } from 'react'
import * as db from '@/lib/db'
import { todayKey } from '@/lib/app/date'
import NumberField from '@/components/common/NumberField'
import { GOAL_ACTUAL_COLOR } from '@/lib/settings/palette'
import { useMonoTheme } from '@/lib/settings/useMonoTheme'

interface Props {
  totalWords: number
  dailyStats: db.DailyStat[]
}

/**
 * 写作目标与完稿预估（v1.3）
 * 设定：每日目标字数 / 全书目标字数 / 完稿截止日。
 * 基于最近 7 日平均日产与剩余字数，预估完稿日期。目标存于项目设置。
 */
export default function WritingGoals({ totalWords, dailyStats }: Props) {
  // 🔴 mono（3.1.1）：「实际累计」的语义绿失效 ⇒ 改由**实线 vs 目标虚线**区分（黑/白二值）
  const mono = useMonoTheme()
  const ink = 'rgb(var(--ink-100))'
  const [daily, setDaily] = useState(2000)
  const [total, setTotal] = useState(0)
  const [deadline, setDeadline] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    (async () => {
      const [d, t, dl] = await Promise.all([
        db.getSetting('goalDaily', 2000),
        db.getSetting('goalTotal', 0),
        db.getSetting('goalDeadline', ''),
      ])
      setDaily(d); setTotal(t); setDeadline(dl); setLoaded(true)
    })()
  }, [])

  const recentPace = useMemo(() => {
    // 🔴 2026-09-22 六维审计 P2：原来取「最近 7 **条**有记录的天」而不是「最近 7 个自然日」——
    //    `dailyStats` 只会在真的写了字的那天落一条，所以断更时这 7 条的区间能跨远超 7 天，
    //    算出来的「日均」被**系统性高估**（写在 UI 上却叫「近 7 日日均」）。
    //    改为按日期键回填近 7 个自然日（缺日按 0 计），与下方燃尽图用同一套写法。
    const byDate = new Map(dailyStats.map(d => [d.date, d.words]))
    const now = new Date()
    let sum = 0
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      sum += byDate.get(todayKey(dt)) ?? 0
    }
    return Math.round(sum / 7)
  }, [dailyStats])

  // v1.6.1：燃尽图数据 —— 近 14 天逐日累计「实际 / 目标」曲线（缺写字的天按 0 计）
  const BURNDOWN_DAYS = 14
  const burndown = useMemo(() => {
    const byDate = new Map(dailyStats.map(d => [d.date, d.words]))
    const days: { label: string; actualCum: number; targetCum: number }[] = []
    const now = new Date()
    let aCum = 0, tCum = 0
    for (let i = BURNDOWN_DAYS - 1; i >= 0; i--) {
      const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      const key = todayKey(dt)
      aCum += byDate.get(key) ?? 0
      tCum += daily
      days.push({ label: `${dt.getMonth() + 1}/${dt.getDate()}`, actualCum: aCum, targetCum: tCum })
    }
    return days
  }, [dailyStats, daily])
  const bMax = Math.max(1, ...burndown.map(d => Math.max(d.actualCum, d.targetCum)))
  const bW = 560, bH = 170, bL = 44, bR = 10, bT = 12, bB = 22
  const bX = (i: number) => bL + (i / (BURNDOWN_DAYS - 1)) * (bW - bL - bR)
  const bY = (v: number) => bT + (1 - v / bMax) * (bH - bT - bB)
  const bPath = (key: 'actualCum' | 'targetCum') =>
    burndown.map((d, i) => `${i === 0 ? 'M' : 'L'}${bX(i).toFixed(1)},${bY(d[key]).toFixed(1)}`).join(' ')

  const remaining = Math.max(0, total - totalWords)
  const daysNeeded = recentPace > 0 && total > 0 ? Math.ceil(remaining / recentPace) : 0
  const estDate = daysNeeded > 0 ? new Date(Date.now() + daysNeeded * 86400000) : null
  const totalPct = total > 0 ? Math.min(100, Math.round((totalWords / total) * 100)) : 0

  const save = async (patch: Partial<{ daily: number; total: number; deadline: string }>) => {
    if (patch.daily !== undefined) { setDaily(patch.daily); await db.setSetting('goalDaily', patch.daily) }
    if (patch.total !== undefined) { setTotal(patch.total); await db.setSetting('goalTotal', patch.total) }
    if (patch.deadline !== undefined) { setDeadline(patch.deadline); await db.setSetting('goalDeadline', patch.deadline) }
  }

  if (!loaded) return <div className="py-8 text-center text-ink-500 text-12">加载中…</div>

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="block">
          <div className="text-11 text-ink-400 mb-1">每日目标字数</div>
          <NumberField
            value={daily} min={0} max={100000} step={100}
            onChange={v => save({ daily: v ?? 0 })}
            className="w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-13 text-ink-100 outline-none focus:border-amber/50"
          />
        </label>
        <label className="block">
          <div className="text-11 text-ink-400 mb-1">全书目标字数</div>
          <NumberField
            value={total} min={0} max={100000000} step={10000}
            onChange={v => save({ total: v ?? 0 })}
            placeholder="例：1000000"
            className="w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-13 text-ink-100 outline-none focus:border-amber/50"
          />
        </label>
        <label className="block">
          <div className="text-11 text-ink-400 mb-1">完稿截止日</div>
          <input
            type="date" value={deadline}
            onChange={e => save({ deadline: e.target.value })}
            className="w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-13 text-ink-100 outline-none focus:border-amber/50"
          />
        </label>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-ink-800 rounded-lg px-3 py-2.5">
          <div className="text-10 text-ink-500">当前总字数</div>
          <div className="text-15 font-bold text-ink-50 mt-0.5">{totalWords.toLocaleString()}</div>
        </div>
        <div className="bg-ink-800 rounded-lg px-3 py-2.5">
          <div className="text-10 text-ink-500">近7日日均</div>
          <div className="text-15 font-bold text-amber mt-0.5">{recentPace.toLocaleString()}</div>
        </div>
        <div className="bg-ink-800 rounded-lg px-3 py-2.5">
          <div className="text-10 text-ink-500">距目标还差</div>
          <div className="text-15 font-bold text-ink-50 mt-0.5">{remaining.toLocaleString()}</div>
        </div>
        <div className="bg-ink-800 rounded-lg px-3 py-2.5">
          <div className="text-10 text-ink-500">预估完稿</div>
          <div className="text-15 font-bold text-success mt-0.5">
            {total > 0 ? (estDate ? estDate.toLocaleDateString() : '—') : '设目标'}
          </div>
        </div>
      </div>

      {total > 0 && (
        <div>
          <div className="flex items-center justify-between text-11 mb-1">
            <span className="text-ink-400">全书完成度</span>
            <span className="text-ink-200">{totalPct}%</span>
          </div>
          <div className="h-2 bg-ink-700 rounded-full overflow-hidden">
            <div className="h-full bg-amber/60 rounded-full transition-all duration-500" style={{ width: `${totalPct}%` }} />
          </div>
        </div>
      )}

      {/* v1.6.1：燃尽图 —— 近 14 天累计目标 vs 实际码字曲线（SVG 自绘，零依赖） */}
      {daily > 0 && burndown.length > 0 && (
        <div className="rounded-lg border border-ink-700 bg-ink-850 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-12 font-semibold text-ink-100">近 14 天燃尽图</span>
            <div className="flex items-center gap-3 text-10 text-ink-400">
              <span className="flex items-center gap-1">
                {/* ⚠️ 主题变量必须走 style：SVG 表现属性（stroke=/fill=）不解析 var()，写 stroke={ink} 会静默失效 → 图例线不画。
                    mono 下「目标累计」用虚线、「实际累计」用实线，靠线型而非颜色区分。 */}
                {mono ? <svg width="14" height="8" aria-hidden="true"><line x1="1" y1="4" x2="13" y2="4" style={{ stroke: ink }} strokeWidth="1.6" strokeDasharray="5 4" /></svg>
                  : <i className="w-3.5 h-0.5 bg-amber/70 inline-block rounded" />} 目标累计
              </span>
              <span className="flex items-center gap-1">
                {mono ? <svg width="14" height="8" aria-hidden="true"><line x1="1" y1="4" x2="13" y2="4" style={{ stroke: ink }} strokeWidth="2.4" /></svg>
                  : <i className="w-3.5 h-0.5 inline-block rounded" style={{ background: GOAL_ACTUAL_COLOR }} />} 实际累计
              </span>
            </div>
          </div>
          <svg viewBox={`0 0 ${bW} ${bH}`} className="w-full" style={{ maxHeight: bH }} role="img" aria-label="近14天码字燃尽图">
            {[0, 0.5, 1].map(f => (
              <g key={f}>
                {/* ⚠️ 主题变量必须走 style：SVG 表现属性（stroke=/fill=）不解析 var()。
                    原写作 stroke="rgb(var(--ink-700))" / fill="rgb(var(--ink-500))"，
                    实际一直无效并回退成黑色——网格线与轴标签此前与主题无关恒为黑。 */}
                <line x1={bL} x2={bW - bR} y1={bY(bMax * f)} y2={bY(bMax * f)} style={{ stroke: 'rgb(var(--ink-700))' }} strokeDasharray="3 3" strokeWidth={0.6} />
                <text x={bL - 6} y={bY(bMax * f) + 3} textAnchor="end" fontSize={9} style={{ fill: 'rgb(var(--ink-500))' }}>{Math.round(bMax * f).toLocaleString()}</text>
              </g>
            ))}
            {[0, Math.floor((BURNDOWN_DAYS - 1) / 2), BURNDOWN_DAYS - 1].map(i => (
              <text key={i} x={bX(i)} y={bH - 6} textAnchor={i === 0 ? 'start' : i === BURNDOWN_DAYS - 1 ? 'end' : 'middle'} fontSize={9} style={{ fill: 'rgb(var(--ink-500))' }}>{burndown[i].label}</text>
            ))}
            <path d={bPath('targetCum')} fill="none" style={{ stroke: mono ? ink : 'rgb(var(--amber))' }} strokeOpacity={mono ? 1 : 0.75} strokeWidth={mono ? 2 : 1.6} strokeDasharray="5 4" />
            <path d={bPath('actualCum')} fill="none" style={{ stroke: mono ? ink : GOAL_ACTUAL_COLOR }} strokeWidth={mono ? 2.4 : 2} />
            <circle cx={bX(BURNDOWN_DAYS - 1)} cy={bY(burndown[BURNDOWN_DAYS - 1].actualCum)} r={3} style={{ fill: mono ? ink : GOAL_ACTUAL_COLOR }} />
          </svg>
          <div className="text-10 text-ink-500 mt-1">
            今日累计 {burndown[BURNDOWN_DAYS - 1].actualCum.toLocaleString()} / 目标 {burndown[BURNDOWN_DAYS - 1].targetCum.toLocaleString()} 字
            {(() => {
              const diff = burndown[BURNDOWN_DAYS - 1].actualCum - burndown[BURNDOWN_DAYS - 1].targetCum
              return diff >= 0
                ? <span className="text-success"> · 超出目标 {diff.toLocaleString()} 字，节奏良好</span>
                : <span className="text-danger"> · 落后目标 {(-diff).toLocaleString()} 字，加把劲</span>
            })()}
          </div>
        </div>
      )}

      {deadline && (
        <div className="text-11 text-ink-400">
          截止日 {deadline}：按当前日均，{daysNeeded > 0 ? `还需约 ${daysNeeded} 天（${estDate?.toLocaleDateString()} 前完稿可达成）` : '已达标或暂无法预估'}
          {(() => {
            const dl = new Date(deadline).getTime()
            if (isNaN(dl) || daysNeeded === 0) return null
            const diff = Math.round((dl - Date.now()) / 86400000)
            if (diff < daysNeeded) return <span className="text-danger"> · 注意：截止日只剩 {diff} 天，按当前节奏恐难如期完稿</span>
            return null
          })()}
        </div>
      )}
      {recentPace === 0 && total > 0 && (
        <div className="text-11 text-ink-500">近 7 日暂无码字记录，无法预估完稿日期——先在编辑器写几章，或在「写作进度」登记每日字数。</div>
      )}
    </div>
  )
}
