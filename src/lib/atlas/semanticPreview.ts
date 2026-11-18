/**
 * 图鉴详情的「按语义看」（3.6.1 · B5 接线 `templates/semanticView`）。
 *
 * 【它是什么】把作者自己的字段结构**投影**成「身份 / 动机 / 状态」三组，并逐项标出处
 * （这一条来自哪一栏）。用的就是 `readSemanticView` —— 全项目唯一的语义读取实现。
 *
 * 🔴 三条边界（方案 §3.10.1 与 3.6.1 定案）：
 *    · **只读**：不写回、不提供「按语义改」的入口（写回仍需作者在表格里改原字段）；
 *    · **不落第二份事实库**：投影只在渲染时算，不存 settingsKV、不进导出、不进同步；
 *    · **不改原数据**：`record.data` 只读，函数返回全新对象。
 *
 * 🔴 为什么按 `slotsForTab` 分组而不是自己定"身份/动机/状态"的字段名：
 *    槽位目录是语义映射的唯一真源（`KIND_MAP` 反查得出），自己再列一份必然漂移。
 */
import { buildMappingPlan } from '@/lib/templates/mappingPlan'
import { slotsForTab } from '@/lib/templates/semanticSlots'
import { readSemanticView } from '@/lib/templates/semanticView'
import type { EffectiveTemplate } from '@/lib/templates/types'

export type SemanticGroupId = 'identity' | 'motivation' | 'state'

export interface SemanticPreviewItem {
  slot: string
  /** 槽位中文名（`身份定位` / `内在矛盾/动机` …） */
  label: string
  value: string
  /** 出处：来源字段的显示名（多来源时列全，便于作者回表格核对） */
  sourceLabels: string[]
  /** 需要如实说明的情况（目前只带「多个字段都能当这个用途」） */
  notes: string[]
}

export interface SemanticPreviewGroup {
  id: SemanticGroupId
  label: string
  /**
   * `false` = 当前模板里**没有**这个用途的字段（≠ 资料缺失）。
   * 🔴 界面必须把这两种情况分开说，否则作者会去翻一条根本不存在的资料。
   */
  mapped: boolean
  items: SemanticPreviewItem[]
}

/**
 * 三组各自覆盖哪些槽位。
 * 🔴 只收已在槽位目录里出现过的槽位；目录里没有的会被自动忽略（不凭空造用途）。
 */
export const SEMANTIC_GROUPS: readonly { id: SemanticGroupId; label: string; slots: readonly string[] }[] = [
  { id: 'identity', label: '身份', slots: ['identity', 'faction', 'alias'] },
  { id: 'motivation', label: '动机', slots: ['innerStruggle', 'traits'] },
  { id: 'state', label: '状态', slots: ['realm', 'power', 'skills'] },
]

export interface SemanticPreviewRecord {
  id: string
  data: Record<string, string>
}

/**
 * 生成三组只读投影。页签不参与语义映射（如「每日字数」这类）⇒ 返回空数组，界面不渲染。
 *
 * @param template 该条目所在页签的有效模板（调用方用 `resolveTemplateForTab` 解析，与表格同源）
 * @param record 记录（`TableRow` / `CardRecord` 都满足）
 * @param tabId 页签 id —— 决定可用槽位目录
 */
export function buildSemanticPreview(
  template: EffectiveTemplate,
  record: SemanticPreviewRecord,
  tabId: string,
): SemanticPreviewGroup[] {
  const slotDefs = slotsForTab(tabId)
  if (!slotDefs.length) return []
  const plan = buildMappingPlan(template, slotDefs)
  // includeEmpty:false —— 图鉴是速查视图，空值列在这里只会占位；「有字段但没填」由表格负责
  const entries = readSemanticView(template, record, plan, slotDefs, { includeEmpty: false })
  const bySlot = new Map(entries.map(e => [e.slot, e]))
  const known = new Set(slotDefs.map(d => d.slot))

  return SEMANTIC_GROUPS.map(group => {
    const slots = group.slots.filter(slot => known.has(slot))
    const items = slots.flatMap<SemanticPreviewItem>(slot => {
      const entry = bySlot.get(slot)
      if (!entry || !entry.value) return []
      const notes = entry.limitations
        .filter(l => l.code === 'ambiguous-target')
        .map(l => l.detail)
      return [{
        slot,
        label: entry.label,
        value: entry.value,
        sourceLabels: [...new Set(entry.sources.map(s => s.label))],
        notes,
      }]
    })
    return { id: group.id, label: group.label, mapped: slots.length > 0, items }
  })
}
