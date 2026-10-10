// ============ 表格自动编号（单一来源） ============
// 「编号」列的续号规则原先只写在 TableSheet 内部；1.9.1「设定补登」也要往设定表写新行，
// 若各写一套必然漂移，故抽成共享模块，两处共用同一规则。
import type { TableRow } from '@/lib/types'

/** 需要自动编号的页签分组（世界构建 / 创作管理 / 运营维护）。这些分组的「编号」列在新增行时自动续号。 */
export const AUTONUM_GROUPS = new Set(['世界构建', '创作管理', '运营维护'])

/** 各表编号前缀（与 schema 的 codeRule 一致）；空表新增行时使用默认前缀 */
const CODE_PREFIX: Record<string, string> = {
  nations: 'N', geography: 'G', races: 'R', items: 'I', history: 'H', terms: 'T',
  foreshadow: 'F', subplots: 'LINE', secrets: 'S', changelog: 'C', ideas: 'IDEA',
  geomaps: 'MAP',
  // ⚠️ 「其他设定」（misc-settings）**不在此表**，是有意的：它在 2026-09-20 晚间改成了
  // **卡片型**，而卡片表一律没有「编号」列（角色卡 / 分卷大纲 / 章节细纲都没有）。
  // 原先给它登记过 'MISC'，是表格时代的事；留着只会是一条永远取不到的死配置。
}

/**
 * 计算某表「编号」列的下一个自动编号：**补最小的空号**（2026-09-29 改）。
 *
 * 旧规则是「最大序号 +1」＋退役池不复用，社区的反馈是删错了想补回来却补不回来；
 * 现改为顺序补缺：
 * - 0001~0005 全在 → 0006
 * - 删掉末尾 0005 → 新增仍是 0005（补末尾空位）
 * - 删掉中间 0003 → 新增是 0003（补中间缺口）
 * 编号复用可能让别处的旧引用指向新条目，所以删除时另有引用检查提示（lib/codeRefs.ts）。
 *
 * @param drafts 未落盘的草稿值优先于已保存值；不传则只读已保存数据
 */
export function nextAutoCode(
  tabId: string,
  rows: TableRow[],
  drafts: Record<string, Record<string, string>> = {},
  codeCol = '编号',
): string {
  const prefix = CODE_PREFIX[tabId] ?? ''
  const used = new Set<number>()
  const rowPrefixes = new Set<string>()
  for (const r of rows) {
    // 🔴 原值与草稿值**都算已占用**：草稿还没落库，库里那个编号仍然占着。
    //    只按草稿算会把库里的编号「释放」掉 —— 新增行就可能抢用别人正在改的那个号。
    const orig = ((r.data[codeCol] ?? '') as string).trim()
    const draft = ((drafts[r.id]?.[codeCol] ?? '') as string).trim()
    for (const raw of [orig, draft]) {
      if (!raw) continue
      const m = raw.match(/^(\D*)(\d+)$/)
      if (m) {
        rowPrefixes.add(m[1])
        used.add(parseInt(m[2], 10))
      }
    }
  }
  // 前缀沿用：用户把整表编号改成了自定义前缀（如「北域001」）时，新增行应跟随表内前缀，
  // 而不是回到出厂默认（旧版这里是个永假的死分支 —— 默认前缀非空，`if (!usedPrefix)` 永不成立）。
  // 表内前缀不一致（混用）时退回出厂默认，由重复校验兜底。
  const usedPrefix = rowPrefixes.size === 1 ? [...rowPrefixes][0] : (rowPrefixes.size === 0 ? prefix : prefix)
  let n = 1
  while (used.has(n)) n++
  return usedPrefix + String(n).padStart(4, '0')
}
