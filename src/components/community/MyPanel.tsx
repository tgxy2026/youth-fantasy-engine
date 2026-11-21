// 投稿广场 · 我的投稿 / 评论 / 举报 / 申诉（3.5.0）
//
// 作者能在这里看到**状态与原因**：审核中、需修改、未通过、已撤回、已下架。
// 🔴 页面只展示「自己的」内容，服务端按会话 uid 过滤；这里不拼任何账号参数。
// 🔴 「改为匿名 / 显示昵称」只改展示、不重新审核 —— 但**不能消除**已经被他人看到或保存的关联。

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/common/Button'
import { confirmDialog } from '@/components/dialogs/dialogs'
import {
  addPostToCollection, createCollection, deleteCollection, listMyCollections, updateCollection,
  removePostFromCollection,
  deleteComment, deletePost, myAppeals, myComments, myPosts, myReports,
  setPostDisplay, submitAppeal, submitPost, withdrawPost,
} from '@/lib/community/api'
import type { MyCollection, MyComment, MyPost } from '@/lib/community/types'
import { formatViews } from '@/lib/community/format'
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
  /** 我的合集（3.6.2） */
  const [collections, setCollections] = useState<MyCollection[] | null>(null)
  const [newColTitle, setNewColTitle] = useState('')
  /** 正在改名的合集（inline 编辑：改个名字不该开弹窗） */
  const [editingCol, setEditingCol] = useState<{ id: string; title: string } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const [p, c, r, a, cols] = await Promise.all([
        myPosts(), myComments(), myReports(), myAppeals(), listMyCollections(),
      ])
      setPosts(p.items); setComments(c.items); setReports(r.items); setAppeals(a.items)
      setCollections(cols.items)
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

  /** 新建合集（3.6.2）。简介留空即可，后续可补 —— 先让人把「分组」这件事完成 */
  async function createCol() {
    const title = newColTitle.trim()
    if (!title) { setError('合集名称不能为空'); return }
    setBusy('new-col'); setError(''); setNotice('')
    try {
      await createCollection({ title })
      setNewColTitle('')
      setNotice('合集已创建。可以在每篇投稿下选择「所属合集」。')
      await load()
      onChanged()
    } catch (e) { setError(errorText(e)) } finally { setBusy('') }
  }

  async function removeCol(c: MyCollection) {    const ok = await confirmDialog({
      title: `删除合集《${c.title}》？`,
      message: `删掉的只是合集本身。里面的 ${c.postCount} 篇投稿不会被删除，只会从合集移出，仍然留在广场上。`,
      confirmText: '删除合集',
      danger: true,
    })
    if (!ok) return
    await act(`col-${c.id}`, () => deleteCollection(c.id), '合集已删除，篇目仍在广场上')
  }

  /** 保存合集改名。空名不发请求（服务端也会拒，但没必要多跑一趟） */
  async function saveRename() {
    const cur = editingCol
    if (!cur) return
    const title = cur.title.trim()
    if (!title) { setError('合集名称不能为空'); return }
    await act(`rename-${cur.id}`, () => updateCollection(cur.id, { title }), '合集名称已更新')
    setEditingCol(null)
  }

  /**
   * 改归属：移出 → 加入（顺序不能反，服务端不允许一篇同时在两个合集里）。
   * 🔴 旧稿件同样适用 —— 这里不判「是不是新建的投稿」，也不要求它已有浏览量。
   */
  async function movePost(p: MyPost, targetId: string) {
    if ((p.collectionId || '') === targetId) return
    await act(`col-post-${p.id}`, async () => {
      if (p.collectionId) await removePostFromCollection(p.collectionId, p.id)
      if (targetId) await addPostToCollection(targetId, p.id)
    }, targetId ? '已加入合集' : '已从合集移出')
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="ok">{notice}</Notice>}

      {/**
        * 我的合集（3.6.2）。
        * 🔴 放在「我的投稿」之前：连载作者的第一动作是"建一个合集，然后往里放"，
        *    而不是先看一堆散稿再找归集入口。
        */}
      <section aria-label="我的合集" className="space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-15 font-semibold text-ink-100">我的合集</h3>
          <span className="text-11 text-ink-400">连载作品按顺序归到这里，读者能从第 1 篇连着读</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={newColTitle}
            onChange={(e) => setNewColTitle(e.target.value)}
            // 中文输入法按 Enter 是选词，不能当成提交（项目里所有 Enter/Escape 处理都要守这一条）
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
              e.preventDefault(); void createCol()
            }}
            placeholder="合集名称，例如：归墟（连载）"
            maxLength={40}
            aria-label="新合集名称"
            className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-12 text-ink-100 placeholder:text-ink-500"
          />
          <Button size="sm" disabled={busy === 'new-col' || !newColTitle.trim()} onClick={() => void createCol()}>
            {busy === 'new-col' ? '创建中…' : '新建合集'}
          </Button>
        </div>
        {collections === null && <Notice>正在读取…</Notice>}
        {collections?.length === 0 && (
          <p className="text-12 text-ink-400">还没有合集。建一个之后，每篇投稿下面就能选「所属合集」了。</p>
        )}
        <ul className="space-y-2">
          {(collections ?? []).map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-ink-700 bg-ink-900/40 px-3 py-2">
              {editingCol?.id === c.id ? (
                <>
                  <input
                    value={editingCol.title}
                    autoFocus
                    maxLength={40}
                    aria-label="合集新名称"
                    onChange={(e) => setEditingCol({ id: c.id, title: e.target.value })}
                    onKeyDown={(e) => {
                      // 输入法组合期的 Enter 是选词，不是提交
                      if (e.nativeEvent.isComposing) return
                      if (e.key === 'Enter') { e.preventDefault(); void saveRename() }
                      if (e.key === 'Escape') { e.preventDefault(); setEditingCol(null) }
                    }}
                    className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-13 text-ink-100"
                  />
                  <Button size="xs" disabled={busy === `rename-${c.id}`} onClick={() => void saveRename()}>保存</Button>
                  <Button size="xs" variant="secondary" onClick={() => setEditingCol(null)}>取消</Button>
                </>
              ) : (
                <>
                  <span className="text-13 font-medium text-ink-100">{c.title}</span>
                  <span className="text-11 text-ink-400">{c.postCount} 篇</span>
                  {c.draftCount > 0 && (
                    <span className="text-11 text-amber" title="已挂进合集但还没公开（草稿或待审）">
                      · 其中 {c.draftCount} 篇未公开
                    </span>
                  )}
                  <span className="text-11 text-ink-400">合计浏览 {formatViews(c.totalViews)}</span>
                  <div className="ml-auto flex items-center gap-2">
                    <Button size="xs" variant="secondary" onClick={() => setEditingCol({ id: c.id, title: c.title })}>改名</Button>
                    <Button size="xs" variant="danger" disabled={busy === `col-${c.id}`}
                      onClick={() => void removeCol(c)}>删除合集</Button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

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
                {p.displayName && <span className="text-11 text-ink-400">展示名：{p.displayName}</span>}
                <span className="ml-auto text-11 text-ink-400">更新于 {formatTime(p.updatedAt)}</span>
              </div>
              {p.lastDecision?.reason && (
                <p className="mt-2 rounded-lg border border-amber/25 bg-amber/5 px-3 py-2 text-12 leading-6 text-amber">
                  审核意见：{p.lastDecision.reason}
                </p>
              )}
              <p className="mt-2 text-11 text-ink-400">赞 {p.counts.up} · 踩 {p.counts.down} · 评论 {p.counts.comments}</p>
              {/**
                * 所属合集（3.6.2）。**旧稿件同样能改** —— 不判它是不是新建的，
                * 也不要求它以前统计过浏览量；归集这件事对已经发过的稿子一样成立。
                */}
              {(collections?.length ?? 0) > 0 && (
                <label className="mt-2 flex flex-wrap items-center gap-2 text-11 text-ink-400">
                  所属合集
                  <select
                    value={p.collectionId || ''}
                    disabled={busy === `col-post-${p.id}`}
                    onChange={(e) => void movePost(p, e.target.value)}
                    aria-label={`《${p.title || '未命名'}》所属合集`}
                    className="rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-11 text-ink-200"
                  >
                    <option value="">不归入合集</option>
                    {(collections ?? []).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                  </select>
                  {busy === `col-post-${p.id}` && <span className="text-ink-500">保存中…</span>}
                </label>
              )}
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
                  <Button size="sm" variant="secondary" disabled={busy === `display-${p.id}`} onClick={() => void toggleDisplay(p)}>
                    {p.display === 'anonymous' ? '改为显示昵称' : '改为匿名'}
                  </Button>
                )}
                {canAppeal(p) && (
                  <Button size="sm" variant="secondary" disabled={busy === p.id} onClick={() => void appeal(p)}>申诉</Button>
                )}
                {p.status !== 'withdrawn' && p.status !== 'removed' && (
                  <Button size="sm" variant="secondary" disabled={busy === p.id}
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
                <Button size="xs" variant="secondary" className="mt-1" disabled={busy === c.id}
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
