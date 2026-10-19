/**
 * 3.2.0 · WT0-3：**语义写回**（`resolveSemanticWrite`）
 *
 * 方案 §3.10.3 的不对称原则：**读取可以宽，写回必须严**。
 * 读错了顶多是少看到一段资料；写错了是把内容塞进另一栏、而且没人报错。
 *
 * 因此这里**一律 fail-closed**：
 *   · 槽位没绑定字段 ⇒ 拒绝（`unmapped`）——不猜「差不多就是这个字段」；
 *   · 一个槽位绑了多个字段 ⇒ 拒绝（`ambiguous-target`）——不按第一个蒙；
 *   · 槽位本身是多字段合成用途 ⇒ 拒绝（`needs-manual-target`）——要作者指定；
 *   · 字段归档 / 未开放 AI 写入 / 类别不符 ⇒ 拒绝；
 *   · 值类型或候选项对不上 ⇒ 拒绝，**不做单位换算、不猜数字**。
 * 🔴 **绝不新建字段、绝不写未知键**（方案 §3.10.3 最后一行：不得自动创造目标）。
 * 🔴 拿不到事实就如实上报（`warnings` / `rejected`），不静默丢弃。
 */
import type { EffectiveField, EffectiveTemplate } from './types'
import { canSemanticWrite, writeDeniedReason } from './fieldPolicy'
import { bindingOf, isAutoWritable, type SemanticMappingPlan } from './mappingPlan'
import type { SemanticSlotDef } from './semanticSlots'

export type SemanticWriteRejectCode =
  | 'unknown-slot'        // 候选里的槽位本目录不认识（旧槽位残留/拼写错误）
  | 'unmapped'            // 模板里没有对应字段
  | 'ambiguous-target'    // 多个字段都能当这个用途
  | 'needs-manual-target' // 多字段合成用途：写回必须作者指定
  | 'archived'            // 字段已归档
  | 'not-writable'        // 字段未开放 AI 写入
  | 'category-mismatch'   // 字段不适用于该类别
  | 'category-required'   // 字段限定了类别，但调用方没给类别（无法证明适用）
  | 'unknown-type'        // 字段类型未识别，不能安全写入
  | 'empty'               // 值为空
  | 'invalid-value'       // 类型对不上（数字栏给了文字等）
  | 'not-in-options'      // 下拉候选里没有这个值
  | 'field-conflict'      // 同一次写回里两个槽位抢同一个字段（后写的会静默覆盖前一个）

export interface SemanticWriteAccepted {
  slot: string
  fieldId: string
  fieldKey: string
  label: string
  /** 归一化后的字符串值（保存器直接吃） */
  value: string
  /** identity=原样；normalized=做了纯格式归一（去空白/多选分隔/布尔中文化） */
  transform: 'identity' | 'normalized'
}

export interface SemanticWriteRejection {
  slot: string
  code: SemanticWriteRejectCode
  detail: string
}

export interface SemanticWriteWarning {
  slot: string
  code: 'reference-unverified'
  detail: string
}

export interface SemanticWriteResult {
  accepted: SemanticWriteAccepted[]
  rejected: SemanticWriteRejection[]
  warnings: SemanticWriteWarning[]
  /** 本次写回依据的映射摘要（任务据此记录真实依赖） */
  planDigest: string
}

export interface ResolveSemanticWriteOptions {
  /** 目标条目的类别（自定义字段的适用范围校验用） */
  category?: string
}

/**
 * 把抽取器/模型的输出译回真实字段。
 *
 * @param candidate 形如 `{ name: '林昭', identity: '…', realm: '…' }` 的槽位字典
 */
export function resolveSemanticWrite(
  template: EffectiveTemplate,
  plan: SemanticMappingPlan,
  slotDefs: readonly SemanticSlotDef[],
  candidate: Record<string, unknown>,
  opts: ResolveSemanticWriteOptions = {},
): SemanticWriteResult {
  const byId = new Map(template.fields.map(f => [f.id, f]))
  const defBySlot = new Map(slotDefs.map(d => [d.slot, d]))
  const accepted: SemanticWriteAccepted[] = []
  const rejected: SemanticWriteRejection[] = []
  const warnings: SemanticWriteWarning[] = []
  /** 本次已写字段（用于发现「两个槽位抢同一字段」） */
  const written = new Map<string, { slot: string; value: string }>()

  for (const [slot, raw] of Object.entries(candidate)) {
    const def = defBySlot.get(slot)
    if (!def) {
      rejected.push({ slot, code: 'unknown-slot', detail: `槽位「${slot}」不在当前槽位目录里，未写入` })
      continue
    }
    const binding = bindingOf(plan, slot)
    if (!binding || !binding.fieldIds.length) {
      rejected.push({ slot, code: 'unmapped', detail: `当前模板没有对应「${def.label}」的字段（候选：${def.targets.join(' / ')}）` })
      continue
    }
    // 多字段：作者**显式声明**的组合用途可以人工定；自动多命中则是语义重复，得先挑一个
    if (binding.fieldIds.length > 1) {
      if (binding.origin === 'declared') {
        rejected.push({ slot, code: 'needs-manual-target', detail: `「${def.label}」被声明绑定了 ${binding.fieldIds.length} 个字段，属多字段合成用途，请作者指定目标` })
      } else {
        rejected.push({
          slot,
          code: 'ambiguous-target',
          detail: `有 ${binding.fieldIds.length} 个字段都能当「${def.label}」（${binding.fieldIds.join('、')}），需作者指定目标`,
        })
      }
      continue
    }
    if (!isAutoWritable(plan, def)) {
      rejected.push({ slot, code: 'needs-manual-target', detail: `「${def.label}」按槽位声明不自动覆盖，请作者指定目标` })
      continue
    }

    const field = byId.get(binding.fieldIds[0])
    if (!field) {
      rejected.push({ slot, code: 'unmapped', detail: `绑定字段 ${binding.fieldIds[0]} 不在当前模板里` })
      continue
    }
    if (field.archived) {
      rejected.push({ slot, code: 'archived', detail: `字段「${field.label}」已归档，常规使用不写入` })
      continue
    }
    if (!canSemanticWrite(field)) {
      rejected.push({ slot, code: 'not-writable', detail: writeDeniedReason(field) ?? `字段「${field.label}」不可写` })
      continue
    }
    // 类别适用范围：字段限定了类别却拿不到类别 ⇒ 无法证明适用，宁可拒绝也不写进看不见的栏位
    if (field.appliesTo !== '*') {
      if (!opts.category) {
        rejected.push({ slot, code: 'category-required', detail: `字段「${field.label}」仅适用于 ${field.appliesTo.join('、')}，调用方未提供类别` })
        continue
      }
      if (!field.appliesTo.includes(opts.category)) {
        rejected.push({ slot, code: 'category-mismatch', detail: `字段「${field.label}」不适用于类别「${opts.category}」` })
        continue
      }
    }
    if (field.type === 'other') {
      rejected.push({ slot, code: 'unknown-type', detail: `字段「${field.label}」类型未识别，不能安全写入` })
      continue
    }

    const c = coerce(field, raw)
    if (!c.ok) {
      rejected.push({ slot, code: c.code, detail: c.detail })
      continue
    }
    // 同一字段被两个槽位抢：值相同视为幂等（跳过重复），值不同则拒后者，绝不静默覆盖
    const prev = written.get(field.id)
    if (prev) {
      if (prev.value === c.value) continue
      rejected.push({
        slot,
        code: 'field-conflict',
        detail: `「${field.label}」已被槽位「${prev.slot}」写成「${prev.value.slice(0, 40)}」，本槽位的值不同，未写入`,
      })
      continue
    }
    written.set(field.id, { slot, value: c.value })
    if (field.type === 'tableRef' || field.type === 'character' || field.type === 'characters') {
      warnings.push({
        slot,
        code: 'reference-unverified',
        detail: `字段「${field.label}」是引用型，目标是否存在未校验（需调用方在保存前用库核对）`,
      })
    }
    accepted.push({
      slot,
      fieldId: field.id,
      fieldKey: field.sourceKey,
      label: field.label,
      value: c.value,
      transform: c.normalized ? 'normalized' : 'identity',
    })
  }

  return { accepted, rejected, warnings, planDigest: plan.digest }
}

type Coerced =
  | { ok: true; value: string; normalized: boolean }
  | { ok: false; code: SemanticWriteRejectCode; detail: string }

/** 按字段类型归一化取值。**不做单位换算、不做语义猜测** */
function coerce(field: EffectiveField, raw: unknown): Coerced {
  if (raw == null) return { ok: false, code: 'empty', detail: `「${field.label}」的值为空` }

  if (field.type === 'multiSelect') {
    const list = Array.isArray(raw)
      ? raw.map(x => String(x).trim()).filter(Boolean)
      : splitMulti(String(raw))
    if (!list.length) return { ok: false, code: 'empty', detail: `「${field.label}」的值为空` }
    const opts = field.options ?? []
    if (opts.length) {
      const bad = list.filter(v => !opts.includes(v))
      if (bad.length) {
        return { ok: false, code: 'not-in-options', detail: `「${field.label}」不接受：${bad.join('、')}（候选：${opts.join('、')}）` }
      }
    }
    const value = list.join('、')
    return { ok: true, value, normalized: value !== String(raw) }
  }

  const text = typeof raw === 'string' ? raw.trim() : String(raw).trim()
  if (!text) return { ok: false, code: 'empty', detail: `「${field.label}」的值为空` }

  switch (field.type) {
    case 'number': {
      // 只认纯数值（可带符号/小数/千分位逗号）；「三阶」「约 20」这类一律拒，不猜
      const cleaned = text.replace(/,/g, '')
      if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned) || !Number.isFinite(Number(cleaned))) {
        return { ok: false, code: 'invalid-value', detail: `「${field.label}」是数值字段，无法从「${text}」得到确定数值` }
      }
      return { ok: true, value: cleaned, normalized: cleaned !== text }
    }
    case 'boolean': {
      const v = normalizeBool(text)
      if (v == null) return { ok: false, code: 'invalid-value', detail: `「${field.label}」是是非字段，无法识别「${text}」` }
      return { ok: true, value: v, normalized: v !== text }
    }
    case 'select': {
      const opts = field.options ?? []
      // 选项为空＝作者没设候选，按普通文本处理（不硬造候选）
      if (opts.length && !opts.includes(text)) {
        return { ok: false, code: 'not-in-options', detail: `「${field.label}」不接受「${text}」（候选：${opts.join('、')}）` }
      }
      return { ok: true, value: text, normalized: false }
    }
    default:
      return { ok: true, value: text, normalized: false }
  }
}

/** 多选：中英文顿号/逗号/分号/竖线都认（作者手写习惯不同），去空去重 */
function splitMulti(s: string): string[] {
  const parts = s.split(/[、,，;；|]/).map(x => x.trim()).filter(Boolean)
  return [...new Set(parts)]
}

function normalizeBool(s: string): string | null {
  const t = s.toLowerCase()
  if (['是', 'true', 'yes', 'y', '1', '有'].includes(t)) return '是'
  if (['否', 'false', 'no', 'n', '0', '无'].includes(t)) return '否'
  return null
}
