/**
 * 3.3.3 · B1：把「用云端新版更新本机」的四步流程从面板里抽出来。
 *
 * 【为什么要抽文件】`CloudSyncPanel.tsx` 已经撞 1200 行硬上限（structureGates ⑰ 会红）。
 * 更重要的是：这一段的顺序就是**数据安全本身**（钉版本 → 保存屏障 → 记录 → 备份 →
 * 写前复检 → 写库 → 基线 → 收尾），把它埋在几百行 JSX 之间最容易在下一次改界面时被顺手改错。
 *
 * 🔴 这里没有 React 状态：全部由调用方传入 setter / reload。
 *    这样单测与静态契约都能直接读这一份顺序，不用把组件渲染起来。
 */
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import { getCurrentProjectId, ops } from '@/lib/db/core'
import { restoreBackup } from '@/lib/db/backups'
import type { Project } from '@/lib/types'
import type { SyncBinding } from '@/lib/sync/projectBinding'
import type { createSettingBindingStore } from '@/lib/sync/projectBindingStore'
import { applyCloudCopyInPlace } from '@/lib/sync/projectPullApply'
import {
  beginPullOperation, clearPullOperation, finishPullOperation, readPullOperation, updatePullOperation,
  type PullOperation,
} from '@/lib/sync/pullOperation'
import {
  checkSameBinding, checkLocalVersionUnchanged, checkSameProject, verifyTargets,
} from '@/lib/sync/pullTarget'
import {
  getSyncAccountId, isAutoSyncRunning, startAutoSync, stopAutoSync,
} from '@/lib/app/syncBoot'

type BindingStore = ReturnType<typeof createSettingBindingStore>

/** 绑定快照串：只取影响判定的字段（与面板共用同一口径） */
export function bindingKeyOf(b: SyncBinding | null | undefined): string {
  return b ? `${b.cloudProjectId}|${b.baseRevision}|${b.accountId ?? ''}` : ''
}

export interface CloudPullDeps {
  /** 打开着的本机作品（null 时流程直接拒绝） */
  project: Project | null
  binding: SyncBinding | null
  /** 面板上看到的云端最新版本（必须已探测成功；null ⇒ 不做） */
  cloudRevision: number | null
  /** 本机是否还有未同步改动（决定确认文案） */
  localDirty: boolean
  store: BindingStore
  ensureSaved: () => Promise<boolean>
  setBusy: (v: boolean) => void
  setPullOp: (op: PullOperation | null) => void
  setBinding: (b: SyncBinding) => void
  onApplied: (a: { revision: number; backupId?: string }) => void
  reload: () => Promise<void>
}

/**
 * 执行「用云端第 N 版更新本机」。
 *
 * 顺序不可调换（每一步失败都要能说出"本机现在是什么状态"）：
 *   ① 有未完成记录 / 版本未知 ⇒ 直接拒绝；
 *   ② 确认（写明版本号、会先建备份、写前会复检）；
 *   ③ 过保存屏障；
 *   ④ 写操作记录 → 建备份（备份/记录失败即中止）；
 *   ⑤ 写库前复检项目 / 本机更新时间 / 绑定；
 *   ⑥ 写库；失败按"是否可能写了一半"决定保留还是清掉记录；
 *   ⑦ 写基线；失败保留记录；成功后才删记录并提示重新载入。
 */
export async function runCloudPull(deps: CloudPullDeps): Promise<void> {
  const { project, binding, cloudRevision } = deps
  if (!project || !binding) return
  const pid = project.id
  if (await readPullOperation(pid).catch(() => null)) {
    showToast('上次「用云端更新本机」还没有走完，请先在提示里核对或恢复', 'error')
    return
  }
  if (cloudRevision == null) {
    showToast('云端版本未知，请先点「刷新」再试；不会对未知版本做覆盖', 'error')
    return
  }
  const pinned = cloudRevision
  const ok = await confirmDialog({
    title: '用云端新版更新本机',
    message: `会把本机这本替换为云端第 ${pinned} 版。\n\n`
      + (deps.localDirty
        ? '⚠️ 本机还有未同步的改动，这些改动会被丢弃。\n\n'
        : '本机没有未同步的改动。\n\n')
      + '确认后会先创建一份备份，备份成功才开始写入。\n\n'
      + '写入前还会再核对一次云端版本与本机内容；期间任何一边变了都会中止，让你重新确认。\n\n'
      + '完成后需要重新载入界面。',
    confirmText: '创建备份并更新',
  })
  if (!ok) return
  if (!await deps.ensureSaved()) return

  const wasAuto = isAutoSyncRunning()
  if (wasAuto) stopAutoSync()
  deps.setBusy(true)
  let op: PullOperation | null = null
  try {
    // 屏障之后取快照：这之后作者再动一下，就在 ⑤ 里被拦下
    const fresh = await ops.get<Project>('projects', pid)
    const expectedUpdatedAt = fresh?.updatedAt || 0
    const expectedBinding = bindingKeyOf(binding)
    const accountId = getSyncAccountId()
    op = await beginPullOperation({
      projectId: pid,
      cloudProjectId: binding.cloudProjectId,
      confirmedRevision: pinned,
      fromBaseRevision: binding.baseRevision,
      ...(accountId ? { accountId } : {}),
    })
    deps.setPullOp(op)

    const r = await applyCloudCopyInPlace({
      cloudProjectId: binding.cloudProjectId,
      localProjectId: pid,
      localDirty: deps.localDirty,
      allowLocalChanges: true,
      rev: pinned,
      expectedRevision: pinned,
      onBackup: async (backupId) => {
        if (op) op = await updatePullOperation(op, { phase: 'backup-done', backupId })
        deps.setPullOp(op)
      },
      beforeWrite: async () => {
        const same = verifyTargets([checkSameProject({ expectedId: pid, currentId: getCurrentProjectId() })])
        if (!same.ok) return same.reason
        const now = await ops.get<Project>('projects', pid)
        if (!now) return '这本作品已经不在了（可能刚被删除），本次没有更新。'
        const ver = checkLocalVersionUnchanged({ expectedUpdatedAt, currentUpdatedAt: now.updatedAt || 0 })
        if (!ver.ok) return ver.reason
        const bnow = await deps.store.get(pid)
        const bcheck = checkSameBinding({ expected: expectedBinding, current: bindingKeyOf(bnow) })
        if (!bcheck.ok) return bcheck.reason
        if (op) op = await updatePullOperation(op, { phase: 'writing' })
        deps.setPullOp(op)
        return ''
      },
    })

    if (!r.ok) {
      // 🔴 只有 WRITE 会留下"写了一半"的可能 ⇒ 保留记录；其余失败本机内容没变，清掉
      if (r.code === 'WRITE') {
        if (op) op = await updatePullOperation(op, { phase: 'writing' })
      } else {
        await clearPullOperation(pid)
        op = null
      }
      deps.setPullOp(op)
      showToast(r.reason, 'error', 9000)
      await deps.reload()
      return
    }

    if (op) op = await updatePullOperation(op, { phase: 'written' })
    deps.setPullOp(op)
    const next: SyncBinding = {
      ...binding,
      baseRevision: r.revision ?? pinned,
      lastSyncedAt: Date.now(),
      lastSnapshotId: r.snapshotId,
    }
    try {
      await deps.store.set(pid, next)
    } catch (e) {
      showToast(
        `内容已更新为云端第 ${r.revision ?? pinned} 版，但同步基线没有写入（${e instanceof Error ? e.message : '本机写入失败'}）。`
        + '已保留操作记录；重新载入后请核对，自动同步会先停着。',
        'error', 10000,
      )
      await deps.reload()
      return
    }
    deps.setBinding(next)
    // 覆盖 / 基线 / 记录三者都完成才收尾
    if (op) { await finishPullOperation(op); op = null }
    deps.setPullOp(null)
    deps.onApplied({ revision: r.revision ?? pinned, ...(r.backupId ? { backupId: r.backupId } : {}) })
    await deps.reload()
  } catch (e) {
    showToast(e instanceof Error ? e.message : '覆盖失败', 'error')
  } finally {
    deps.setBusy(false)
    // 记录还在时不要恢复自动同步：它会被 pull-pending 挡着，重新拉起也没有意义
    if (wasAuto && !op) void startAutoSync()
  }
}

/** 上次覆盖没走完 —— 用覆盖前那份备份恢复本机（不改同步基线） */
export async function restoreCloudPullBackup(deps: {
  pullOp: PullOperation
  binding: SyncBinding | null
  setBusy: (v: boolean) => void
  setPullOp: (op: PullOperation | null) => void
  reload: () => Promise<void>
}): Promise<void> {
  const { pullOp } = deps
  if (!pullOp.backupId) return
  const ok = await confirmDialog({
    title: '从覆盖前的备份恢复',
    message: `会用备份 ${pullOp.backupId.slice(0, 8)} 覆盖本机当前内容，回到这次更新之前的样子。\n\n`
      + (deps.binding
        ? `同步基线不会改动（仍基于第 ${deps.binding.baseRevision} 版）；恢复后自动同步会按正常流程重新判断要推还是拉。`
        : '这本当前没有同步绑定；恢复后不会自动上传。'),
    confirmText: '从备份恢复', danger: true,
  })
  if (!ok) return
  deps.setBusy(true)
  try {
    await restoreBackup(pullOp.backupId)
    await clearPullOperation(pullOp.projectId)
    deps.setPullOp(null)
    showToast('已从覆盖前的备份恢复本机内容', 'success', 7000)
    await deps.reload()
  } catch (e) {
    showToast(e instanceof Error ? e.message : '从备份恢复失败', 'error')
  } finally {
    deps.setBusy(false)
  }
}

/** 作者核对过当前内容 ⇒ 把基线认到那一次确认的版本，并恢复自动同步 */
export async function acceptCloudPullCurrent(deps: {
  pullOp: PullOperation
  binding: SyncBinding | null
  store: BindingStore
  setBusy: (v: boolean) => void
  setBinding: (b: SyncBinding) => void
  setPullOp: (op: PullOperation | null) => void
  reload: () => Promise<void>
}): Promise<void> {
  const { pullOp, binding } = deps
  if (!binding) {
    showToast('这本当前没有同步绑定，无法记录基线；请先重新绑定云端作品', 'error')
    return
  }
  const risky = pullOp.phase === 'writing'
  const ok = await confirmDialog({
    title: '核对通过，继续使用当前内容',
    message: `会把同步基线认到云端第 ${pullOp.confirmedRevision} 版，并恢复这本的自动同步。\n\n`
      + (risky ? '⚠️ 上次是在写入过程中中断的，本机内容可能只更新了一部分。请先在正文里逐章核对，再确认这一步。\n\n' : '')
      + '这一步不会改动本机内容，只改同步基线。',
    confirmText: '已核对，继续', danger: risky,
  })
  if (!ok) return
  deps.setBusy(true)
  try {
    const next: SyncBinding = {
      ...binding,
      baseRevision: pullOp.confirmedRevision,
      lastSyncedAt: Date.now(),
    }
    await deps.store.set(pullOp.projectId, next)
    deps.setBinding(next)
    await clearPullOperation(pullOp.projectId)
    deps.setPullOp(null)
    showToast(`已按云端第 ${pullOp.confirmedRevision} 版记基线，自动同步恢复`, 'success', 7000)
    await deps.reload()
  } catch (e) {
    showToast(e instanceof Error ? e.message : '写入基线失败', 'error')
  } finally {
    deps.setBusy(false)
  }
}