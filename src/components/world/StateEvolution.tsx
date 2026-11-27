/**
 * 状态演变（3.7.0 · W4 复核补）
 *
 * 角色卡 / 记录详情的「按章状态」列表 + 手动补登。
 * 🔴 prop 名用 `target` 而不是 `ref`：React 会把 `ref` 当特殊属性吞掉，传进来是 undefined（实机踩过）。
 * 🔴 只追加、不覆盖：不改当前字段值；与「设定变更」页签（作者改字段）是两回事。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/common/Button'
import { showToast } from '@/components/dialogs/dialogs'
import { appendStateRecords, buildStateRecord, evolutionOf, readStateRecords, type StateRecord } from '@/lib/settings/stateTrack'
import type { RecordRef } from '@/lib/revision/revisionTypes'

export default function StateEvolution({ target: recordRef, hint }: { target: RecordRef; hint?: string }) {
  // 🔴 用基础字段做依赖：调用方常传内联对象，按对象做依赖会导致 effect 每次渲染都重跑
  const { kind, tabId, id, projectId } = recordRef
  const [records, setRecords] = useState<StateRecord[] | null>(null)
  const [stateDraft, setStateDraft] = useState('')
  const [chapterNo, setChapterNo] = useState('')
  const [adding, setAdding] = useState(false)
  const aliveRef = useRef(true)
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])

  const load = useCallback((isCurrent: () => boolean = () => true) => {
    void readStateRecords()
      .then(list => { if (isCurrent()) setRecords(evolutionOf(list, { kind, tabId, id, projectId })) })
      .catch(() => { if (isCurrent()) setRecords(null) })
  }, [kind, tabId, id, projectId])
  useEffect(() => {
    let cancelled = false
    load(() => !cancelled)
    return () => { cancelled = true }
  }, [load])

  const add = async () => {
    if (adding) return
    const state = stateDraft.trim(), no = Number(chapterNo.trim())
    if (!state) { showToast('请先填写这一章的状态', 'info'); return }
    setAdding(true)
    try {
      const r = await appendStateRecords([buildStateRecord({
        ref: { kind, tabId, id, projectId }, chapterId: '', chapterNo: Number.isFinite(no) && no > 0 ? Math.floor(no) : 0,
        state, trigger: '手动补登',
      })])
      if (!aliveRef.current) return
      if (r.appended > 0) {
        setStateDraft(''); setChapterNo('')
        showToast('已补登一条状态演变', 'success')
        load(() => aliveRef.current)
      } else showToast('补登没写进去，请重试', 'error')
    } finally {
      if (aliveRef.current) setAdding(false)
    }
  }

  if (!records) return null
  return (
    <section data-state-evolution className="rounded-lg border border-ink-700 yfe-surface-3 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-11 text-ink-300">状态演变</span>
        <span className="text-10 text-ink-500">{records.length} 条 · 按章回溯，不改当前字段</span>
      </div>
      {hint && <div className="mb-1 text-10 text-ink-600">{hint}</div>}
      {records.length === 0 ? (
        <div className="text-10 text-ink-500 leading-relaxed">
          还没有演变记录。章后整理确认「人物状态 / 关系变化」时会自动记一条；也可以在下方手动补登。
        </div>
      ) : (
        <ol className="space-y-1">
          {records.map(r => (
            <li key={r.id} className="text-10 text-ink-400 leading-relaxed">
              <span className="text-ink-300">第{r.chapterNo || '?'}章</span>
              {r.previous ? <span className="text-ink-600">（改前：{r.previous}）</span> : null}
              <span className="mx-1">→</span>{r.state}
              {r.trigger ? <span className="text-ink-600"> · {r.trigger}</span> : null}
            </li>
          ))}
        </ol>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <input value={chapterNo} onChange={e => setChapterNo(e.target.value)} placeholder="章号" inputMode="numeric"
          className="w-16 rounded border border-ink-700 bg-ink-950 px-1.5 py-1 text-10 text-ink-200" />
        <input value={stateDraft} onChange={e => setStateDraft(e.target.value)} placeholder="第 N 章时是什么状态（作者直接写）"
          className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-950 px-1.5 py-1 text-10 text-ink-200" />
        <Button variant="secondary" size="xs" onClick={() => void add()} disabled={!stateDraft.trim() || adding}>补登</Button>
      </div>
    </section>
  )
}