// 投稿广场 · 投稿与编辑（3.5.0）
//
// 【草稿】输入即存本地（按账号隔离），断网/失败/登录失效都不丢；提交成功后**只清掉
//   与提交内容一致的部分** —— 用户在等待回执期间继续写的字必须留下。
// 【迟到回执】提交时记下「账号 + 请求序号」：回执回来时账号已切换或已有更新的提交，
//   一律丢弃，不覆盖当前输入，也不清空新账号的草稿。
// 【重复提交】用一次性 clientToken：断网重试与连点两次都只会产生一篇。
// 【状态】新投稿 → 审核中；编辑已发布 → 生成新版本待审，旧版本默认继续展示。

import { useCallback, useEffect, useRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { confirmDialog } from '@/components/dialogs/dialogs'
import { COMMUNITY_LIMITS, COMMUNITY_TAGS, charCount, isBlank } from '@/lib/community/limits'
import { createPost, updatePost } from '@/lib/community/api'
import { clearDraft, loadDraft, saveDraft } from '@/lib/community/draft'
import { decideAfterSubmit } from '@/lib/community/publishOutcome'
import type { DisplayMode } from '@/lib/community/types'
import { Field, Notice, StatusPill, errorText, formatTime } from '@/components/community/ui'
import ReadingText from '@/components/community/ReadingText'

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
  const [preview, setPreview] = useState(false)
  const [savedAt, setSavedAt] = useState(0)

  const tokenRef = useRef('')
  const timerRef = useRef<number | null>(null)
  // 🔴 迟到回执防护：账号变更会自增序号，在途响应随即作废
  const seqRef = useRef(0)
  const accountRef = useRef(accountKey)
  const defaultDisplayRef = useRef(defaultDisplay)
  defaultDisplayRef.current = defaultDisplay

  /**
   * 账号 / 编辑目标变化：**显式重建**输入区。
   * 🔴 原实现只在「新账号有草稿」时赋值，没有草稿就保留上一个账号的输入 —— 这在共享电脑上
   *    等于把 A 的未提交正文显示给 B。这里无条件覆盖（无草稿就清空）。
   */
  useEffect(() => {
    accountRef.current = accountKey
    seqRef.current += 1
    tokenRef.current = ''
    setError('')
    if (editTarget) {
      setTitle(editTarget.title); setBody(editTarget.body); setTags(editTarget.tags); setDisplay(editTarget.display)
      setRestored(false); setSavedAt(0)
      return
    }
    const draft = loadDraft(accountKey)
    setTitle(draft?.title || '')
    setBody(draft?.body || '')
    setTags(draft?.tags || [])
    setDisplay(draft?.display || defaultDisplayRef.current)
    setRestored(!!draft && !!(draft.title || draft.body))
    setSavedAt(draft?.updatedAt || 0)
  }, [accountKey, editTarget])

  // 输入停顿 600ms 落本地草稿（编辑态不覆盖「新投稿」草稿）
  useEffect(() => {
    if (editTarget) return
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      if (!title.trim() && !body.trim()) return
      if (saveDraft(accountKey, { title, body, tags, display })) setSavedAt(Date.now())
    }, 600)
    return () => { if (timerRef.current) window.clearTimeout(timerRef.current) }
  }, [accountKey, title, body, tags, display, editTarget])

  const bodyCount = charCount(body)
  const titleCount = charCount(title)
  const overLimit = bodyCount > COMMUNITY_LIMITS.bodyMax || titleCount > COMMUNITY_LIMITS.titleMax
  const canSubmit = !busy && !overLimit && !isBlank(title) && !isBlank(body)

  const toggleTag = useCallback((t: string) => {
    setTags((prev) => prev.includes(t)
      ? prev.filter((x) => x !== t)
      : (prev.length >= COMMUNITY_LIMITS.tagMax ? prev : [...prev, t]))
  }, [])

  async function submit() {
    if (!canSubmit) return
    const snapshot = { accountKey, title: title.trim(), body, tags, display }
    const seq = ++seqRef.current
    setBusy(true); setError('')
    try {
      if (editTarget) {
        const r = await updatePost(editTarget.id, {
          title: snapshot.title, body: snapshot.body, tags: snapshot.tags, display: snapshot.display,
        })
        if (seq !== seqRef.current || accountRef.current !== snapshot.accountKey) return
        onCancelEdit()
        onSubmitted(r.post.hasPublishedVersion
          ? '修改已提交审核；通过前旧版本继续展示。'
          : '修改已提交审核。')
        return
      }
      if (!tokenRef.current) tokenRef.current = `ct-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const r = await createPost({
        title: snapshot.title, body: snapshot.body, tags: snapshot.tags,
        display: snapshot.display, clientToken: tokenRef.current,
      })
      // 🔴 回执可能晚于账号切换 / 新一次提交：此时不得改动界面与草稿
      if (seq !== seqRef.current) return
      const outcome = decideAfterSubmit(snapshot, { accountKey, title, body })
      if (outcome === 'ignore') return
      tokenRef.current = ''
      if (outcome === 'clear') {
        setTitle(''); setBody(''); setTags([]); setRestored(false); setSavedAt(0)
        clearDraft(accountKey)
      } else {
        // 用户在等待期间继续写了：保留新输入，并把「已提交」与「仍保留」一次说清
        saveDraft(accountKey, { title, body, tags, display })
        setSavedAt(Date.now())
      }
      onSubmitted(
        r.duplicate
          ? '这篇投稿此前已提交，无需重复提交。'
          : outcome === 'clear'
            ? '投稿已提交审核；通过后才会公开。'
            : '投稿已提交审核；你在等待期间继续写的内容仍保留在本页与本地草稿中。',
      )
    } catch (e) {
      if (seq !== seqRef.current || accountRef.current !== snapshot.accountKey) return
      setError(`${errorText(e)}（内容仍保留在本页，可修改后重试）`)
    } finally {
      if (seq === seqRef.current) setBusy(false)
    }
  }

  async function clearAll() {
    const ok = await confirmDialog({
      title: '清空这份草稿？',
      message: '标题、正文和已选标签都会被清空，本地草稿也会删除。此操作不可撤销。',
      confirmText: '清空', danger: true,
    })
    if (!ok) return
    setTitle(''); setBody(''); setTags([]); setPreview(false)
    clearDraft(accountKey); setRestored(false); setSavedAt(0); 
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      {restored && !editTarget && (
        <Notice kind="ok">已恢复本账号上次未提交的本地草稿{savedAt ? `（保存于 ${formatTime(savedAt)}）` : ''}。</Notice>
      )}
      {editTarget && (
        <Notice kind="warn">
          正在编辑已发布的投稿。提交后会生成一个新的待审版本；
          {editTarget.hasPublishedVersion ? '审核通过前，读者仍会看到旧版本。' : '通过后才会公开。'}
          <button type="button" className="ml-2 underline" onClick={() => { onCancelEdit(); setTitle(''); setBody(''); setTags([]) }}>取消编辑</button>
        </Notice>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-14 font-semibold text-ink-100">{editTarget ? '修改投稿' : '写一段新投稿'}</h3>
          {savedAt > 0 && !editTarget && <StatusPill>草稿已存本机</StatusPill>}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setPreview((v) => !v)}>
          {preview ? <EyeOff size={14} /> : <Eye size={14} />}{preview ? '返回编辑' : '预览读者视角'}
        </Button>
      </div>

      {preview ? (
        <article className="rounded-2xl border border-ink-700 bg-ink-900/60 p-5 sm:p-6">
          <h2 className="text-20 font-semibold leading-snug text-ink-100">{title.trim() || '（未填写标题）'}</h2>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-12 text-ink-400">
            <span>{display === 'nickname' ? '你的社区昵称' : '匿名用户'}</span>
            <span>·</span><span>审核通过后显示发布时间</span>
            {tags.map((t) => <StatusPill key={t}>{t}</StatusPill>)}
          </p>
          <div className="mt-4"><ReadingText body={body || '（正文还是空的）'} fontSize={16} /></div>
          <p className="mt-6 text-12 leading-relaxed text-ink-400">
            以上是默认阅读样式。正文以纯文本显示，段落间空行会压缩；不支持富文本或图片。
          </p>
        </article>
      ) : (
        <>
          <Field label="标题" hint={`${titleCount} / ${COMMUNITY_LIMITS.titleMax} 个字符`} htmlFor="community-title">
            <input id="community-title" value={title} maxLength={COMMUNITY_LIMITS.titleMax * 2}
              onChange={(e) => setTitle(e.target.value)} placeholder="给这段文字起个标题"
              className="w-full rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-15 text-ink-100 outline-none focus:border-amber/60" />
          </Field>

          <Field
            label="正文"
            hint={`${bodyCount.toLocaleString('zh-CN')} / ${COMMUNITY_LIMITS.bodyMax.toLocaleString('zh-CN')} 个字符（含标点、空格与换行）`}
            htmlFor="community-body"
          >
            <textarea id="community-body" rows={16} value={body} onChange={(e) => setBody(e.target.value)}
              placeholder="只支持纯文字。请只粘贴你愿意公开的片段，不要上传整本作品或他人隐私。"
              className={`w-full resize-y rounded-xl border bg-ink-900 px-4 py-3 text-15 leading-8 text-ink-100 outline-none ${overLimit ? 'border-red-500/60' : 'border-ink-700 focus:border-amber/60'}`} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={`标签（最多 ${COMMUNITY_LIMITS.tagMax} 个）`}>
              <div className="flex flex-wrap gap-2">
                {COMMUNITY_TAGS.map((t) => (
                  <Button key={t} size="xs" variant="toggle" selected={tags.includes(t)} onClick={() => toggleTag(t)}>{t}</Button>
                ))}
              </div>
            </Field>

            <Field label="公开方式" hint="匿名展示不会公开登录账号；选择昵称后，别人可能据此把你在不同内容里的发言关联起来。">
              <select aria-label="公开方式" value={display} onChange={(e) => setDisplay(e.target.value as DisplayMode)}
                className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-13 text-ink-100">
                <option value="anonymous">匿名用户（默认）</option>
                <option value="nickname">显示我的社区昵称</option>
              </select>
            </Field>
          </div>

          <Notice kind="warn">
            发布前请确认：内容将公开、可能被他人复制或转载；你需要有权发布这些文字；请避免写入门牌、电话、真实姓名等个人信息。
          </Notice>
        </>
      )}

      {error && <Notice kind="error">{error}</Notice>}
      {overLimit && <Notice kind="error">超出字数上限，请删减后再提交（当前正文 {bodyCount.toLocaleString('zh-CN')} 字）。</Notice>}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="lg" disabled={!canSubmit || preview} onClick={() => void submit()}>
          {busy ? '提交中…' : editTarget ? '提交修改' : '提交审核'}
        </Button>
        {!editTarget && (title || body) && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void clearAll()}>清空草稿</Button>
        )}
        <span className="text-11 text-ink-400">审核流程：规则初筛 → 管理员本地 AI 建议 → 管理员确认发布。AI 只提供建议，不会自动发布。</span>
      </div>
    </div>
  )
}
