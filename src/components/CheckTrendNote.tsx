/**
 * 「上次检查」趋势行（2.9.1 引入，2026-10-09 从 `AuditModals.tsx` 提取供多处复用）。
 *
 * 为什么要有它：体检台账（`lib/checkLog.ts`）落库本身不是目的 ——
 * 作者真正要回答的是「这一轮的问题比上一轮是变好还是变坏」。
 * 少了这一行，台账就又是一次「存了没人读」（正是 2.9.1 要修的那类问题）。
 *
 * 消费者：伏笔闭环看板 / 连续性校验（`components/AuditModals.tsx`）、
 * 投稿前自检（`components/ManuscriptCheckPanel.tsx`，2.9.2 起）。
 */
import { humanAgo, type CheckTrend } from '../lib/checkLog'

export default function CheckTrendNote({ trend }: { trend: CheckTrend }) {
  const diff = trend.prev ? trend.cur.total - trend.prev.total : 0
  const cls = diff > 0 ? 'text-danger' : diff < 0 ? 'text-success' : 'text-ink-500'
  return (
    <span className="text-10 text-ink-500 whitespace-nowrap">
      上次检查 {trend.cur.total} 条（{humanAgo(trend.cur.ts)}）
      {trend.prev && (
        <span className={`ml-1.5 ${cls}`}>
          {diff > 0 ? `比上轮多 ${diff} 条` : diff < 0 ? `比上轮少 ${-diff} 条` : '与上轮持平'}
        </span>
      )}
    </span>
  )
}
