// 投稿广场 · 投稿与编辑（3.5.0）
//
// 【草稿】输入即存本地（按账号隔离），断网/失败/登录失效都不丢；提交成功后清掉。
// 【重复提交】用一次性 clientToken：断网重试与连点两次都只会产生一篇。
// 【状态】新投稿 → 审核中；编辑已发布 → 生成新版本待审，旧版本默认继续展示。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/common/Button'
import { COMMUNITY_LIMITS, COMMUNITY_TAGS, charCount, isBlank } from '@/lib/community/limits'
import { createPost, updatePost } from '@/lib/community/api'
import { clearDraft, loadDraft, saveDraft } from '@/lib/community/draft'
import type { DisplayMode } from '@/lib/community/types'
import { Field, Notice, errorText } from '@/components/community/ui'

export interface EditTarget {
  id: string
  title: string
  body: string
  tags: string[]
  display: DisplayMode
  /** 是否已有公开版本（决定文案：编辑会生成待审版本） */
  hasPublishedVersion: boolean
}

interface Props {
  accountKey: string
  defaultDisplay: DisplayMode
  editTarget: EditTarget | null
  onCancelEdit: () => void
  onSubmitted: (message: string) => void
}

export default function PublishPanel({ accountKey, defaultDisplay, editTarget, onCancelEdit, onSubmitted }: Props) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [display, setDisplay] = useState<DisplayMode>(defaultDisplay)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [restored, setRestored] = useState(false)
  const tokenRef = useRef('')
  const timerRef = useRef<number | null>(null)

  // 进入时：编辑目标优先，否则恢复本地草稿
  useEffect(() => {
    if (editTarget) {
      setTitle(editTarget.title); setBody(editTarget.body); setTags(editTarget.tags); setDisplay(editTarget.display)
      tokenRef.current = ''
      return
    }
    const draft = loadDraft(accountKey)
    if (draft && (draft.title || draft.body)) {
      setTitle(draft.title); setBody(draft.body); setTags(draft.tags); setDisplay(draft.display)
      setRestored(true)
    }
    tokenRef.current = ''
  }, [accountKey, editTarget])

  // 输入停顿 600ms 落本地草稿（编辑态不覆盖「新投稿」草稿）
  useEffect(() => {
    if (editTarget) return
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      if (!title.trim() && !body.trim()) return
      saveDraft(accountKey, { title, body, tags, display })
    }, 600)
    return () => { if (timerRef.current) window.clearTimeout(timerRef.current) }
  }, [accountKey, title, body, tags, display, editTarget])

  const bodyCount = useMemo(() => charCount(body), [body])
  const titleCount = charCount(title)
  const overLimit = bodyCount > COMMUNITY_LIMITS.bodyMax || titleCount > COMMUNITY_LIMITS.titleMax
  const canSubmit = !busy && !overLimit && !isBlank(title) && !isBlank(body)

  function toggleTag(t: string) {
    setTags((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : (prev.length >= COMMUNITY_LIMITS.tagMax ? prev : [...prev, t]))
  }

  async function submit() {
    if (!canSubmit) return
    setBusy(true); setError('')
    try {
      if (editTarget) {
        const r = await updatePost(editTarget.id, { title: title.trim(), body, tags, display })
        onCancelEdit()
        onSubmitted(r.post.hasPublishedVersion
          ? '修改已提交审核；通过前旧版本继续展示。'
          : '修改已提交审核。')
        return
      }
      if (!tokenRef.current) tokenRef.current = `ct-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const r = await createPost({ title: title.trim(), body, tags, display, clientToken: tokenRef.current })
      clearDraft(accountKey)
      tokenRef.current = ''
      setTitle(''); setBody(''); setTags([]); setRestored(false)
      onSubmitted(r.duplicate ? '这篇投稿此前已提交，无需重复提交。' : '投稿已提交审核；通过后才会公开。')
    } catch (e) {
      setError(`${errorText(e)}（内容仍保留在本页，可修改后重试）`)
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      {restored && !editTarget && <Notice kind="ok">已恢复上次未提交的本地草稿。</Notice>}
      {editTarget && (
        <Notice kind="warn">
          正在编辑已发布的投稿。提交后会生成一个新的待审版本；
          {editTarget.hasPublishedVersion ? '审核通过前，读者仍会看到旧版本。' : '通过后才会公开。'}
          <button type="button" className="ml-2 underline" onClick={() => { onCancelEdit(); setTitle(''); setBody(''); setTags([]) }}>取消编辑</button>
        </Notice>
      )}

      <Field label="标题" hint={`${titleCount} / ${COMMUNITY_LIMITS.titleMax} 个字符`} htmlFor="community-title">
        <input id="community-title" value={title} maxLength={COMMUNITY_LIMITS.titleMax * 2}
          onChange={(e) => setTitle(e.target.value)} placeholder="给这段文字起个标题"
          className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-13 text-ink-100" />
      </Field>

      <Field label="正文" hint={`${bodyCount} / ${COMMUNITY_LIMITS.bodyMax} 个字符（含标点、空格与换行）`} htmlFor="community-body">
        <textarea id="community-body" rows={14} value={body} onChange={(e) => setBody(e.target.value)}
          placeholder="只支持纯文字。请只粘贴你愿意公开的片段，不要上传整本作品或他人隐私。"
          className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-13 leading-7 text-ink-100" />
      </Field>

      <Field label={`标签（最多 ${COMMUNITY_LIMITS.tagMax} 个）`}>
        <div className="flex flex-wrap gap-2">
          {COMMUNITY_TAGS.map((t) => (
            <Button key={t} size="xs" variant="toggle" selected={tags.includes(t)} onClick={() => toggleTag(t)}>{t}</Button>
          ))}
        </div>
      </Field>

      <Field label="公开方式" hint="匿名展示不会公开登录账号；选择昵称则其他人可能据此把不同内容关联起来。">
        <select aria-label="公开方式" value={display} onChange={(e) => setDisplay(e.target.value as DisplayMode)}
          className="rounded border border-ink-700 bg-ink-900 px-2 py-1 text-12 text-ink-100">
          <option value="anonymous">匿名用户（默认）</option>
          <option value="nickname">显示我的社区昵称</option>
        </select>
      </Field>

      <Notice kind="warn">
        发布前请确认：内容将公开、可能被他人复制或转载；你需要有权发布这些文字；请避免写入门牌、电话、真实姓名等个人信息。
      </Notice>

      {error && <Notice kind="error">{error}</Notice>}
      {overLimit && <Notice kind="error">超出字数上限，请删减后再提交。</Notice>}

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!canSubmit} onClick={() => void submit()}>{busy ? '提交中…' : editTarget ? '提交修改' : '提交审核'}</Button>
        {!editTarget && (title || body) && (
          <Button size="sm" variant="ghost" onClick={() => { setTitle(''); setBody(''); setTags([]); clearDraft(accountKey); setRestored(false) }}>清空草稿</Button>
        )}
      </div>
      <p className="text-11 leading-relaxed text-ink-400">
        首版由「规则初筛 → 管理员本地 AI 辅助 → 管理员确认」决定是否发布；AI 只提供建议，不会自动发布。
      </p>
    </div>
  )
}