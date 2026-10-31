// ============ 3.3.3 · B1 「用云端新版更新本机」的操作记录 ============
//
// 【为什么需要一条记录】这条流程有四步且**跨越多个真实写盘**：
//   确认版本 → 建备份 → 覆盖本机 → 推进同步基线。
// 任何一步之间断电/关窗，磁盘上都会留下"看起来正常、其实不一致"的状态：
//   · 备份建好了但还没写：无害，但用户不知道那条备份为什么在这；
//   · 写了一半：`restoreBundleToProject` 是"先写后删"，旧内容可能还在、新内容可能只写了一部分；
//   · 写完了但基线没推进：本机是新的，绑定还指着旧版 ⇒ 下一轮自动同步会把新内容**当成本机改动**
//     再推一遍（多一个无意义版本），或者反过来被判冲突。
// ⇒ 备份完成与首次写入之间写一条本机记录；覆盖 / 基线 / 重载全部完成才收尾。
//
// 🔴 位置：`meta` 里 `syncPullOp::<projectId>`，并登记进
//    `storage/sensitiveMeta.LOCAL_ONLY_META_KEY_PREFIXES` —— 它**不跟云同步、不进数据文件导出**。
//    换台机器看到"上次更新没走完"只会让人困惑，而且那条备份根本不在这台机器上。
// 🔴 不放在 `settingsKV`：那是项目级、会随项目包与云端快照走的。
import { ops } from '@/lib/db/core'
import { uid } from '@/lib/app/id'
import type { StoreOps } from '@/lib/storage/storeOps'

/** 流程阶段（只增不改语义；恢复面板据此说人话） */
export type PullOpPhase = 'prepared' | 'backup-done' | 'writing' | 'written'

export interface PullOperation {
  id: string
  projectId: string
  cloudProjectId: string
  /** 作者在确认框里看到、并同意的那一版 */
  confirmedRevision: number
  /** 确认时本机绑定所基于的版本（从备份恢复后要把基线说清楚，不能凭空前进） */
  fromBaseRevision: number
  /** 当时的账号（换账号后不该拿别人的备份去恢复） */
  accountId?: string
  /** 覆盖前自动备份的 id（`backup-done` 之后必有） */
  backupId?: string
  phase: PullOpPhase
  startedAt: number
  updatedAt: number
}

export const PULL_OP_KEY_PREFIX = 'syncPullOp::'
const keyOf = (projectId: string) => `${PULL_OP_KEY_PREFIX}${projectId}`

export function newPullOperation(input: {
  projectId: string
  cloudProjectId: string
  confirmedRevision: number
  fromBaseRevision: number
  accountId?: string
}): PullOperation {
  const now = Date.now()
  return {
    id: `pull-${uid()}`,
    projectId: input.projectId,
    cloudProjectId: input.cloudProjectId,
    confirmedRevision: input.confirmedRevision,
    fromBaseRevision: input.fromBaseRevision,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    phase: 'prepared',
    startedAt: now,
    updatedAt: now,
  }
}

async function write(op: PullOperation, store: StoreOps): Promise<PullOperation> {
  const next = { ...op, updatedAt: Date.now() }
  await store.put('meta', { key: keyOf(next.projectId), value: next })
  return next
}

export async function beginPullOperation(input: {
  projectId: string
  cloudProjectId: string
  confirmedRevision: number
  fromBaseRevision: number
  accountId?: string
}, store: StoreOps = ops): Promise<PullOperation> {
  return write(newPullOperation(input), store)
}

/** 推进阶段（`backupId` 只在备份成功时补上） */
export async function updatePullOperation(
  op: PullOperation,
  patch: Partial<Pick<PullOperation, 'phase' | 'backupId'>>,
  store: StoreOps = ops,
): Promise<PullOperation> {
  return write({ ...op, ...patch }, store)
}

/** 收尾：覆盖 / 基线 / 重载全部完成才删记录 */
export async function finishPullOperation(op: PullOperation, store: StoreOps = ops): Promise<void> {
  await store.del('meta', keyOf(op.projectId))
}

export async function readPullOperation(projectId: string, store: StoreOps = ops): Promise<PullOperation | null> {
  if (!projectId) return null
  try {
    const rec = await store.get<{ key: string; value?: PullOperation }>('meta', keyOf(projectId))
    return rec?.value ?? null
  } catch {
    // 读不到当作没有：这是**恢复入口**的判据，读失败不能变成"阻止一切同步"
    return null
  }
}

/** 该项目的自动同步是否该被挡住（有未完成操作 ⇒ 不推） */
export async function isPullOperationPending(projectId: string, store: StoreOps = ops): Promise<boolean> {
  return !!(await readPullOperation(projectId, store))
}

/** 本机全部未完成操作（界面启动时提示用；按项目各一条，量很小） */
export async function listPendingPullOperations(store: StoreOps = ops): Promise<PullOperation[]> {
  try {
    const rows = await store.getAll<{ key: string; value?: PullOperation }>('meta')
    return rows
      .filter(r => typeof r?.key === 'string' && r.key.startsWith(PULL_OP_KEY_PREFIX) && !!r.value)
      .map(r => r.value as PullOperation)
  } catch {
    return []
  }
}

/** 显式清除（作者已核对当前内容，或已从备份恢复） */
export async function clearPullOperation(projectId: string, store: StoreOps = ops): Promise<void> {
  await store.del('meta', keyOf(projectId))
}