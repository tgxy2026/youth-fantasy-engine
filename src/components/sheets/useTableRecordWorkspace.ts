import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { getAllChapterLedgerRows, getCurrentProjectId, getTableRowsFor } from '@/lib/db'
import type { TableRow } from '@/lib/types'
import { candidateApplyContext } from '@/lib/ai/candidateContext'
import { captureStorageWriteOwner } from '@/lib/storage/writeOwner'
import { createRecordDraftFlusher } from '@/lib/editor/recordDraftFlush'
import { registerLeaveGuard, type LeaveFlushResult } from '@/lib/editor/leaveBarrier'
import { useListWorkspaceView } from '@/components/common/useListWorkspaceView'
import { showToast } from '@/components/dialogs/dialogs'
import { commitTableDrafts, flushDrafts, type DraftMap } from './tableSheetDraftOps'

export function useTableRecordWorkspace(tabId: string, validate: () => string | null) {
  const view = useListWorkspaceView(getCurrentProjectId(), 'table-records:' + tabId)
  const context = candidateApplyContext(), ownerKey = view.ownerKey + context
  const currentView = view.isCurrent
  const current = useCallback(() => currentView() && context === candidateApplyContext(), [currentView, context])
  const [rows, storeRows] = useState<TableRow[]>([]), [drafts, storeDrafts] = useState<DraftMap>({})
  const rowsRef = useRef(rows), draftsRef = useRef(drafts)
  const source = useRef({ key: ownerKey, pid: getCurrentProjectId(), tabId, owner: captureStorageWriteOwner(getCurrentProjectId()) })
  const validateRef = useRef(validate); validateRef.current = validate
  const [loadedOwner, setLoadedOwner] = useState(''), [errorOwner, setErrorOwner] = useState('')
  const [revision, setRevision] = useState(0), [jobs, setJobs] = useState(0)
  const [receiptOwner, setReceiptOwner] = useState(''), [saveError, setSaveError] = useState({ owner: '', message: '' })
  const setRows = useCallback((action: SetStateAction<TableRow[]>) => {
    if (!current() || source.current.key !== ownerKey) return
    const next = typeof action === 'function' ? action(rowsRef.current) : action
    rowsRef.current = next; storeRows(next)
  }, [current, ownerKey])
  const setDrafts = useCallback((action: SetStateAction<DraftMap>) => {
    if (!current() || source.current.key !== ownerKey) return
    const next = typeof action === 'function' ? action(draftsRef.current) : action
    draftsRef.current = next; storeDrafts(next)
  }, [current, ownerKey])
  useEffect(() => {
    let cancelled = false
    rowsRef.current = []; draftsRef.current = {}; storeRows([]); storeDrafts({}); setJobs(0)
    source.current = { key: ownerKey, pid: getCurrentProjectId(), tabId, owner: captureStorageWriteOwner(getCurrentProjectId()) }
    setErrorOwner(''); setLoadedOwner('')
    const loading = tabId === 'chapter-master' ? getAllChapterLedgerRows() : getTableRowsFor(source.current.pid, tabId)
    void loading.then(value => {
      if (cancelled || !current()) return
      rowsRef.current = value; storeRows(value); setLoadedOwner(ownerKey)
    }).catch(() => { if (!cancelled && current()) setErrorOwner(ownerKey) })
    return () => { cancelled = true }
  }, [ownerKey, tabId, current, revision])
  const flush = useMemo(() => createRecordDraftFlusher<{ rows: TableRow[]; drafts: DraftMap }>({
    current: () => current() && source.current.key === ownerKey,
    read: () => ({ record: { rows: rowsRef.current, drafts: draftsRef.current }, dirty: Object.keys(draftsRef.current).length > 0 }),
    write: async snapshot => {
      const error = validateRef.current()
      if (error) throw new Error(error)
      if (!await flushDrafts(source.current.pid, tabId, snapshot.rows, snapshot.drafts)) throw new Error('资料归属或模板状态已改变，请核对当前草稿后重试')
    },
    saved: snapshot => {
      const committed = commitTableDrafts(rowsRef.current, draftsRef.current, snapshot.drafts)
      setRows(committed.rows); setDrafts(committed.drafts)
    },
  }), [current, ownerKey, tabId, setRows, setDrafts])
  const flushRecords = useCallback(() => {
    if (!current()) return Promise.resolve<LeaveFlushResult>({ ok: false, scope: 'record', error: new Error('资料上下文已改变') })
    setJobs(count => count + 1)
    return flush().then(result => {
      if (current()) {
        if (result.ok) { setReceiptOwner(ownerKey); setSaveError({ owner: '', message: '' }) }
        else setSaveError({ owner: ownerKey, message: '表格修改尚未提交，请保留草稿并重试保存。' })
      }
      return result
    }).finally(() => { if (current()) setJobs(count => Math.max(0, count - 1)) })
  }, [flush, current, ownerKey])
  useEffect(() => {
    registerLeaveGuard({ isDirty: () => Object.keys(draftsRef.current).length > 0, flush: async () => {
      for (let attempt = 0; attempt < 3 && Object.keys(draftsRef.current).length; attempt++) {
        const result = await flushRecords(); if (!result.ok) return result
      }
      return Object.keys(draftsRef.current).length ? { ok: false, scope: 'record', error: new Error('保存期间仍有新修改，请保存最新草稿后再离开') } : { ok: true }
    } })
    return () => registerLeaveGuard(null)
  }, [flushRecords])
  useEffect(() => () => {
    const owner = source.current, pending = draftsRef.current
    if (!Object.keys(pending).length || !owner.owner.current()) return
    void flushDrafts(owner.pid, owner.tabId, rowsRef.current, pending).then(ok => {
      if (!ok) showToast('离开前表格修改没能提交，请回到原表格核对草稿', 'error')
    }).catch(() => showToast('离开前保存表格失败，请回到原表格核对草稿', 'error'))
  }, [])
  return { rows, setRows, rowsRef, drafts, setDrafts, draftsRef, loaded: loadedOwner === ownerKey,
    loadError: errorOwner === ownerKey, retry: () => setRevision(value => value + 1), saving: jobs > 0, flushRecords, ownerKey,
    saveState: { saving: jobs > 0, submitted: receiptOwner === ownerKey, error: saveError.owner === ownerKey ? saveError.message : '' } }
}
