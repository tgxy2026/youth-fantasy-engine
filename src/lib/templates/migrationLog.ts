/**
 * 3.2.0 · WT1-4：模板迁移日志与迁移前备份（**纯存储层**，不做决策）
 *
 * 方案 §3.5「迁移暂存」逐字对齐：
 *   > `meta`：本机项目级迁移日志，保存目标配置和受影响值的恢复引用；
 *   > 不进入日常云同步，恢复未完成前禁止再迁移同一页签。
 *
 * 为什么单独一层、而不写进 `migrate.ts`：
 *   `migrate.ts`（执行）与 `migrationGuard.ts`（写入隔离）都要读"这个页签现在是不是
 *   正在迁移"，两边都去 import 执行层会凑出**运行期环**（执行层反过来要拿锁）。
 *   本文件只依赖 db 门面，谁都可以引，不构成环。
 *
 * 键布局（全部落在 `templateMigration32:` 前缀下，云同步 / 数据文件导出按前缀排除）：
 *   · 日志：`templateMigration32:log:<pid>:<tabId>`
 *   · 备份：`templateMigration32:backup:<pid>:<tabId>`
 *   · 待处理索引：`templateMigration32:index:<pid>`
 *
 * 🔴 为什么不启用"日志跟在 settingsKV 里随项目走"：
 *   迁移是**本机动作**，值也写在本机库里；日志跟到别的设备上只会在那台机器上
 *   复现一个它的数据并未经历的中间态，最坏情况是照着别人的日志回滚。
 */
import * as db from '@/lib/db'
import type { TemplateDef } from './definition'

export const MIGRATION_LOG_VERSION = 1
export const MIGRATION_KEY_PREFIX = 'templateMigration32:'

// ────────────────────────── 键 ──────────────────────────

export function migrationLogKeyOf(pid: string, tabId: string): string {
  return `${MIGRATION_KEY_PREFIX}log:${pid}:${tabId}`
}

export function migrationBackupKeyOf(pid: string, tabId: string): string {
  return `${MIGRATION_KEY_PREFIX}backup:${pid}:${tabId}`
}

export function migrationIndexKeyOf(pid: string): string {
  return `${MIGRATION_KEY_PREFIX}index:${pid}`
}

/** 本文件写的键是否都属于"本机专属"族（自检用，防将来改键漏改前缀） */
export function isMigrationKey(key: string): boolean {
  return key.startsWith(MIGRATION_KEY_PREFIX)
}

// ────────────────────────── 类型 ──────────────────────────

/**
 * 迁移状态。
 *
 * `done-partial` 必须与 `done` 分开：方案要求「转换失败保留原值并列出条目，
 * 未解决前不能报告完整迁移成功」。合成一个 `done` 就是在骗作者。
 */
export type MigrationState =
  | 'prepared'        // 备份已落库并校验，尚未开始写值
  | 'writing'         // 正在写值 / 写模板
  | 'done'            // 全部完成，无失败条目
  | 'done-partial'    // 结构已切，但有条目转换失败（值保留原样，已列清单）
  | 'rolled-back'     // 失败后已恢复（或作者手动恢复）
  | 'rollback-failed' // 失败且恢复不完整 ⇒ 必须人工处理，且禁止再迁移

/** 逐步写入的完成项（桌面/便携不能依赖跨文件事务，必须记录走到哪） */
export type MigrationStepId =
  | 'verify'      // 变更计划的配置/值基准核对
  | 'backup'      // 严格持久化备份 + 读回校验
  | 'values'      // 写值（类型转换 / 作者确认的映射）
  | 'template'    // 写目标模板定义
  | 'index'       // 目录索引读回校验
  | 'invalidate'  // 模板缓存失效

export interface MigrationStep {
  id: MigrationStepId
  at: number
  ok: boolean
  detail?: string
}

/** 值的定位：表单一条（`form`）或表格/卡片某一行（`row:<rowId>`） */
export type ValueTarget = string

export function targetOfForm(): ValueTarget {
  return 'form'
}

export function targetOfRow(rowId: string): ValueTarget {
  return `row:${rowId}`
}

export function isRowTarget(target: ValueTarget): boolean {
  return target.startsWith('row:')
}

export function rowIdOfTarget(target: ValueTarget): string {
  return isRowTarget(target) ? target.slice(4) : ''
}

/** 一条值转换/写入失败（原值保留，列清单交给作者） */
export interface MigrationFailure {
  target: ValueTarget
  fieldId: string
  /** 作者可见字段名（清单里比 `cf_xxx` 好认） */
  label?: string
  reason: string
  /** 原值（便于作者判断怎么处理） */
  value?: string
}

/**
 * 整字段「需人工处理」的汇总（不逐条列，避免上千条把日志撑爆）。
 *
 * 🔴 与 `failures` 分开的原因：
 *   · `failures` = 试过、失败了（转换值不合法），要逐条给出原值；
 *   · `manualFields` = **根本没敢动**（多选↔单选、引用端点、日期编码、未确认的同名映射），
 *     逐条列出来只是噪音，作者需要的是"哪个字段、多少条、为什么"。
 *   两者都算"未解决"，都会让结论落到 `done-partial`。
 */
export interface ManualFieldPending {
  fieldId: string
  label: string
  count: number
  reason: string
}

/** 迁移日志（不含值本身，值副本在 backup 里） */
export interface MigrationLog {
  formatVersion: typeof MIGRATION_LOG_VERSION
  pid: string
  tabId: string
  state: MigrationState
  startedAt: number
  updatedAt: number
  /** 变更计划所依据的旧模板标识（`<none>` = 首次采用） */
  fromTemplateId: string
  toTemplateId: string
  fromRevision: number | null
  toRevision: number
  steps: MigrationStep[]
  failures: MigrationFailure[]
  /** 整字段未自动处理（见 `ManualFieldPending`） */
  manualFields: ManualFieldPending[]
  /** 实际写回的值（含类型转换与作者确认的映射） */
  writtenValues: number
  /** 备份已读回校验（"严格持久化"的唯一证据） */
  backupVerified: boolean
  /** 给人看的一句话结论（界面直接展示） */
  note?: string
}

/** 值的原始副本条目 */
export interface ValueBackupEntry {
  target: ValueTarget
  fieldId: string
  value: string
}

/**
 * 迁移前备份：**只存会被改写的值**。
 *
 * 🔴 为什么不备份整页签：归档 / 保留字段的值原地不动，多备份一份反而会在恢复时
 *    把作者在迁移后新写的内容覆盖回旧值。只备份"这次真要动"的那几条，恢复才安全。
 */
export interface MigrationBackup {
  formatVersion: typeof MIGRATION_LOG_VERSION
  pid: string
  tabId: string
  at: number
  /** 旧模板定义（首次采用时为 null，恢复＝删除定义） */
  def: TemplateDef | null
  values: ValueBackupEntry[]
}

export interface MigrationIndexEntry {
  tabId: string
  state: MigrationState
  updatedAt: number
}

export interface MigrationIndex {
  formatVersion: typeof MIGRATION_LOG_VERSION
  entries: MigrationIndexEntry[]
}

// ────────────────────────── 状态判据 ──────────────────────────

/**
 * 是否**阻止再次迁移同一页签**（方案：恢复未完成前禁止）。
 *
 * `prepared` / `writing` = 上次执行没走到终点（崩溃 / 断电 / 强杀）；
 * `rollback-failed` = 回滚没做完，值可能半新半旧。
 * `done-partial` 不阻止再迁移 —— 结构本身已经切成功，作者可以继续调模板。
 */
export function isBlockingState(state: MigrationState): boolean {
  return state === 'prepared' || state === 'writing' || state === 'rollback-failed'
}

// ────────────────────────── 读 ──────────────────────────

function isLog(v: unknown): v is MigrationLog {
  if (!v || typeof v !== 'object') return false
  const l = v as Partial<MigrationLog>
  return l.formatVersion === MIGRATION_LOG_VERSION
    && typeof l.tabId === 'string'
    && typeof l.state === 'string'
    && Array.isArray(l.steps)
    && Array.isArray(l.failures)
}

export async function loadMigrationLog(pid: string, tabId: string): Promise<MigrationLog | null> {
  if (!pid || !tabId) return null
  const raw = await db.getMeta<unknown>(migrationLogKeyOf(pid, tabId), null)
  return isLog(raw) ? raw : null
}

export async function loadMigrationBackup(pid: string, tabId: string): Promise<MigrationBackup | null> {
  if (!pid || !tabId) return null
  const raw = await db.getMeta<unknown>(migrationBackupKeyOf(pid, tabId), null)
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Partial<MigrationBackup>
  if (b.formatVersion !== MIGRATION_LOG_VERSION || !Array.isArray(b.values)) return null
  return raw as MigrationBackup
}

export async function loadMigrationIndex(pid: string): Promise<MigrationIndex> {
  const raw = await db.getMeta<unknown>(migrationIndexKeyOf(pid), null)
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as MigrationIndex).entries)) {
    return { formatVersion: MIGRATION_LOG_VERSION, entries: [] }
  }
  return raw as MigrationIndex
}

// ────────────────────────── 写 ──────────────────────────

export async function saveMigrationLog(log: MigrationLog): Promise<void> {
  await db.setMeta(migrationLogKeyOf(log.pid, log.tabId), log)
  await updateMigrationIndex(log)
}

export async function saveMigrationBackup(backup: MigrationBackup): Promise<void> {
  await db.setMeta(migrationBackupKeyOf(backup.pid, backup.tabId), backup)
}

/**
 * 读回校验：备份必须**能原样读出来**才算"严格持久化"。
 *
 * 🔴 为什么不能只 `await setMeta` 就宣布备份成功：桌面/便携三种后端（IDB / JSON 文件 /
 *    内存）里，写入失败可能被吞在防抖或配额异常里。回读一次是唯一能拿到的证据；
 *    校验不通过就必须**在动值之前**停手 —— 那时数据还没脏，停手是零成本。
 */
export async function verifyMigrationBackup(backup: MigrationBackup): Promise<boolean> {
  const back = await loadMigrationBackup(backup.pid, backup.tabId)
  if (!back) return false
  return JSON.stringify(back) === JSON.stringify(backup)
}

async function updateMigrationIndex(log: MigrationLog): Promise<void> {
  const idx = await loadMigrationIndex(log.pid)
  const rest = idx.entries.filter(e => e.tabId !== log.tabId)
  rest.push({ tabId: log.tabId, state: log.state, updatedAt: log.updatedAt })
  await db.setMeta(migrationIndexKeyOf(log.pid), {
    formatVersion: MIGRATION_LOG_VERSION,
    entries: rest,
  } satisfies MigrationIndex)
}

async function removeFromMigrationIndex(pid: string, tabId: string): Promise<void> {
  const idx = await loadMigrationIndex(pid)
  await db.setMeta(migrationIndexKeyOf(pid), {
    formatVersion: MIGRATION_LOG_VERSION,
    entries: idx.entries.filter(e => e.tabId !== tabId),
  } satisfies MigrationIndex)
}

/**
 * 清掉一个页签的迁移痕迹（日志 + 备份 + 索引项）。
 *
 * 🔴 只允许在**确认无需恢复**时调用（`done` / `done-partial` / `rolled-back`）。
 *    阻断态下清痕迹等于把"还没恢复"的证据抹掉，下次运行就会在脏数据上再迁一次。
 */
export async function clearMigrationArtifacts(pid: string, tabId: string): Promise<void> {
  const log = await loadMigrationLog(pid, tabId)
  if (log && isBlockingState(log.state)) {
    throw new Error(`迁移尚未恢复（${log.state}），不能清除恢复痕迹：${tabId}`)
  }
  await db.setMeta(migrationLogKeyOf(pid, tabId), null)
  await db.setMeta(migrationBackupKeyOf(pid, tabId), null)
  await removeFromMigrationIndex(pid, tabId)
}

/** 当前是否有**阻断态**的迁移（执行入口的准入条件） */
export async function blockingMigrationOf(pid: string, tabId: string): Promise<MigrationLog | null> {
  const log = await loadMigrationLog(pid, tabId)
  return log && isBlockingState(log.state) ? log : null
}
