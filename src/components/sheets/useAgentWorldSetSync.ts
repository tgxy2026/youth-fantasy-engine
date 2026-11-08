import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { getCurrentProjectId } from '@/lib/db'
import { captureOwnedOperation } from '@/lib/storage/ownedOperation'
import { subTabIdOf } from '@/lib/world/worldSets'
import type { CardRecord } from '@/lib/types'

/** 仅合并 Agent 新建的子项，不替换正在编辑的本地草稿。 */
export function useAgentWorldSetSync(tabId: string, setSubs: Dispatch<SetStateAction<CardRecord[]>>) {
  useEffect(() => {
    let alive = true
    const projectId = getCurrentProjectId()
    const onWrite = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; projectId?: string; tabId?: string; cardId?: string }>).detail
      if (!detail || detail.kind !== 'world-set' || detail.projectId !== projectId || detail.tabId !== tabId || !detail.cardId) return
      const owner = captureOwnedOperation(projectId)
      void owner.store.get<CardRecord>('cardRecords', detail.cardId).then(record => {
        if (!alive || !record || record.projectId !== projectId || record.tabId !== subTabIdOf(tabId)) return
        owner.assertCurrent()
        setSubs(previous => {
          try { owner.assertCurrent() } catch { return previous }
          if (!alive || previous.some(item => item.id === record.id)) return previous
          return [...previous, record].sort((a, b) => a.order - b.order)
        })
      }).catch(() => { /* 保留当前草稿，可切换页签后重载 */ })
    }
    window.addEventListener('yfe:agent-write', onWrite)
    return () => { alive = false; window.removeEventListener('yfe:agent-write', onWrite) }
  }, [tabId, setSubs])
}
