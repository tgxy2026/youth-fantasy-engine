/**
 * 3.2.0 · WT1-4：模板迁移**执行**（严格备份 → 逐步写入 → 恢复日志）
 *
 * 方案 §3.6 原文要点（逐条落在这里）：
 *   1. 「先验证变更计划的配置/值基准」——`verifyBaseline` 两个基准都核，任一不符就停手；
 *   2. 「完成严格持久化备份并建立日志，再写入」——备份必须**读回校验**通过才继续；
 *   3. 「桌面/便携不能依赖跨文件事务，逐步写入须记录完成项」——`steps` 逐段落账；
 *   4. 「默认归档，不删除旧值；转换失败保留原值并列出条目」——只写能证明安全的；
 *   5. 「未解决前不能报告完整迁移成功」——有条目未解决 ⇒ `done-partial`，不装成功。
 *
 * 🔴 与 `plan.ts` 的分工（不许合并）：
 *   计划层只**推演**（纯函数、可反复算、错了只影响显示）；
 *   本层**动手**，输入必须是作者已确认的计划，绝不在写值现场重新推一遍 ——
 *   否则"作者看到的"和"实际执行的"可能不是同一份计划。
 *
 * 🔴 为什么执行要串行：迁移会改「定义 + 索引 + 值」三处。两路迁移同时跑，
 *   后写者会用自己读到的旧索引覆盖前者的条目（同 `store.ts` 的教训）。
 */
import * as db from '@/lib/db'
import type { TableRow } from '@/lib/types'
import { MAX_TEXT_LEN } from '@/lib/atlas/values'
import { invalidateTemplateCache } from './cache'
import type { TemplateDef } from './definition'
import {
  planIsNoop, type TemplateChangePlan,
} from './plan'
import { beginTabMigrationLock } from './migrationGuard'
import {
  blockingMigrationOf, MIGRATION_LOG_VERSION,
  loadMigrationBackup, loadMigrationLog, saveMigrationBackup, saveMigrationLog,
  targetOfForm, targetOfRow, rowIdOfTarget, verifyMigrationBackup,
  type ManualFieldPending, type MigrationBackup, type MigrationFailure, type MigrationLog,
  type MigrationState, type MigrationStep, type MigrationStepId,
  type ValueBackupEntry, type ValueTarget,
} from './migrationLog'
import { deleteTemplateDef, loadTemplateDef, loadTemplateIndex, saveTemplateDef } from './store'
import type { TemplateFieldType } from './types'

// ────────────────────────── 值存储 ──────────────────────────

/**
 * 一个页签的两种值存放位置。
 *
 * 🔴 两者都要看：图鉴 / 表格 / 卡片页签的值在 `tableRows`，普通表单页签在 `formData`。
 *    只挑一种就能"迁移成功"，然后在另一处留下没转换的旧值 —— 那种半迁移最难发现。
 */
interface ValueStore {
  form: Record<string, string>
  rows: TableRow[]
}

async function readValueStore(pid: string, tabId: string): Promise<ValueStore> {
  const [form, rows] = await Promise.all([
    db.getFormDataFor(pid, tabId),
    db.getTableRowsFor(pid, tabId),
  ])
  return { form, rows }
}

/** 列出某字段有值的位置（表单一条 + 每行一条） */
function targetsWithValue(store: ValueStore, fieldId: string): ValueTarget[] {
  const out: ValueTarget[] = []
  const fv = store.form[fieldId]
  if (typeof fv === 'string' && fv.trim() !== '') out.push(targetOfForm())
  for (const r of store.rows) {
    const v = r.data?.[fieldId]
    if (typeof v === 'string' && v.trim() !== '') out.push(targetOfRow(r.id))
  }
  return out
}

function readAt(store: ValueStore, target: ValueTarget, fieldId: string): string {
  if (target === 'form') return store.form[fieldId] ?? ''
  const id = rowIdOfTarget(target)
  const row = store.rows.find(r => r.id === id)
  return row?.data?.[fieldId] ?? ''
}

function countValues(store: ValueStore, fieldId: string): number {
  return targetsWithValue(store, fieldId).length
}

/**
 * 统计若干字段当前的**值条目数**（供升级预览等"先看规模再动手"的场景）。
 *
 * 🔴 口径必须与执行层内部一致：表单一条 + 每行一条，空串不算值。
 *    这个函数是那个口径的**唯一出口**，界面/预览不许自己数一遍 ——
 *    两处口径分叉，就会出现"预览说影响 3 条、实际改了 5 条"。
 */
export async function countValuesForFields(
  pid: string,
  tabId: string,
  fieldIds: readonly string[],
): Promise<Record<string, number>> {
  if (!pid || !tabId || fieldIds.length === 0) return {}
  const store = await readValueStore(pid, tabId)
  const out: Record<string, number> = {}
  for (const id of fieldIds) out[id] = countValues(store, id)
  return out
}

/** 待写入的一条值（先算后写：备份必须覆盖"将要动"的全部槽位） */
interface PlannedWrite {
  target: ValueTarget
  fieldId: string
  value: string
}

/**
 * 记下一条待写入（**只在内存里排队，绝不改 `store`**）。
 *
 * 🔴 为什么不能边算边改 `store`：备份必须在"值还没被动过"的那一刻取原值。
 *    一旦这里顺手改了内存副本，`backupValuesOf` 取到的就是新值 ⇒ 备份形同虚设，
 *    回滚会把"新值"写回去，作者以为恢复了、其实没恢复。
 */
function scheduleWrite(
  writes: PlannedWrite[],
  target: ValueTarget,
  fieldId: string,
  value: string,
): void {
  writes.push({ target, fieldId, value })
}

/**
 * 统一落库：先按「目标槽位」去重（同一槽位多次写取最后一次），
 * 再改内存副本、按需逐行 / 整份表单写盘。
 */
async function flushWrites(
  pid: string,
  tabId: string,
  store: ValueStore,
  writes: readonly PlannedWrite[],
): Promise<void> {
  if (writes.length === 0) return
  const dedup = new Map<string, PlannedWrite>()
  for (const w of writes) dedup.set(`${w.target}␁${w.fieldId}`, w)
  const list = [...dedup.values()]
  const touchedRows = new Set<string>()
  let formDirty = false

  for (const w of list) {
    if (w.target === 'form') {
      store.form[w.fieldId] = w.value
      formDirty = true
      continue
    }
    const id = rowIdOfTarget(w.target)
    const row = store.rows.find(r => r.id === id)
    if (!row) continue
    row.data = { ...row.data, [w.fieldId]: w.value }
    touchedRows.add(id)
  }

  if (formDirty) await db.saveFormDataFor(pid, tabId, store.form)
  for (const row of store.rows) {
    if (!touchedRows.has(row.id)) continue
    await db.saveTableRow(row)
  }
}

// ────────────────────────── 类型转换 ──────────────────────────

export type ConvertResult = { ok: true; value: string } | { ok: false; reason: string }

/** 布尔存储串的合法写法（与 `coerceAiValue` 同一口径，免得两处认的不一样） */
const TRUE_WORDS = new Set(['true', '是', '1', '真', 'yes'])
const FALSE_WORDS = new Set(['false', '否', '0', '假', 'no'])

/**
 * 逐值类型转换。
 *
 * 🔴 判据与 `plan.valuePlanForTypeChange` **必须一致**：计划说 "convert" 的类型组合，
 *    这里才尝试；其余组合一律返回失败（转人工），不发明计划没承诺过的转换。
 * 🔴 失败不返回空串：调用方保留原值并记一条失败 ——"转换失败变空白"等于静默删数据。
 */
export function convertValueForMigration(
  from: TemplateFieldType,
  to: TemplateFieldType,
  raw: string,
  opts: { options?: readonly string[] } = {},
): ConvertResult {
  const v = raw ?? ''
  if (v.trim() === '') return { ok: true, value: '' }
  if (from === to) return { ok: true, value: v }

  if (from === 'text' && to === 'textarea') return { ok: true, value: v }
  if (from === 'number' && to === 'text') return { ok: true, value: v }
  if (from === 'select' && to === 'text') return { ok: true, value: v }
  if (from === 'boolean' && to === 'text') return { ok: true, value: v }

  if (from === 'textarea' && to === 'text') {
    const t = v.trim()
    if (t.length > MAX_TEXT_LEN) {
      return { ok: false, reason: `长文本 ${t.length} 字，超出短文本上限 ${MAX_TEXT_LEN} 字` }
    }
    return { ok: true, value: t }
  }

  if (from === 'text' && to === 'number') {
    const t = v.trim().replace(/\s+/g, '')
    if (!/^-?\d+(\.\d+)?$/.test(t) || !Number.isFinite(Number(t))) {
      return { ok: false, reason: `不是可解析的数字：${v.trim().slice(0, 40)}` }
    }
    return { ok: true, value: t }
  }

  if (from === 'text' && to === 'select') {
    const options = opts.options ?? []
    const t = v.trim()
    if (!options.includes(t)) return { ok: false, reason: `不在新选项内：${t.slice(0, 40)}` }
    return { ok: true, value: t }
  }

  if (from === 'text' && to === 'boolean') {
    const t = v.trim().toLowerCase()
    if (TRUE_WORDS.has(t)) return { ok: true, value: 'true' }
    if (FALSE_WORDS.has(t)) return { ok: true, value: 'false' }
    return { ok: false, reason: `不是「是 / 否」：${v.trim().slice(0, 20)}` }
  }

  return { ok: false, reason: '该类型组合不在自动转换范围内，需人工处理' }
}

// ────────────────────────── 准入：基准核对 ──────────────────────────

export type MigrationFailCode =
  | 'bad-request'
  | 'plan-blocked'
  | 'plan-baseline-mismatch'
  | 'pending-migration'
  | 'baseline-config-changed'
  | 'baseline-values-changed'
  | 'invalid-approved-map'
  | 'backup-failed'
  | 'write-failed'
  | 'template-rejected'
  | 'index-stale'
  | 'rollback-failed'

export type MigrationResult =
  | { ok: true; state: 'noop' }
  | { ok: true; state: 'done' | 'done-partial'; log: MigrationLog }
  | {
    ok: false
    code: MigrationFailCode
    detail: string
    log: MigrationLog | null
    /** 失败后是否已恢复到迁移前（`false` 且 `log.state === 'rollback-failed'` ⇒ 需人工） */
    recovered: boolean
  }

export interface MigrationRequest {
  pid: string
  tabId: string
  /** 作者已确认的只读计划（`plan.ts` 产出） */
  plan: TemplateChangePlan
  /** 目标模板（要写入的定义） */
  to: TemplateDef
  /**
   * 计划所依据的旧定义（`null` = 首次采用模板）。
   * 🔴 必须原样传入：执行时拿它跟库里现状比对，才认得出"计划算完之后有人改过模板"。
   */
  expectedFrom: TemplateDef | null
  /**
   * 作者**显式确认**的同名映射：旧字段 id → 新字段 id。
   * 🔴 只接受计划里 `suggestedTargetId` 与之相符的项：显示名相同只是建议，
   *    执行层不许自己"看着像"就搬值。
   */
  approvedMaps?: Record<string, string>
}

function sameDefIdentity(a: TemplateDef | null, b: TemplateDef | null): boolean {
  if (a === null || b === null) return a === b
  return a.templateId === b.templateId
    && a.revision === b.revision
    && a.semanticDigest === b.semanticDigest
    && a.tabId === b.tabId
}

/**
 * 配置基准：库里现状是否仍是"计划算的时候那份定义"。
 *
 * 🔴 为什么必须核：计划是异步算出来的，作者可能在另一个窗口又改了一版模板；
 *    拿着旧计划去改新定义，等于把作者刚做的改动悄悄抹掉。
 */
function checkConfigBaseline(
  current: TemplateDef | null,
  expected: TemplateDef | null,
  plan: TemplateChangePlan,
): { ok: true } | { ok: false; code: MigrationFailCode; detail: string } {
  const planFromId = expected?.templateId ?? '<none>'
  if (plan.fromTemplateId !== planFromId) {
    return {
      ok: false,
      code: 'plan-baseline-mismatch',
      detail: `变更计划的起点（${plan.fromTemplateId}）与传入的旧定义（${planFromId}）不一致，请重新生成变更计划`,
    }
  }
  if (!sameDefIdentity(current, expected)) {
    return {
      ok: false,
      code: 'baseline-config-changed',
      detail: current
        ? `模板在执行前已被改动（现为 ${current.templateId} 第 ${current.revision} 版），请重新生成变更计划`
        : '模板在执行前已被改动（当前已无自定义模板），请重新生成变更计划',
    }
  }
  return { ok: true }
}

/**
 * 值基准：受影响字段的**值规模**是否仍与计划一致。
 *
 * 🔴 只在计划带了 `valueCounts` 时校验（`valueScaleKnown`）：没有规模数据就没得比，
 *    硬核只会把所有迁移都拒掉。规模变了 ⇒ 说明计划算完之后有人写过数据，
 *    转换清单已经不完整，必须重新推演。
 */
function checkValueBaseline(
  plan: TemplateChangePlan,
  store: ValueStore,
): { ok: true } | { ok: false; detail: string } {
  if (!plan.valueScaleKnown) return { ok: true }
  const fieldIds = new Set<string>()
  for (const it of plan.items) if (it.fromId) fieldIds.add(it.fromId)
  let total = 0
  for (const id of fieldIds) total += countValues(store, id)
  if (total !== plan.affectedValueCount) {
    return {
      ok: false,
      detail: `受影响的值在执行前已变化（计划时 ${plan.affectedValueCount} 条，现在 ${total} 条），请重新生成变更计划`,
    }
  }
  return { ok: true }
}

/** 收集并校验作者确认的映射（不合法项直接拒，不"尽量照做"） */
function collectApprovedMaps(
  plan: TemplateChangePlan,
  approved: Record<string, string> | undefined,
): { ok: true; maps: Map<string, string> } | { ok: false; detail: string } {
  const maps = new Map<string, string>()
  if (!approved) return { ok: true, maps }
  for (const [fromId, toId] of Object.entries(approved)) {
    const item = plan.items.find(i => i.fromId === fromId && i.disposition === 'suggested-map')
    if (!item) {
      return { ok: false, detail: `映射来源 ${fromId} 不在计划的同名建议里，不能据此搬值` }
    }
    if (item.suggestedTargetId !== toId) {
      return {
        ok: false,
        detail: `字段 ${fromId} 的建议目标是 ${item.suggestedTargetId ?? '（无）'}，与确认的 ${toId} 不一致`,
      }
    }
    maps.set(fromId, toId)
  }
  return { ok: true, maps }
}

// ────────────────────────── 写入计划 ──────────────────────────

interface ValueWriteOutcome {
  writes: PlannedWrite[]
  failures: MigrationFailure[]
  manual: ManualFieldPending[]
}

/**
 * 把计划翻译成具体的值写入（**只算不写**）。
 *
 * 🔴 三种处置必须分开：
 *   · `convert`：逐值转换，失败保留原值并记条目；
 *   · 已确认映射：复制到新字段键（**旧键值保留**，不删 —— 删除不属于迁移的默认动作）；
 *   · `manual` 且未确认映射：一条都不动，按字段汇总成人工作业项。
 */
function planValueWrites(
  store: ValueStore,
  plan: TemplateChangePlan,
  to: TemplateDef,
  approved: Map<string, string>,
): ValueWriteOutcome {
  const writes: PlannedWrite[] = []
  const failures: MigrationFailure[] = []
  const manual: ManualFieldPending[] = []
  const toById = new Map(to.fields.map(f => [f.id, f]))

  for (const item of plan.items) {
    if (!item.fromId) continue
    const targets = targetsWithValue(store, item.fromId)

    // 已确认映射：值复制到新字段（旧字段在新模板里可能已不存在，旧键值保留不删）
    const mappedTo = approved.get(item.fromId)
    if (mappedTo) {
      for (const t of targets) {
        scheduleWrite(writes, t, mappedTo, readAt(store, t, item.fromId))
      }
      continue
    }

    if (item.valuePlan === 'manual') {
      if (targets.length > 0) {
        manual.push({
          fieldId: item.fromId,
          label: toById.get(item.fromId)?.label ?? item.fromId,
          count: targets.length,
          reason: item.note ?? '该字段的定义变化无法自动映射，需作者逐条处理',
        })
      }
      continue
    }

    if (item.valuePlan !== 'convert' || !item.toId) continue
    const typeChange = item.changes.find(c => c.aspect === 'type')
    // 🔴 没有 type 变化却标了 convert = 计划与目标模板对不上；宁可不写，也不猜类型
    if (!typeChange) continue
    const toField = toById.get(item.toId)
    if (!toField) {
      manual.push({
        fieldId: item.fromId, label: item.fromId,
        count: targets.length, reason: '目标字段在新模板中不存在，无法写入',
      })
      continue
    }
    const fromType = typeChange.from as TemplateFieldType
    for (const t of targets) {
      const raw = readAt(store, t, item.fromId)
      const r = convertValueForMigration(fromType, toField.type, raw, { options: toField.options ?? [] })
      if (r.ok) {
        scheduleWrite(writes, t, item.fromId, r.value)
      } else {
        failures.push({
          target: t,
          fieldId: item.fromId,
          label: toField.label,
          reason: r.reason,
          value: raw,
        })
      }
    }
  }
  return { writes, failures, manual }
}

function backupValuesOf(store: ValueStore, writes: readonly PlannedWrite[]): ValueBackupEntry[] {
  const seen = new Set<string>()
  const out: ValueBackupEntry[] = []
  for (const w of writes) {
    const k = `${w.target}␁${w.fieldId}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ target: w.target, fieldId: w.fieldId, value: readAt(store, w.target, w.fieldId) })
  }
  return out
}

/** 把备份里的原值写回去（恢复的唯一动作；幂等） */
async function restoreValues(
  pid: string,
  tabId: string,
  entries: readonly ValueBackupEntry[],
): Promise<number> {
  if (entries.length === 0) return 0
  const store = await readValueStore(pid, tabId)
  let n = 0
  for (const e of entries) {
    if (e.target === 'form') {
      if (store.form[e.fieldId] === e.value) continue
      store.form[e.fieldId] = e.value
    } else {
      const row = store.rows.find(r => r.id === rowIdOfTarget(e.target))
      if (!row) continue // 行已被作者删掉 ⇒ 不复活它，只记"跳过"
      if (row.data?.[e.fieldId] === e.value) continue
      row.data = { ...row.data, [e.fieldId]: e.value }
    }
    n += 1
    // 逐条落库：中途失败时，已恢复的部分必须已经持久化（否则回滚也只是"看起来恢复了"）
    if (e.target === 'form') await db.saveFormDataFor(pid, tabId, store.form)
    else {
      const row = store.rows.find(r => r.id === rowIdOfTarget(e.target))
      if (row) await db.saveTableRow(row)
    }
  }
  return n
}

// ────────────────────────── 执行 ──────────────────────────

let chain: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job)
  chain = run.then(() => undefined, () => undefined)
  return run
}

function step(id: MigrationStepId, ok: boolean, detail?: string): MigrationStep {
  return { id, at: Date.now(), ok, ...(detail ? { detail } : {}) }
}

/**
 * 执行一次模板迁移。
 *
 * 顺序（失败即停，已写的值按备份恢复）：
 *   准入 → 配置基准 → 值基准 → 占锁 → 备份+读回 → 写值 → 写模板 → 索引校验 → 缓存失效 → 结论
 */
export function applyTemplateMigration(req: MigrationRequest): Promise<MigrationResult> {
  return enqueue(() => runMigration(req))
}

async function runMigration(req: MigrationRequest): Promise<MigrationResult> {
  const { pid, tabId, plan, to } = req

  if (!pid || !tabId) return fail('bad-request', '缺少项目或页签标识，迁移未执行', null)
  if (plan.tabId !== tabId || to.tabId !== tabId) {
    return fail('bad-request', `变更计划 / 目标模板的页签（${plan.tabId} / ${to.tabId}）与请求的 ${tabId} 不一致`, null)
  }
  if (plan.blockers.length > 0) {
    return fail('plan-blocked', `变更计划存在 ${plan.blockers.length} 项阻断：${plan.blockers.map(b => b.detail).join('；')}`, null)
  }

  const pending = await blockingMigrationOf(pid, tabId)
  if (pending) {
    return fail(
      'pending-migration',
      `该页签上次迁移未收尾（${pending.state}），必须先完成恢复再迁移：${pending.note ?? '见迁移日志'}`,
      pending,
    )
  }

  // 幂等：同一份目标重复执行必须识别为 no-op（方案 §3.6 第 208 行）
  if (planIsNoop(plan)) return { ok: true, state: 'noop' }

  const current = await loadTemplateDef(pid, tabId)
  const cfg = checkConfigBaseline(current, req.expectedFrom, plan)
  if (!cfg.ok) return fail(cfg.code, cfg.detail, null)

  const store = await readValueStore(pid, tabId)
  const val = checkValueBaseline(plan, store)
  if (!val.ok) return fail('baseline-values-changed', val.detail, null)

  const approvedRes = collectApprovedMaps(plan, req.approvedMaps)
  if (!approvedRes.ok) return fail('invalid-approved-map', approvedRes.detail, null)

  const release = beginTabMigrationLock(pid, tabId)
  const log: MigrationLog = {
    formatVersion: MIGRATION_LOG_VERSION,
    pid,
    tabId,
    state: 'prepared',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    fromTemplateId: plan.fromTemplateId,
    toTemplateId: to.templateId,
    fromRevision: req.expectedFrom?.revision ?? null,
    toRevision: to.revision,
    steps: [step('verify', true, '配置基准与值基准一致')],
    failures: [],
    manualFields: [],
    backupVerified: false,
    writtenValues: 0,
  }

  let backup: MigrationBackup | null = null
  try {
    // ── 备份（只备份"将要动"的槽位）──
    const outcome = planValueWrites(store, plan, to, approvedRes.maps)
    backup = {
      formatVersion: MIGRATION_LOG_VERSION,
      pid,
      tabId,
      at: Date.now(),
      def: req.expectedFrom,
      values: backupValuesOf(store, outcome.writes),
    }
    await saveMigrationBackup(backup)
    log.backupVerified = await verifyMigrationBackup(backup)
    if (!log.backupVerified) {
      log.state = 'rolled-back'
      log.note = '备份读回校验失败，未写入任何值'
      log.steps.push(step('backup', false, '备份读回不一致'))
      await saveMigrationLog(log)
      return fail('backup-failed', '迁移前备份读回校验失败，为保证安全已停手（数据未改动）', log, true)
    }
    log.steps.push(step('backup', true, `${backup.values.length} 个槽位已备份并读回校验`))
    log.state = 'writing'
    await saveMigrationLog(log)

    // ── 写值 ──
    await flushWrites(pid, tabId, store, outcome.writes)
    log.failures = outcome.failures
    log.manualFields = outcome.manual
    log.writtenValues = outcome.writes.length
    log.steps.push(step('values', true, `${outcome.writes.length} 条写入 / ${outcome.failures.length} 条转换失败 / ${outcome.manual.length} 个字段待人工`))
    log.updatedAt = Date.now()
    await saveMigrationLog(log)

    // ── 写模板定义 ──
    const saved = await saveTemplateDef(pid, to)
    if (!saved.ok) {
      const detail = saved.violations.map(v => v.detail).join('；')
      throw new MigrationAbort('template-rejected', `目标模板未通过校验：${detail}`)
    }
    log.steps.push(step('template', true, `已切换到 ${to.templateId}`))

    // ── 索引读回校验（同一份 store 写两处，必须核）──
    const idx = await loadTemplateIndex(pid)
    const hit = idx.entries.find(e => e.tabId === tabId)
    if (!hit || hit.templateId !== to.templateId || hit.revision !== to.revision) {
      throw new MigrationAbort('index-stale', '模板目录索引与定义不一致（索引没跟上），请重试或从项目备份恢复')
    }
    log.steps.push(step('index', true, '目录索引一致'))

    invalidateTemplateCache(tabId)
    log.steps.push(step('invalidate', true, '模板缓存已失效'))

    // ── 结论 ──
    const unresolved = log.failures.length + log.manualFields.length
    log.state = unresolved > 0 ? 'done-partial' : 'done'
    log.note = unresolved > 0
      ? `结构已切换；${log.failures.length} 条值转换失败、${log.manualFields.length} 个字段待人工处理（原值均未删除）`
      : '迁移完成，全部值已按新结构处理'
    log.updatedAt = Date.now()
    await saveMigrationLog(log)
    return { ok: true, state: log.state as 'done' | 'done-partial', log }
  } catch (e) {
    return rollbackAfterFailure(pid, tabId, log, backup, req.expectedFrom, e)
  } finally {
    release()
  }
}

class MigrationAbort extends Error {
  constructor(readonly code: MigrationFailCode, message: string) {
    super(message)
  }
}

/**
 * 失败收尾：按备份恢复 → 记日志。
 *
 * 🔴 恢复失败的后果必须**显式留痕**（`rollback-failed`），不能只把错误抛给调用方：
 *    那个状态是"禁止再迁移"的唯一依据，丢了就等于允许在脏数据上再迁一次。
 */
async function rollbackAfterFailure(
  pid: string,
  tabId: string,
  log: MigrationLog,
  backup: MigrationBackup | null,
  expectedFrom: TemplateDef | null,
  err: unknown,
): Promise<MigrationResult> {
  const code: MigrationFailCode = err instanceof MigrationAbort ? err.code : 'write-failed'
  const detail = err instanceof Error ? err.message : String(err)
  let restored = false
  const problems: string[] = []
  try {
    if (!backup) {
      problems.push('没有可用的备份')
    } else {
      await restoreValues(pid, tabId, backup.values)
      if (expectedFrom) {
        const r = await saveTemplateDef(pid, expectedFrom)
        if (!r.ok) problems.push(`旧模板回写被拒：${r.violations.map(v => v.detail).join('；')}`)
      } else {
        await deleteTemplateDef(pid, tabId)
      }
      invalidateTemplateCache(tabId)
      // 恢复也要核：定义回不去就等于没恢复
      const now = await loadTemplateDef(pid, tabId)
      if (!sameDefIdentity(now, expectedFrom)) problems.push('旧模板回写后读回不一致')
      restored = problems.length === 0
    }
  } catch (e) {
    problems.push(`恢复过程异常：${e instanceof Error ? e.message : String(e)}`)
  }

  log.state = restored ? 'rolled-back' : 'rollback-failed'
  log.note = restored
    ? `迁移已中止并恢复到迁移前：${detail}`
    : `迁移已中止，但恢复不完整（${problems.join('；')}）：${detail}`
  log.steps.push(step('values', false, detail))
  log.updatedAt = Date.now()
  await saveMigrationLog(log).catch(() => { /* 日志都写不进去时，调用方仍拿到失败结果 */ })
  return { ok: false, code: restored ? code : 'rollback-failed', detail: log.note, log, recovered: restored }
}

function fail(
  code: MigrationFailCode,
  detail: string,
  log: MigrationLog | null,
  recovered = false,
): MigrationResult {
  return { ok: false, code, detail, log, recovered }
}

// ────────────────────────── 恢复 ──────────────────────────

export type RecoveryResult =
  | { ok: true; state: 'recovered'; restoredValues: number }
  | { ok: true; state: 'nothing-to-do'; log: MigrationLog }
  | { ok: false; code: 'no-log' | 'no-backup' | 'restore-incomplete'; detail: string }

/**
 * 手工/启动时恢复一个页签到迁移前。
 *
 * 🔴 幂等：已 `done` / `done-partial` 的迁移**不允许**用本函数回退 ——
 *    结构已经切过去，作者可能已经在写新字段了；那种情况该走"再迁移一次"，
 *    而不是把值按旧槽位硬搬回去（会覆盖新内容）。故这里只处理阻断态。
 */
export async function recoverTemplateMigration(pid: string, tabId: string): Promise<RecoveryResult> {
  const log = await loadMigrationLog(pid, tabId)
  if (!log) return { ok: false, code: 'no-log', detail: '没有该页签的迁移日志' }
  if (!isBlockingRecovery(log.state)) {
    return { ok: true, state: 'nothing-to-do', log }
  }
  const backup = await loadMigrationBackup(pid, tabId)
  if (!backup) {
    log.state = 'rollback-failed'
    log.note = '迁移日志存在但没有备份，无法自动恢复；请从项目正式备份恢复该页签'
    log.updatedAt = Date.now()
    await saveMigrationLog(log)
    return { ok: false, code: 'no-backup', detail: log.note }
  }

  const problems: string[] = []
  let restoredValues = 0
  try {
    restoredValues = await restoreValues(pid, tabId, backup.values)
    if (backup.def) {
      const r = await saveTemplateDef(pid, backup.def)
      if (!r.ok) problems.push(`旧模板回写被拒：${r.violations.map(v => v.detail).join('；')}`)
    } else {
      await deleteTemplateDef(pid, tabId)
    }
    invalidateTemplateCache(tabId)
    const now = await loadTemplateDef(pid, tabId)
    if (!sameDefIdentity(now, backup.def)) problems.push('旧模板回写后读回不一致')
  } catch (e) {
    problems.push(`恢复过程异常：${e instanceof Error ? e.message : String(e)}`)
  }

  if (problems.length > 0) {
    log.state = 'rollback-failed'
    log.note = `恢复未完成：${problems.join('；')}`
    log.updatedAt = Date.now()
    await saveMigrationLog(log)
    return { ok: false, code: 'restore-incomplete', detail: log.note }
  }

  log.state = 'rolled-back'
  log.note = '已恢复到迁移前（作者手动恢复）'
  log.updatedAt = Date.now()
  await saveMigrationLog(log)
  return { ok: true, state: 'recovered', restoredValues }
}

function isBlockingRecovery(state: MigrationState): boolean {
  return state === 'prepared' || state === 'writing' || state === 'rollback-failed'
}
