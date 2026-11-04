import { useEffect, useRef, useState } from 'react'
import { Lightbulb } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { addItem, INSPIRATION_MAX } from '@/lib/creative/inspirationBox'
import { registerAuxiliaryLeaveGuard } from '@/lib/editor/leaveBarrier'
import type { Chapter } from '@/lib/types'

/** 快速记录复用灵感夹；每个项目的未提交输入在当前挂载期间独立保留。 */
export default function QuickInspiration({ projectId, onOpen, chapters }: { projectId: string; onOpen: () => void; chapters: Chapter[] }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [chapterByProject, setChapterByProject] = useState<Record<string, string>>({})
  const busyRef = useRef(false)
  const text = drafts[projectId] ?? ''
  const draftRef = useRef(text)
  draftRef.current = text
  const saveRef = useRef<() => Promise<boolean>>(async () => false)
  const save = async () => {
    if (busyRef.current) return false
    if (!text.trim()) return true
    const ownerId = projectId, submitted = text
    busyRef.current = true
    setBusy(true)
    setNotice(current => ({ ...current, [ownerId]: '' }))
    try {
      const result = await addItem(submitted, undefined, ownerId, chapterByProject[ownerId] || undefined)
      if (result.added) {
        setDrafts(current => ({ ...current, [ownerId]: current[ownerId] === submitted ? '' : current[ownerId] }))
        setNotice(current => ({ ...current, [ownerId]: '已保存到本作品的灵感夹。' }))
        if (draftRef.current === submitted) draftRef.current = ''
        return true
      } else {
        const message = result.reason === 'dup' ? '这条灵感已在夹中，输入已保留。' : result.reason === 'full' ? `灵感夹已达 ${INSPIRATION_MAX} 条，输入已保留。` : '请输入灵感。'
        setNotice(current => ({ ...current, [ownerId]: message }))
        return false
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setNotice(current => ({ ...current, [ownerId]: `保存未确认：${detail}；输入已保留。` }))
      return false
    } finally { busyRef.current = false; setBusy(false) }
  }
  saveRef.current = save
  useEffect(() => registerAuxiliaryLeaveGuard({
    isDirty: () => !!draftRef.current.trim() || busyRef.current,
    flush: async () => await saveRef.current() ? { ok: true } : { ok: false, scope: 'record', error: '灵感尚未保存，请处理后重试。' },
  }), [])
  return <section aria-label="随手记灵感" className="space-y-2">
    <h2 className="text-13 font-semibold text-ink-100 flex items-center gap-2"><Lightbulb size={14} className="text-amber" />随手记灵感</h2>
    <textarea aria-label="灵感内容" value={text} rows={2} className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-12 text-ink-100" placeholder="记下一个点子、一句台词或一个画面" onChange={e => { draftRef.current = e.target.value; setDrafts(current => ({ ...current, [projectId]: e.target.value })) }} />
    <label className="flex items-center gap-2 text-11 text-ink-300">关联章节（可选）
      <select aria-label="关联章节" disabled={busy} value={chapterByProject[projectId] ?? ''} onChange={e => setChapterByProject(current => ({ ...current, [projectId]: e.target.value }))} className="min-w-0 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-ink-100">
        <option value="">不关联</option>
        {chapterByProject[projectId] && !chapters.some(chapter => chapter.id === chapterByProject[projectId]) && <option value={chapterByProject[projectId]}>所选章节不可用，请重新选择</option>}
        {chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.title || '未命名章节'}</option>)}
      </select>
    </label>
    <div className="flex items-center gap-2 flex-wrap">
      <Button size="sm" onClick={() => void save()} disabled={busy || !text.trim()}>{busy ? '保存中…' : '保存到灵感夹'}</Button>
      <Button size="sm" variant="ghost" onClick={onOpen}>打开灵感启发</Button>
      {notice[projectId] && <span role="status" className="text-11 text-ink-300">{notice[projectId]}</span>}
    </div>
  </section>
}
