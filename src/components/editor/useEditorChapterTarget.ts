import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { Chapter } from '@/lib/types'
import { captureWorkspaceView } from '@/lib/settings/workspaceRuntime'

/** A request generation, rather than a chapter ID, owns one explicit chapter selection. */
export function useEditorChapterTarget({ loaded, chapters, chapterId, requestId, setActiveId, expandedRef, setExpanded }: {
  loaded: boolean; chapters: Chapter[]; chapterId?: string | null; requestId?: number
  setActiveId: Dispatch<SetStateAction<string | null>>
  expandedRef: MutableRefObject<Set<string>>
  setExpanded: Dispatch<SetStateAction<Set<string>>>
}) {
  const consumed = useRef('')
  useEffect(() => {
    if (!chapterId) { consumed.current = ''; return }
    if (!loaded) return
    const key = JSON.stringify([requestId ?? 0, chapterId])
    if (consumed.current === key) return
    consumed.current = key
    const chapter = chapters.find(item => item.id === chapterId)
    if (!chapter) return
    captureWorkspaceView()
    setActiveId(chapterId)
    if (!expandedRef.current.has(chapter.volumeId)) setExpanded(previous => new Set(previous).add(chapter.volumeId))
  }, [loaded, chapters, chapterId, requestId, setActiveId, expandedRef, setExpanded])
}
