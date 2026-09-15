// ============ 表格自动编号（单一来源） ============
// 「编号」列的续号规则原先只写在 TableSheet 内部；1.9.1「设定补登」也要往设定表写新行，
// 若各写一套必然漂移，故抽成共享模块，两处共用同一规则。
import type { TableRow } from './types'

/** 需要自动编号的页签分组（世界构建 / 创作管理 / 运营维护）。这些分组的「编号」列在新增行时自动续号。 */
export const AUTONUM_GROUPS = new Set(['世界构建', '创作管理', '运营维护'])

/** 各表编号前缀（与 schema 的 codeRule 一致）；空表新增行时使用默认前缀 */
export const CODE_PREFIX: Record<string, string> = {
  nations: 'N', geography: 'G', races: 'R', items: 'I', history: 'H', terms: 'T',
  foreshadow: 'F', subplots: 'LINE', secrets: 'S', changelog: 'C', ideas: 'IDEA',
  geomaps: 'MAP',
}

/**
 * 计算某表「编号」列的下一个自动编号：
 * 保留原字母前缀，数字部分统一 4 位补零、从 0001 起，续接已有最大序号。
 * - 表内已有编号：取最大数字 +1（如 F0001~F0005 → F0006）
 * - 空表：用该表默认前缀 + 0001（如 N0001）
 * @param drafts 未落盘的草稿值优先于已保存值；不传则只读已保存数据
 */
export function nextAutoCode(
  tabId: string,
  rows: TableRow[],
  drafts: Record<string, Record<string, string>> = {},
  codeCol = '编号',
): string {
  const prefix = CODE_PREFIX[tabId] ?? ''
  let maxNum = 0
  let usedPrefix = prefix
  for (const r of rows) {
    const raw = ((drafts[r.id]?.[codeCol] ?? r.data[codeCol] ?? '') as string).trim()
    if (!raw) continue
    const m = raw.match(/^(\D*)(\d+)$/)
    if (m) {
      if (!usedPrefix) usedPrefix = m[1]
      const n = parseInt(m[2], 10)
      if (n > maxNum) maxNum = n
    }
  }
  return usedPrefix + String(maxNum + 1).padStart(4, '0')
}
