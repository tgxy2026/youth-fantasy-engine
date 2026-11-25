import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FileUp, RotateCcw, Trash2 } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { downloadBlob } from '@/lib/storage/zip'
import * as db from '@/lib/db'
import type { StoredSyncConflict } from '@/lib/db'
import {
  CONFLICT_PAGE, CONFLICT_RETENTION_DAYS, CONFLICT_SIZE_WARN_BYTES, CONFLICT_TOTAL_WARN_BYTES,
  conflictStats, conflictStoreLabel, conflictStores, filterConflicts, formatConflictBytes, isConflictExpired,
  type ConflictStatusFilter,
} from '@/lib/sync/conflictView'
import {
  conflictDeletePrompt, conflictLabel, conflictPreview, conflictRestorePrompt,
  decideConflictRestore, pickConflictSelection,
} from '@/lib/sync/conflictActions'


export default function SyncConflictCenter({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [records, setRecords] = useState<StoredSyncConflict[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  // 🔴 3.1.1 · 筛选状态每次打开**重置为默认**（全部类型 / 全部状态）—— 不做跨会话持久化。
  //    这样「上次筛了待处理、这次一条也看不到」的误会不存在（验收口径 4 允许「明确重置为默认」）。
  const [storeFilter, setStoreFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<ConflictStatusFilter>('all')
  const [shown, setShown] = useState(CONFLICT_PAGE)

  const reload = useCallback(async () => {
    try {
      const list = await db.listSyncConflicts()
      setRecords(list)
      setSelected(previous => pickConflictSelection(list, previous))
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
  useEffect(() => {
    if (!open) return
    setStoreFilter('all'); setStatusFilter('all'); setShown(CONFLICT_PAGE)
    void reload()
  }, [open, reload])

  // 🔴 体积一次性算好（records 变才重算）：300+ 条时若在 render 里逐条 JSON.stringify，
  //    每次选中/翻页都会重算一遍大正文序列化 —— 那是分页要解决的「卡顿」源头。
  const stats = useMemo(() => conflictStats(records), [records])
  const storeOptions = useMemo(() => conflictStores(records), [records])
  const filtered = useMemo(
    () => filterConflicts(records, { store: storeFilter, status: statusFilter }),
    [records, storeFilter, statusFilter],
  )
  const visible = useMemo(() => filtered.slice(0, shown), [filtered, shown])
  const sizeOf = (c: StoredSyncConflict) => stats.sizes.get(c.metaKey) ?? 0

  // 选中项必须落在当前筛选结果里 —— 切换筛选后，旧的选中可能已被筛掉
  useEffect(() => {
    setSelected(pickConflictSelection(filtered, selected))
  }, [filtered, selected])

  const current = filtered.find(c => c.metaKey === selected)
  const unresolved = stats.unresolved
  const totalWarn = stats.bytes > CONFLICT_TOTAL_WARN_BYTES
  // 🔴 能不能原位恢复、不能时为什么 —— 判定与文案都在 `conflictActions`（那里有单测）；
  //    旧实现把这段写在组件里，作者点下去才发现「当前章节已不存在」。
  const restoreDecision = current ? decideConflictRestore(current, db.getCurrentProjectId()) : null
  const exportRecord = (c: StoredSyncConflict) => {
    const name = `青春幻想引擎-同步冲突-${new Date(c.at || Date.now()).toISOString().replace(/[:.]/g, '-')}.json`
    downloadBlob(name, new Blob([JSON.stringify({
      format: 'yfe-sync-conflict', version: 1, store: c.store, key: c.key, at: c.at,
      local: c.local, server: c.server,
    }, null, 2)], { type: 'application/json' }))
  }
  const restore = async (c: StoredSyncConflict) => {
    const ok = await confirmDialog(conflictRestorePrompt(c))
    if (!ok) return
    setBusy(true)
    try {
      // 主操作成功后可能带回「下游动作没跟上」的告警（字数统计 / 处理状态 / 落盘），如实合并进提示
      const projectId = db.getCurrentProjectId()
      const { warnings, persisted } = await db.restoreServerChapterFromConflict(c.metaKey)
      const base = persisted ? '章节已恢复并保存到本机，恢复前项目备份可在备份管理中找到' : '章节已在内存中恢复'
      showToast(warnings.length ? `${base}；但${warnings.join('、')}` : base, warnings.length ? 'error' : 'success')
      await reload()
      if (persisted && db.getCurrentProjectId() === projectId) location.reload()
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
    const ok = await confirmDialog(conflictDeletePrompt(c))
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
    <Modal open={open} onClose={() => { if (!busy) setOpen(false) }} showCloseButton={!busy} title="同步冲突中心" icon={<AlertTriangle size={15} />} width="2xl">
      <p className="mb-3 text-11 text-ink-400">冲突双方保存在本机。先核对内容，再导出或恢复；已处理记录可以保留作为历史。</p>
      {loadError && <p className="mb-3 text-12 text-danger">读取失败：{loadError}</p>}
      {records.length === 0 ? <div className="py-8 text-center text-12 text-ink-500">
        {/* 🔴 读库失败与「确实没有冲突」必须分开说 —— 冲突副本是云端那一版的唯一留档，
            把「读取失败」显示成「没有记录」会让作者以为安全（违反「绝不静默」）。 */}
        {loadError ? '读取失败，暂时无法确认有没有冲突记录 —— 关掉本窗口重开一次再试。' : '没有同步冲突记录'}
      </div> : <div className="space-y-3">
        {/* 体积与保留策略：**只展示，不自动清理**（自动删除属不可逆操作，须主人单独确认） */}
        <div className="rounded-lg border border-ink-700 bg-ink-800/50 p-2.5 text-10 text-ink-500">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>共 <b className="font-medium text-ink-200">{stats.total}</b> 条 · 待处理 <b className="font-medium text-ink-200">{stats.unresolved}</b> · 合计占用 <b className={totalWarn ? 'font-medium text-danger' : 'font-medium text-ink-200'}>{formatConflictBytes(stats.bytes)}</b></span>
            {stats.expired > 0 && <span className="text-amber">其中 {stats.expired} 条已超保留期</span>}
          </div>
          <div className="mt-1 leading-relaxed">
            保留策略：已处理的副本保留 <b className="font-medium text-ink-300">{CONFLICT_RETENTION_DAYS}</b> 天后会在这里提示「可清理」，<b className="font-medium text-ink-300">不会自动删除</b>；
            单条超过 {formatConflictBytes(CONFLICT_SIZE_WARN_BYTES)}、或合计超过 {formatConflictBytes(CONFLICT_TOTAL_WARN_BYTES)} 时会明显增大本机数据文件。
          </div>
          {totalWarn && <div className="mt-1 text-danger">冲突数据合计已超过 {formatConflictBytes(CONFLICT_TOTAL_WARN_BYTES)} —— 建议导出留档后，删除不再需要的副本。</div>}
        </div>

        {/* 筛选：类型（按实际出现过的 store）+ 处理状态 */}
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="筛选冲突类型" value={storeFilter} onChange={e => { setStoreFilter(e.target.value); setShown(CONFLICT_PAGE) }}
            className="rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-12">
            <option value="all">全部类型</option>
            {storeOptions.map(s => <option key={s} value={s}>{conflictStoreLabel(s)}</option>)}
          </select>
          <select aria-label="筛选处理状态" value={statusFilter} onChange={e => { setStatusFilter(e.target.value as ConflictStatusFilter); setShown(CONFLICT_PAGE) }}
            className="rounded-lg border border-ink-700 bg-ink-900 px-2 py-1 text-12">
            <option value="all">全部状态</option>
            <option value="open">待处理</option>
            <option value="resolved">已处理</option>
          </select>
          <span className="flex-1" />
          <span className="text-10 text-ink-500">筛选后 {filtered.length} 条</span>
        </div>

        {filtered.length === 0 ? <div className="py-6 text-center text-12 text-ink-500">当前筛选条件下没有冲突记录</div> : <>
          {/* 分批渲染：与「资料提及」面板同范式，300+ 条时不一次铺满 */}
          <div className="max-h-56 overflow-y-auto space-y-1">{visible.map(c => {
            const b = sizeOf(c)
            const expired = isConflictExpired(c)
            return <Button key={c.metaKey} variant="bare" onClick={() => setSelected(c.metaKey)}
              className={`w-full rounded-lg border px-2 py-1.5 text-left text-11 ${selected === c.metaKey ? 'border-amber/50 bg-amber/10' : 'border-ink-700 bg-ink-800/50'}`}>
              <span className="block truncate text-ink-100">{conflictLabel(c)} {c.resolvedAt ? '· 已处理' : '· 待处理'}{expired ? ' · 可清理' : ''}</span>
              <span className="text-10 text-ink-500">{new Date(c.at).toLocaleString()} · <span className={b > CONFLICT_SIZE_WARN_BYTES ? 'text-danger' : ''}>{formatConflictBytes(b)}</span></span>
            </Button>
          })}</div>
          {shown < filtered.length && <div className="text-center">
            <Button variant="secondary" size="sm" onClick={() => setShown(s => s + CONFLICT_PAGE)}>
              显示更多（剩余 {filtered.length - shown} 条）
            </Button>
          </div>}
          {current && <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div><h3 className="mb-1 text-11 text-ink-300">本机那一版</h3><pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-ink-700 bg-ink-900 p-2 text-10 text-ink-300">{conflictPreview(current.local)}</pre></div>
              <div><h3 className="mb-1 text-11 text-ink-300">云端那一版</h3><pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-ink-700 bg-ink-900 p-2 text-10 text-ink-300">{conflictPreview(current.server)}</pre></div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => exportRecord(current)}><FileUp size={12} /> 导出双方完整数据</Button>
              {restoreDecision?.allowed &&
                <Button variant="secondary" disabled={busy} onClick={() => void restore(current)}><RotateCcw size={12} /> 恢复云端章节</Button>}
              {!current.resolvedAt && <Button variant="secondary" disabled={busy} onClick={() => void resolve(current)}>标为已处理</Button>}
              <Button variant="danger" disabled={busy} onClick={() => void remove(current)}><Trash2 size={12} /> 删除副本</Button>
            </div>
            {restoreDecision && !restoreDecision.allowed && <p className="text-11 text-ink-500">{restoreDecision.reason}</p>}
          </>}

          {/* 底部状态条：与「资料提及」面板同范式 */}
          <div className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-1.5 text-10 text-ink-600">
            <span>共 {stats.total} 条 · 筛选后 {filtered.length} 条 · 已显示 {visible.length} 条 · 合计 {formatConflictBytes(stats.bytes)}</span>
            <span className="flex-1" />
            <span>点击记录查看双方内容</span>
          </div>
        </>}
      </div>}
    </Modal>
  </>
}
