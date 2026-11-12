// 投稿广场 · 浏览与详情（3.5.0 / 3.5.2 评论分页与重试）
//
// 未登录也能看（服务端允许公共读）；能写时才显示操作按钮 —— 按钮隐藏不是权限控制，
// 服务端每个写接口都会再判一次，这里只是不给出「点了必失败」的入口。
//
// 【阅读优先】详情按「标题 → 作者/时间 → 正文 → 互动 → 评论」分区，正文限制在舒适行宽，
// 评论区与正文之间有明确分隔；列表只给摘要，避免把长文塞进卡片。
//
// 🔴 3.5.2：
//   · 评论按游标分页，总数以服务端 `total` 为准（已加载条数不能当总数）；
//   · 所有异步回执都校验「当前帖子 + 会话序号」，切换帖子/返回列表后的迟到响应直接丢弃；
//   · 提交结果分「已确认 / 确定失败 / 未确认」；未确认时同一意图复用令牌重试，避免重复评论。

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, MessageSquare, ThumbsDown, ThumbsUp } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { COMMUNITY_LIMITS, COMMUNITY_TAGS, charCount } from '@/lib/community/limits'
import {
  addComment, getPost, listComments, listPosts, reportContent, votePost,
  CommunityError,
} from '@/lib/community/api'
import { classifyCommentFailure, forgetIntent, tokenForIntent, type CommentIntent } from '@/lib/community/pendingComment'
import type { CommunityComment, CommunityPostDetail, CommunityPostSummary } from '@/lib/community/types'
import { Empty, Notice, StatusPill, errorText, formatTime } from '@/components/community/ui'
import ReadingText from '@/components/community/ReadingText'

const READING_SIZE_KEY = 'yfe:community:reading-size'
const READING_SIZES = [14, 16, 18, 20]
const COMMENT_PAGE_SIZE = 20

function initialReadingSize() {
  try {
    const size = Number(localStorage.getItem(READING_SIZE_KEY))
    return READING_SIZES.includes(size) ? size : 16
  } catch { return 16 }
}

interface Props {
  canWrite: boolean
  defaultDisplay: 'nickname' | 'anonymous'
  onNeedLogin: () => void
  /** 3.5.1 · U1：外壳已独占连接/错误状态时，本面板不再重复出状态条/骨架/空态 */
  shellOwnsStatus?: boolean
}

export default function FeedPanel({ canWrite, defaultDisplay, onNeedLogin, shellOwnsStatus = false }: Props) {
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
  const [readingSize, setReadingSize] = useState(initialReadingSize)

  function changeReadingSize(size: number) {
    setReadingSize(size)
    try { localStorage.setItem(READING_SIZE_KEY, String(size)) } catch { /* reading remains usable */ }
  }

  const [openId, setOpenId] = useState('')
  const [detail, setDetail] = useState<CommunityPostDetail | null>(null)
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'gone' | 'failed'>('idle')
  const [detailError, setDetailError] = useState('')
  const [comments, setComments] = useState<CommunityComment[]>([])
  const [commentTotal, setCommentTotal] = useState(0)
  const [commentCursor, setCommentCursor] = useState('')
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState('')
  const [commentText, setCommentText] = useState('')
  const [commentDisplay, setCommentDisplay] = useState<'nickname' | 'anonymous'>(defaultDisplay)
  const [busy, setBusy] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportReason, setReportReason] = useState('广告或引流')
  const [reportDetail, setReportDetail] = useState('')

  // 当前详情会话：每次打开/关闭/切换帖子都递增，旧请求回执据此丢弃
  const commentSeqRef = useRef(0)
  const commentCursorRef = useRef('')
  const detailIdRef = useRef('')
  // 「意图 → 令牌」只活在当前页面会话；账号切换/刷新页面后不保证去重（文案不承诺）
  const pendingIntentsRef = useRef(new Map<string, string>())

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

  /** 重置评论会话：递增序号让所有在途评论请求的回执失效 */
  function resetCommentSession() {
    commentSeqRef.current += 1
    commentCursorRef.current = ''
    setComments([])
    setCommentTotal(0)
    setCommentCursor('')
    setCommentsError('')
    setCommentsLoading(false)
  }

  async function loadComments(postId: string, append: boolean, seq: number) {
    setCommentsLoading(true); setCommentsError('')
    try {
      const page = await listComments(postId, {
        cursor: append ? commentCursorRef.current : '',
        limit: COMMENT_PAGE_SIZE,
      })
      // 🔴 迟到回执：帖子已切换或会话已重置 -> 应用了就会串项
      if (seq !== commentSeqRef.current || detailIdRef.current !== postId) return
      setComments((prev) => {
        if (!append) return page.items
        const seen = new Set(prev.map((c) => c.id))
        return [...prev, ...page.items.filter((c) => !seen.has(c.id))]
      })
      commentCursorRef.current = page.nextCursor
      setCommentCursor(page.nextCursor)
      const total = page.total
      if (typeof total === 'number') {
        setCommentTotal(total)
        // 详情页顶部评论数也以服务端总数口径为准，避免与列表/发评后不一致
        setDetail((d) => (d && d.id === postId ? { ...d, counts: { ...d.counts, comments: total } } : d))
      } else if (!append) {
        // 旧服务端没有 total：只能给出可解释的「当前已加载」下限，不冒充权威总数
        setCommentTotal(page.items.length)
      }
    } catch (e) {
      if (seq !== commentSeqRef.current || detailIdRef.current !== postId) return
      setCommentsError(errorText(e))
    } finally {
      if (seq === commentSeqRef.current) setCommentsLoading(false)
    }
  }

  async function openPost(id: string) {
    detailIdRef.current = id
    resetCommentSession()
    const seq = commentSeqRef.current
    setOpenId(id); setDetail(null); setDetailState('loading'); setDetailError('')
    setNotice(''); setReportOpen(false)
    try {
      const r = await getPost(id)
      if (seq !== commentSeqRef.current) return
      if (r.unavailable || !r.post) { setDetailState('gone'); return }
      setDetail(r.post)
      setDetailState('idle')
      await loadComments(id, false, seq)
    } catch (e) {
      if (seq !== commentSeqRef.current) return
      // 🔴 网络失败不能当成「投稿不存在」：404 才是不可见，其余保留页面并提供重试
      if (e instanceof CommunityError && e.status === 404) {
        setDetailState('gone')
      } else {
        setDetailError(errorText(e))
        setDetailState('failed')
      }
    }
  }

  function closeDetail() {
    commentSeqRef.current += 1
    detailIdRef.current = ''
    commentCursorRef.current = ''
    setOpenId(''); setDetail(null); setDetailState('idle'); setDetailError('')
    setComments([]); setCommentTotal(0); setCommentCursor(''); setCommentsError(''); setCommentsLoading(false)
    setNotice(''); setReportOpen(false)
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
    const intent: CommentIntent = { postId: detail.id, body, display: commentDisplay }
    // 同一帖子 + 同一正文 + 同一展示方式 = 同一意图；重试复用令牌，改内容/换帖子即新令牌
    const { token } = tokenForIntent(pendingIntentsRef.current, intent)
    const seq = commentSeqRef.current
    setBusy(true)
    try {
      const r = await addComment(detail.id, { body, display: commentDisplay, clientToken: token })
      if (seq !== commentSeqRef.current || detailIdRef.current !== detail.id) return
      forgetIntent(pendingIntentsRef.current, intent)
      // 用户提交期间继续输入的新内容必须保留，只清空与本次提交一致的内容
      setCommentText((prev) => (prev.trim() === body ? '' : prev))
      if (r.comment.status === 'visible') {
        setComments((prev) => (prev.some((c) => c.id === r.comment.id) ? prev : [r.comment, ...prev]))
        const nextTotal = typeof r.total === 'number' ? r.total : commentTotal + 1
        setCommentTotal(nextTotal)
        setDetail((d) => (d && d.id === detail.id ? { ...d, counts: { ...d.counts, comments: nextTotal } } : d))
        setNotice(r.duplicate ? '评论此前已发表。' : '评论已发表')
      } else {
        setNotice(r.duplicate ? '评论此前已提交，正在等待审核。' : '评论已提交，正在等待审核；通过后其他读者才能看到。')
      }
    } catch (e) {
      if (seq !== commentSeqRef.current || detailIdRef.current !== detail.id) return
      if (classifyCommentFailure(e) === 'unconfirmed') {
        // 结果未确认：保留令牌，用户再次点击「发表评论」会复用同一令牌，不会产生第二条
        setNotice('网络中断，评论结果未确认。可直接再点一次「发表评论」重试，不会重复发表；也可先刷新评论确认。')
      } else {
        forgetIntent(pendingIntentsRef.current, intent)
        setNotice(e instanceof CommunityError && e.code === 'COMMENTS_CLOSED' ? e.message : errorText(e))
      }
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
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={closeDetail}>
            <ChevronLeft size={14} />返回列表
          </Button>
        </div>

        {detailState === 'loading' && <Notice>正在读取…</Notice>}
        {detailState === 'gone' && <Notice kind="warn">这篇投稿已不可见（可能被撤回、下架或尚未通过审核）。</Notice>}
        {detailState === 'failed' && (
          <div className="space-y-2">
            <Notice kind="error">{detailError || '读取失败，请检查网络后重试。'}</Notice>
            <Button size="sm" variant="secondary" onClick={() => void openPost(openId)}>重新读取</Button>
          </div>
        )}

        {detail && (
          <div className="space-y-8">
            <article className="w-full min-w-0">
              <h2 className="text-22 font-semibold leading-snug tracking-tight text-ink-100 sm:text-24">{detail.title}</h2>
              {detail.isExample && <div className="mt-2"><StatusPill>示例故事</StatusPill></div>}
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-12 text-ink-300">
                <span className="text-ink-300">{detail.displayName}</span>
                <span>·</span><span>{formatTime(detail.createdAt)}</span>
                {detail.tags.map((t) => <StatusPill key={t}>{t}</StatusPill>)}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-1.5" role="group" aria-label="阅读字号">
                <span className="mr-1 text-12 text-ink-400">字号</span>
                {READING_SIZES.map((size) => (
                  <Button key={size} size="sm" variant="toggle" selected={readingSize === size} aria-pressed={readingSize === size}
                    aria-label={`阅读字号 ${size}`} onClick={() => changeReadingSize(size)}>{size}</Button>
                ))}
              </div>
              <div className="mt-4"><ReadingText body={detail.body} fontSize={readingSize} /></div>

              <div className="mt-7 flex flex-wrap items-center gap-2 border-t border-ink-700/70 pt-4">
                <Button size="sm" variant="secondary" disabled={busy} selected={detail.myVote === 1} onClick={() => void vote(1)}
                  aria-pressed={detail.myVote === 1} aria-label={`点赞，当前 ${detail.counts.up}`}>
                  <ThumbsUp size={14} />{detail.counts.up}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy} selected={detail.myVote === -1} onClick={() => void vote(-1)}
                  aria-pressed={detail.myVote === -1} aria-label={`点踩，当前 ${detail.counts.down}`}>
                  <ThumbsDown size={14} />{detail.counts.down}
                </Button>
                <span className="inline-flex items-center gap-1 text-12 text-ink-400"><MessageSquare size={13} />{detail.counts.comments}</span>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => (canWrite ? setReportOpen((v) => !v) : onNeedLogin())}>举报</Button>
              </div>

              {reportOpen && (
                <div className="mt-3 space-y-3 rounded-xl border border-ink-700 bg-ink-900/60 p-4">
                  <p className="text-13 font-medium text-ink-100">举报这篇投稿</p>
                  <label className="block text-12 text-ink-300">原因
                    <select aria-label="举报原因" value={reportReason} onChange={(e) => setReportReason(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-12 text-ink-100">
                      {['广告或引流', '色情或低俗', '人身攻击', '疑似抄袭', '违法内容', '侵犯隐私', '其他'].map((r) => <option key={r}>{r}</option>)}
                    </select>
                  </label>
                  <textarea aria-label="补充说明" rows={3} value={reportDetail} onChange={(e) => setReportDetail(e.target.value)}
                    placeholder="补充说明（可选，最多 500 字）" maxLength={500}
                    className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-12 text-ink-100" />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy} onClick={() => void submitReport()}>提交举报</Button>
                    <Button size="sm" variant="ghost" onClick={() => setReportOpen(false)}>取消</Button>
                  </div>
                  <p className="text-11 text-ink-400">举报会进入管理员队列；处理结果可在「我的 → 我的举报」查看。</p>
                </div>
              )}
            </article>

            <section aria-label="评论" className="w-full min-w-0 border-t border-ink-700/70 pt-6">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-15 font-semibold text-ink-100">评论{commentTotal > 0 ? ` (${commentTotal})` : ''}</h3>
                <Button size="sm" variant="ghost" className="ml-auto" disabled={commentsLoading}
                  onClick={() => void loadComments(detail.id, false, commentSeqRef.current)}>刷新评论</Button>
              </div>
              {commentsError && (
                <div className="mt-2 space-y-2">
                  <Notice kind="error">{commentsError}</Notice>
                  <Button size="sm" variant="secondary" disabled={commentsLoading}
                    onClick={() => void loadComments(detail.id, comments.length > 0, commentSeqRef.current)}>
                    {comments.length > 0 ? '重试加载更多' : '重新读取评论'}
                  </Button>
                </div>
              )}
              {commentsLoading && comments.length === 0 && <p className="mt-2 text-12 text-ink-400">正在读取评论…</p>}
              {!commentsLoading && !commentsError && commentTotal === 0 && <p className="mt-2 text-12 text-ink-400">还没有评论。写下第一条看法吧。</p>}
              <ul className="mt-3 space-y-3">
                {comments.map((c) => (
                  <li key={c.id} className="rounded-xl border border-ink-700/70 bg-ink-900/40 p-3.5">
                    <p className="text-11 text-ink-400">
                      <span className="text-ink-300">{c.displayName}</span>
                      {c.byAuthor ? ' · 作者' : ''} · {formatTime(c.createdAt)}
                    </p>
                    <p className="mt-1.5 whitespace-pre-wrap break-words text-13 leading-7 text-ink-200">{c.body}</p>
                  </li>
                ))}
              </ul>

              {commentCursor && !commentsError && (
                <div className="mt-3">
                  <Button size="sm" variant="secondary" disabled={commentsLoading}
                    onClick={() => void loadComments(detail.id, true, commentSeqRef.current)}>
                    {commentsLoading ? '读取中…' : '加载更多评论'}
                  </Button>
                </div>
              )}

              {canWrite ? (
                <div className="mt-4 space-y-2 rounded-xl border border-ink-700 bg-ink-900/60 p-4">
                  {/* 🔴 maxLength 是 UTF-16 单位，服务端按 Unicode 码点计数。放宽到 2 倍后，
                      1000 个 emoji 仍可输入；真正的上限由码点计数与服务端校验共同判定。 */}
                  <textarea aria-label="写评论" rows={3} value={commentText} maxLength={COMMUNITY_LIMITS.commentMax * 2}
                    onChange={(e) => setCommentText(e.target.value)} placeholder="写下你的看法（纯文字，最多 1000 字）"
                    className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-13 leading-6 text-ink-100 outline-none focus:border-amber/60" />
                  <div className="flex flex-wrap items-center gap-2">
                    <select aria-label="评论展示方式" value={commentDisplay} onChange={(e) => setCommentDisplay(e.target.value as 'nickname' | 'anonymous')}
                      className="rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-11 text-ink-100">
                      <option value="anonymous">匿名用户</option>
                      <option value="nickname">显示我的昵称</option>
                    </select>
                    <span className="text-11 text-ink-400">{charCount(commentText)} / {COMMUNITY_LIMITS.commentMax}</span>
                    <Button size="sm" className="ml-auto" disabled={busy || !commentText.trim() || charCount(commentText) > COMMUNITY_LIMITS.commentMax}
                      onClick={() => void sendComment()}>发表评论</Button>
                  </div>
                  <p className="text-11 leading-relaxed text-ink-400">
                    低风险评论会直接显示；命中规则、检查不确定或检查失败时进入待审，通过后其他读者才能看到。
                    网络中断时再次点击会复用同一提交，不会重复发表。
                  </p>
                </div>
              ) : (
                <div className="mt-4">
                  <Button size="sm" onClick={onNeedLogin}>登录后参与评论</Button>
                </div>
              )}
            </section>
          </div>
        )}

        <div aria-live="polite">{(notice || error) && <Notice kind={error ? 'error' : 'info'}>{error || notice}</Notice>}</div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {!shellOwnsStatus && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="toggle" selected={!tag} onClick={() => { setTag(''); tagRef.current = ''; void load({ tag: '' }) }}>全部</Button>
          {COMMUNITY_TAGS.map((t) => (
            <Button key={t} size="sm" variant="toggle" selected={tag === t} onClick={() => { setTag(t); tagRef.current = t; void load({ tag: t }) }}>{t}</Button>
          ))}
          <span className="ml-auto text-11 text-ink-400">按发布时间排序</span>
        </div>
      )}

      {!shellOwnsStatus && (
        <div aria-live="polite" className="space-y-3">
          {error && <Notice kind="error">{error}</Notice>}
          {/* 关闭态由外壳独占（square.open=false ⇒ shellOwnsStatus），这里不再叠第二条 warn */}
        </div>
      )}

      {!shellOwnsStatus && loading && items.length === 0 && (
        <ul className="space-y-3" aria-label="正在加载投稿">
          {[0, 1, 2].map((i) => (
            <li key={i} className="animate-pulse rounded-2xl border border-ink-700 bg-ink-900/40 p-4">
              <div className="h-4 w-1/3 rounded bg-ink-800" />
              <div className="mt-3 h-3 w-full rounded bg-ink-800/80" />
              <div className="mt-2 h-3 w-2/3 rounded bg-ink-800/80" />
            </li>
          ))}
        </ul>
      )}
      {!shellOwnsStatus && !loading && !closed && items.length === 0 && <Empty title="还没有已发布的投稿" hint="通过审核的投稿会出现在这里。" />}

      <ul className="space-y-3">
        {items.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => void openPost(p.id)}
              className="group w-full rounded-2xl border border-ink-700 bg-surface-app p-5 text-left shadow-sm transition-colors hover:border-amber/40 focus-visible:border-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/40 sm:px-6 sm:py-5">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-15 font-semibold text-ink-100 group-hover:text-amber sm:text-16">{p.title}</h3>
                {p.isExample && <StatusPill>示例故事</StatusPill>}
                {p.tags.map((t) => <StatusPill key={t}>{t}</StatusPill>)}
              </div>
              <p className="mt-3 line-clamp-3 text-14 leading-7 text-ink-300">{p.excerpt}</p>
              <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-11 text-ink-300">
                <span>{p.displayName}</span>
                <span>{formatTime(p.createdAt)}</span>
                <span className="inline-flex items-center gap-1"><ThumbsUp size={11} />{p.counts.up}</span>
                <span className="inline-flex items-center gap-1"><ThumbsDown size={11} />{p.counts.down}</span>
                <span className="inline-flex items-center gap-1"><MessageSquare size={11} />{p.counts.comments}</span>
              </p>
            </button>
          </li>
        ))}
      </ul>

      {cursor && !closed && (
        <div className="pt-1">
          <Button size="sm" variant="secondary" disabled={loading} onClick={() => void load({ append: true })}>
            {loading ? '读取中…' : '加载更多'}
          </Button>
        </div>
      )}
    </div>
  )
}