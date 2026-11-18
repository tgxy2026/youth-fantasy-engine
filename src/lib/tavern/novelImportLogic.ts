/**
 * 角色卡「从小说角色导入」弹窗的两处映射（3.6.1 · B7 抽出）。
 *
 * 【为什么抽】过滤与分组计数在 `app/viewSelectors`（已有单测），剩下两处纯映射：
 *   ① 列表右侧那个分组标签：未知 tabId 必须**原样显示**，不能显示成空白（否则作者看到的是一行没有归属的名字）；
 *   ② 底部统计：只有真的在过滤时才多说一句「命中 N 个」，否则「共 5 个 · 命中 5 个」是废话。
 */
const NOVEL_TAB_LABEL: Record<string, string> = {
  'char-main': '主要', 'char-secondary': '次要', 'char-npc': 'NPC',
}

/** 分组标签：认得的给中文名，不认得的原样显示（不给空白） */
export function novelTabLabel(tabId: string): string {
  return NOVEL_TAB_LABEL[tabId] ?? tabId
}

/** 底部统计行：转换中优先说进度；过滤生效时补一句命中数 */
export function novelImportFooterText(input: { converting: boolean; total: number; matched: number }): string {
  if (input.converting) return '正在转换（要读一遍角色卡，可能要十几秒）…'
  const base = `共 ${input.total} 个角色`
  return input.matched === input.total ? base : `${base} · 命中 ${input.matched} 个`
}
