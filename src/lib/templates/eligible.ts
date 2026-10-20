/**
 * 可用模板编辑的七个页签（3.2.0 · T1）。
 *
 * 四个世界构建图鉴表 + 三张角色卡。其他页签（人物关系 / 历史事件等）
 * 仍沿用内置结构，不开放模板编辑 —— 它们的列由业务逻辑驱动，改结构会打架。
 *
 * 🔴 单一判据：界面入口、测试与交接说明都从这里取，别各写一份数组。
 */
export const TEMPLATE_TAB_IDS = [
  'nations',
  'geography',
  'races',
  'items',
  'char-main',
  'char-secondary',
  'char-npc',
] as const

const SET = new Set<string>(TEMPLATE_TAB_IDS)

export function isTemplateTab(tabId: string): boolean {
  return SET.has(tabId)
}
