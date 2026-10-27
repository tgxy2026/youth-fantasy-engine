import { useEffect, useRef, useState } from 'react'
import { captureCandidateOwner } from '@/lib/ai/candidateContext'
import { createManualDraftSaver, type ManualDraftSaveState } from '@/lib/editor/manualDraftSave'

export function useManualDraftSave<T>(options: {
  read: () => { value: T; dirty: boolean }
  write: (value: T) => Promise<void>
  committed: (value: T) => boolean
}) {
  const latest = useRef(options)
  latest.current = options
  const [owner] = useState(captureCandidateOwner)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [state, setState] = useState<ManualDraftSaveState>({ saving: false, submitted: false, error: '' })
  const [save] = useState(() => createManualDraftSaver<T>({
    current: () => alive.current && owner.current(),
    read: () => latest.current.read(),
    write: value => latest.current.write(value),
    committed: value => latest.current.committed(value),
    state: setState,
  }))
  return { ...state, save }
}
