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
import { useCallback, useEffect, useState } from 'react'
import { CloudUpload, CloudOff, RefreshCw, Cloud, Clock, AlertTriangle, Link2 } from 'lucide-react'
import { WEB_CLOUD } from '@/lib/app/platform'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { getCurrentProjectId, ops } from '@/lib/db/core'
import type { Project } from '@/lib/types'
import { createSettingBindingStore } from '@/lib/sync/projectBindingStore'
import type { SyncBinding } from '@/lib/sync/projectBinding'
import { decideSync, planConflict } from '@/lib/sync/projectBinding'
import { bootSync, startAutoSync, stopAutoSync, isAutoSyncRunning, getSyncAccountId } from '@/lib/app/syncBoot'
import { createCloudProject, probeCloudProject } from '@/lib/cloud/syncApi'
import { saveCloudCopyAsNewProject } from '@/lib/sync/projectPullWrite'
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

export default function CloudSyncPanel() {
  const [open, setOpen] = useState(false)
  const [project, setProject] = useState<Project | null>(null)
  const [binding, setBinding] = useState<SyncBinding | null>(null)
  const [cloudRevision, setCloudRevision] = useState<number | null>(null)
  const [state, setState] = useState<SyncState>('idle')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const store = createSettingBindingStore()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const pid = getCurrentProjectId()
      if (!pid) { setProject(null); setBinding(null); setCloudRevision(null); return }
      const p = await ops.get<Project>('projects', pid)
      setProject(p ?? null)
      const b = await store.get(pid)
      setBinding(b)
      if (b?.cloudProjectId) {
        const probe = await probeCloudProject(b.cloudProjectId)
        if (probe.ok) setCloudRevision(probe.state.revision)
        else if (probe.reason === 'not-found') setCloudRevision(null)
        else {
          setCloudRevision(null)
          // 🔴 网络问题与"云端没有"必须分开说，否则用户以为稿子丢了
          setError(probe.reason === 'unauthorized'
            ? '登录状态已失效，请重新登录后再同步'
            : '暂时连不上云端（网络问题），云端版本未知')
        }
      } else {
        setCloudRevision(null)
      }
      const ctl = await bootSync()
      setState(await ctl.stateOf(pid))
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取同步状态失败')
    } finally {
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

  if (!WEB_CLOUD) return null

  const decision = binding && cloudRevision !== null
    ? decideSync({
        binding,
        remote: { exists: true, revision: cloudRevision },
        localDirty: (project?.updatedAt ?? 0) > binding.lastSyncedAt,
      })
    : null

  /** 第一次上云：建云端项目 → 存绑定 → 立刻推一次 */
  const bindAndUpload = async () => {
    const pid = getCurrentProjectId()
    if (!pid || !project) { showToast('先打开一本要同步的作品', 'error'); return }
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

  return (
    <>
      <Button
        variant="icon-muted"
        iconOnly
        size="xs"
        onClick={() => setOpen(true)}
        title={binding ? `云端同步（${stateInfo.label}）` : '同步到云端'}
        className="shrink-0"
      >
        <Cloud size={12} />
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
                      <span>云端版本 第 {cloudRevision ?? '?'} 版</span>
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
                    <Button variant="ghost" size="xs" disabled title="需要按项目原地改写 10 类记录与两套键前缀，必须先在真机回归后开放">
                      用云端覆盖本机（暂未开放）
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
                    <Button variant="ghost" size="xs" onClick={() => void exportCloudCopy()} disabled={busy}>
                      导出云端这一版
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
        </div>
      </Modal>
    </>
  )
}
