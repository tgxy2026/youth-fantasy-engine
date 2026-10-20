/**
 * 3.2.0 · WT2：**拆书草稿的映射上下文**
 *
 * 旧引擎（拆书 / 设定补登）一直用 `KIND_MAP` 的字段名去 `schema` 里查落点，
 * 所以作者新建一个同义的自定义字段时，抽取结果**永远写不进去**；两个同名字段时，
 * 又可能按 schema 顺序写进另一个栏位。
 *
 * 这里把「页签 → 已采用模板 + 映射方案」装成一份只读上下文，交给 `draft.ts`：
 *   · 采用过模板 ⇒ 槽位落点以映射方案为准（作者确认的优先），查不到就**不写**；
 *   · 没采用模板 ⇒ 不提供上下文，`draft.ts` 逐字节沿用旧口径（老项目行为不变）。
 *
 * 🔴 只读映射，不在这里写库：落库仍由作者勾选后的 `commit.ts` 执行。
 */
import type { TemplateDef } from '@/lib/templates/definition'
import { adaptTemplateDef } from '@/lib/templates/defAdapter'
import { buildMappingPlan, type SemanticMappingPlan } from '@/lib/templates/mappingPlan'
import { slotsForTab, type SemanticSlotDef } from '@/lib/templates/semanticSlots'
import { loadTemplateDef } from '@/lib/templates/store'
import type { EffectiveTemplate } from '@/lib/templates/types'

export interface DraftMappingContext {
  template: EffectiveTemplate
  plan: SemanticMappingPlan
  slots: SemanticSlotDef[]
}

/**
 * 从一份模板定义构造上下文（纯函数，便于测试）。
 *
 * 用途取 `export`：它不按展示开关过滤，正好是「这份模板有哪些字段」的全集；
 * 归档字段仍会被 `adaptTemplateDef` 排除 —— 归档字段不参与映射，也不该被写。
 */
export function draftMappingContextOf(def: TemplateDef, tabId: string): DraftMappingContext | null {
  const slots = slotsForTab(tabId)
  if (!slots.length) return null
  const template = adaptTemplateDef(def, { purpose: 'export', ignoreAppliesTo: true })
  const plan = buildMappingPlan(template, slots, def.bindings ?? {})
  return { template, plan, slots }
}

/**
 * 读取一组页签的映射上下文。
 *
 * 🔴 读失败时返回空表（调用方沿用旧口径），**不阻断拆书** ——
 *    模板层故障不该让整本书抽不出草稿；但这也意味着写回会按旧字段名走，
 *    所以只在「确实没有采用模板」时才是等价行为，界面需要如实说明。
 */
export async function loadDraftMappingContexts(
  pid: string | undefined,
  tabIds: Iterable<string>,
): Promise<Map<string, DraftMappingContext>> {
  const out = new Map<string, DraftMappingContext>()
  if (!pid) return out
  for (const tabId of new Set(tabIds)) {
    try {
      const def = await loadTemplateDef(pid, tabId)
      if (!def) continue
      const ctx = draftMappingContextOf(def, tabId)
      if (ctx) out.set(tabId, ctx)
    } catch {
      /* 单个页签读取失败不影响其余页签；该页签回落到旧口径 */
    }
  }
  return out
}
