// 投稿广场 · 浏览与详情（3.5.0）
//
// 未登录也能看（服务端允许公共读）；能写时才显示操作按钮 —— 按钮隐藏不是权限控制，
// 服务端每个写接口都会再判一次，这里只是不给出「点了必失败」的入口。

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, MessageSquare, ThumbsDown, ThumbsUp } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { COMMUNITY_LIMITS, COMMUNITY_TAGS, charCount } from '@/lib/community/limits'
import {
  addComment, getPost, listComments, listPosts, reportContent, votePost,
  CommunityError,
} from '@/lib/community/api'
import type { CommunityComment, CommunityPostDetail, CommunityPostSummary } from '@/lib/community/types'
import { Empty, Notice, StatusPill, errorText, formatTime } from '@/components/community/ui'

interface Props {
  canWrite: boolean
  defaultDisplay: 'nickname' | 'anonymous'
  onNeedLogin: () => void
}

export default function FeedPanel({ canWrite, defaultDisplay, onNeedLogin }: Props) {
  const [items, setItems] = useState<CommunityPostSummary[]>([])
  const [cursor, setCursor] = useState('')
  const [tag, setTag] = useState('')
  // 🔴 翻页参数走 ref：`load` 若把 cursor/tag 放进 deps，每次拿到新游标都会重建函数，
  //    进而触发「初次加载」effect 再跑一次（重复请求第一页）。
  const cursorRef = useRef('')
  const tagRef = useRef('')
  const [closed, setClosed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [openId, setOpenId] = useState('')
  const [detail, setDetail] = useState<CommunityPostDetail | null>(null)
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'gone'>('idle')
  const [comments, setComments] = useState<CommunityComment[]>([])
  const [commentText, setCommentText] = useState('')
  const [commentDisplay, setCommentDisplay] = useState<'nickname' | 'anonymous'>(defaultDisplay)
  const [busy, setBusy] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportReason, setReportReason] = useState('广告或引流')
  const [reportDetail, setReportDetail] = useState('')

  const load = useCallback(async (opts: { append?: boolean; tag?: string } = {}) => {
    setLoading(true); setError('')
    try {
      const r = await listPosts({
        tag: opts.tag ?? tagRef.current,
        cursor: opts.append ? cursorRef.current : '',
      })
      setItems(opts.append ? (prev) => [...prev, ...r.items] : r.items)
      setCursor(r.nextCursor)
      cursorRef.current = r.nextCursor
      setClosed(!!r.closed)
    } catch (e) {
      setError(errorText(e))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function openPost(id: string) {
    setOpenId(id); setDetail(null); setDetailState('loading'); setComments([]); setNotice(''); setReportOpen(false)
    try {
      const r = await getPost(id)
      if (r.unavailable || !r.post) { setDetailState('gone'); return }
      setDetail(r.post)
      setDetailState('idle')
      const c = await listComments(id)
      setComments(c.items)
    } catch (e) {
      setError(errorText(e)); setDetailState('gone')
    }
  }

  async function vote(value: 1 | -1) {
    if (!detail) return
    if (!canWrite) { onNeedLogin(); return }
    setBusy(true)
    try {
      const next = detail.myVote === value ? 0 : value
      const r = await votePost(detail.id, next as 1 | -1 | 0)
      setDetail({ ...detail, counts: r.counts, myVote: r.myVote })
      setItems((prev) => prev.map((p) => (p.id === detail.id ? { ...p, counts: r.counts, myVote: r.myVote } : p)))
      setNotice(next === 0 ? '已取消评价' : next === 1 ? '已点赞' : '已点踩')
    } catch (e) { setNotice(errorText(e)) } finally { setBusy(false) }
  }

  async function sendComment() {
    if (!detail) return
    if (!canWrite) { onNeedLogin(); return }
    const body = commentText.trim()
    if (!body) return
    if (charCount(body) > COMMUNITY_LIMITS.commentMax) { setNotice(`评论最多 ${COMMUNITY_LIMITS.commentMax} 个字符`); return }
    setBusy(true)
    try {
      const token = `ct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const r = await addComment(detail.id, { body, display: commentDisplay, clientToken: token })
      setCommentText('')
      if (r.comment.status === 'visible') {
        setNotice('评论已发表')
        const c = await listComments(detail.id)
        setComments(c.items)
        setDetail({ ...detail, counts: { ...detail.counts, comments: c.items.length } })
      } else {
        setNotice('评论已提交，正在等待审核；通过后其他读者才能看到。')
      }
    } catch (e) {
      setNotice(e instanceof CommunityError && e.code === 'COMMENTS_CLOSED' ? e.message : errorText(e))
    } finally { setBusy(false) }
  }

  async function submitReport() {
    if (!detail) return
    if (!canWrite) { onNeedLogin(); return }
    setBusy(true)
    try {
      const r = await reportContent({ targetType: 'post', targetId: detail.id, reason: reportReason, detail: reportDetail })
      setReportOpen(false); setReportDetail('')
      setNotice(r.duplicate ? '你此前已举报过这篇，处理中。' : '举报已提交，管理员会尽快处理。')
    } catch (e) { setNotice(errorText(e)) } finally { setBusy(false) }
  }

  if (openId) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => { setOpenId(''); setDetail(null) }}>
            <ChevronLeft size={14} />返回列表
          </Button>
          {detail && <StatusPill>发布于 {formatTime(detail.createdAt)}</StatusPill>}
        </div>

        {detailState === 'loading' && <Notice>正在读取…</Notice>}
        {detailState === 'gone' && <Notice kind="warn">这篇投稿已不可见（可能被撤回、下架或尚未通过审核）。</Notice>}
        {detail && (
          <>
            <article className="rounded-xl border border-ink-700 bg-ink-900/60 p-4">
              <h2 className="text-16 font-semibold text-ink-100">{detail.title}</h2>
              <p className="mt-1 text-11 text-ink-400">
                {detail.displayName} · {formatTime(detail.createdAt)}
                {detail.tags.length ? ` · ${detail.tags.join(' / ')}` : ''}
              </p>
              <div className="mt-3 whitespace-pre-wrap break-words text-13 leading-7 text-ink-200">{detail.body}</div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" disabled={busy} selected={detail.myVote === 1} onClick={() => void vote(1)}>
                  <ThumbsUp size={14} />{detail.counts.up}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy} selected={detail.myVote === -1} onClick={() => void vote(-1)}>
                  <ThumbsDown size={14} />{detail.counts.down}
                </Button>
                <span className="text-11 text-ink-400"><MessageSquare size={12} className="inline" /> {detail.counts.comments} 条评论</span>
                <Button size="sm" variant="ghost" onClick={() => (canWrite ? setReportOpen((v) => !v) : onNeedLogin())}>举报</Button>
              </div>
              {reportOpen && (
                <div className="mt-3 space-y-2 rounded-lg border border-ink-700 bg-ink-900/70 p-3">
                  <label className="block text-12 text-ink-200">举报原因
                    <select aria-label="举报原因" value={reportReason} onChange={(e) => setReportReason(e.target.value)}
                      className="mt-1 w-full rounded border border-ink-700 bg-ink-900 px-2 py-1 text-12 text-ink-100">
                      {['广告或引流', '色情或低俗', '人身攻击', '疑似抄袭', '违法内容', '侵犯隐私', '其他'].map((r) => <option key={r}>{r}</option>)}
                    </select>
                  </label>
                  <textarea aria-label="补充说明" rows={2} value={reportDetail} onChange={(e) => setReportDetail(e.target.value)}
                    placeholder="补充说明（可选，最多 500 字）" maxLength={500}
                    className="w-full rounded border border-ink-700 bg-ink-900 px-2 py-1 text-12 text-ink-100" />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy} onClick={() => void submitReport()}>提交举报</Button>
                    <Button size="sm" variant="ghost" onClick={() => setReportOpen(false)}>取消</Button>
                  </div>
                </div>
              )}
            </article>

            <section aria-label="评论" className="space-y-2">
              <h3 className="text-13 font-semibold text-ink-100">评论</h3>
              {comments.length === 0 && <p className="text-11 text-ink-400">还没有评论。</p>}
              <ul className="space-y-2">
                {comments.map((c) => (
                  <li key={c.id} className="rounded-lg border border-ink-700 bg-ink-900/40 p-3">
                    <p className="text-11 text-ink-400">
                      {c.displayName}{c.byAuthor ? ' · 作者' : ''} · {formatTime(c.createdAt)}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-12 leading-6 text-ink-200">{c.body}</p>
                  </li>
                ))}
              </ul>
              {canWrite ? (
                <div className="space-y-2 rounded-lg border border-ink-700 bg-ink-900/60 p-3">
                  <textarea aria-label="写评论" rows={3} value={commentText} maxLength={COMMUNITY_LIMITS.commentMax}
                    onChange={(e) => setCommentText(e.target.value)} placeholder="写下你的看法（纯文字，最多 1000 字）"
                    className="w-full rounded border border-ink-700 bg-ink-900 px-2 py-1 text-12 text-ink-100" />
                  <div className="flex flex-wrap items-center gap-2">
                    <select aria-label="评论展示方式" value={commentDisplay} onChange={(e) => setCommentDisplay(e.target.value as 'nickname' | 'anonymous')}
                      className="rounded border border-ink-700 bg-ink-900 px-2 py-1 text-11 text-ink-100">
                      <option value="anonymous">匿名用户</option>
                      <option value="nickname">显示我的昵称</option>
                    </select>
                    <span className="text-11 text-ink-400">{charCount(commentText)} / {COMMUNITY_LIMITS.commentMax}</span>
                    <Button size="sm" disabled={busy || !commentText.trim()} onClick={() => void sendComment()}>发表评论</Button>
                  </div>
                  <p className="text-11 text-ink-400">低风险评论会直接显示；命中规则或检查不确定的评论会进入待审，通过后其他读者才能看到。</p>
                </div>
              ) : (
                <Button size="sm" onClick={onNeedLogin}>登录后参与评论</Button>
              )}
            </section>
          </>
        )}
        {(notice || error) && <Notice kind={error ? 'error' : 'info'}>{error || notice}</Notice>}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" variant="toggle" selected={!tag} onClick={() => { setTag(''); tagRef.current = ''; void load({ tag: '' }) }}>全部</Button>
        {COMMUNITY_TAGS.map((t) => (
          <Button key={t} size="xs" variant="toggle" selected={tag === t} onClick={() => { setTag(t); tagRef.current = t; void load({ tag: t }) }}>{t}</Button>
        ))}
      </div>

      {error && <Notice kind="error">{error}</Notice>}
      {closed && <Notice kind="warn">广场暂时关闭，暂时无法浏览新内容。</Notice>}
      {loading && items.length === 0 && <Notice>正在读取广场…</Notice>}
      {!loading && !closed && items.length === 0 && <Empty title="还没有已发布的投稿" hint="通过审核的投稿会出现在这里。" />}

      <ul className="space-y-2">
        {items.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => void openPost(p.id)}
              className="w-full rounded-xl border border-ink-700 bg-ink-900/50 p-3 text-left transition-colors hover:border-amber/40">
              <p className="flex flex-wrap items-center gap-2">
                <span className="text-13 font-semibold text-ink-100">{p.title}</span>
                {p.tags.map((t) => <StatusPill key={t}>{t}</StatusPill>)}
              </p>
              <p className="mt-1 line-clamp-2 text-12 leading-6 text-ink-300">{p.excerpt}</p>
              <p className="mt-2 text-11 text-ink-400">{p.displayName} · {formatTime(p.createdAt)} · 赞 {p.counts.up} / 踩 {p.counts.down} · 评论 {p.counts.comments}</p>
            </button>
          </li>
        ))}
      </ul>

      {cursor && !closed && (
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load({ append: true })}>
          {loading ? '读取中…' : '加载更多'}
        </Button>
      )}
    </div>
  )
}