import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { getCurrentProjectId } from '@/lib/db'
import { captureOwnedOperation } from '@/lib/storage/ownedOperation'
import { subTabIdOf } from '@/lib/world/worldSets'
import { decideWorldSetEvent, shouldMergeWorldSetRecord, type WorldSetEventDetail } from '@/lib/world/agentWorldSetDecision'
import type { CardRecord } from '@/lib/types'

/** 仅合并 Agent 新建的子项，不替换正在编辑的本地草稿。判定见 `agentWorldSetDecision`。 */
export function useAgentWorldSetSync(tabId: string, setSubs: Dispatch<SetStateAction<CardRecord[]>>) {
  useEffect(() => {
    let alive = true
    const projectId = getCurrentProjectId()
    const onWrite = (event: Event) => {
      const detail = (event as CustomEvent<WorldSetEventDetail>).detail
      const decision = decideWorldSetEvent({ detail, projectId, tabId })
      if (!decision.accept) return
      const owner = captureOwnedOperation(projectId)
      void owner.store.get<CardRecord>('cardRecords', decision.cardId).then(record => {
        if (!alive) return
        owner.assertCurrent()
        setSubs(previous => {
          try { owner.assertCurrent() } catch { return previous }
          const merge = alive && shouldMergeWorldSetRecord({
            record,
            projectId,
            expectedTabId: subTabIdOf(tabId),
            existingIds: previous.map(item => item.id),
          })
          return merge && record ? [...previous, record].sort((a, b) => a.order - b.order) : previous
        })
      }).catch(() => { /* 保留当前草稿，可切换页签后重载 */ })
    }
    window.addEventListener('yfe:agent-write', onWrite)
    return () => { alive = false; window.removeEventListener('yfe:agent-write', onWrite) }
  }, [tabId, setSubs])
}
