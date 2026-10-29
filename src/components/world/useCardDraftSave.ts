import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { captureCandidateOwner } from '@/lib/ai/candidateContext'
import { getCardRecordsFor, saveCardRecord } from '@/lib/db'
import type { CardRecord } from '@/lib/types'
import { guardTabWrite } from '@/lib/templates/migrationGuard'
import { assertSubmissionAvailable } from '@/lib/storage/submissionState'
import { registerAuxiliaryLeaveGuard } from '@/lib/editor/leaveBarrier'
import { useManualDraftSave } from '@/components/common/useManualDraftSave'

/** Manual saves, card switches and App navigation share one immutable, owned submission. */
export function useCardDraftSave(options: {
  read: () => { value: CardRecord | null; dirty: boolean }
  committed: (value: CardRecord) => boolean
}) {
  const [owner] = useState(captureCandidateOwner)
  const alive = useRef(true), live = useRef(options)
  live.current = options
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const current = () => alive.current && owner.current()
  const save = useManualDraftSave<CardRecord | null>({
    read: options.read,
    write: async value => {
      if (!value || !current() || value.projectId !== owner.projectId) throw new Error('记录上下文已改变')
      assertSubmissionAvailable()
      const conflict = await guardTabWrite(value.projectId, value.tabId, 'draft')
      if (!current()) throw new Error('记录上下文已改变')
      if (conflict) throw new Error('模板迁移尚未完成')
      const records = await getCardRecordsFor(value.projectId, value.tabId)
      if (!current()) throw new Error('记录上下文已改变')
      if (!records.some(record => record.id === value.id)) throw new Error('这条记录已不存在')
      assertSubmissionAvailable()
      await saveCardRecord({ ...value, data: { ...value.data } })
      assertSubmissionAvailable()
    },
    committed: value => !!value && options.committed(value),
  })
  const saveRef = useRef(save.save)
  saveRef.current = save.save
  useEffect(() => registerAuxiliaryLeaveGuard({
    isDirty: () => alive.current && owner.current() && live.current.read().dirty,
    flush: async () => await saveRef.current() ? { ok: true } : { ok: false, scope: 'record', error: '角色或设定修改尚未提交，请保留草稿并重试。' },
  }), [owner])
  return save
}
