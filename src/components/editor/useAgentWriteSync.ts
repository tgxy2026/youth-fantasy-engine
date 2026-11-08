/**
 * 外部 Agent 写入正文后的界面同步（3.4.3）。
 *
 * 【为什么单独一个 hook】`useNovelEditorModel.ts` 已顶到 1200 行硬上限（structureGates ① /
 * editorViewMath ④）。按项目规矩越线**外抽 hook**，而不是删注释凑行数。
 *
 * 【做什么】执行器在写入前已拒绝有未保存草稿的章节；这里仍再判一次「当前章是否干净」，
 * 干净才用库里的新内容替换内存副本。否则页面会停在旧正文，作者下一次编辑就会用旧内容
 * 覆盖 Agent 刚写入的正文。
 *
 * 【为什么直接改 draft 而不是 `load()`】`load()` 会重新挑初始章，可能把作者正在看的章
 * 弹走。这里只针对「事件指定的那一章」原地刷新。
 */
import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import * as db from '@/lib/db'
import type { Chapter } from '@/lib/types'

export interface AgentWriteSyncDeps {
  activeRef: { current: Chapter | null }
  draftRef: { current: string }
  setChapters: Dispatch<SetStateAction<Chapter[]>>
  setDraftContent: (value: string) => void
  setDeferredContent: (value: string) => void
  onStatsChangeRef: { current: (() => void) | undefined }
}

export function useAgentWriteSync(deps: AgentWriteSyncDeps): void {
  const { activeRef, draftRef, setChapters, setDraftContent, setDeferredContent, onStatsChangeRef } = deps
  useEffect(() => {
    let alive = true
    const onAgentWrite = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; kind?: string; chapterId?: string }>).detail
      if (!detail || detail.kind !== 'chapter' || !detail.chapterId) return
      if (detail.projectId && detail.projectId !== db.getCurrentProjectId()) return
      const current = activeRef.current
      if (!current || current.id !== detail.chapterId) return
      if (draftRef.current !== (current.content ?? '')) return // 有未保存输入：不覆盖
      void db.getAllChapters().then(list => {
        if (!alive) return
        const next = list.find(c => c.id === detail.chapterId)
        if (!next) return
        setChapters(list)
        draftRef.current = next.content ?? ''
        setDraftContent(next.content ?? '')
        setDeferredContent(next.content ?? '')
        onStatsChangeRef.current?.()
      }).catch(() => { /* 读取失败不打断写作，作者可手动切章刷新 */ })
    }
    window.addEventListener('yfe:agent-write', onAgentWrite)
    return () => { alive = false; window.removeEventListener('yfe:agent-write', onAgentWrite) }
  }, [activeRef, draftRef, setChapters, setDraftContent, setDeferredContent, onStatsChangeRef])
}