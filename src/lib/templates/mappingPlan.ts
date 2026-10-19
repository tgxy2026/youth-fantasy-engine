/**
 * 3.2.0 · WT0-3：**语义映射方案**（槽位 → 真实字段）
 *
 * 方案 §3.10.2：映射分三种可信度 ——
 *   · `exact`    字段的**存储键**就是旧引擎认识的那个名字（未改名，或改了显示名但源键没动）；
 *   · `alias`    存储键不是它，但**显示名**撞上了（自定义字段起名叫「身份定位」）；
 *   · `declared` 作者显式指定的绑定（本次传进来，优先级最高）。
 *
 * 🔴 匹配**先看 sourceKey 再看 label**，这个顺序不能反：
 *    作者把「身份」改名叫「出身」之后，源键仍是「身份」—— 先按 label 匹配会当场失配，
 *    于是 AI 抽到的身份被静默丢掉（正是 3.2.0 要消灭的那类「改名即失能」）。
 * 🔴 同一个槽位命中**多个字段**不算好事：那说明语义重复，写回时必须作者指定，
 *    绝不按「第一个」蒙一个 —— 蒙错就是把内容写进另一栏，而且不报错。
 * 🔴 归档字段不参与映射（归档＝常规使用不出现，但内容还在）：读不到、也不自动写。
 */
import { fnv1a } from './legacyAdapter'
import type { EffectiveTemplate } from './types'
import type { SemanticSlotDef } from './semanticSlots'

export type BindingOrigin = 'exact' | 'alias' | 'declared'

export interface SlotBinding {
  slot: string
  /** 命中字段 ID（>1 表示语义重复，写回需作者指定） */
  fieldIds: string[]
  origin: BindingOrigin
}

export interface UnmappedSlot {
  slot: string
  reason: 'no-field' | 'ambiguous'
  /** `ambiguous` 时列出冲突字段，便于界面直接展示 */
  candidateIds?: string[]
}

export interface SemanticMappingPlan {
  tabId: string
  version: number
  /**
   * 映射摘要：只包含「哪个槽位绑到哪些字段」。
   * 方案 §3.10.4：任务记录**实际依赖的字段/映射摘要**，映射不变就不该作废旧结果。
   */
  digest: string
  bindings: SlotBinding[]
  unmapped: UnmappedSlot[]
  /**
   * 同一个字段被多个槽位绑定（如「人物」的 `desc` 与 `identity` 都指向「身份定位」）。
   * 🔴 这不是错，是 `KIND_MAP` 里既有的事实；但**同一次写回**里两个槽位给不同值时必须拒后一个，
   *    否则后写的静默覆盖前一个，作者永远不知道丢了一条。
   */
  sharedFields: { fieldId: string; slots: string[] }[]
}

/** 作者显式指定的绑定：`{ slot: 字段ID | 字段ID[] }` */
export type DeclaredBindings = Record<string, string | string[]>

const PLAN_VERSION = 1

/**
 * 构建映射方案。
 *
 * @param template 有效模板（已按用途过滤；这里不再做用途判断）
 * @param slotDefs 槽位目录（`slotsForKind()` 的输出）
 * @param declared 作者显式绑定（可选，优先级最高）
 */
export function buildMappingPlan(
  template: EffectiveTemplate,
  slotDefs: readonly SemanticSlotDef[],
  declared: DeclaredBindings = {},
): SemanticMappingPlan {
  const usable = template.fields.filter(f => !f.archived)
  const byId = new Map(usable.map(f => [f.id, f]))
  const bindings: SlotBinding[] = []
  const unmapped: UnmappedSlot[] = []

  for (const def of slotDefs) {
    const declaredIds = toIds(declared[def.slot]).filter(id => byId.has(id))
    if (declaredIds.length) {
      bindings.push({ slot: def.slot, fieldIds: declaredIds, origin: 'declared' })
      continue
    }

    // 1) 存储键精确命中（改名不影响）
    //    卡片/表单页签的存储键是 `模块::字段名`，而槽位候选只写**字段名**
    //    （与 `resolveSlot()` 同口径），所以按「末段字段名」比对。
    const exact = usable.filter(f => keyMatchesCandidate(f.sourceKey, def.targets))
    if (exact.length) {
      bindings.push({ slot: def.slot, fieldIds: dedupe(exact.map(f => f.id)), origin: 'exact' })
      if (exact.length > 1) unmapped.push({ slot: def.slot, reason: 'ambiguous', candidateIds: exact.map(f => f.id) })
      continue
    }

    // 2) 显示名命中（自定义字段起了个旧字段名）
    const alias = usable.filter(f => def.targets.includes(f.label))
    if (alias.length) {
      bindings.push({ slot: def.slot, fieldIds: dedupe(alias.map(f => f.id)), origin: 'alias' })
      if (alias.length > 1) unmapped.push({ slot: def.slot, reason: 'ambiguous', candidateIds: alias.map(f => f.id) })
      continue
    }

    unmapped.push({ slot: def.slot, reason: 'no-field' })
  }

  return {
    tabId: template.tabId,
    version: PLAN_VERSION,
    digest: digestOf(template.tabId, bindings),
    bindings,
    unmapped,
    sharedFields: sharedFieldsOf(bindings),
  }
}

/** 找出被多个槽位共用的字段 */
function sharedFieldsOf(bindings: readonly SlotBinding[]): { fieldId: string; slots: string[] }[] {
  const map = new Map<string, string[]>()
  for (const b of bindings) {
    for (const id of b.fieldIds) {
      const arr = map.get(id) ?? []
      arr.push(b.slot)
      map.set(id, arr)
    }
  }
  return [...map.entries()]
    .filter(([, slots]) => slots.length > 1)
    .map(([fieldId, slots]) => ({ fieldId, slots }))
}

/** 取某槽位的绑定；没有则 undefined */
export function bindingOf(plan: SemanticMappingPlan, slot: string): SlotBinding | undefined {
  return plan.bindings.find(b => b.slot === slot)
}

/** 该槽位是否可自动写（唯一目标 + 槽位本身允许自动写） */
export function isAutoWritable(
  plan: SemanticMappingPlan,
  def: SemanticSlotDef | undefined,
): boolean {
  if (!def || def.write !== 'single') return false
  const b = bindingOf(plan, def.slot)
  return !!b && b.fieldIds.length === 1
}

function toIds(v: string | string[] | undefined): string[] {
  if (!v) return []
  return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [v]
}

/**
 * 存储键是否等于某个候选字段名。
 * 表格 = 列名（`sourceKey === 候选`）；卡片/表单 = `模块::字段名`（取末段比对）。
 * 🔴 不能改成 `includes` 或模糊匹配：那会让「年龄」误中「年龄/性别」，
 *    写回时把年龄塞进外貌栏 —— 正是要防的那类静默错位。
 */
function keyMatchesCandidate(sourceKey: string, candidates: readonly string[]): boolean {
  if (candidates.includes(sourceKey)) return true
  const idx = sourceKey.lastIndexOf('::')
  if (idx < 0) return false
  return candidates.includes(sourceKey.slice(idx + 2))
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)]
}

/**
 * 映射摘要：`slot=fieldId,fieldId|origin` 排序后哈希。
 * 🔴 **不含** `unmapped` —— 「某个槽位暂时没字段」不改变已有绑定关系，
 *    把它算进摘要会让「新建一个无关字段」引发全量候选失效（方案 §3.10.4 明令禁止）。
 */
function digestOf(tabId: string, bindings: readonly SlotBinding[]): string {
  const canon = [...bindings]
    .map(b => `${b.slot}=${[...b.fieldIds].sort().join(',')}|${b.origin}`)
    .sort()
  return 'm1:' + fnv1a(tabId + '\u0001' + canon.join('\u0001'))
}

/** 仅测试用：直读版本号，防止有人悄悄改结构却忘了升版本 */
export const MAPPING_PLAN_VERSION = PLAN_VERSION
