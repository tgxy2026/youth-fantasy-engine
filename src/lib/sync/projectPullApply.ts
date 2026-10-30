// ============ 3.3.2 · B3-2 用云端这一版覆盖本机 ============
//
// 【它补的是哪一段】B3-1 能把云端版本另存成**新书**，但"跨设备接续同一本"还需要一条原地更新的路：
//   另一台设备已经写了新章，本机这本要变成云端那一版。
//
// 🔴 **为什么敢现在开**：真正危险的"清空再写"并不需要在这里重写一遍 ——
//    `db/backups` 的 `restoreBundleToProject` 早就是「先写新数据、全部成功后才删旧记录」的实现，
//    并且处理了卷/章 id 重映射、台账行 tabId、快照 chapterId 改指、子项活跃态、两套设置前缀。
//    本模块只做三件它不做的事：**先备份**、**判定能不能覆盖**、**把失败如实说出来**。
//
// 🔴 顺序不可调换：
//   ① 先下载并校验（缺内容绝不开始）；
//   ② 再建备份（备份失败就中止 —— 没有退路时不做破坏性操作）；
//   ③ 才写库（`restoreBundleToProject` 内部"先写后删"，失败时旧数据仍在）；
//   ④ 最后清理**被替换掉那一版**的历史快照（它们指向已不存在的章节，留着只是悬空数据）。
//
// 🔴 `localDirty` 的判定在调用方（草稿、待同步队列都算），本模块不猜；
//    本机有未同步改动时必须 `allowLocalChanges`（界面上是二次确认），否则拒绝。
import type { Snapshot } from '@/lib/db/chapters'
import { ops } from '@/lib/db/core'
import { getProject } from '@/lib/db/projects'
import { createAutoBackup, restoreBundleToProject } from '@/lib/db/backups'
import { loadCloudCopy } from '@/lib/sync/projectPullBundle'
import type { PullDeps } from '@/lib/sync/projectPull'
import { canApplyInPlace as canApplyGate, type ApplyInPlaceCode } from '@/lib/sync/applyGate'

export { canApplyInPlace } from '@/lib/sync/applyGate'
export type { ApplyInPlaceCode } from '@/lib/sync/applyGate'

export interface ApplyInPlaceInput {
  cloudProjectId: string
  localProjectId: string
  /** 本机是否有未同步改动（调用方判定） */
  localDirty: boolean
  /** 用户已明确同意丢弃本机这一版（界面上是二次确认） */
  allowLocalChanges?: boolean
  /** 指定云端版本；不传取最新 */
  rev?: number
  /** 仅供测试注入 */
  deps?: PullDeps
}

export interface ApplyInPlaceResult {
  ok: boolean
  code: ApplyInPlaceCode
  /** 中文人话原因（成功时为空） */
  reason: string
  revision?: number
  snapshotId?: string
  /** 覆盖前自动备份的 id（成功时必有；界面据此告诉用户"去哪儿找回"） */
  backupId?: string
  records?: number
  /** 副本没带过来的内容（自定义下拉选项等） */
  omitted?: string[]
}

export async function applyCloudCopyInPlace(input: ApplyInPlaceInput): Promise<ApplyInPlaceResult> {
  if (!canApplyGate({ localDirty: input.localDirty, allowLocalChanges: !!input.allowLocalChanges })) {
    return {
      ok: false, code: 'LOCAL_DIRTY',
      reason: '本机还有未同步的改动。直接覆盖会丢掉这些改动 —— 需明确同意，或先把本机这一版另存为新书。',
    }
  }

  const project = await getProject(input.localProjectId).catch(() => undefined)
  if (!project) {
    return { ok: false, code: 'NO_PROJECT', reason: '本机这本作品已经不在了（可能刚被删除），本次没有覆盖。' }
  }

  // ① 下载并校验（缺内容 → 一条都不写）
  const loaded = await loadCloudCopy({
    cloudProjectId: input.cloudProjectId,
    baseProject: project,
    rev: input.rev,
    deps: input.deps,
  })
  if (!loaded.ok || !loaded.bundle) {
    return { ok: false, code: 'DOWNLOAD', reason: loaded.reason || '云端内容没有下载完整，本次没有覆盖。', omitted: loaded.omitted }
  }

  // ② 先备份：没有退路就不做破坏性操作
  let backupId = ''
  try {
    const meta = await createAutoBackup(input.localProjectId, 'manual', '用云端覆盖前自动备份')
    if (!meta) {
      return {
        ok: false, code: 'BACKUP',
        reason: '这份作品没有建成备份（示范项目不参与备份），为免无法找回，本次没有覆盖。',
      }
    }
    backupId = meta.id
  } catch (e) {
    return {
      ok: false, code: 'BACKUP',
      reason: `备份没有建成：${e instanceof Error ? e.message : '本机写入失败'}。为免无法找回，本次没有覆盖。`,
    }
  }

  // 记下被替换这一版的快照 id：写入成功后再删（失败时它们仍然有效）
  let oldSnapshotIds: string[] = []
  try {
    const snaps = await ops.getAllByIndex<Snapshot>('snapshots', 'projectId', input.localProjectId)
    oldSnapshotIds = snaps.map((s) => s.id)
  } catch (e) {
    // 读不到就不删 —— 宁可留下悬空历史，也不误删还能用的记录
    console.warn('[sync] 覆盖前读取本机快照失败，本次保留全部旧快照：', e)
    oldSnapshotIds = []
  }

  // ③ 写库（内部"先写后删"，失败时旧记录仍在）
  try {
    await restoreBundleToProject(input.localProjectId, loaded.bundle)
  } catch (e) {
    return {
      ok: false, code: 'WRITE',
      backupId,
      reason: `覆盖写入失败：${e instanceof Error ? e.message : '本机写入出错'}。原有内容没有被删除`
        + `（可能新增了一部分新记录），可以重试，或从刚建的备份里恢复。`,
    }
  }

  // ④ 清掉被替换那一版的历史快照（它们指向已不存在的章节）
  if (oldSnapshotIds.length) {
    try {
      await ops.bulkDel('snapshots', oldSnapshotIds)
    } catch (e) {
      console.warn('[sync] 覆盖后清理旧快照失败（只是占空间，不影响正文）：', e)
    }
  }

  return {
    ok: true,
    code: 'OK',
    reason: '',
    revision: loaded.revision,
    snapshotId: loaded.snapshotId,
    backupId,
    records: loaded.records,
    omitted: loaded.omitted,
  }
}