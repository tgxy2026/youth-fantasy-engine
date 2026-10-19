/**
 * 3.2.0 · WT0-3：**语义读取视图**（`readSemanticView`）
 *
 * 方案 §3.10.1：把作者的字段结构**投影**成旧引擎认识的语义（身份/动机/状态/地点…），
 * 并按来源标注每个值的出处。投影只在读取时生成 ——
 * 🔴 **不另存第二份角色/世界事实库**：正式内容永远只在原 `row.data` / `card.data` 里，
 *    投影是视图，不是仓库。任何「顺手把投影存下来方便下次读」的想法都会造成两份真相。
 *
 * 每条产出（与方案同形）：
 *   `{ slot, value, sources[], mappingId, transform, writableTarget?, limitations }`
 */
import type { EffectiveField, EffectiveTemplate } from './types'
import { canSemanticWrite, writeDeniedReason } from './fieldPolicy'
import { bindingOf, isAutoWritable, type SemanticMappingPlan } from './mappingPlan'
import type { SemanticSlotDef } from './semanticSlots'

/** 记录的最小形状（`TableRow` 与 `CardRecord` 都满足） */
export interface SemanticRecordLike {
  id: string
  data: Record<string, string>
}

export interface SemanticSource {
  recordId: string
  fieldId: string
  /** 存储键（表格=列名，卡片=`模块::字段`） */
  fieldKey: string
  /** 当前显示名（作者可能改过） */
  label: string
  /** 原始文本（多来源合并时便于追溯；单来源且等长时省略） */
  quote?: string
}

export type SemanticLimitationCode =
  | 'no-target'          // 模板里没有对应字段（≠ 资料缺失）
  | 'empty-value'        // 有字段但值为空
  | 'ambiguous-target'   // 多个字段都能当这个用途 ⇒ 写回须作者指定
  | 'not-ai-readable'    // 字段权限关闭了 AI 读取
  | 'read-only-target'   // 读得到但不可写（AI 回填会被拒）
  | 'unknown-type'       // 字段类型未识别（只读展示）

export interface SemanticLimitation {
  code: SemanticLimitationCode
  detail: string
}

export interface SemanticViewEntry {
  slot: string
  label: string
  /** 读取结果（多来源按槽位规则合并）；空值为 `''` 并带 `empty-value` 限制 */
  value: string
  sources: SemanticSource[]
  /** 映射标识：`<planDigest>#<slot>` —— 任务据此记录「实际依赖了哪份映射」 */
  mappingId: string
  transform: 'identity' | 'concat'
  /** 可写的唯一目标（不唯一/不允许自动写时为 undefined） */
  writableTarget?: { fieldId: string; fieldKey: string; label: string }
  limitations: SemanticLimitation[]
}

export interface ReadSemanticViewOptions {
  /** 是否返回空值条目（默认 true：AI 需要知道「有这个字段但这章还没填」） */
  includeEmpty?: boolean
}

/**
 * 读取一份记录在某模板下的语义视图。
 *
 * 🔴 取值只看 `field.sourceKey`（存储键）：作者怎么改显示名都不影响读到的内容。
 * 🔴 多来源合并**不丢来源**：`sources` 必须列全，否则「AI 凭什么这么说」无法追溯。
 */
export function readSemanticView(
  template: EffectiveTemplate,
  record: SemanticRecordLike,
  plan: SemanticMappingPlan,
  slotDefs: readonly SemanticSlotDef[],
  opts: ReadSemanticViewOptions = {},
): SemanticViewEntry[] {
  const includeEmpty = opts.includeEmpty !== false
  const byId = new Map(template.fields.map(f => [f.id, f]))
  const out: SemanticViewEntry[] = []

  for (const def of slotDefs) {
    const binding = bindingOf(plan, def.slot)
    const limitations: SemanticLimitation[] = []
    const fields: EffectiveField[] = []

    if (!binding || !binding.fieldIds.length) {
      limitations.push({
        code: 'no-target',
        detail: `当前模板里没有可用于「${def.label}」的字段（候选：${def.targets.join(' / ')}）`,
      })
      out.push(entry(def, '', [], limitations, plan, 'identity'))
      continue
    }

    for (const id of binding.fieldIds) {
      const f = byId.get(id)
      if (f) fields.push(f)
    }
    if (fields.length > 1) {
      limitations.push({
        code: 'ambiguous-target',
        detail: `有 ${fields.length} 个字段都能当「${def.label}」，读取取第一个有值的，写回需作者指定`,
      })
    }

    const sources: SemanticSource[] = []
    const values: string[] = []
    for (const f of fields) {
      const raw = (record.data?.[f.sourceKey] ?? '').trim()
      if (!raw) continue
      if (!f.permissions.aiRead) {
        limitations.push({ code: 'not-ai-readable', detail: `字段「${f.label}」未开放 AI 读取，已跳过` })
        continue
      }
      if (f.type === 'other') {
        limitations.push({ code: 'unknown-type', detail: `字段「${f.label}」类型未识别，仅按文本读取` })
      }
      sources.push({
        recordId: record.id,
        fieldId: f.id,
        fieldKey: f.sourceKey,
        label: f.label,
        // 原文摘录（截断）：多来源合并时靠它追溯「这句话是从哪一栏来的」
        quote: raw.length > 120 ? raw.slice(0, 120) + '…' : raw,
      })
      values.push(raw)
    }

    // 合并规则：concat 全拼；first 取候选顺序里第一个有值的
    let value = ''
    if (def.read === 'concat') value = values.join('\n')
    else value = values[0] ?? ''
    if (!value) limitations.push({ code: 'empty-value', detail: `「${def.label}」的字段存在但值为空` })

    const unique = fields.length === 1
    let writableTarget: SemanticViewEntry['writableTarget']
    if (unique && isAutoWritable(plan, def)) {
      const f = fields[0]
      if (canSemanticWrite(f)) {
        writableTarget = { fieldId: f.id, fieldKey: f.sourceKey, label: f.label }
      } else {
        limitations.push({
          code: 'read-only-target',
          detail: writeDeniedReason(f) ?? `字段「${f.label}」不可写，自动回填会被拒`,
        })
      }
    }

    if (!value && !includeEmpty) continue
    out.push(entry(def, value, sources, limitations, plan, def.read === 'concat' ? 'concat' : 'identity', writableTarget))
  }

  return out
}

/** 便捷：把语义视图压成 `{ slot: value }`（只保留有值的，供旧 prompt 兼容） */
export function semanticValuesOf(entries: readonly SemanticViewEntry[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of entries) if (e.value) out[e.slot] = e.value
  return out
}

/** 便捷：取某个槽位（AI 任务只需要一两个字段时用，不必整份视图） */
export function semanticValueOf(entries: readonly SemanticViewEntry[], slot: string): string {
  return entries.find(e => e.slot === slot)?.value ?? ''
}

function entry(
  def: SemanticSlotDef,
  value: string,
  sources: SemanticSource[],
  limitations: SemanticLimitation[],
  plan: SemanticMappingPlan,
  transform: SemanticViewEntry['transform'],
  writableTarget?: SemanticViewEntry['writableTarget'],
): SemanticViewEntry {
  return {
    slot: def.slot,
    label: def.label,
    value,
    sources,
    mappingId: `${plan.digest}#${def.slot}`,
    transform,
    ...(writableTarget ? { writableTarget } : {}),
    limitations,
  }
}
