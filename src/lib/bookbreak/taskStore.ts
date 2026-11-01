/**
 * 拆书任务的**业务门面**（3.3.3 · P1）：把「单元台账」包装成界面与管线都能用的形状。
 *
 * 分层（别打乱）：
 *   纯判定 `lib/tasks/unitLedger` → 落盘 `lib/db/taskLedger` → **本文件** → `run.ts` / `BookBreakPanel`
 *
 * 🔴 界面只 import 本文件，不直接 import `db/taskLedger` —— 与 structureGates ⑭
 *    「界面只走 lib 门面」同一口径（那里钉的是检查报告，这里同理：口径散到界面就会各写一套）。
 *
 * 🔴 降级策略（必须分清两类失败）：
 *    · **配额超限 / 执行权丢失** ⇒ 如实抛错，任务停住（不能装作没发生）；
 *    · **存储本身不可用**（隐私模式 IDB 打不开 / 数据文件只读）⇒ 返回 null，
 *      调用方退回"只在内存里跑"的旧行为 —— 拆书本身不该因为记账失败而彻底用不了。
 *      降级只影响"重启后还能不能接着跑"，必须在结果里如实说明（见 run.ts 的 ledgerNote）。
 */
import { uid } from '@/lib/app/id'
import { getCurrentProjectId } from '@/lib/db/core'
import { storageWriteContext } from '@/lib/storage/writeOwner'
import {
  BOOKBREAK_TASK_KIND, TASK_PROTOCOL_VERSION, configFingerprint, countUnits, decideTaskQuota,
  taskIdOf, textFingerprint, unitIdOf, unitKeyOf,
  type TaskCounts, type TaskHead, type TaskHeadStatus, type TaskIdentity, type TaskUnit,
} from '@/lib/tasks/unitLedger'
import {
  claimTaskLocked, deleteTaskArtifacts, deleteTaskArtifactsLocked, finishTask, getTaskHead, listProjectTaskHeads,
  loadTask, openTaskOwner, saveTaskHead, saveTaskUnit, taskUsage, TaskExecutionLost, isTaskExecutionLost,
  withTaskLedgerLock,
} from '@/lib/db/taskLedger'

/** 配额/容量类拒绝：**必须**让作者看见原因，不能被降级吞掉。 */
export class TaskQuotaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskQuotaError'
  }
}

export function isTaskQuotaError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'TaskQuotaError'
}

/**
 * 影响抽取结果的配置（**只放这些**）。
 *
 * 🔴 刻意不含 `persistToChapters / summarizeForms / organizeRelations` 这类下游开关：
 *    它们不影响任何一个抽取单元，塞进指纹只会让作者关掉"整理关系"就丢掉已完成进度。
 */
export interface BookBreakUnitConfig {
  maxChunks?: number
  maxUnitChars?: number
  maxUnits?: number
  chunkTokens?: number
  titleSamples?: string
}

export interface BookBreakIdentity extends TaskIdentity {
  taskId: string
}

/** 任务身份：原文 + 抽取配置 + 协议版本 + 项目（同一本书同一套参数 ⇒ 同一任务） */
export function bookBreakIdentity(raw: string, cfg: BookBreakUnitConfig, projectId = getCurrentProjectId()): BookBreakIdentity {
  const inputFingerprint = textFingerprint(raw)
  const cfgFingerprint = configFingerprint({
    protocol: TASK_PROTOCOL_VERSION,
    maxChunks: cfg.maxChunks ?? null,
    maxUnitChars: cfg.maxUnitChars ?? null,
    maxUnits: cfg.maxUnits ?? null,
    chunkTokens: cfg.chunkTokens ?? null,
    // 标题示例会改变 AI 边界识别 ⇒ 属于影响结果的配置
    titleSamples: (cfg.titleSamples ?? '').trim(),
  })
  const base: TaskIdentity = {
    kind: BOOKBREAK_TASK_KIND, projectId, inputFingerprint, configFingerprint: cfgFingerprint,
    protocolVersion: TASK_PROTOCOL_VERSION,
  }
  return { ...base, taskId: taskIdOf(base) }
}

/** 单个抽取单元的元信息（管线按它写台账） */
export interface BookBreakUnitMeta {
  index: number
  /** unitKeyOf(...) 的结果 */
  key: string
  chapterTitle: string
}

function unitKeyFor(identity: BookBreakIdentity, index: number, unitText: string): string {
  return unitKeyOf({
    inputFingerprint: identity.inputFingerprint,
    configFingerprint: identity.configFingerprint,
    protocolVersion: identity.protocolVersion,
    index,
    textFingerprint: textFingerprint(unitText),
  })
}

/** 单元键：管线与台账必须用**同一个**算法（导出给 run.ts 复用，别各写一份） */
export function bookBreakUnitKey(identity: BookBreakIdentity, index: number, unitText: string): string {
  return unitKeyFor(identity, index, unitText)
}

/** 管线侧句柄：每次写都过执行权校验（晚回包写不进去） */
export interface BookBreakTaskHandle {
  head: TaskHead
  identity: BookBreakIdentity
  units(): Promise<TaskUnit[]>
  beginUnit(meta: BookBreakUnitMeta): Promise<void>
  settleUnit(meta: BookBreakUnitMeta, result: unknown): Promise<void>
  failUnit(meta: BookBreakUnitMeta, code: string): Promise<void>
  cancelUnit(meta: BookBreakUnitMeta): Promise<void>
  finish(status: TaskHeadStatus, label: string): Promise<void>
  discard(): Promise<void>
}

/** 只读预览（面板显示历史进度用） */
export interface BookBreakTaskPreview {
  head: TaskHead
  units: TaskUnit[]
  counts: TaskCounts
}

/**
 * 打开（或新建）任务并接管执行权。
 *
 * @param totalUnits 本次切分出的单元总数（台账据此显示 N/M 与判定上限）
 * @param freshStart 「从头重跑」：先清本任务私有产物再建头（已成功单元不会被复用）
 */
export async function openBookBreakTask(input: {
  identity: BookBreakIdentity
  totalUnits: number
  modelTag: string
  label: string
  freshStart?: boolean
}): Promise<BookBreakTaskHandle | null> {
  const { identity } = input
  const context = storageWriteContext()
  try {
    return await withTaskLedgerLock(async () => {
    if (context !== storageWriteContext() || identity.projectId !== getCurrentProjectId()) {
      throw new TaskExecutionLost('作品或存储空间已切换，不能启动原任务。')
    }
    if (input.freshStart) await deleteTaskArtifactsLocked(identity.taskId)
    let head = await getTaskHead(identity.taskId)
    if (!head) {
      // 新建前先过配额（条数 / 本项目总量）。超限抛 TaskQuotaError，绝不淘汰别人的产物。
      const [heads, usage] = await Promise.all([
        listProjectTaskHeads(identity.projectId),
        taskUsage(identity.projectId),
      ])
      const verdict = decideTaskQuota({
        heads: heads.map(h => ({ id: h.id, status: h.status })),
        projectBytes: usage.projectBytes,
        taskBytes: 0,
        projectedBytes: 0,
        creating: true,
      })
      if (!verdict.ok) throw new TaskQuotaError(verdict.reason)
      head = {
        id: identity.taskId,
        kind: identity.kind,
        projectId: identity.projectId,
        storageKey: storageWriteContext(),
        inputFingerprint: identity.inputFingerprint,
        configFingerprint: identity.configFingerprint,
        protocolVersion: identity.protocolVersion,
        modelTag: input.modelTag,
        totalUnits: input.totalUnits,
        status: 'pending',
        ownerId: '',
        generation: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        label: input.label,
      }
      await saveTaskHead(head)
    } else if (head.totalUnits !== input.totalUnits) {
      // 切分数变了（如 AI 边界识别这次给了不同结果）：更新总数，**旧单元由单元键判过期**。
      // 🔴 不要在这里抛错拦住作者：切分本身不是确定性的，抛错会让"继续"莫名其妙不可用；
      //    而键不一致的旧结果本来就不会参与合并（见 `unitLedger.planUnitRun`）。
      head = { ...head, totalUnits: input.totalUnits, updatedAt: Date.now() }
      await saveTaskHead(head)
    }
    const snapshot = await claimTaskLocked(identity.taskId, uid())
    const owner = openTaskOwner(snapshot.head, snapshot.head.ownerId)
    const known = new Map<number, TaskUnit>(snapshot.units.map(u => [u.index, u]))
    const list = () => Promise.resolve([...known.values()].sort((a, b) => a.index - b.index))

    const write = async (meta: BookBreakUnitMeta, patch: Partial<TaskUnit>): Promise<void> => {
      const prev = known.get(meta.index)
      const record: TaskUnit = {
        id: unitIdOf(identity.taskId, meta.index),
        taskId: identity.taskId,
        projectId: identity.projectId,
        index: meta.index,
        unitKey: meta.key,
        chapterTitle: meta.chapterTitle,
        status: prev?.status ?? 'pending',
        attempts: prev?.attempts ?? 0,
        bytes: 0,
        updatedAt: Date.now(),
        ...patch,
      }
      const saved = await saveTaskUnit(record, owner)
      known.set(meta.index, saved)
    }

    const handle: BookBreakTaskHandle = {
      head: snapshot.head,
      identity,
      units: list,
      async beginUnit(meta) {
        const prev = known.get(meta.index)
        await write(meta, { status: 'running', attempts: (prev?.attempts ?? 0) + 1, result: undefined, failure: undefined })
      },
      async settleUnit(meta, result) {
        // 🔴 结果与 succeeded 同一条记录一次写入：不存在"标了成功却没有产物"的中间态
        await write(meta, { status: 'succeeded', result, failure: undefined })
      },
      async failUnit(meta, code) {
        await write(meta, { status: 'failed', result: undefined, failure: code.slice(0, 80) })
      },
      async cancelUnit(meta) {
        await write(meta, { status: 'cancelled' })
      },
      async finish(status, label) {
        handle.head = await finishTask(handle.head, status, label, owner)
      },
      async discard() {
        await deleteTaskArtifacts(identity.taskId, owner)
        known.clear()
      },
    }
    return handle
    })
  } catch (e) {
    if (isTaskQuotaError(e) || isTaskExecutionLost(e)) throw e
    // 存储不可用 ⇒ 降级为"只在内存里跑"。调用方必须如实告诉作者本次进度不会留存。
    console.warn('[bookbreak] 单元台账不可用，本次拆书不做断点持久化：', e)
    return null
  }
}

/** 只读预览：只在界面显示"本机留有一份进度"（不 claim、不写任何东西） */
export async function previewBookBreakTask(identity: BookBreakIdentity): Promise<BookBreakTaskPreview | null> {
  try {
    const snap = await loadTask(identity.taskId)
    if (!snap) return null
    return { head: snap.head, units: snap.units, counts: countUnits(snap.units, snap.head.totalUnits) }
  } catch {
    return null
  }
}

/** 丢弃一份拆书台账（界面「清理记录」/「从头重跑」前调用） */
export async function discardBookBreakTask(taskId: string): Promise<void> {
  await deleteTaskArtifacts(taskId)
}

/** 供界面显示的短模型标识（不含端点、不含密钥） */
export function modelTagOf(p: { name?: string; model?: string } | null | undefined): string {
  if (!p) return ''
  const name = String(p.name ?? '').slice(0, 40)
  const model = String(p.model ?? '').slice(0, 60)
  return [name, model].filter(Boolean).join('/')
}

export { TaskExecutionLost }
