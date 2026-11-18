/**
 * 酒馆导出弹窗的「要导出多少条」判定（3.6.1 · B7 从 `TavernExportDialog` 抽出）。
 *
 * 【为什么抽这一处】文件名、格式、排版全在 `renderDoc`（已有单测），
 * 组件里唯一会算错的是这个数：**关掉「含已隐藏」时，导出条数要减去隐藏条数**。
 * 算错的后果很直接 —— 作者看到「将导出 42 条」，实际文件里只有 30 条，会以为导出丢内容。
 */
export function exportedCountOf(input: {
  /** 报告类文档没有消息条数 ⇒ undefined（界面上不显示条数） */
  messageCount: number | undefined
  hiddenCount: number
  includeHidden: boolean
}): number | undefined {
  if (input.messageCount === undefined) return undefined
  return Math.max(0, input.messageCount - (input.includeHidden ? 0 : input.hiddenCount))
}
