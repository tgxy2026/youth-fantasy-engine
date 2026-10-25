// ============ 保存失败时给作者的话（3.2.3 · R4）============
//
// 背景（已实测，见 docs/归档/3.2/3.2.3-R4游客故障导出缺口-2026-10-24.md）：
//   游客模式的数据只在浏览器 IndexedDB 里，整库导出的取数走 `collectAll() → ops.getAll`（走库），
//   所以**保存失败时导出的备份里没有未落盘的草稿**。写失败那一刻，草稿只活在页面内存。
//   只提示"保存失败"不够 —— 作者会以为还能导出救一下，或者随手关掉页面。
//
// 口径：桌面/便携保持原文案**逐字不变**（red line：三端文案各说各话，不能为改一端而改另一端），
//      只有游客模式追加这句补充。
import { WEB_GUEST } from '@/lib/app/platform'

/** 游客模式追加的补充说明（导出拿不到草稿 + 别关页面 + 怎么重试） */
export const GUEST_SAVE_FAILURE_HINT =
  '（游客模式的数据只在这个浏览器里，导出的备份不含未保存的草稿 —— 请不要关闭或刷新页面，排除问题后按 Ctrl+S 重试）'

/**
 * 拼出保存失败的提示文案。
 * @param prefix 原有前缀，如「保存失败：」「自动保存失败：」—— 桌面/便携下输出与改动前逐字一致
 * @param detail 错误详情
 * @param guest  是否游客模式（测试可显式传入；生产走 {@link saveFailureMessage}）
 */
export function buildSaveFailureMessage(prefix: string, detail: string, guest: boolean): string {
  return prefix + detail + (guest ? GUEST_SAVE_FAILURE_HINT : '')
}

/** 生产入口：按当前运行形态决定是否追加游客补充说明 */
export function saveFailureMessage(prefix: string, error: unknown): string {
  return buildSaveFailureMessage(prefix, error instanceof Error ? error.message : String(error), WEB_GUEST)
}
