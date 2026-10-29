import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import * as db from '@/lib/db'
import { captureCandidateOwner } from '@/lib/ai/candidateContext'

/** A failed refresh keeps the last readable snapshot; late reads never enter another workspace. */
export function useRevisionRead<T>(read: (projectId: string) => Promise<T[]>) {
  const [owner] = useState(captureCandidateOwner)
  const alive = useRef(true), sequence = useRef(0)
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const current = useCallback(() => alive.current && owner.current(), [owner])
  const [rows, setRows] = useState<T[] | null>(null)
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const [reading, setReading] = useState(true)
  const load = useCallback(async () => {
    if (!current()) return
    const request = ++sequence.current
    setReading(true)
    try {
      const [list, chapters] = await Promise.all([read(owner.projectId), db.getAllChapters()])
      if (!current() || request !== sequence.current) return
      setRows(list)
      setTitles(Object.fromEntries(chapters.map(chapter => [chapter.id, chapter.title])))
      setErr('')
    } catch {
      if (current() && request === sequence.current) {
        setErr('读取未完成，已保留上次显示的内容。请检查存储状态后重试；当前列表可能不是最新。')
        setRows(previous => previous ?? [])
      }
    } finally {
      if (current() && request === sequence.current) setReading(false)
    }
  }, [current, owner, read])
  return { rows, titles, err, reading, load, current }
}
