import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Download, RotateCcw, Trash2 } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { downloadBlob } from '@/lib/storage/zip'
import * as db from '@/lib/db'
import type { StoredSyncConflict } from '@/lib/db'

const labelOf = (c: StoredSyncConflict) => {
  const row = (c.server && typeof c.server === 'object' ? c.server : c.local) as { title?: unknown; name?: unknown } | null
  const name = row?.title ?? row?.name ?? c.key
  return `${c.store || '未知类型'} · ${String(name ?? '未知记录')}`
}

const previewOf = (v: unknown) => {
  if (v == null) return '此侧已删除或没有该记录'
  const text = JSON.stringify(v, null, 2)
  return text.length > 20000 ? `${text.slice(0, 20000)}\n…预览已截断，导出文件包含完整内容` : text
}

export default function SyncConflictCenter({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [records, setRecords] = useState<StoredSyncConflict[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')

  const reload = useCallback(async () => {
    try {
      const list = await db.listSyncConflicts()
      setRecords(list)
      setSelected(previous => list.some(c => c.metaKey === previous) ? previous : list[0]?.metaKey ?? null)
      setLoadError('')
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void reload()
    window.addEventListener('yfe:sync-conflict', reload)
    return () => window.removeEventListener('yfe:sync-conflict', reload)
  }, [reload])
  useEffect(() => { if (open) void reload() }, [open, reload])

  const current = records.find(c => c.metaKey === selected)
  const unresolved = records.filter(c => !c.resolvedAt).length
  const exportRecord = (c: StoredSyncConflict) => {
    const name = `青春幻想引擎-同步冲突-${new Date(c.at || Date.now()).toISOString().replace(/[:.]/g, '-')}.json`
    downloadBlob(name, new Blob([JSON.stringify({
      format: 'yfe-sync-conflict', version: 1, store: c.store, key: c.key, at: c.at,
      local: c.local, server: c.server,
    }, null, 2)], { type: 'application/json' }))
  }
  const restore = async (c: StoredSyncConflict) => {
    const ok = await confirmDialog({
      title: '恢复云端那一版章节',
      message: `将用冲突副本覆盖当前章节「${labelOf(c)}」。操作前会自动建立一份完整项目备份；备份失败时不会覆盖。请确认已查看双方内容。`,
      confirmText: '建立备份并恢复', danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await db.restoreServerChapterFromConflict(c.metaKey)
      showToast('章节已恢复，恢复前项目备份可在备份管理中找到', 'success')
      await reload()
      setTimeout(() => location.reload(), 500)
    } catch (e) {
      showToast(`恢复失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally { setBusy(false) }
  }
  const resolve = async (c: StoredSyncConflict) => {
    setBusy(true)
    try { await db.markSyncConflictResolved(c.metaKey); await reload() }
    catch (e) { showToast(`标记失败：${e instanceof Error ? e.message : String(e)}`, 'error') }
    finally { setBusy(false) }
  }
  const remove = async (c: StoredSyncConflict) => {
    const ok = await confirmDialog({
      title: '删除冲突副本', message: `将永久删除「${labelOf(c)}」的双方冲突记录。建议先导出副本，再删除。`,
      confirmText: '删除副本', danger: true,
    })
    if (!ok) return
    setBusy(true)
    try { await db.deleteSyncConflict(c.metaKey); await reload() }
    catch (e) { showToast(`删除失败：${e instanceof Error ? e.message : String(e)}`, 'error') }
    finally { setBusy(false) }
  }

  return <>
    {compact ? <Button variant="icon-amber" size="xs" iconOnly onClick={() => setOpen(true)}
      className="relative shrink-0" title={`同步冲突中心${unresolved ? `：${unresolved} 条待处理` : ''}`} aria-label={`同步冲突中心${unresolved ? `，${unresolved} 条待处理` : ''}`}>
      <AlertTriangle size={12} />{unresolved > 0 && <span className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-red-400" />}
    </Button> : <Button variant="bare" onClick={() => setOpen(true)} className="flex w-full items-center justify-center gap-1 rounded-lg border border-ink-700 px-2 py-1.5 text-11 text-ink-300 hover:text-amber">
      <AlertTriangle size={12} /> 同步冲突{unresolved ? `（${unresolved} 条待处理）` : ''}
    </Button>}
    <Modal open={open} onClose={() => setOpen(false)} title="同步冲突中心" icon={<AlertTriangle size={15} />} width="2xl">
      <p className="mb-3 text-11 text-ink-400">冲突双方保存在本机。先核对内容，再导出或恢复；已处理记录可以保留作为历史。</p>
      {loadError && <p className="mb-3 text-12 text-danger">读取失败：{loadError}</p>}
      {records.length === 0 ? <div className="py-8 text-center text-12 text-ink-500">没有同步冲突记录</div> : <div className="space-y-3">
        <div className="max-h-36 overflow-y-auto space-y-1">{records.map(c => <Button key={c.metaKey} variant="bare" onClick={() => setSelected(c.metaKey)}
          className={`w-full rounded-lg border px-2 py-1.5 text-left text-11 ${selected === c.metaKey ? 'border-amber/50 bg-amber/10' : 'border-ink-700 bg-ink-800/50'}`}>
          <span className="block truncate text-ink-100">{labelOf(c)} {c.resolvedAt ? '· 已处理' : '· 待处理'}</span>
          <span className="text-10 text-ink-500">{new Date(c.at).toLocaleString()}</span>
        </Button>)}</div>
        {current && <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div><h3 className="mb-1 text-11 text-ink-300">本机那一版</h3><pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-ink-700 bg-ink-900 p-2 text-10 text-ink-300">{previewOf(current.local)}</pre></div>
            <div><h3 className="mb-1 text-11 text-ink-300">云端那一版</h3><pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-ink-700 bg-ink-900 p-2 text-10 text-ink-300">{previewOf(current.server)}</pre></div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => exportRecord(current)}><Download size={12} /> 导出双方完整数据</Button>
            {current.store === 'chapters' && current.server != null && db.getCurrentProjectId() === (current.server as { projectId?: string }).projectId &&
              <Button variant="secondary" disabled={busy} onClick={() => void restore(current)}><RotateCcw size={12} /> 恢复云端章节</Button>}
            {!current.resolvedAt && <Button variant="secondary" disabled={busy} onClick={() => void resolve(current)}>标为已处理</Button>}
            <Button variant="danger" disabled={busy} onClick={() => void remove(current)}><Trash2 size={12} /> 删除副本</Button>
          </div>
          {current.store !== 'chapters' && <p className="text-11 text-ink-500">此类型暂不支持安全的原位恢复。导出双方完整数据后，可在对应项目中手工核对。</p>}
        </>}
      </div>}
    </Modal>
  </>
}
