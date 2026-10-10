/**
 * 「上次检查」趋势行（2.9.1 引入，2026-10-09 从 `AuditModals.tsx` 提取供多处复用）。
 *
 * 为什么要有它：体检台账（`lib/checkLog.ts`）落库本身不是目的 ——
 * 作者真正要回答的是「这一轮的问题比上一轮是变好还是变坏」。
 * 少了这一行，台账就又是一次「存了没人读」（正是 2.9.1 要修的那类问题）。
 *
 * 消费者：伏笔闭环看板 / 连续性校验（`components/AuditModals.tsx`）、
 * 投稿前自检（`components/ManuscriptCheckPanel.tsx`，2.9.2 起）、
 * 节奏与章末钩子（`components/PaceAnalysisPanel.tsx`，2.9.2 · ④ 起 —— 用 `neutral` 形态）。
 */
import { humanAgo, type CheckTrend } from '@/lib/audit/checkLog'

export default function CheckTrendNote({ trend, neutral = false, noun = '条' }: {
  trend: CheckTrend
  /**
   * **观察类**引擎（节奏与章末钩子）：多 ≠ 坏 —— 爆点变多不一定更好、变少也可能是这本该收束。
   * 故不染红绿（体检类默认染：问题变多是坏事，这条判据对它们成立）。
   */
  neutral?: boolean
  /** 计数单位：体检类说「条」，观察类说「个观察点」（默认保持既有调用方一字不变） */
  noun?: string
}) {
  const diff = trend.prev ? trend.cur.total - trend.prev.total : 0
  const cls = neutral ? 'text-ink-400' : diff > 0 ? 'text-danger' : diff < 0 ? 'text-success' : 'text-ink-500'
  return (
    <span className="text-10 text-ink-500 whitespace-nowrap">
      上次检查 {trend.cur.total} {noun}（{humanAgo(trend.cur.ts)}）
      {trend.prev && (
        <span className={`ml-1.5 ${cls}`}>
          {diff > 0 ? `比上轮多 ${diff} ${noun}` : diff < 0 ? `比上轮少 ${-diff} ${noun}` : '与上轮持平'}
        </span>
      )}
    </span>
  )
}
