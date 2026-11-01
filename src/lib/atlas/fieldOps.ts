/**
 * 3.3.3 · B6：图鉴自定义字段的**类型转换**与**永久删除**（方案 §5.2 / 规划 §11）。
 *
 * 【为什么转换不直接改 JS 类型】`TableRow.data` 的值**一律是字符串**（看图鉴 schema 的值约定）。
 *    "转成数字"只是「这一列以后按数字校验与展示」，底层仍是字符串 —— 直接把全表字符串改成
 *    JS number 会破坏既有序列化约定，并让导出/同步两端出现不可逆的类型漂移。
 *
 * 【逐值可逆，不隐式改值】
 *   · 文本 ↔ 长文本：按长度上限逐值检查，超限**整批阻止**（不截断）；
 *   · 数字 ↔ 文本：`001`、`1e3`、`-0`、`1.50`、超安全整数、非数字一律阻止，**不归零、不四舍五入**；
 *   · 空字符串/空值：保持为空（不当作 0）。
 *
 * 【永久删除】先给影响数与依赖；有依赖（如被用作卡片摘要）就阻止，让作者先去解除依赖。
 *    执行前必须建备份；删定义与删值分两步，删值失败时定义已不在、值成为不可见的孤儿（可接受，
 *    且备份可恢复），不会出现"类型与值不兼容"的半状态。
 *
 * 【转换的原子性】因为值不改，类型转换只有**一次 schema 写入** —— 天然不会留下半状态。
 */
import type { AtlasFieldDefinition, AtlasSchemaConfig, CustomFieldType } from '@/lib/atlas/types'
import { getTableRowsFor, saveTableRow } from '@/lib/db/tabs'
import { createAutoBackup } from '@/lib/db/backups'
import { emptyAtlasSchema } from '@/lib/atlas/schema'

/** 短文本上限（超过这个长度就只能留在长文本里；不截断） */
export const TEXT_MAX_CHARS = 2000

export interface FieldRowLike {
  id: string
  data: Record<string, string>
}

export interface ValueIssue {
  rowId: string
  value: string
  reason: string
}

export interface ConversionPlan {
  ok: boolean
  target: CustomFieldType
  /** 有值的行数 */
  affected: number
  /** 可转换的行数 */
  convertible: number
  /** 不可转换（整批阻止；不部分写入） */
  blocked: ValueIssue[]
  reason: string
}

export interface DeletionPlan {
  ok: boolean
  affected: number
  /** 依赖说明（如「卡片摘要」）；非空即阻止 */
  dependencies: string[]
  reason: string
}

const SUPPORTED_TARGETS: CustomFieldType[] = ['text', 'longText', 'number']

/** 比较预览时的字段数据；行顺序变化不视为数据变化。 */
export function sameFieldRows(a: readonly FieldRowLike[], b: readonly FieldRowLike[]): boolean {
  const fingerprint = (rows: readonly FieldRowLike[]) => JSON.stringify(
    rows.map(row => [row.id, Object.entries(row.data ?? {}).sort(([x], [y]) => x.localeCompare(y))])
      .sort(([x], [y]) => String(x).localeCompare(String(y))),
  )
  return fingerprint(a) === fingerprint(b)
}

/** 数字字符串是否**精确可逆**（String(Number(s)) === s） */
export function canonicalNumber(value: string): { ok: boolean; reason?: string } {
  const s = String(value ?? '').trim()
  if (!s) return { ok: true }
  if (/^-?0\d/.test(s)) return { ok: false, reason: '有前导零（如 "001"），转成数字会丢零' }
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    return { ok: false, reason: /e/i.test(s) ? '科学计数法不能精确还原成原文本' : '不是纯数字' }
  }
  const n = Number(s)
  if (!Number.isFinite(n)) return { ok: false, reason: '超出数字可表示范围' }
  if (Number.isInteger(n) && !Number.isSafeInteger(n)) return { ok: false, reason: '超出安全整数范围（可能丢精度）' }
  if (String(n) !== s) return { ok: false, reason: `转成数字再转回文本会变成「${String(n)}」，与原值不一致` }
  return { ok: true }
}

function checkValue(value: string, target: CustomFieldType): { ok: boolean; reason?: string } {
  if (target === 'text' && value.length > TEXT_MAX_CHARS) {
    return { ok: false, reason: `超过短文本上限 ${TEXT_MAX_CHARS} 字（会截断，已阻止）` }
  }
  if (target === 'number') return canonicalNumber(value)
  return { ok: true }
}

/** 预览一次类型转换（纯函数）：值不改，只判断能不能整批通过 */
export function planFieldConversion(
  field: Pick<AtlasFieldDefinition, 'id' | 'label' | 'type'>,
  rows: readonly FieldRowLike[],
  target: CustomFieldType,
): ConversionPlan {
  if (!SUPPORTED_TARGETS.includes(target)) {
    return { ok: false, target, affected: 0, convertible: 0, blocked: [], reason: '这一版只支持 文本 / 长文本 / 数字 之间互转' }
  }
  if (field.type === target) {
    return { ok: true, target, affected: 0, convertible: 0, blocked: [], reason: '类型本来就相同' }
  }
  let affected = 0
  let convertible = 0
  const blocked: ValueIssue[] = []
  for (const row of rows) {
    const raw = String(row.data?.[field.id] ?? '')
    if (!raw.trim()) continue
    affected++
    const r = checkValue(raw, target)
    if (r.ok) convertible++
    else blocked.push({ rowId: row.id, value: raw.slice(0, 80), reason: r.reason ?? '不可转换' })
  }
  return {
    ok: blocked.length === 0,
    target,
    affected,
    convertible,
    blocked,
    reason: blocked.length
      ? `有 ${blocked.length} 条值不能安全转换，整批已阻止（可先手工改这几条，或另建字段搬运）`
      : '',
  }
}

/** 预览永久删除：影响数 + 依赖（有依赖即阻止） */
export function planFieldDeletion(
  field: Pick<AtlasFieldDefinition, 'id' | 'label'>,
  rows: readonly FieldRowLike[],
  config?: Pick<AtlasSchemaConfig, 'summaryKeys'> | null,
): DeletionPlan {
  const affected = rows.filter(r => String(r.data?.[field.id] ?? '').trim().length > 0).length
  const dependencies: string[] = []
  if (config?.summaryKeys?.includes(field.id)) dependencies.push('卡片摘要字段')
  return {
    ok: dependencies.length === 0,
    affected,
    dependencies,
    reason: dependencies.length
      ? `这个字段正被用作${dependencies.join('、')}；请先在字段设置里取消它，再永久删除`
      : '',
  }
}

export async function loadAtlasFieldRows(projectId: string, tabId: string): Promise<FieldRowLike[]> {
  const rows = await getTableRowsFor(projectId, tabId as Parameters<typeof getTableRowsFor>[1])
  return rows.map(r => ({ id: r.id, data: { ...(r.data ?? {}) } }))
}

/** 删除前备份；建不成备份就**不要**继续（返回 null，调用方中止） */
export async function backupBeforeAtlasFieldChange(projectId: string, label: string) {
  return createAutoBackup(projectId, 'manual', label)
}

/**
 * 永久删除字段后清理各行的值（在 schema 已删掉该字段之后调用）。
 * 返回清理了几行。这里**只删这一个键**，不碰其它字段。
 */
export async function purgeFieldValues(projectId: string, tabId: string, fieldId: string): Promise<number> {
  const rows = await getTableRowsFor(projectId, tabId as Parameters<typeof getTableRowsFor>[1])
  let n = 0
  for (const row of rows) {
    if (!row.data || !(fieldId in row.data)) continue
    const data = { ...row.data }
    delete data[fieldId]
    await saveTableRow({ ...row, data })
    n++
  }
  return n
}

/** 一份"删除后的空配置"：给测试与需要构造默认配置的调用方复用 */
export function atlasFieldOpsEmptyConfig(): AtlasSchemaConfig {
  return emptyAtlasSchema()
}
