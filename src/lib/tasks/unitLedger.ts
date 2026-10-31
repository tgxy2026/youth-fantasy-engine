/**
 * 长任务「单元台账」的纯逻辑层（3.3.3 · P1：A4 失败单元重试 / B3 重启恢复共用基础）。
 *
 * 只做判定，不碰存储、不碰模型、不 import 任何兄弟域 —— 便于穷举单测。
 * 落盘见 `@/lib/db/taskLedger`，业务门面见 `@/lib/bookbreak/taskStore`。
 *
 * 三条必须守住的语义（规划 §6.1 / §14.3）：
 * 1. **单元身份**：单元键必须含原文指纹、拆分/抽取配置、协议版本、单元下标与单元文本指纹。
 *    只比「单元数相同」是不够的 —— 改了原文但单元数没变时，旧结果会整体错位。
 * 2. **状态与产物同一条记录**：`succeeded` 必须与结果一起写；先标成功、后写结果
 *    （或反过来）中间的崩溃窗口都会造出「看起来成功、其实没有产物」的单元。
 * 3. **默认不重试失败**：失败单元是「问过模型但没成」，自动重试等于替作者额外付费；
 *    只有作者点「只重试失败单元」时才跑。
 *
 * 验收口径见 `docs/3.3.3-开发规划-2026-10-31.md` §6 / §14.3（本文件只提供可复算的纯函数）。
 */

/** 当前任务协议版本。改动单元拆分/结果形状时必须递增（旧单元键随之失效，不会错用旧产物）。 */
export const TASK_PROTOCOL_VERSION = 1

/** 拆书任务在台账里的 kind（与创意写作未来接入时区分，别共用一个 id 空间）。 */
export const BOOKBREAK_TASK_KIND = 'bookbreak-extract'

/** 单元状态。`interrupted` 不是"失败"：它是进程中途退出、结果从未落盘的那一档。 */
export type TaskUnitStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

/** 任务头状态。`done` 表示全单元成功；有失败/中断时仍停在 `pending` 或 `interrupted`。 */
export type TaskHeadStatus = 'pending' | 'running' | 'interrupted' | 'done'

/** 本次要跑哪些单元。 */
export type UnitRunMode = 'resume' | 'retry-failed' | 'fresh'

export interface TaskHead {
  /** 由项目 + 原文指纹 + 配置指纹 + 协议版本推出的稳定 id（同一本书同一套参数 ⇒ 同一任务） */
  id: string
  kind: string
  projectId: string
  /** 存储空间标识（见 `storageWriteContext()`）：换账号 / 换后端后旧任务不激活 */
  storageKey: string
  /** 原文指纹（不是原文本身：台账不复制第二份书稿） */
  inputFingerprint: string
  /** 拆分 / 抽取 / 材料上限等全部可影响结果的参数 */
  configFingerprint: string
  protocolVersion: number
  /** 模型/提示来源的短标识（不含端点地址、不含密钥） */
  modelTag: string
  totalUnits: number
  status: TaskHeadStatus
  /** 执行权持有者（一次运行一个随机串），用于拒绝晚回包 */
  ownerId: string
  /** 执行代次：每次 claim 递增；写入前比对，旧执行者一律拒绝 */
  generation: number
  createdAt: number
  updatedAt: number
  /** 给人看的一行说明（如「已抽 37/60」） */
  label: string
}

export interface TaskUnit {
  /** `${taskId}::u${index}`（主键；同一任务内按单元下标唯一） */
  id: string
  taskId: string
  projectId: string
  index: number
  /** 单元身份键：原文 / 配置 / 协议 / 下标 / 单元文本指纹的合成哈希 */
  unitKey: string
  chapterTitle: string
  status: TaskUnitStatus
  /** 已尝试次数（成功前可能 >1，仅用于显示"重试过几次"） */
  attempts: number
  /** 结果序列化后的 UTF-8 字节数（配额按真实字节算） */
  bytes: number
  updatedAt: number
  /** 产物。`succeeded` 时必有（合法空结果存 `[]`，与"失败"分开） */
  result?: unknown
  /** 有限失败原因码（如 `parse-invalid`、`timeout`），不存原始异常/请求内容 */
  failure?: string
}

/** 配额（规划 §6.2：每项目最多 5 个可恢复任务、每任务 20 MiB、合计 50 MiB） */
export const TASK_LIMITS = {
  maxTasksPerProject: 5,
  maxBytesPerTask: 20 * 1024 * 1024,
  maxBytesPerProject: 50 * 1024 * 1024,
} as const

/** JSON 稳定序列化：键名排序 ⇒ 同一份参数无论键序如何指纹一致 */
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? String(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

/**
 * FNV-1a 32 位 + 长度后缀（同步、浏览器/Node 同码）。
 *
 * 🔴 为什么不用 `crypto.subtle.digest`：它是异步的，而单元计划要在循环里同步判定；
 *    这里只需要「变了能看出来」，不需要抗碰撞强度 —— 前缀 8 位 hex 加长度已经够用。
 *    与 `lib/semantic/chunk.hashOf` 同一算法，但**刻意各自实现**：本模块是零依赖的
 *    任务叶子，反向 import 语义检索层会把重依赖拖进来（也容易凑成 import 环）。
 */
export function stableHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(16).padStart(8, '0')}-${text.length.toString(16)}`
}

/** UTF-8 实字节（配额口径：中文一个字 3 字节，不能按 JS 字符数算） */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** 一条记录在台账里占用的字节（按真实序列化算，含索引字段本身） */
export function recordBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value ?? null))
}

/** 原文指纹。长度一起进哈希，避免"短文本撞到长文本前缀"这类低级巧合。 */
export function textFingerprint(text: string): string {
  return `t1:${stableHash(text)}`
}

/** 配置指纹：调用方传入一个只含**影响结果**的参数对象（不要塞界面开关/时间戳） */
export function configFingerprint(config: unknown): string {
  return `c1:${stableHash(stableStringify(config))}`
}

export interface TaskIdentity {
  kind: string
  projectId: string
  inputFingerprint: string
  configFingerprint: string
  protocolVersion: number
}

/**
 * 任务 id：**确定性**推导，不用随机 uid。
 *
 * 好处：同一本书 + 同一套参数重跑时自然落到同一条任务上，重启后能找回历史进度；
 * 代价：作者改原文或改参数 ⇒ 得到另一个 id（旧台账仍是"另一个任务"，不会被错用）。
 */
export function taskIdOf(p: TaskIdentity): string {
  return `${p.kind}:${stableHash([p.projectId, p.inputFingerprint, p.configFingerprint, String(p.protocolVersion)].join('\u0001'))}`
}

export function unitIdOf(taskId: string, index: number): string {
  return `${taskId}::u${index}`
}

export interface UnitKeyInput {
  inputFingerprint: string
  configFingerprint: string
  protocolVersion: number
  index: number
  /** 该单元文本的指纹（不是全文：同一章被拆成多块时每块独立） */
  textFingerprint: string
}

/** 单元身份键 —— 结果能否被复用**只看它**，不看"已完成多少个" */
export function unitKeyOf(p: UnitKeyInput): string {
  return stableHash([p.inputFingerprint, p.configFingerprint, String(p.protocolVersion), String(p.index), p.textFingerprint].join('\u0001'))
}

/** 状态迁移表（穷举，测试逐条钉住）。未列出的组合一律拒绝。 */
const TRANSITIONS: Record<TaskUnitStatus, TaskUnitStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled', 'interrupted'],
  // 失败可以再试（作者显式发起），也可以放弃
  failed: ['running', 'cancelled'],
  cancelled: ['running'],
  interrupted: ['running'],
  // 成功是终态：要重跑就换任务（原文/参数变了 id 必变），不允许把成功改回 running
  succeeded: [],
}

export function canTransition(from: TaskUnitStatus, to: TaskUnitStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** 重启对账：磁盘上还写着 `running` 的单元 = 进程退出时没人收尾 ⇒ 一律降为 `interrupted` */
export function reconcileOnLoad(units: TaskUnit[]): TaskUnit[] {
  return units.map(u => (u.status === 'running' ? { ...u, status: 'interrupted' } : u))
}

export interface PlannedUnit {
  index: number
  textFingerprint: string
  chapterTitle: string
}

export interface UnitPlan {
  /** 本次要调模型的单元下标（升序） */
  run: number[]
  /** 结果可直接复用的单元下标（succeeded 且键一致） */
  reuse: number[]
  /** 台账里有记录、但键对不上当前原文/参数的单元（旧结果不得参与合并） */
  stale: number[]
  /** 台账里是失败的下标（默认不跑，除非 retry-failed） */
  failed: number[]
  /** 台账里是已取消的下标（继续时由作者显式选择是否跑，见 mode） */
  cancelled: number[]
  /** 台账里是中断的下标 */
  interrupted: number[]
}

export interface UnitPlanInput {
  units: PlannedUnit[]
  existing: TaskUnit[]
  identity: Omit<TaskIdentity, 'kind'> & { taskId: string }
  mode: UnitRunMode
}

/**
 * 计算本次该跑哪些单元。
 *
 * 三种模式的区别（对应界面三个按钮）：
 * - `resume`       「继续抽取（只补剩余）」：补齐 pending / interrupted / cancelled；
 *                  **失败单元不自动重试**（那是另一次付费，须作者点第二个按钮）。
 * - `retry-failed` 「只重试失败单元」：**只跑 failed**；已成功的照常复用。
 *                  未尝试的 pending / 过期的旧记录**不顺手补跑** —— 作者要补它们请用「继续抽取」，
 *                  否则一个按钮会悄悄发出比名字更多的请求。
 * - `fresh`        「从头重跑」：全部重跑（调用方应先清掉旧任务产物）。
 */
export function planUnitRun(input: UnitPlanInput): UnitPlan {
  const plan: UnitPlan = { run: [], reuse: [], stale: [], failed: [], cancelled: [], interrupted: [] }
  if (input.mode === 'fresh') {
    for (const u of input.units) plan.run.push(u.index)
    return plan
  }
  /** 本模式下"没有记录/记录过期"的单元要不要补跑（只有 retry-failed 不补） */
  const fillMissing = input.mode !== 'retry-failed'
  const byIndex = new Map<number, TaskUnit>()
  for (const rec of input.existing) {
    if (rec.taskId !== input.identity.taskId) continue
    byIndex.set(rec.index, rec)
  }
  const seen = new Set<number>()
  for (const u of input.units) {
    seen.add(u.index)
    const key = unitKeyOf({
      inputFingerprint: input.identity.inputFingerprint,
      configFingerprint: input.identity.configFingerprint,
      protocolVersion: input.identity.protocolVersion,
      index: u.index,
      textFingerprint: u.textFingerprint,
    })
    const rec = byIndex.get(u.index)
    // 没有记录 ⇒ 本次必须跑（重试模式下不动：那不是"失败单元"）
    if (!rec) { if (fillMissing) plan.run.push(u.index); continue }
    // 键不一致 ⇒ 原文/参数变过：旧结果作废（**不能**只按"下标已完成"跳过）
    if (rec.unitKey !== key) {
      plan.stale.push(u.index)
      if (fillMissing) plan.run.push(u.index)
      continue
    }
    switch (rec.status) {
      case 'succeeded':
        plan.reuse.push(u.index)
        break
      case 'failed':
        plan.failed.push(u.index)
        if (input.mode === 'retry-failed') plan.run.push(u.index)
        break
      case 'cancelled':
        plan.cancelled.push(u.index)
        if (input.mode === 'resume') plan.run.push(u.index)
        break
      case 'interrupted':
        plan.interrupted.push(u.index)
        if (input.mode === 'resume') plan.run.push(u.index)
        break
      case 'pending':
      case 'running':
        if (fillMissing) plan.run.push(u.index)
        break
    }
  }
  // 台账里有、当前单元列表里没有的记录（原文变短 / 上限调小）同样算过期
  for (const [index, rec] of byIndex) if (!seen.has(index) && rec.status !== 'succeeded') plan.stale.push(index)
  const asc = (a: number, b: number) => a - b
  plan.run.sort(asc); plan.reuse.sort(asc); plan.stale.sort(asc)
  plan.failed.sort(asc); plan.cancelled.sort(asc); plan.interrupted.sort(asc)
  return plan
}

export interface TaskCounts {
  total: number
  succeeded: number
  failed: number
  cancelled: number
  interrupted: number
  running: number
  pending: number
}

/** 台账摘要（界面只读显示历史进度用；不据此推断"可续跑"） */
export function countUnits(units: TaskUnit[], total?: number): TaskCounts {
  const out: TaskCounts = { total: total ?? units.length, succeeded: 0, failed: 0, cancelled: 0, interrupted: 0, running: 0, pending: 0 }
  for (const u of units) {
    if (u.status === 'succeeded') out.succeeded++
    else if (u.status === 'failed') out.failed++
    else if (u.status === 'cancelled') out.cancelled++
    else if (u.status === 'interrupted') out.interrupted++
    else if (u.status === 'running') out.running++
    else out.pending++
  }
  return out
}

export interface TaskQuotaInput {
  /** 本项目现存任务头（调用方按 projectId 取） */
  heads: Pick<TaskHead, 'id' | 'status'>[]
  /** 本项目所有任务已占用的结果字节（含索引） */
  projectBytes: number
  /** 当前任务已占用的字节（新建任务时为 0） */
  taskBytes: number
  /** 本次预计新增字节（通常取一条结果的序列化长度） */
  projectedBytes: number
  /** 是否在新建任务头（新建才检查任务条数上限） */
  creating: boolean
}

export interface TaskQuotaVerdict {
  ok: boolean
  code: '' | 'tasks' | 'task-bytes' | 'project-bytes'
  reason: string
}

/**
 * 容量判定。
 *
 * 🔴 超限时**暂停并如实说明**，不淘汰未完成任务 —— 淘汰等于静默删掉作者还没取回的产物。
 * 🔴 新建任务也要算条数：不然一项目里躺 30 个半截任务，界面和磁盘都会被拖垮。
 */
export function decideTaskQuota(q: TaskQuotaInput): TaskQuotaVerdict {
  const live = q.heads.filter(h => h.status !== 'done' || true) // 终态也要算：产物仍占空间，作者明确清理才释放
  if (q.creating && live.length >= TASK_LIMITS.maxTasksPerProject) {
    return {
      ok: false, code: 'tasks',
      reason: `本机该项目已有 ${live.length} 个拆书记录（上限 ${TASK_LIMITS.maxTasksPerProject} 个）。请先在面板里清理不再需要的旧记录。`,
    }
  }
  if (q.taskBytes + q.projectedBytes > TASK_LIMITS.maxBytesPerTask) {
    return {
      ok: false, code: 'task-bytes',
      reason: `本次结果会让这个任务超过 ${Math.round(TASK_LIMITS.maxBytesPerTask / (1024 * 1024))} MiB 的单元产物上限，已暂停：请清理旧任务或分批拆书。`,
    }
  }
  if (q.projectBytes + q.projectedBytes > TASK_LIMITS.maxBytesPerProject) {
    return {
      ok: false, code: 'project-bytes',
      reason: `本机该项目的拆书产物合计将超过 ${Math.round(TASK_LIMITS.maxBytesPerProject / (1024 * 1024))} MiB 上限（只统计未清理的任务），已暂停：请先清理旧记录。`,
    }
  }
  return { ok: true, code: '', reason: '' }
}