// ============ 存储层 · 长任务单元台账（3.3.3 · P1：A4 / B3 共用基础）============
//
// 两个 store：
//   · taskHeads  —— 任务头（本机专属：不参与云盘同步）
//   · taskUnits  —— 逐单元状态与产物（本机专属）
//
// 🔴 为什么是**本机专属**而不是项目级数据（与 `revisionJobs` 相反）：
//    规划 §14.1 明确「任务头、产物、执行权默认本机专属；不自动进入云端快照、
//    日常项目包或另一设备；导入作品不激活旧任务」。任务产物是"这台机器上的一次运行结果"，
//    跟着项目包跑到别人机器上只会变成一份无法校验来源的残留。
//    ⇒ 已登记进 `syncCore.LOCAL_ONLY_STORES`；`exportProject()` 的显式清单也不含它们。
//
// 🔴 写序（规划 §14.2）：单元结果**先真正落盘、再标 succeeded**。
//    IDB 以事务提交为边界；桌面/便携的 put 只更新内存，必须等 `flush` 才算数。
//    失败/取消/中断只改状态，不伪造产物。
//
// 🔴 执行权：同一任务多窗口靠 `generation` 互斥。`claimTask` 递增代次，
//    之后每次写入前重读任务头比对；旧执行者的回包一律 `TaskExecutionLost`。
//    这不是跨进程锁，也不假装是 —— 它只保证"晚到的写不会盖掉新执行者"。
import type { TaskHead, TaskHeadStatus, TaskUnit, TaskUnitStatus } from '@/lib/tasks/unitLedger'
import { reconcileOnLoad, recordBytes } from '@/lib/tasks/unitLedger'
import { ops } from '@/lib/db/core'
import { DESKTOP, flushDesktop, getDesktopState } from '@/lib/app/desktop'
import { PORTABLE, flushPortable, getPortableState } from '@/lib/storage/fileBackend'
import type { StoreOps } from '@/lib/storage/storeOps'
import { captureStorageWriteOwner, storageWriteContext } from '@/lib/storage/writeOwner'

/** 执行权已失效（别一个窗口接管 / 任务被清理 / 项目或存储空间已切换）。 */
export class TaskExecutionLost extends Error {
  constructor(message = '这次拆书已由另一个窗口接管，或任务记录已被清理；本次结果不再写入。') {
    super(message)
    this.name = 'TaskExecutionLost'
  }
}

export function isTaskExecutionLost(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'TaskExecutionLost'
}

/** Serialize ledger mutations across same-origin windows; never pretend an unavailable lock is safe. */
export async function withTaskLedgerLock<T>(action: () => Promise<T>): Promise<T> {
  if (typeof window === 'undefined') return action()
  if (typeof navigator === 'undefined' || !navigator.locks) {
    throw new TaskExecutionLost('当前环境无法安全协调多个窗口，已暂停可恢复任务。')
  }
  return navigator.locks.request('yfe-task-ledger-v1', { mode: 'exclusive' }, action)
}

/** 一次运行的写入凭据：项目/存储空间 + 执行代次。**打开时捕获 StoreOps**，恢复时不再取全局。 */
export interface TaskWriteOwner {
  projectId: string
  store: StoreOps
  ownerId: string
  generation: number
  /** 同步校验：项目或存储上下文变了就抛（已发出的 I/O 无法撤回，只能让后续写失败） */
  assertCurrent: () => void
  /** 异步校验：重读任务头，比对 owner/generation */
  assertGeneration: () => Promise<void>
}

export function openTaskOwner(head: TaskHead, ownerId: string): TaskWriteOwner {
  const guard = captureStorageWriteOwner(head.projectId)
  const store = ops
  const assertCurrent = () => {
    if (!guard.current()) throw new TaskExecutionLost('存储空间或账号已切换，本次结果不再写入。')
  }
  return {
    projectId: head.projectId,
    store,
    ownerId,
    generation: head.generation,
    assertCurrent,
    assertGeneration: async () => {
      assertCurrent()
      const fresh = await store.get<TaskHead>('taskHeads', head.id)
      assertCurrent()
      if (!fresh) throw new TaskExecutionLost('任务记录已被清理，本次结果不再写入。')
      if (fresh.generation !== head.generation || fresh.ownerId !== ownerId) {
        throw new TaskExecutionLost()
      }
    },
  }
}

/**
 * 严格写：真实落盘成功才返回。
 * 口径与 `revisionJobs.saveRevisionPayload` 一致（同一处踩过的坑，别再各写一份）。
 */
async function writeStrict(store: StoreOps, name: string, value: unknown, guard?: () => void): Promise<void> {
  guard?.()
  if (store.putStrict) await store.putStrict(name, value)
  else await store.put(name, value)
  // 文件后端 put 只更新内存；没 flush 成功就不能对外说"已保存"。
  if (DESKTOP || PORTABLE) {
    const state = DESKTOP ? getDesktopState : getPortableState
    const flush = DESKTOP ? flushDesktop : flushPortable
    const deadline = Date.now() + 10000
    // 防抖保存可能已在途：先等它结束，再提交包含本次状态的新快照。
    while (state().saving && Date.now() < deadline) { guard?.(); await new Promise(resolve => setTimeout(resolve, 20)) }
    guard?.()
    if (state().saving || !await flush()) throw new Error('拆书单元结果未能写入数据文件，请检查保存状态后重试')
    guard?.()
  }
}

// ============ 任务头 ============

export async function getTaskHead(id: string, store: StoreOps = ops): Promise<TaskHead | undefined> {
  return store.get<TaskHead>('taskHeads', id)
}

/** 某项目的全部任务头（走 projectId 索引，避免全表扫） */
export async function listProjectTaskHeads(projectId: string, store: StoreOps = ops): Promise<TaskHead[]> {
  return store.getAllByIndex<TaskHead>('taskHeads', 'projectId', projectId)
}

export async function saveTaskHead(head: TaskHead, owner?: TaskWriteOwner): Promise<void> {
  await writeStrict(owner?.store ?? ops, 'taskHeads', head, owner?.assertCurrent)
}

// ============ 单元 ============

export async function listTaskUnits(taskId: string, store: StoreOps = ops): Promise<TaskUnit[]> {
  const rows = await store.getAllByIndex<TaskUnit>('taskUnits', 'taskId', taskId)
  return rows.sort((a, b) => a.index - b.index)
}

/**
 * 写一个单元（结果与状态同一条记录）。
 *
 * 🔴 调用方必须在拿到模型结果之后、合并批次之前调用 —— 只有这里写成功，
 *    这个单元才算"可跳过"。界面/日志说的「已完成 N 个」以此为准，不以内存计数为准。
 */
export async function saveTaskUnit(unit: TaskUnit, owner?: TaskWriteOwner): Promise<TaskUnit> {
  return withTaskLedgerLock(async () => {
  if (owner) {
    owner.assertCurrent()
    await owner.assertGeneration()
  }
  // 字节口径：真实序列化长度（含索引字段本身），配额按它累加
  const base: TaskUnit = { ...unit, bytes: 0 }
  base.bytes = recordBytes(base)
  await writeStrict(owner?.store ?? ops, 'taskUnits', base, owner?.assertCurrent)
  return base
  })
}

/** 只改状态（不改产物）。用于 running / cancelled / interrupted 这类中间态。 */
export async function setTaskUnitStatus(
  unit: Pick<TaskUnit, 'id' | 'taskId' | 'projectId' | 'index' | 'unitKey' | 'chapterTitle' | 'attempts' | 'result'>,
  status: TaskUnitStatus,
  owner?: TaskWriteOwner,
): Promise<TaskUnit> {
  const next: TaskUnit = {
    ...unit,
    status,
    updatedAt: Date.now(),
    bytes: 0,
  }
  return saveTaskUnit(next, owner)
}

// ============ 打开 / 接管 / 收尾 ============

export interface TaskSnapshot {
  head: TaskHead
  units: TaskUnit[]
}

/**
 * 只读打开（界面显示历史进度用）。
 *
 * 🔴 **只在校验阶段把 running 视作 interrupted，不写回磁盘**：
 *    另一个窗口可能正在跑这个任务 —— 预览顺手改状态会把它正在跑的单元标成中断。
 *    真正的重置发生在 `claimTask`（那里会写）。
 */
export async function loadTask(taskId: string, store: StoreOps = ops): Promise<TaskSnapshot | undefined> {
  const head = await getTaskHead(taskId, store)
  if (!head) return undefined
  const units = reconcileOnLoad(await listTaskUnits(taskId, store))
  return { head, units }
}

/**
 * 接管执行权：递增代次、写 owner、把残留的 `running` 单元降为 `interrupted`。
 *
 * 🔴 顺序很重要：**先把中断态落盘，再把 running 写进任务头**。
 *    反过来的话，中途崩溃会留下「任务在跑、单元在跑、其实没人跑」的三重假象。
 */
export async function claimTask(taskId: string, ownerId: string): Promise<TaskSnapshot> {
  return withTaskLedgerLock(() => claimTaskLocked(taskId, ownerId))
}

/** Caller holds the task ledger lock. */
export async function claimTaskLocked(taskId: string, ownerId: string): Promise<TaskSnapshot> {
  const store = ops
  const originalContext = storageWriteContext()
  const head = await getTaskHead(taskId, store)
  if (ops !== store || storageWriteContext() !== originalContext) throw new TaskExecutionLost('存储空间或账号已切换，不能接管任务。')
  if (!head) throw new Error('拆书任务记录已不存在，请重新开始。')
  const guard = captureStorageWriteOwner(head.projectId)
  const check = () => { if (!guard.current() || ops !== store) throw new TaskExecutionLost('存储空间或账号已切换，不能接管任务。') }
  check()
  const raw = await listTaskUnits(taskId, store)
  check()
  for (const u of raw) {
    if (u.status !== 'running') continue
    await writeStrict(store, 'taskUnits', { ...u, status: 'interrupted', updatedAt: Date.now() }, check)
  }
  const next: TaskHead = {
    ...head,
    status: 'running',
    ownerId,
    generation: head.generation + 1,
    updatedAt: Date.now(),
  }
  await writeStrict(store, 'taskHeads', next, check)
  return { head: next, units: reconcileOnLoad(raw) }
}

/** 收尾：写入任务头终态（`done` = 全单元成功；有失败/中断则停在 pending 或 interrupted） */
export async function finishTask(head: TaskHead, status: TaskHeadStatus, label: string, owner?: TaskWriteOwner): Promise<TaskHead> {
  return withTaskLedgerLock(async () => {
    if (owner) await owner.assertGeneration()
    const next: TaskHead = { ...head, status, label, updatedAt: Date.now() }
    await saveTaskHead(next, owner)
    return next
  })
}

// ============ 清理 ============

/** 丢弃任务私有产物：只删本任务的头与单元，**不碰已确认写入书库的正文/设定**。 */
export async function deleteTaskArtifacts(taskId: string, owner?: TaskWriteOwner): Promise<void> {
  return withTaskLedgerLock(() => deleteTaskArtifactsLocked(taskId, owner))
}

/** Caller holds the task ledger lock. */
export async function deleteTaskArtifactsLocked(taskId: string, owner?: TaskWriteOwner): Promise<void> {
  if (owner) await owner.assertGeneration()
  const store = owner?.store ?? ops
  const units = await listTaskUnits(taskId, store)
  if (units.length) await store.bulkDel('taskUnits', units.map(u => u.id))
  await store.del('taskHeads', taskId)
}

/** 删项目时按 projectId 级联清理（项目没了，它的拆书台账没有继续存在的理由）。 */
export async function deleteProjectTaskArtifacts(projectId: string, store: StoreOps = ops): Promise<void> {
  return withTaskLedgerLock(async () => {
  const heads = await listProjectTaskHeads(projectId, store)
  if (heads.length) await store.bulkDel('taskHeads', heads.map(h => h.id))
  const units = await store.getAllByIndex<TaskUnit>('taskUnits', 'projectId', projectId)
  if (units.length) await store.bulkDel('taskUnits', units.map(u => u.id))
  })
}

/** 项目级用量（配额判定用）：按单元记录里的真实字节累加 */
export async function taskUsage(projectId: string, store: StoreOps = ops): Promise<{ projectBytes: number; byTask: Record<string, number> }> {
  const units = await store.getAllByIndex<TaskUnit>('taskUnits', 'projectId', projectId)
  const byTask: Record<string, number> = {}
  let projectBytes = 0
  for (const u of units) {
    const n = typeof u.bytes === 'number' && Number.isFinite(u.bytes) ? u.bytes : 0
    projectBytes += n
    byTask[u.taskId] = (byTask[u.taskId] ?? 0) + n
  }
  return { projectBytes, byTask }
}
