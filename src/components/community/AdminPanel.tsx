// 投稿广场 · 审核工作台（3.5.0）
//
// 🔴 每个决定都必须带上**当前审阅的 versionId**：服务端会比对，过期回执返回 STALE_VERSION。
//    工作台绝不「先批准、后刷新」—— 刷新后版本变了就得重新领取。
// 🔴 本地 AI 只产出建议：按钮是「生成建议」，结果写进建议区，**不会改变状态**。
//    真正发布/拒绝只有管理员点「通过 / 要求修改 / 拒绝」。
// 🔴 领取、决定、开关全部以服务端回执为准；失败原样展示错误，不假装成功。

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/common/Button'
import {
  adminAdvice, adminAudit, adminClaim, adminCloseReport, adminDecision, adminItem, adminOverview,
  adminQueue, adminSwitch, CommunityError,
} from '@/lib/community/api'
import { SCREENING_REASON_LABELS } from '@/lib/community/limits'
import { suggestReview } from '@/lib/community/advice'
import type {
  AdminOverview, AdminPostItem, AdminQueueComment, AdminQueuePost, AdminQueueReport,
} from '@/lib/community/types'
import { Empty, Notice, StatusPill, errorText, formatTime } from '@/components/community/ui'

type QueueType = 'post' | 'comment' | 'report' | 'appeal'

export default function AdminPanel({ onTitle }: { onTitle?: (n: number) => void }) {
  const [tab, setTab] = useState<QueueType>('post')
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [items, setItems] = useState<Array<AdminQueuePost | AdminQueueComment | AdminQueueReport>>([])
  const [cursor, setCursor] = useState('')
  const cursorRef = useRef('')
  const [openItem, setOpenItem] = useState<AdminPostItem | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [reason, setReason] = useState('')
  const [adviceBusy, setAdviceBusy] = useState(false)
  const [audit, setAudit] = useState<Array<{ id: string; action: string; note: string; at: number }>>([])

  const loadOverview = useCallback(async () => {
    try {
      const r = await adminOverview()
      setOverview(r)
      onTitle?.(r.queue.posts + r.queue.comments + r.queue.reports + r.queue.appeals)
    } catch (e) { setError(errorText(e)) }
  }, [onTitle])

  const loadQueue = useCallback(async (type: QueueType, append = false) => {
    setError('')
    try {
      const r = await adminQueue(type, { cursor: append ? cursorRef.current : '' })
      setItems(append ? (prev) => [...prev, ...r.items] : r.items)
      setCursor(r.nextCursor)
      cursorRef.current = r.nextCursor
    } catch (e) { setError(errorText(e)) }
  }, [])

  useEffect(() => { void loadOverview() }, [loadOverview])
  useEffect(() => {
    void loadQueue(tab)
  }, [tab, loadQueue])

  async function run(key: string, fn: () => Promise<unknown>, message: string) {
    setBusy(key); setError(''); setNotice('')
    try {
      await fn()
      setNotice(message)
      await loadOverview()
      await loadQueue(tab)
    } catch (e) {
      setError(e instanceof CommunityError && e.code === 'STALE_VERSION'
        ? `${e.message}（当前队列已刷新，请重新领取）`
        : errorText(e))
    } finally { setBusy('') }
  }

  async function openPost(id: string, versionId: string) {
    setError(''); setNotice(''); setOpenItem(null); setReason('')
    try {
      const r = await adminItem('post', id)
      // 🔴 只有「从待审队列点进来」才比对版本；从举报页查看内容时没有队列版本，不能误判为过期
      if (versionId && r.item.versionId !== versionId) {
        setError('内容已更新，请刷新队列后重新领取。')
        await loadQueue(tab)
        return
      }
      setOpenItem(r.item)
    } catch (e) { setError(errorText(e)) }
  }

  async function openComment(id: string) {
    setError(''); setNotice(''); setOpenItem(null)
    try {
      const r = await adminItem('comment', id)
      const body = (r.item as unknown as { body?: string }).body || ''
      setOpenItem({ ...r.item, title: `评论（${r.item.title || '投稿'}）`, body, tags: [] })
    } catch (e) { setError(errorText(e)) }
  }

  async function generateAdvice() {
    if (!openItem) return
    setAdviceBusy(true); setError(''); setNotice('')
    try {
      const a = await suggestReview({
        kind: openItem.id.startsWith('c_') ? 'comment' : 'post',
        title: openItem.title,
        body: openItem.body,
      })
      await adminAdvice({
        targetType: openItem.id.startsWith('c_') ? 'comment' : 'post',
        id: openItem.id, versionId: openItem.versionId,
        suggestion: a.suggestion, reasons: a.reasons, model: a.model,
        endpoint: a.endpoint, coverage: a.coverage,
      })
      setOpenItem({
        ...openItem,
        advice: {
          suggestion: a.suggestion, reasons: a.reasons, versionId: openItem.versionId,
          at: Date.now(), model: a.model, endpoint: a.endpoint, coverage: a.coverage,
        },
      })
      setNotice('已生成建议（仅作参考，不改变状态）。')
    } catch (e) { setError(errorText(e)) } finally { setAdviceBusy(false) }
  }

  async function decide(action: 'approve' | 'reject' | 'request_changes') {
    if (!openItem) return
    const isComment = openItem.id.startsWith('c_')
    await run(`decide-${openItem.id}`, () => adminDecision({
      targetType: isComment ? 'comment' : 'post',
      id: openItem.id,
      versionId: openItem.versionId,
      action,
      reason: reason.trim(),
    }), action === 'approve' ? '已通过并发布' : action === 'reject' ? '已拒绝' : '已要求修改')
    setOpenItem(null)
    setReason('')
  }

  async function toggleSwitch(key: 'squareOpen' | 'postsOpen' | 'commentsOpen') {
    if (!overview) return
    await run(key, () => adminSwitch({ [key]: !overview.state[key] }), '开关已更新')
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="toggle" selected={tab === 'post'} onClick={() => setTab('post')}>待审投稿 {overview ? `(${overview.queue.posts})` : ''}</Button>
        <Button size="sm" variant="toggle" selected={tab === 'comment'} onClick={() => setTab('comment')}>待审评论 {overview ? `(${overview.queue.comments})` : ''}</Button>
        <Button size="sm" variant="toggle" selected={tab === 'report'} onClick={() => setTab('report')}>举报处理 {overview ? `(${overview.queue.reports})` : ''}</Button>
        <Button size="sm" variant="toggle" selected={tab === 'appeal'} onClick={() => setTab('appeal')}>申诉复核 {overview ? `(${overview.queue.appeals})` : ''}</Button>
        <Button size="xs" variant="ghost" onClick={() => { void loadOverview(); void loadQueue(tab) }}>刷新</Button>
        <Button size="xs" variant="ghost" onClick={() => { void (async () => {
          try { setAudit((await adminAudit(30)).items) } catch (e) { setError(errorText(e)) }
        })() }}>最近操作</Button>
      </div>

      {overview && (
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={overview.state.squareOpen ? 'ok' : 'bad'}>广场{overview.state.squareOpen ? '开放' : '已关闭'}</StatusPill>
          <Button size="xs" variant={overview.state.postsOpen ? 'ghost' : 'danger'} onClick={() => void toggleSwitch('postsOpen')}>
            新投稿{overview.state.postsOpen ? '暂停' : '恢复'}
          </Button>
          <Button size="xs" variant={overview.state.commentsOpen ? 'ghost' : 'danger'} onClick={() => void toggleSwitch('commentsOpen')}>
            评论{overview.state.commentsOpen ? '暂停' : '恢复'}
          </Button>
          <Button size="xs" variant={overview.state.squareOpen ? 'danger' : 'secondary'} onClick={() => void toggleSwitch('squareOpen')}>
            整个广场{overview.state.squareOpen ? '紧急关闭' : '恢复开放'}
          </Button>
        </div>
      )}

      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="ok">{notice}</Notice>}

      {openItem && (
        <section className="space-y-2 rounded-xl border border-amber/40 bg-ink-900/70 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-13 font-semibold text-ink-100">{openItem.title || '（无标题）'}</h3>
            <StatusPill>{openItem.status}</StatusPill>
            <span className="text-11 text-ink-400">版本 {openItem.versionId} · {formatTime(openItem.createdAt)}</span>
            <Button size="xs" variant="ghost" onClick={() => setOpenItem(null)}>关闭</Button>
          </div>
          {openItem.screening && (
            <p className="text-11 text-amber">
              规则初筛：{openItem.screening.level} · {openItem.screening.reasons.map((r) => SCREENING_REASON_LABELS[r] || r).join('、') || '无命中'}
            </p>
          )}
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-ink-700 bg-ink-900 p-3 text-12 leading-6 text-ink-200">
            {openItem.body || '（没有正文）'}
          </div>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="xs" variant="secondary" disabled={adviceBusy} onClick={() => void generateAdvice()}>
                {adviceBusy ? '生成中…' : '生成本地 AI 建议'}
              </Button>
              {openItem.advice && (
                <StatusPill tone={openItem.advice.suggestion === 'approve' ? 'ok' : openItem.advice.suggestion === 'reject' ? 'bad' : 'warn'}>
                  建议：{openItem.advice.suggestion === 'approve' ? '可通过' : openItem.advice.suggestion === 'reject' ? '建议拒绝' : '需人工复核'}
                </StatusPill>
              )}
            </div>
            {/* 🔴 截断提示必须在理由**之前**：先看到「只读了 6000 字」，再看建议 */}
            {openItem.advice?.coverage?.truncated && (
              <div role="alert" className="rounded-lg border-2 border-amber bg-amber/15 px-3 py-2 text-12 font-semibold leading-6 text-amber">
                本次建议只读了全文的前 {openItem.advice.coverage.shown.toLocaleString('zh-CN')} 个字符
                （全文 {openItem.advice.coverage.total.toLocaleString('zh-CN')} 个字符），
                「不代表全文结论」——通过前请通读下方全文。
              </div>
            )}
            {openItem.advice?.reasons.map((r, i) => <p key={i} className="text-11 text-ink-300">· {r}</p>)}
            {(openItem.advice?.model || openItem.advice?.endpoint) && (
              <p className="text-11 text-ink-400">
                生成位置：{openItem.advice.model || '本机模型'}
                {openItem.advice.endpoint ? ` @ ${openItem.advice.endpoint}` : ''}
              </p>
            )}
            <p className="text-11 text-ink-400">AI 只提供建议，最终是否发布由你决定；请结合文学语境判断。</p>
          </div>
          {/* 处理条吸在卡片底部：长文滚到底时仍能看见「规则初筛 / 这是哪一版」的上下文由上方卡片标题保证 */}
          <div className="sticky bottom-0 z-10 -mx-3 -mb-3 mt-1 flex flex-wrap items-center gap-2 border-t border-ink-700 bg-surface-app/95 px-3 py-2 backdrop-blur">
            <input aria-label="处理原因" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={400}
              placeholder="处理原因（通过可留空；拒绝/要求修改请写清楚）"
              className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-12 text-ink-100" />
            <Button size="sm" disabled={busy !== ''} onClick={() => void decide('approve')}>通过并发布</Button>
            <Button size="sm" variant="secondary" disabled={busy !== ''} onClick={() => void decide('request_changes')}>要求修改</Button>
            <Button size="sm" variant="danger" disabled={busy !== ''} onClick={() => void decide('reject')}>拒绝</Button>
          </div>
        </section>
      )}

      {items.length === 0 && <Empty title="这个队列现在是空的" hint="领到任务后先看原文，再决定；审核结果绑定具体版本。" />}

      <ul className="space-y-2">
        {items.map((it) => {
          if (tab === 'report' || tab === 'appeal') {
            const r = it as AdminQueueReport
            const isAppeal = r.kind === 'appeal'
            return (
              <li key={r.id} className="rounded-xl border border-ink-700 bg-ink-900/50 p-3">
                <p className="text-12 text-ink-100">
                  {isAppeal ? '申诉' : '举报'} {r.targetType === 'post' ? '投稿' : '评论'} · {r.reason}
                  <StatusPill>{r.status === 'claimed' ? '已领取' : '待处理'}</StatusPill>
                </p>
                {isAppeal && r.versionId && <p className="mt-1 text-11 text-ink-400">申诉版本 {r.versionId}（复核针对这一版内容）</p>}
                {r.detail && <p className="mt-1 text-11 text-ink-300">补充：{r.detail}</p>}
                <p className="mt-1 text-11 text-ink-400">{formatTime(r.createdAt)}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="xs" variant="ghost" disabled={busy === `claim-${r.id}`}
                    onClick={() => void run(`claim-${r.id}`, () => adminClaim(isAppeal ? 'appeal' : 'report', [r.id]), isAppeal ? '已领取申诉' : '已领取举报')}>领取</Button>
                  {r.targetType === 'post' && (
                    <Button size="xs" variant="secondary" onClick={() => void openPost(r.targetId, r.versionId || '')}>查看内容</Button>
                  )}
                  {isAppeal ? (
                    <>
                      <Button size="xs" disabled={busy === `close-${r.id}`}
                        onClick={() => void run(`close-${r.id}`, () => adminCloseReport({ id: r.id, action: 'reopen', outcome: '申诉成立，重新进入待审' }), '已重新放回待审队列')}>申诉成立，重新待审</Button>
                      <Button size="xs" variant="ghost" disabled={busy === `close-${r.id}`}
                        onClick={() => void run(`close-${r.id}`, () => adminCloseReport({ id: r.id, action: 'none', outcome: '维持原处理' }), '已驳回申诉')}>维持原处理</Button>
                    </>
                  ) : (
                    <>
                      <Button size="xs" variant="danger" disabled={busy === `close-${r.id}`}
                        onClick={() => void run(`close-${r.id}`, () => adminCloseReport({ id: r.id, action: 'takedown', outcome: '举报成立，已下架' }), '已下架并关闭举报')}>举报成立并下架</Button>
                      <Button size="xs" variant="ghost" disabled={busy === `close-${r.id}`}
                        onClick={() => void run(`close-${r.id}`, () => adminCloseReport({ id: r.id, action: 'none', outcome: '未发现违规' }), '已关闭举报')}>未违规并关闭</Button>
                    </>
                  )}
                </div>
                {!isAppeal && r.targetType === 'comment' && <Notice kind="warn">评论举报请在「待审评论」里处理；已显示的评论由举报成立动作直接下架。</Notice>}
                {isAppeal && <Notice>申诉成立只是把「那一版内容」放回待审；是否公开仍由你按正常审核流程决定。</Notice>}
              </li>
            )
          }
          if (tab === 'comment') {
            const c = it as AdminQueueComment
            return (
              <li key={c.id} className="rounded-xl border border-ink-700 bg-ink-900/50 p-3">
                <p className="text-12 text-ink-100">{c.body}</p>
                {c.screening && (
                  <p className="mt-1 text-11 text-amber">
                    初筛 {c.screening.level} · {c.screening.reasons.map((r) => SCREENING_REASON_LABELS[r] || r).join('、') || '无命中'}
                  </p>
                )}
                <p className="mt-1 text-11 text-ink-400">{formatTime(c.createdAt)}{c.claimedBy ? ' · 已领取' : ''}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="xs" variant="ghost" disabled={busy === `claim-${c.id}`}
                    onClick={() => void run(`claim-${c.id}`, () => adminClaim('comment', [c.id]), '已领取评论')}>领取</Button>
                  <Button size="xs" variant="secondary" onClick={() => void openComment(c.id)}>查看</Button>
                  <Button size="xs" disabled={busy === `ok-${c.id}`}
                    onClick={() => void run(`ok-${c.id}`, () => adminDecision({ targetType: 'comment', id: c.id, action: 'approve' }), '评论已通过并显示')}>通过</Button>
                  <Button size="xs" variant="danger" disabled={busy === `no-${c.id}`}
                    onClick={() => void run(`no-${c.id}`, () => adminDecision({ targetType: 'comment', id: c.id, action: 'reject' }), '评论已拒绝')}>拒绝</Button>
                </div>
              </li>
            )
          }
          const p = it as AdminQueuePost
          return (
            <li key={p.id} className="rounded-xl border border-ink-700 bg-ink-900/50 p-3">
              <p className="flex flex-wrap items-center gap-2">
                <span className="text-13 font-semibold text-ink-100">{p.title || '（无标题）'}</span>
                {p.claimedBy && <StatusPill>已领取</StatusPill>}
                {p.advice && <StatusPill tone="warn">有 AI 建议</StatusPill>}
              </p>
              <p className="mt-1 line-clamp-2 text-12 text-ink-300">{p.excerpt}</p>
              {p.screening && (
                <p className="mt-1 text-11 text-amber">
                  初筛 {p.screening.level} · {p.screening.reasons.map((r) => SCREENING_REASON_LABELS[r] || r).join('、') || '无命中'}
                </p>
              )}
              <p className="mt-1 text-11 text-ink-400">{formatTime(p.createdAt)}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="xs" variant="ghost" disabled={busy === `claim-${p.id}`}
                  onClick={() => void run(`claim-${p.id}`, () => adminClaim('post', [p.id]), '已领取投稿')}>领取</Button>
                <Button size="xs" onClick={() => void openPost(p.id, p.versionId)}>审阅</Button>
              </div>
            </li>
          )
        })}
      </ul>

      {cursor && <Button size="sm" variant="ghost" onClick={() => void loadQueue(tab, true)}>加载更多</Button>}

      {audit.length > 0 && (
        <section className="space-y-1 border-t border-ink-700 pt-2">
          <h3 className="text-12 font-semibold text-ink-100">最近操作</h3>
          <ul className="space-y-0.5">
            {audit.map((a) => (
              <li key={a.id} className="text-11 text-ink-400">{formatTime(a.at)} · {a.action} {a.note ? `· ${a.note}` : ''}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}