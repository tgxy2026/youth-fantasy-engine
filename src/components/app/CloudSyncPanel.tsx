/**
 * 网页云端版 · 「云端同步」面板（3.3.2 · B2）。
 *
 * 【它解决什么】P2/P3/P4 把同步的零件全做完了，但用户在界面上**看不到任何东西**：
 * 不知道这本有没有上云、上次同步是什么时候、云端是不是有更新版本、冲突了该点哪儿。
 * 没有这块界面，前面所有代码等于没装。
 *
 * 🔴 只在 `WEB_CLOUD` 渲染。桌面/便携/游客没有 `/api/v2` 路由，
 *    放个按钮出来只会让人点了报 404（同类判断见 `LoginDevices.tsx`）。
 * 🔴 **未绑定**时只有一条路：把本机这本传上去。不做"从云端拉一本新的回来"——
 *    那要先建本地项目再套用内容，涉及 id 重映射，属于 P5 的形态接入，这里不硬塞。
 * 🔴 冲突时**不自动选边**（`decideSync` 已定死）：只给「以本机为准重传」，
 *    「用云端覆盖本机」标为暂未开放 —— 它需要下载全部对象再套用，
 *    半路失败会留下写了一半的书，必须先在隔离环境验证过才敢放出来。
 * ✅ 「两份都留」已开放：走 `saveCloudCopyAsNewProject` —— 下载云端版本后**新建一本**，
 *    原项目的任何记录都不被改写，所以不需要"先备份再覆盖"那套风险承诺。
 *    副本不带自定义下拉选项（当前快照协议未包含），界面会如实说明。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CloudUpload, CloudOff, RefreshCw, Cloud, Clock, AlertTriangle, Link2 } from 'lucide-react'
import { WEB_CLOUD } from '@/lib/app/platform'
import { DESKTOP } from '@/lib/app/desktop'
import { desktopAuthStatus, DESKTOP_ACCOUNT_EVENT } from '@/lib/cloud/desktopLogin'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { getCurrentProjectId, ops } from '@/lib/db/core'
import type { Project } from '@/lib/types'
import { createSettingBindingStore } from '@/lib/sync/projectBindingStore'
import type { SyncBinding } from '@/lib/sync/projectBinding'
import { decideSync, planConflict } from '@/lib/sync/projectBinding'
import { bootSync, startAutoSync, stopAutoSync, isAutoSyncRunning, getSyncAccountId } from '@/lib/app/syncBoot'
import { runSaveBarrier } from '@/lib/app/bossSave'
import { createCloudProject, probeCloudProject, restoreCloudProject, purgeCloudProject, listCloudProjects, listCloudRevisions } from '@/lib/cloud/syncApi'
import type { CloudProjectList, CloudProjectRow, CloudRevisionRow, CloudVersionSummary } from '@/lib/cloud/syncApi'
import { uid } from '@/lib/app/id'
import { saveCloudCopyAsNewProject } from '@/lib/sync/projectPullWrite'
import { applyCloudCopyInPlace } from '@/lib/sync/projectPullApply'
import { cloudCopyFileName, loadCloudCopy } from '@/lib/sync/projectPullBundle'
import { downloadBlob } from '@/lib/storage/zip'
import type { SyncState } from '@/lib/sync/syncMachine'

const STATE_TEXT: Record<SyncState, { label: string; cls: string }> = {
  idle: { label: '未同步', cls: 'text-ink-400' },
  queued: { label: '排队中', cls: 'text-amber' },
  syncing: { label: '同步中', cls: 'text-amber' },
  synced: { label: '已同步', cls: 'text-emerald-400' },
  conflict: { label: '有冲突', cls: 'text-rose-400' },
  failed: { label: '同步失败', cls: 'text-rose-400' },
  blocked: { label: '已暂停', cls: 'text-rose-400' },
  offline: { label: '离线', cls: 'text-ink-400' },
}

const fmtWhen = (ms: number): string => {
  if (!ms) return '从未'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(ms).toLocaleString('zh-CN')
}

const fmtBytes = (n: number): string => {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default function CloudSyncPanel({ inline = false }: { inline?: boolean } = {}) {
  const [open, setOpen] = useState(false)
  const [project, setProject] = useState<Project | null>(null)
  const [binding, setBinding] = useState<SyncBinding | null>(null)
  const [cloudRevision, setCloudRevision] = useState<number | null>(null)
  /** 云端是否在回收站（0 = 否；>0 = 删除时间） */
  const [cloudDeletedAt, setCloudDeletedAt] = useState(0)
  /** 覆盖完成后的结果（含备份 id）—— 界面据此提示重新载入 */
  const [applied, setApplied] = useState<{ revision: number; backupId?: string } | null>(null)
  /** 云端这一版的摘要（章节数 / 时间）—— 覆盖前给用户看得见的依据 */
  const [cloudSummary, setCloudSummary] = useState<CloudVersionSummary | null>(null)
  /** 账号下的云端作品（含配额） */
  const [cloudList, setCloudList] = useState<CloudProjectList | null>(null)
  /** 展开历史版本的作品 id */
  const [historyOpen, setHistoryOpen] = useState<string | null>(null)
  const [historyData, setHistoryData] = useState<Record<string, CloudRevisionRow[]>>({})
  const [state, setState] = useState<SyncState>('idle')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** 桌面端：是否已登录云端账号（未登录时不显示入口） */
  const [desktopSignedIn, setDesktopSignedIn] = useState(false)

  // 🔴 **必须是稳定引用**：直接写 `const store = createSettingBindingStore()` 会让
  //    每次 render 都产生新对象 ⇒ 依赖它的 `load` 每次都是新函数 ⇒
  //    `useEffect([open, load])` 每次 render 都重跑 ⇒ `load` 里 setState ⇒ 再 render ⇒ 死循环。
  //    2026-10-31 实机验证踩到：服务端在几分钟内被灌了 3.7 万次 GET（面板一开就停不下来）。
  const store = useMemo(() => createSettingBindingStore(), [])

  // 桌面端：登录状态决定入口是否出现（网页云端版恒出现）
  useEffect(() => {
    if (!DESKTOP) return
    let alive = true
    const read = () => {
      void desktopAuthStatus().then((s) => { if (alive) setDesktopSignedIn(s.signedIn) })
    }
    read()
    window.addEventListener(DESKTOP_ACCOUNT_EVENT, read)
    return () => { alive = false; window.removeEventListener(DESKTOP_ACCOUNT_EVENT, read) }
  }, [])

  // 🔴 重入保护：即便 effect 因为父组件重挂而被反复触发，同一时刻也只跑一次读取。
  //    （2026-10-31 实机验证：面板打开后服务端几十秒收到 1.7 万次 GET，加这层兜底）
  const loadBusy = useRef(false)
  const load = useCallback(async () => {
    if (loadBusy.current) return
    loadBusy.current = true
    setLoading(true)
    setError('')
    try {
      const pid = getCurrentProjectId()
      if (!pid) { setProject(null); setBinding(null); setCloudRevision(null); setCloudDeletedAt(0); setCloudSummary(null); return }
      const p = await ops.get<Project>('projects', pid)
      setProject(p ?? null)
      const b = await store.get(pid)
      setBinding(b)
      if (b?.cloudProjectId) {
        const probe = await probeCloudProject(b.cloudProjectId)
        if (probe.ok) {
          setCloudRevision(probe.state.revision)
          setCloudDeletedAt(probe.state.deleted ? (probe.state.deletedAt || 1) : 0)
          setCloudSummary(probe.state.summary ?? null)
        } else if (probe.reason === 'not-found') { setCloudRevision(null); setCloudDeletedAt(0); setCloudSummary(null) }
        else {
          setCloudRevision(null)
          setCloudDeletedAt(0)
          setCloudSummary(null)
          // 🔴 网络问题与"云端没有"必须分开说，否则用户以为稿子丢了
          setError(probe.reason === 'unauthorized'
            ? '登录状态已失效，请重新登录后再同步'
            : '暂时连不上云端（网络问题），云端版本未知')
        }
      } else {
        setCloudRevision(null)
        setCloudDeletedAt(0)
        setCloudSummary(null)
      }
      const ctl = await bootSync()
      setState(await ctl.stateOf(pid))
      // 账号下的云端作品 + 配额（失败返回空，不影响上面这次状态读取）
      setCloudList(await listCloudProjects())
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取同步状态失败')
    } finally {
      loadBusy.current = false
      setLoading(false)
    }
  }, [store])

  useEffect(() => { if (open) void load() }, [open, load])

  // 订阅控制器状态：同步过程中界面要跟着变，而不是等用户点刷新
  useEffect(() => {
    if (!open) return
    let off: (() => void) | null = null
    void bootSync().then((ctl) => {
      off = ctl.subscribe((pid, s) => {
        if (pid === getCurrentProjectId()) setState(s)
      })
    })
    return () => { off?.() }
  }, [open])

  const available = WEB_CLOUD || (DESKTOP && desktopSignedIn)
  if (!available) return null

  const decision = binding && cloudRevision !== null
    ? decideSync({
        binding,
        remote: { exists: true, revision: cloudRevision, deleted: cloudDeletedAt > 0 },
        localDirty: (project?.updatedAt ?? 0) > binding.lastSyncedAt,
      })
    : null

  /** 第一次上云：建云端项目 → 存绑定 → 立刻推一次 */
  const bindAndUpload = async () => {
    const pid = getCurrentProjectId()
    if (!pid || !project) { showToast('先打开一本要同步的作品', 'error'); return }
    if (!await ensureSaved()) return
    setBusy(true)
    setError('')
    try {
      const created = await createCloudProject({ name: project.name || '未命名' })
      if (!created.ok) { showToast(created.error, 'error'); return }
      const next: SyncBinding = {
        cloudProjectId: created.cloudProjectId,
        baseRevision: 0,
        lastSyncedAt: 0,     // 0 = 从没同步过，第一次一定会推
        enabled: true,
        // 🔴 必须记账号：这本以后被导入到别的账号时，绑定要立刻作废，
        //    否则会拿着别人的云端 id 一路 403（用户只看到"同步失败"）
        accountId: getSyncAccountId(),
      }
      await store.set(pid, next)
      setBinding(next)
      const ctl = await bootSync()
      await ctl.requestPush({ projectId: pid, cloudProjectId: created.cloudProjectId, baseRevision: 0 })
      await startAutoSync()
      showToast('已上传到云端，之后每次保存会自动同步', 'success')
      await load()
    } catch (e) {
      showToast(e instanceof Error ? e.message : '上传失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  /** 立即同步一次 */
  const syncNow = async () => {
    const pid = getCurrentProjectId()
    if (!pid || !binding) return
    if (!await ensureSaved()) return
    setBusy(true)
    try {
      const ctl = await bootSync()
      // 冲突时先按"以本机为准"换基线，否则会反复撞 409（用户点了像没反应）
      const base = decision?.action === 'conflict'
        ? planConflict('keep-local', decision.remoteRevision).type === 'push'
          ? decision.remoteRevision
          : binding.baseRevision
        : (cloudRevision ?? binding.baseRevision)
      await ctl.requestPush({ projectId: pid, cloudProjectId: binding.cloudProjectId, baseRevision: base })
      if (base !== binding.baseRevision) {
        const next = { ...binding, baseRevision: base, lastSyncedAt: Date.now() }
        await store.set(pid, next)
        setBinding(next)
      }
      await load()
    } catch (e) {
      showToast(e instanceof Error ? e.message : '同步失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const toggleAuto = async () => {
    const pid = getCurrentProjectId()
    if (!pid || !binding) return
    const next = { ...binding, enabled: !binding.enabled }
    await store.set(pid, next)
    setBinding(next)
    if (next.enabled) { await startAutoSync(); showToast('已开启自动同步', 'success') }
    else { stopAutoSync(); showToast('已关闭自动同步（内容仍留在本机）', 'success') }
  }

  const unbind = async () => {
    const pid = getCurrentProjectId()
    if (!pid || !binding) return
    const ok = await confirmDialog({
      title: '解除云端绑定',
      message: '解除后这本不再自动同步。\n\n'
        + '云端已经上传的版本不会被删除；本机内容也不受影响。',
    })
    if (!ok) return
    await store.clear(pid)
    setBinding(null)
    stopAutoSync()
    showToast('已解除绑定', 'success')
    await load()
  }

  const stateInfo = STATE_TEXT[state]

  /**
   * 手动动作前的保存屏障（规划 §13.1：点「立即同步」先完成本地保存）。
   * 🔴 立即同步 / 另存 / 导出 / 覆盖都以**本机当前内容**为准，而 `exportProject()` 读的是 store；
   *    正文草稿还在 2 秒防抖里时，上传出去的版本会少最后几句。
   * 🔴 屏障失败就**不做**：保留现场让作者先处理（不拿半截内容去上传或覆盖）。
   */
  const ensureSaved = async (): Promise<boolean> => {
    const r = await runSaveBarrier()
    if (!r.ok) {
      showToast(r.message, 'error', 6000)
      return false
    }
    return true
  }

  /**
   * 冲突时「两份都留」：把云端这一版另存为一本新作品。
   * 🔴 不碰本机当前这本 —— 写入目标是 `importProject` 生成的全新项目 id，
   *    所以这里不需要先备份、也不需要"覆盖前再确认版本"。
   */
  const saveCloudCopy = async () => {
    if (!binding) return
    const ok = await confirmDialog({
      title: '两份都留',
      message: '会把云端这一版另存为一本新作品，本机当前这本保持原样。\n\n'
        + '云端内容需要先下载，可能要等一会儿。',
    })
    if (!ok) return
    if (!await ensureSaved()) return
    setBusy(true)
    setError('')
    try {
      const r = await saveCloudCopyAsNewProject({
        cloudProjectId: binding.cloudProjectId,
        baseProject: project,
      })
      if (!r.ok) { showToast(r.reason, 'error'); return }
      const notes = r.omitted.length ? `；${r.omitted.join('；')}` : ''
      showToast(`已另存为《${r.name || '云端副本'}》，本机这本保持不变${notes}。回项目中心即可打开`, 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '另存失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 把云端这一版导出成项目备份文件（不写库、不动本机）。
   * 🔴 走与「另存为新书」同一条下载/还原链路，区别只在最后一步：这里不调用 importProject。
   */
  const exportCloudCopy = async () => {
    if (!binding) return
    if (!await ensureSaved()) return
    setBusy(true)
    setError('')
    try {
      const r = await loadCloudCopy({ cloudProjectId: binding.cloudProjectId, baseProject: project })
      if (!r.ok || !r.bundle) { showToast(r.reason, 'error'); return }
      const blob = new Blob([JSON.stringify(r.bundle)], { type: 'application/json' })
      downloadBlob(cloudCopyFileName(r.name, r.revision), blob)
      const notes = r.omitted.length ? `；${r.omitted.join('；')}` : ''
      showToast(`已导出云端第 ${r.revision} 版${notes}。可在项目中心用「导入项目」打开`, 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '导出失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 从云端回收站恢复这一版。
   * 🔴 恢复只改云端（写一个新 revision），不会把本机内容传上去 —— 避免"删了又活"。
   *    恢复后云端 revision 变大，本机会自然显示"云端有新版本"。
   */
  const restoreCloudCopy = async () => {
    if (!binding) return
    const ok = await confirmDialog({
      title: '恢复云端作品',
      message: '会把云端回收站里的这一版恢复成最新版本。\n\n'
        + '本机内容不会被自动上传；恢复后如需同步，请再点「立即同步」。',
    })
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      const r = await restoreCloudProject(binding.cloudProjectId, uid())
      if (!r.ok) { showToast(r.error, 'error'); return }
      showToast(`云端已恢复到第 ${r.revision} 版（内容来自第 ${r.restoredFrom} 版）`, 'success')
      await load()
    } catch (e) {
      showToast(e instanceof Error ? e.message : '恢复失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  /** 从「云端作品」列表里下载一本为新的本机作品（不碰现有作品） */
  const downloadCloudAsNew = async (row: CloudProjectRow) => {
    if (!await ensureSaved()) return
    setBusy(true)
    setError('')
    try {
      const r = await saveCloudCopyAsNewProject({
        cloudProjectId: row.cloudProjectId,
        name: row.name ? `${row.name}（云端副本）` : undefined,
      })
      if (!r.ok) { showToast(r.reason, 'error'); return }
      const notes = r.omitted.length ? `；${r.omitted.join('；')}` : ''
      showToast(`已下载为《${r.name}》${notes}。回项目中心即可打开`, 'success', 7000)
    } catch (e) {
      showToast(e instanceof Error ? e.message : '下载失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  /** 展开 / 收起某本云端作品的历史版本（只读，不改任何数据） */
  const toggleHistory = async (row: CloudProjectRow) => {
    if (historyOpen === row.cloudProjectId) { setHistoryOpen(null); return }
    setHistoryOpen(row.cloudProjectId)
    if (historyData[row.cloudProjectId]) return
    const rows = await listCloudRevisions(row.cloudProjectId)
    setHistoryData((m) => ({ ...m, [row.cloudProjectId]: rows }))
  }

  /** 导出云端某一版为项目备份文件（不写库、不覆盖本机） */
  const exportCloudVersion = async (row: CloudProjectRow, rev: number) => {
    if (!await ensureSaved()) return
    setBusy(true)
    setError('')
    try {
      const r = await loadCloudCopy({
        cloudProjectId: row.cloudProjectId,
        rev,
        name: row.name ? `${row.name}（第 ${rev} 版）` : undefined,
      })
      if (!r.ok || !r.bundle) { showToast(r.reason, 'error'); return }
      const blob = new Blob([JSON.stringify(r.bundle)], { type: 'application/json' })
      downloadBlob(cloudCopyFileName(r.name, r.revision), blob)
      showToast(`已导出云端第 ${rev} 版。可在项目中心用「导入项目」打开`, 'success', 6000)
    } catch (e) {
      showToast(e instanceof Error ? e.message : '导出失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 用云端这一版**覆盖本机**（B3-2）。
   * 🔴 覆盖前先自动备份；备份失败即中止（没有退路时不做破坏性操作）。
   * 🔴 覆盖后当前页面持有的章节 id 已失效 —— 必须提示重新载入，而不是让它继续用旧 id 渲染。
   */
  const applyCloud = async () => {
    if (!binding || !project) return
    const localDirty = (project.updatedAt || 0) > (binding.lastSyncedAt || 0)
    const ok = await confirmDialog({
      title: '用云端覆盖本机',
      message: `会用云端第 ${cloudRevision ?? '?'} 版替换本机这本的全部内容。\n\n`
        + (localDirty
          ? '⚠️ 本机还有未同步的改动，这些改动会被丢弃；覆盖前会自动备份一份，可在「备份」里找回。\n\n'
          : '本机没有未同步的改动。\n\n')
        + '覆盖前的本机版本会自动备份一份；覆盖完成后请重新载入界面。',
    })
    if (!ok) return
    if (!await ensureSaved()) return
    setBusy(true)
    setError('')
    try {
      const r = await applyCloudCopyInPlace({
        cloudProjectId: binding.cloudProjectId,
        localProjectId: project.id,
        localDirty,
        allowLocalChanges: true,
      })
      if (!r.ok) {
        showToast(r.reason, 'error')
        await load()
        return
      }
      const next: SyncBinding = {
        ...binding,
        baseRevision: r.revision ?? binding.baseRevision,
        lastSyncedAt: Date.now(),
        lastSnapshotId: r.snapshotId,
      }
      await store.set(project.id, next)
      setBinding(next)
      setApplied({ revision: r.revision ?? cloudRevision ?? 0, backupId: r.backupId })
      await load()
    } catch (e) {
      showToast(e instanceof Error ? e.message : '覆盖失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 彻底删除云端这一本（只对回收站里的作品可用）。
   * 🔴 不可恢复：必须 danger 确认；删除后本机与云端的绑定自动解除（否则会一直报 remote-gone）。
   */
  const purgeCloudCopy = async () => {
    if (!binding || !project) return
    const ok = await confirmDialog({
      title: '彻底删除云端这一本',
      message: '会从云端永久删除这本作品，回收站里也找不回。\n\n'
        + '本机的这本作品不受影响；云端内容文件会在之后的回收任务中释放空间。\n\n'
        + '彻底删除后，本机与云端的绑定会自动解除。',
      confirmText: '彻底删除', danger: true,
    })
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      const r = await purgeCloudProject(binding.cloudProjectId, uid())
      if (!r.ok) { showToast(r.error, 'error'); await load(); return }
      await store.clear(project.id)
      setBinding(null)
      stopAutoSync()
      const mb = (r.removedBytes / 1024 / 1024).toFixed(2)
      showToast(`已彻底删除云端这本（释放 ${mb} MB 清单占用；内容文件稍后由回收任务释放）`, 'success', 8000)
      await load()
    } catch (e) {
      showToast(e instanceof Error ? e.message : '删除失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        variant={inline ? 'secondary' : 'icon-muted'}
        iconOnly={!inline}
        size="xs"
        onClick={() => setOpen(true)}
        title={binding ? `云端同步（${stateInfo.label}）` : '同步到云端'}
        className={inline ? 'w-full !justify-start gap-1.5' : 'shrink-0'}
      >
        <Cloud size={12} />
        {inline && <span>云端同步</span>}
        {inline && <span className={`ml-auto truncate text-11 ${stateInfo.cls}`}>{stateInfo.label}</span>}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="云端同步"
        icon={<Cloud size={15} />}
        width="md"
        footer={(
          <div className="flex w-full items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading || busy}>
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              刷新
            </Button>
            <div className="ml-auto flex items-center gap-2">
              {binding && (
                <Button variant="ghost" size="sm" onClick={() => void unbind()} disabled={busy}>
                  <CloudOff size={12} />
                  解除绑定
                </Button>
              )}
              {binding
                ? (
                  <Button variant="primary" size="sm" onClick={() => void syncNow()} disabled={busy}>
                    <CloudUpload size={12} />
                    {busy ? '同步中…' : '立即同步'}
                  </Button>
                )
                : (
                  <Button variant="primary" size="sm" onClick={() => void bindAndUpload()} disabled={busy || !project}>
                    <CloudUpload size={12} />
                    {busy ? '上传中…' : '上传这本到云端'}
                  </Button>
                )}
            </div>
          </div>
        )}
      >
        <div className="space-y-3">
          {!project && <p className="text-12 text-ink-400">先打开一本作品再来同步。</p>}

          {error && (
            <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-12 text-amber-200">
              {error}
            </p>
          )}

          {applied && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5">
              <p className="text-12 text-emerald-200">已用云端第 {applied.revision} 版覆盖本机</p>
              <p className="mt-1 text-11 leading-relaxed text-emerald-200/80">
                覆盖前的本机版本已自动备份
                {applied.backupId ? `（备份 ${applied.backupId.slice(0, 8)}）` : ''}
                ，可在「备份」里找回。当前页面还持有旧章节，建议现在重新载入。
              </p>
              <div className="mt-2">
                <Button variant="primary" size="xs" onClick={() => window.location.reload()}>重新载入界面</Button>
              </div>
            </div>
          )}

          {project && (
            <>
              <div className="rounded-lg border border-ink-700 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-12 text-ink-100">{project.name || '未命名'}</span>
                  <span className={`shrink-0 text-11 ${stateInfo.cls}`}>{stateInfo.label}</span>
                </div>
                {binding
                  ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-11 text-ink-500">
                      <span className="inline-flex items-center gap-1">
                        <Clock size={10} />
                        上次同步 {fmtWhen(binding.lastSyncedAt)}
                      </span>
                      <span>
                        云端版本 第 {cloudRevision ?? '?'} 版
                        {cloudSummary && (cloudSummary.counts.chapters || cloudSummary.createdAt) && (
                          <span className="text-ink-600">
                            {cloudSummary.counts.chapters ? ` · ${cloudSummary.counts.chapters} 章` : ''}
                            {cloudSummary.createdAt ? ` · ${fmtWhen(cloudSummary.createdAt)}` : ''}
                          </span>
                        )}
                      </span>
                      <span>本机基于 第 {binding.baseRevision} 版</span>
                    </div>
                  )
                  : <p className="mt-1 text-11 text-ink-500">这本还没上云。</p>}
              </div>

              {!binding && (
                <p className="text-12 leading-relaxed text-ink-400">
                  上传后，这本的正文、设定、图鉴与角色卡会存到云端；
                  你在别的设备登录同一账号就能接着写。
                  <strong className="text-ink-300">上传不会改变本机内容</strong>。
                </p>
              )}

              {binding && decision?.action === 'conflict' && (
                <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-12 text-rose-200">
                    <AlertTriangle size={12} />
                    本机与云端各有改动
                  </p>
                  <p className="mt-1 text-11 leading-relaxed text-rose-200/80">
                    {decision.reason}。点「立即同步」会<strong>以本机这一版为准</strong>上传，
                    云端旧版会留在云端历史里。
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button variant="primary" size="xs" onClick={() => void syncNow()} disabled={busy}
                      title="把本机这一版传上去；云端旧版会留在历史里">
                      保留本机并上传
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => void applyCloud()} disabled={busy}
                      title="会用云端这一版替换本机内容；覆盖前自动备份一份">
                      用云端覆盖本机
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => void saveCloudCopy()}
                      disabled={busy}
                      title="把云端这一版另存为一本新作品，本机这本保持原样"
                    >
                      {busy ? '另存中…' : '两份都留（另存为新书）'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => void exportCloudCopy()}
                      disabled={busy}
                      title="把云端这一版导出成项目备份文件，可在项目中心导入"
                    >
                      导出云端这一版
                    </Button>
                  </div>
                  <p className="mt-1.5 text-11 text-rose-200/60">
                    想保住本机这一版，可以先用「导出项目」存一份备份。
                  </p>
                </div>
              )}

              {binding && decision?.action === 'pull' && (
                <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-12 text-sky-200">
                    <RefreshCw size={12} />
                    云端有新版本（第 {decision.toRevision} 版）
                  </p>
                  <p className="mt-1 text-11 leading-relaxed text-sky-200/80">
                    本机没有未同步的改动。直接替换本机内容要等原地落地开放（下个版本），
                    现在可以先把云端这一版下载为新书，或导出成文件。
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button variant="ghost" size="xs" onClick={() => void saveCloudCopy()} disabled={busy}>
                      下载为新书
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => void applyCloud()} disabled={busy}
                      title="直接用云端这一版替换本机内容；覆盖前自动备份一份">
                      用云端覆盖本机
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => void exportCloudCopy()} disabled={busy}>
                      导出云端这一版
                    </Button>
                  </div>
                </div>
              )}

              {binding && decision?.action === 'remote-deleted' && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-12 text-amber-200">
                    <AlertTriangle size={12} />
                    云端把这本放进了回收站
                  </p>
                  <p className="mt-1 text-11 leading-relaxed text-amber-200/80">
                    {cloudDeletedAt ? `删除于 ${fmtWhen(cloudDeletedAt)}，` : ''}
                    30 天内可以恢复。恢复前不会把本机内容传上去，避免「删了又活」。
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button variant="primary" size="xs" onClick={() => void restoreCloudCopy()} disabled={busy}>
                      {busy ? '恢复中…' : '恢复云端这一版'}
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => void purgeCloudCopy()} disabled={busy}
                      title="永久删除云端这本，回收站里也找不回">
                      彻底删除
                    </Button>
                  </div>
                </div>
              )}

              {binding && decision?.action === 'remote-regressed' && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-12 text-amber-200">
                  {decision.reason}
                </p>
              )}

              {binding && (
                <div className="flex items-center gap-2 rounded-lg border border-ink-700 px-3 py-2">
                  <Link2 size={12} className="shrink-0 text-ink-500" />
                  <span className="min-w-0 flex-1 text-12 text-ink-300">
                    自动同步{isAutoSyncRunning() ? '已开启' : '已关闭'}
                  </span>
                  <Button variant="secondary" size="xs" onClick={() => void toggleAuto()} disabled={busy}>
                    {binding.enabled ? '关闭' : '开启'}
                  </Button>
                </div>
              )}

              <p className="text-11 leading-relaxed text-ink-500">
                撤销/解除都<strong className="text-ink-400">不会删除本机内容</strong>，也不会删除云端已上传的版本。
                同步只针对当前打开的这本作品。
              </p>
            </>
          )}

          {cloudList && cloudList.projects.length > 0 && (
            <div className="rounded-lg border border-ink-700 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-11 text-ink-400">云端作品 {cloudList.projects.length} 本</p>
                {cloudList.quotaBytes > 0 && (
                  <p className="text-11 text-ink-500">
                    已用 {fmtBytes(cloudList.usedBytes)} / {fmtBytes(cloudList.quotaBytes)}
                  </p>
                )}
              </div>
              <div className="mt-1.5 max-h-56 space-y-1 overflow-y-auto">
                {cloudList.projects.slice(0, 20).map((row) => (
                  <div key={row.cloudProjectId} className="rounded-md bg-ink-800/40 px-2 py-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-12 text-ink-200">{row.name || '未命名'}</span>
                      <span className="shrink-0 text-11 text-ink-500">
                        第 {row.revision} 版 · {fmtBytes(row.objectBytes)}
                      </span>
                      {row.deleted && <span className="shrink-0 text-11 text-rose-300">回收站</span>}
                      <Button variant="ghost" size="xs" onClick={() => void toggleHistory(row)} disabled={busy}>
                        {historyOpen === row.cloudProjectId ? '收起历史' : '历史'}
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => void downloadCloudAsNew(row)}
                        disabled={busy || row.deleted} title="下载为一本新的本机作品，不覆盖现有作品">
                        下载为新书
                      </Button>
                    </div>
                    {historyOpen === row.cloudProjectId && (
                      <div className="mt-1 space-y-1 border-t border-ink-700/60 pt-1">
                        {(historyData[row.cloudProjectId] ?? []).slice(0, 10).map((h) => (
                          <div key={h.revision} className="flex flex-wrap items-center gap-2 text-11">
                            <span className="text-ink-400">第 {h.revision} 版{h.deleted ? '（删除）' : ''}</span>
                            <span className="text-ink-600">{h.at ? fmtWhen(h.at) : ''}</span>
                            <Button variant="ghost" size="xs" onClick={() => void exportCloudVersion(row, h.revision)} disabled={busy}>
                              导出这一版
                            </Button>
                          </div>
                        ))}
                        {(historyData[row.cloudProjectId] ?? []).length === 0 && (
                          <p className="text-11 text-ink-600">没有读到历史版本（网络或权限问题）</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-11 text-ink-600">
                下载会新建一本本机作品（不覆盖现有作品）；回收站里的作品要先恢复才能下载。
              </p>
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}
