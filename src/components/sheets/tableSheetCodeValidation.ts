// ============ 表格编号唯一性校验 · 纯函数（P2 · 3.5.3 自 useTableSheetModel 拆出）============
// 🔴 只搬不改：computeCodeDuplicates 的函数体与原 validateCodes 逐字一致（含 draft 优先取值、
//    trim、空号跳过、`「X」被 N 行重复使用` 文案与 `；` 连接）。协调入口仍留在模型里：
//    validateCodes(useCallback) → validateBeforeSave.current → saveAll 的接线一行未动。
// 原保障：保存前合并 draft 逐行提取编号、检测多行重复（2026-09-29 起删除后的编号允许复用，
//    不再命中退役池即阻止）。替代行为测试见 tests/tableCodeValidation.test.ts。
import type { TableRow } from '@/lib/types'
import type { DraftMap } from './tableSheetDraftOps'

/**
 * 编号重复检测：合并 draft（draft 优先于已保存）后逐行提取编号，统计多行重复。
 * 返回错误信息（null 表示通过）；多个重复编号用 `；` 连接。
 */
export function computeCodeDuplicates(
  codeCol: string | undefined,
  rows: readonly TableRow[],
  drafts: DraftMap,
): string | null {
  if (!codeCol) return null
  const owner = new Map<string, number>()
  for (const r of rows) {
    const code = ((drafts[r.id]?.[codeCol] ?? r.data[codeCol] ?? '') as string).trim()
    if (!code) continue
    owner.set(code, (owner.get(code) ?? 0) + 1)
  }
  const errs: string[] = []
  for (const [code, count] of owner) {
    if (count > 1) errs.push(`「${code}」被 ${count} 行重复使用`)
  }
  return errs.length > 0 ? errs.join('；') : null
}