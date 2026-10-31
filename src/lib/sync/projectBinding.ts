// ============ 3.3.2 · P4-1 项目与云端的绑定 ============
//
// 【它记什么】一个本地项目对应云端哪个项目、上次对齐到哪个 revision、是否开了自动同步。
// 没有它，「要不要拉、要不要推、是不是冲突」全都无从判断 —— 只能靠"猜"或者每次都全量比。
//
// 【存在哪】项目级设置 `settingsKV` 的 `sync.binding` 键。
//   · 跟着项目走：导出/导入后仍指向同一个云端项目（用户换机继续写同一本，不用重新绑）
//   · 不是敏感键：里面没有凭据，只是 id 与版本号
//   · 前缀由 `setSettingFor` 自动加 `pid::`，与项目快照的剥离规则一致
//
// 🔴 **不存 token、不存密码、不存 Cookie**。凭据只属于会话，落在绑定记录里就是事故。
//
// 🔴 判据全部是纯函数（`decideSync` / `planConflict`），单测穷举覆盖。
//    "该不该拉"这种判断一旦写进组件里，就没法测，也没法在桌面主进程复用。
import type { SyncState } from '@/lib/sync/syncMachine'

/** 绑定记录 */
export interface SyncBinding {
  /** 云端项目 id（服务端生成，如 `prj_xxx`） */
  cloudProjectId: string
  /** 上次成功对齐到的云端 revision */
  baseRevision: number
  /** 上次对齐时间 */
  lastSyncedAt: number
  /**
   * 是否开启自动同步。
   * 🔴 **默认关闭**（规划 D6：每本显式开启后才自动排队）。
   *    默认打开会让"我只是想本机写"的用户莫名其妙在上传。
   */
  enabled: boolean
  /** 上次对齐时的快照 id（用于快速判断"云端到底变没变"，不必每次比内容） */
  lastSnapshotId?: string
  /**
   * 绑定在哪个账号下建立的（服务端用户 id）。
   *
   * 🔴 必须有：绑定记录会**随项目导出/导入**走（那是刻意的，换机继续写同一本）。
   *    但导入到另一个账号后，`cloudProjectId` 指向的是别人的项目 ——
   *    服务端对象库是按账号隔离的，直接同步会一路 FORBIDDEN，用户只看到"同步失败"。
   *    带上账号就能在导入后立刻识别成"需要重新绑定"。
   */
  accountId?: string
}

/** 存取绑定的最小接口（单测注入内存实现；生产用 `getSettingFor`/`setSettingFor`） */
export interface BindingStore {
  get(projectId: string): Promise<SyncBinding | null>
  set(projectId: string, binding: SyncBinding): Promise<void>
  clear(projectId: string): Promise<void>
}

export const BINDING_KEY = 'sync.binding'

/** 云端那边的现状（来自 `GET /api/v2/projects/:pid`） */
export interface RemoteState {
  /** 云端是否还有这个项目 */
  exists: boolean
  /** 云端当前 revision（exists=false 时无意义） */
  revision: number
  snapshotId?: string
  /** 云端是否已被标记删除（墓碑） */
  deleted?: boolean
}

export type SyncDecision =
  /** 没绑定过：需要用户先选"上传本机"还是"从云端拉" */
  | { action: 'bind-required'; reason: string }
  /** 本地与云端一致，什么都不用做 */
  | { action: 'up-to-date'; reason: string }
  /** 只有云端前进了，本地没改动 ⇒ 拉下来 */
  | { action: 'pull'; fromRevision: number; toRevision: number; reason: string }
  /** 只有本地改动了，云端没变 ⇒ 推上去 */
  | { action: 'push'; baseRevision: number; reason: string }
  /** 两边都变了 ⇒ 让用户选 */
  | { action: 'conflict'; localBase: number; remoteRevision: number; reason: string }
  /** 云端版本比本地记的还旧（回滚/被另一个账号覆盖）⇒ 不敢自动动 */
  | { action: 'remote-regressed'; localBase: number; remoteRevision: number; reason: string }
  /** 云端项目没了（被删或没权限） */
  | { action: 'remote-gone'; reason: string }
  /** 云端标记删除（在回收站里） */
  | { action: 'remote-deleted'; reason: string }

/**
 * 判断当前该做什么。
 *
 * @param localDirty 本机是否有未同步改动（草稿、待上传队列都算）—— 由调用方判定，本函数不猜
 *
 * 🔴 三种"看起来该自动处理、实际绝不能自动处理"的情况：
 *    · 两边都变（conflict）：自动选一边就是丢稿。
 *    · 云端版本比本地记的还旧（remote-regressed）：说明云端被回滚或换了账号，
 *      此时若按"本地基线更高"盲目推送，会把别人的整个版本覆盖掉。
 *    · 云端项目消失（remote-gone）：绝不能悄悄建一个新的同名项目 ——
 *      万一是用户自己删的，就成了"删了又活"。
 */
export function decideSync(input: {
  binding: SyncBinding | null
  remote: RemoteState
  localDirty: boolean
}): SyncDecision {
  const { binding, remote, localDirty } = input

  if (!binding) {
    return { action: 'bind-required', reason: '这本还没有绑定云端，先选择上传本机还是拉取云端' }
  }
  if (!remote.exists) {
    return {
      action: 'remote-gone',
      reason: '云端已经没有这本了（可能被删除或换过账号）。本机内容完好，可以选择重新上传或解除绑定',
    }
  }
  if (remote.deleted) {
    return {
      action: 'remote-deleted',
      reason: '云端把这本放进了回收站。恢复云端或解除绑定后再同步，避免把它又传上去',
    }
  }

  const local = binding.baseRevision
  const away = remote.revision

  if (away === local) {
    return localDirty
      ? { action: 'push', baseRevision: local, reason: '云端没有新版本，把本机改动传上去' }
      : { action: 'up-to-date', reason: '已是最新' }
  }
  if (away > local) {
    return localDirty
      ? {
          action: 'conflict', localBase: local, remoteRevision: away,
          reason: `本机和云端各有改动（本机基于第 ${local} 版，云端已到第 ${away} 版），需要你选保留哪一份`,
        }
      : {
          action: 'pull', fromRevision: local, toRevision: away,
          reason: `云端有新版本（第 ${away} 版），本机没有改动，直接更新`,
        }
  }
  // away < local：云端比本地记的还旧
  return {
    action: 'remote-regressed', localBase: local, remoteRevision: away,
    reason: `云端版本（第 ${away} 版）比本机记录（第 ${local} 版）还旧，可能被回滚或换了账号；为免覆盖，已暂停同步`,
  }
}

export type ConflictStrategy = 'keep-local' | 'keep-remote' | 'keep-both'

export type ConflictAction =
  | { type: 'push'; baseRevision: number; note: string }
  | { type: 'pull'; revision: number; note: string }
  | { type: 'fork-local-then-pull'; revision: number; note: string }
  | { type: 'none'; note: string }

/**
 * 冲突怎么解。
 *
 * 🔴 `keep-local` 的关键是**把基线换成云端的 revision**：
 *    直接重推会用旧基线再撞一次 409，看起来像"点了没反应"。
 * 🔴 `keep-both` 必须先**另存本地**再拉云端：
 *    顺序反了就是"先被覆盖、再想把原来的存下来"，那时本地已经没了。
 */
export function planConflict(strategy: ConflictStrategy, remoteRevision: number): ConflictAction {
  if (!Number.isFinite(remoteRevision) || remoteRevision <= 0) {
    return { type: 'none', note: '云端版本号异常，先刷新一次再决定' }
  }
  switch (strategy) {
    case 'keep-local':
      return {
        type: 'push', baseRevision: remoteRevision,
        note: '保留本机这一版，以云端最新版本为基线重新上传（云端旧版会留在历史里）',
      }
    case 'keep-remote':
      return {
        type: 'pull', revision: remoteRevision,
        note: '用云端这一版覆盖本机；本机当前内容会先留一份自动备份，可在备份里找回',
      }
    case 'keep-both':
      return {
        type: 'fork-local-then-pull', revision: remoteRevision,
        note: '把本机这一版另存为一本新书，然后本机切换到云端版本；两份都在',
      }
    default:
      return { type: 'none', note: '未知选项' }
  }
}

/** 绑定记录 → 界面状态（未开启自动同步时不该显示"未同步"吓人） */
export function bindingToState(binding: SyncBinding | null, decisionAction: SyncDecision['action']): SyncState {
  if (!binding) return 'idle'
  if (!binding.enabled) return 'idle'
  if (decisionAction === 'conflict') return 'conflict'
  if (decisionAction === 'remote-regressed' || decisionAction === 'remote-deleted') return 'blocked'
  if (decisionAction === 'remote-gone') return 'blocked'
  if (decisionAction === 'pull' || decisionAction === 'push') return 'queued'
  return 'synced'
}

/**
 * 界面该显示哪个同步状态。
 *
 * 🔴 不能直接用队列状态（2026-10-31 实机验证抓到）：队列跑空后 `deriveStateFromJobs` 返回
 *    `idle`，界面就写「未同步」—— 可实际是"刚同步完、两边一致"。用户看到「未同步」
 *    会以为没传上去，然后反复点同步。
 *
 * 🔴 判据用**基线是否一致**，不要绕 `decideSync`：后者还掺了"本地是否有改动"，
 *    而"刚打开项目"就会让 `updatedAt > lastSyncedAt` 成立，界面于是在「未同步 / 排队中」
 *    之间来回跳 —— 比显示错更让人不敢信。
 */
export function resolveDisplayState(input: {
  hasBinding: boolean
  queueState: SyncState
  cloudRevision: number | null
  baseRevision: number
}): SyncState {
  const { hasBinding, queueState, cloudRevision, baseRevision } = input
  if (!hasBinding) return queueState
  // 进行中/异常优先展示：它们比"已对齐"更该被看见
  if (queueState === 'syncing' || queueState === 'offline' || queueState === 'conflict' || queueState === 'blocked') {
    return queueState
  }
  if (cloudRevision === null) return queueState
  if (cloudRevision === baseRevision) return 'synced'
  if (cloudRevision > baseRevision) return 'queued'
  // 云端比本机记的还旧：回滚/换账号，不能让界面显示"已同步"
  return 'blocked'
}

/** 内存实现（单测用） */
export function createMemoryBindingStore(seed: Record<string, SyncBinding> = {}): BindingStore {
  const m = new Map(Object.entries(seed))
  return {
    async get(pid) { return m.get(pid) ?? null },
    async set(pid, b) { m.set(pid, b) },
    async clear(pid) { m.delete(pid) },
  }
}


/**
 * 提交成功之后，绑定该变成什么样。
 *
 * 🔴 **这一步漏了就是"永远未同步"**（2026-10-31 实机验证抓到）：
 *    `baseRevision` 不回写 ⇒ 面板一直显示「本机基于第 0 版」；
 *    下一次自动同步 tick 拿 `baseRevision=0` 去比 `remote.revision=1`，
 *    再叠上「本地有改动」（`updatedAt > lastSyncedAt=0`）⇒ 直接判成**假冲突**，
 *    用户刚上传完就被告知"云端与本机各有改动"。
 *
 * @param binding 提交前的绑定
 * @param revision 服务端返回的 revision（`replayed` 时也是同一个值）
 * @param now 提交完成时刻
 * @returns 新绑定；**绑定指向别的云端项目时返回 null**（提交期间被解绑/重绑，不该覆盖）
 */
export function nextBindingAfterCommit(
  binding: SyncBinding | null, cloudProjectId: string, revision: number, now: number,
): SyncBinding | null {
  if (!binding) return null
  if (binding.cloudProjectId !== cloudProjectId) return null
  if (!Number.isFinite(revision) || revision <= 0) return null
  return {
    ...binding,
    baseRevision: revision,
    lastSyncedAt: now,
    // 快照身份留给后续"云端变没变"的快速判断；这里拿不到就保持原值
  }
}

/**
 * 「把云端这本接到本机」时该建的绑定。
 *
 * 🔴 与「下载为新书」的区别（这条是 2026-10-31 实机推桌面端时发现的）：
 *    下载为新书只 `importProject` 一份**独立副本**，不建绑定 ⇒ 那本之后既不能推也不能拉，
 *    「换设备接着写」根本走不通（要么再点上传、变成云端第二本书）。
 *    接续要的是**同一本书**：下载内容 + 绑定到同一个 cloudProjectId。
 *
 * 🔴 `baseRevision` 取云端当前 revision、`lastSyncedAt` 取 now：
 *    刚下载下来的这份内容与云端**完全一致**，若不这么设，下一次 tick 会因为
 *    `updatedAt > lastSyncedAt` 判成"本机有改动"而立刻重推一遍（等于白传一遍全量）。
 *
 * @param accountId 当前账号（换账号后绑定要作废，见 `bindingForAccount`）
 */
export function bindingAfterAttach(
  cloudProjectId: string, revision: number, accountId: string | undefined, now: number,
): SyncBinding | null {
  if (!cloudProjectId || !Number.isFinite(revision) || revision <= 0) return null
  return {
    cloudProjectId,
    baseRevision: revision,
    lastSyncedAt: now,
    enabled: true,
    ...(accountId ? { accountId } : {}),
  }
}

/**
 * 这个绑定在当前账号下还有效吗。
 *
 * @returns 有效返回原绑定；账号不符（或记录里没有账号的老数据 + 当前有账号）返回 null
 *
 * 🔴 老数据（没有 `accountId`）的处理：**当前也没有账号信息时放行**，
 *    有时则视为不匹配。宁可让用户重新绑一次，也不要拿别人的 id 去撞 403。
 */
export function bindingForAccount(binding: SyncBinding | null, currentAccountId?: string): SyncBinding | null {
  if (!binding) return null
  if (!currentAccountId) return binding
  /**
   * 🔴 旧绑定没有账号 id ⇒ **认作当前账号**（2026-10-31 全量审计后改的口径）。
   *
   * 原规则是"宁可重绑一次"，但那是桌面端还不会写 accountId 的时候定的：
   * 桌面版此前从不设置账号 id（本轮才修），于是**每一个已经在用同步的用户**，
   * 升级后打开软件都会看到"这本是在另一个账号下绑定的，请重新绑定"——
   * 明明同一个账号、同一台机器，却要重传一遍整本书。
   * 3.3.2 尚未发布，带 id 的绑定只能来自修复后的版本，因此"缺 id"只可能是旧数据，
   * 认作当前账号是更安全的选择；调用方读到后会**回填**真实 id（见 CloudSyncPanel.load）。
   */
  if (!binding.accountId) return binding
  return binding.accountId === currentAccountId ? binding : null
}
