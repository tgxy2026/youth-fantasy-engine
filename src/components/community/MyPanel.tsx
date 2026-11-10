// 投稿广场 · 我的投稿 / 评论 / 举报 / 申诉（3.5.0）
//
// 作者能在这里看到**状态与原因**：审核中、需修改、未通过、已撤回、已下架。
// 🔴 页面只展示「自己的」内容，服务端按会话 uid 过滤；这里不拼任何账号参数。
// 🔴 「改为匿名 / 显示昵称」只改展示、不重新审核 —— 但**不能消除**已经被他人看到或保存的关联。

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/common/Button'
import { confirmDialog } from '@/components/dialogs/dialogs'
import {
  deleteComment, deletePost, myAppeals, myComments, myPosts, myReports,
  setPostDisplay, submitAppeal, submitPost, withdrawPost,
} from '@/lib/community/api'
import type { MyComment, MyPost } from '@/lib/community/types'
import { COMMENT_STATUS_LABELS, POST_STATUS_LABELS, SCREENING_REASON_LABELS } from '@/lib/community/limits'
import { Empty, Notice, StatusPill, errorText, formatTime } from '@/components/community/ui'
import type { EditTarget } from '@/components/community/PublishPanel'

interface Props {
  onEdit: (target: EditTarget) => void
  onChanged: () => void
}

interface MyReportRow { id: string; targetType: string; targetId: string; status: string; createdAt: number; outcome: string }
interface MyAppealRow { id: string; postId: string; status: string; createdAt: number; outcome: string }

const statusTone = (s: string): 'neutral' | 'ok' | 'warn' | 'bad' =>
  s === 'published' || s === 'visible' ? 'ok' : s === 'pending' ? 'warn' : s === 'rejected' || s === 'removed' ? 'bad' : 'neutral'

const canAppeal = (p: MyPost): boolean =>
  p.status === 'rejected' || p.status === 'changes_requested' || p.status === 'removed'
  || (p.lastDecision?.action === 'reject' || p.lastDecision?.action === 'request_changes' || p.lastDecision?.action === 'remove')

export default function MyPanel({ onEdit, onChanged }: Props) {
  const [posts, setPosts] = useState<MyPost[] | null>(null)
  const [comments, setComments] = useState<MyComment[] | null>(null)
  const [reports, setReports] = useState<MyReportRow[] | null>(null)
  const [appeals, setAppeals] = useState<MyAppealRow[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const [p, c, r, a] = await Promise.all([myPosts(), myComments(), myReports(), myAppeals()])
      setPosts(p.items); setComments(c.items); setReports(r.items); setAppeals(a.items)
    } catch (e) { setError(errorText(e)) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function act(key: string, fn: () => Promise<unknown>, message: string) {
    setBusy(key); setNotice(''); setError('')
    try {
      await fn()
      setNotice(message)
      await load()
      onChanged()
    } catch (e) { setError(errorText(e)) } finally { setBusy('') }
  }

  async function appeal(p: MyPost) {
    const ok = await confirmDialog({
      title: '提交申诉',
      message: `将对《${p.title || '未命名'}》的审核结果申请复核。\n\n申诉会绑定当时被审核的那一版内容；管理员复核通过后会重新进入待审队列，重新审核通过前不会公开。`,
      confirmText: '提交申诉',
    })
    if (!ok) return
    await act(p.id, () => submitAppeal({ postId: p.id, versionId: p.lastDecision?.versionId, reason: '作者对审核结果提出申诉' }), '申诉已提交，管理员复核后会更新状态')
  }

  async function toggleDisplay(p: MyPost) {
    const next = p.display === 'anonymous' ? 'nickname' : 'anonymous'
    await act(`display-${p.id}`, () => setPostDisplay(p.id, next),
      next === 'anonymous'
        ? '已改为匿名展示；已经被他人看到或保存的内容无法收回。'
        : '已改为显示昵称；这会让不同内容之间更容易被关联。')
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="ok">{notice}</Notice>}

      <section aria-label="我的投稿" className="space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-15 font-semibold text-ink-100">我的投稿</h3>
          <span className="text-11 text-ink-400">{posts ? `共 ${posts.length} 篇` : ''}</span>
        </div>
        {posts === null && <Notice>正在读取…</Notice>}
        {posts?.length === 0 && <Empty title="还没有投稿" hint="到「投稿」页写一段愿意公开的文字试试。" />}
        <ul className="space-y-3">
          {(posts ?? []).map((p) => (
            <li key={p.id} className="rounded-2xl border border-ink-700 bg-ink-900/50 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-15 font-semibold text-ink-100">{p.title || '（未命名）'}</span>
                <StatusPill tone={statusTone(p.status)}>{POST_STATUS_LABELS[p.status] || p.status}</StatusPill>
                <StatusPill>{p.display === 'anonymous' ? '匿名展示' : '显示昵称'}</StatusPill>
                <span className="ml-auto text-11 text-ink-400">更新于 {formatTime(p.updatedAt)}</span>
              </div>
              {p.lastDecision?.reason && (
                <p className="mt-2 rounded-lg border border-amber/25 bg-amber/5 px-3 py-2 text-12 leading-6 text-amber">
                  审核意见：{p.lastDecision.reason}
                </p>
              )}
              <p className="mt-2 text-11 text-ink-400">赞 {p.counts.up} · 踩 {p.counts.down} · 评论 {p.counts.comments}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {p.status === 'draft' && (
                  <Button size="sm" disabled={busy === p.id} onClick={() => void act(p.id, () => submitPost(p.id), '已提交审核')}>提交审核</Button>
                )}
                {p.status !== 'withdrawn' && p.status !== 'removed' && (
                  <Button size="sm" variant="secondary" onClick={() => onEdit({
                    id: p.id, title: p.title, body: p.body, tags: p.tags, display: p.display, hasPublishedVersion: p.hasPublishedVersion,
                  })}>编辑</Button>
                )}
                {p.hasPublishedVersion && p.status !== 'withdrawn' && p.status !== 'removed' && (
                  <Button size="sm" variant="ghost" disabled={busy === `display-${p.id}`} onClick={() => void toggleDisplay(p)}>
                    {p.display === 'anonymous' ? '改为显示昵称' : '改为匿名'}
                  </Button>
                )}
                {canAppeal(p) && (
                  <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => void appeal(p)}>申诉</Button>
                )}
                {p.status !== 'withdrawn' && p.status !== 'removed' && (
                  <Button size="sm" variant="ghost" disabled={busy === p.id}
                    onClick={() => void act(p.id, () => withdrawPost(p.id), '已撤回，公开展示已停止')}>撤回</Button>
                )}
                <Button size="sm" variant="danger" disabled={busy === p.id}
                  onClick={async () => {
                    const ok = await confirmDialog({ title: '删除这篇投稿？', message: '删除后立即停止公开展示，无法恢复；争议处理所需的记录会按政策保留。', confirmText: '删除', danger: true })
                    if (ok) await act(p.id, () => deletePost(p.id), '已删除')
                  }}>删除</Button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="我的申诉" className="space-y-3">
        <h3 className="text-15 font-semibold text-ink-100">我的申诉</h3>
        {appeals?.length === 0 && <p className="text-12 text-ink-400">还没有提交过申诉。审核未通过或内容被下架时，可以在上方对应投稿点「申诉」。</p>}
        <ul className="space-y-2">
          {(appeals ?? []).map((a) => (
            <li key={a.id} className="rounded-xl border border-ink-700 bg-ink-900/40 p-3 text-12 text-ink-200">
              <StatusPill tone={a.status === 'closed' ? 'ok' : 'warn'}>{a.status === 'closed' ? '已复核' : '复核中'}</StatusPill>
              <span className="ml-2 text-11 text-ink-400">{formatTime(a.createdAt)}</span>
              {a.outcome && <p className="mt-1 text-11 text-ink-300">结果：{a.outcome}</p>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="我的评论" className="space-y-3">
        <h3 className="text-15 font-semibold text-ink-100">我的评论</h3>
        {comments?.length === 0 && <p className="text-12 text-ink-400">还没有评论。</p>}
        <ul className="space-y-2">
          {(comments ?? []).map((c) => (
            <li key={c.id} className="rounded-xl border border-ink-700 bg-ink-900/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={statusTone(c.status)}>{COMMENT_STATUS_LABELS[c.status] || c.status}</StatusPill>
                <span className="text-11 text-ink-400">{formatTime(c.createdAt)}</span>
              </div>
              <p className="mt-1 break-words text-13 leading-6 text-ink-200">{c.body}</p>
              {c.screening.length > 0 && (
                <p className="mt-1 text-11 text-amber">
                  待审原因：{c.screening.map((r) => SCREENING_REASON_LABELS[r] || r).join('、')}
                </p>
              )}
              {c.status !== 'removed' && (
                <Button size="xs" variant="ghost" className="mt-1" disabled={busy === c.id}
                  onClick={() => void act(c.id, () => deleteComment(c.id), '评论已删除')}>删除</Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="我的举报" className="space-y-3">
        <h3 className="text-15 font-semibold text-ink-100">我的举报</h3>
        {reports?.length === 0 && <p className="text-12 text-ink-400">还没有提交过举报。</p>}
        <ul className="space-y-2">
          {(reports ?? []).map((r) => (
            <li key={r.id} className="rounded-xl border border-ink-700 bg-ink-900/40 p-3 text-12 text-ink-200">
              <span className="mr-2 text-11 text-ink-400">{formatTime(r.createdAt)}</span>
              {r.targetType === 'post' ? '投稿' : '评论'} · {r.status === 'closed' ? `已处理：${r.outcome || '已关闭'}` : '处理中'}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}