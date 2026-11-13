/**
 * 表格编号唯一性校验 · 纯函数 —— 单测（3.5.3 · P2）
 *
 * validateCodes 的内容计算从 useTableSheetModel 外抽到 tableSheetCodeValidation.ts。
 * 这里独立验证原先只靠整条表格保存流程才覆盖到的数据敏感保障：
 *   ① draft 优先于已保存取值；② 空号 / 纯空白跳过；③ 多行重复才报错（删除后的编号允许复用）；
 *   ④ 文案 `「X」被 N 行重复使用`、多编号用 `；` 连接；⑤ trim 归一；⑥ 纯函数不改原对象。
 * 保存接线（validateBeforeSave.current / saveAll / setCodeError）仍留在模型里，由表格流程专项覆盖。
 */
import { computeCodeDuplicates } from '../src/components/sheets/tableSheetCodeValidation'
import type { TableRow } from '../src/lib/types'
import type { DraftMap } from '../src/components/sheets/tableSheetDraftOps'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const row = (id: string, code: string): TableRow => ({
  id, projectId: 'p1', tabId: 't1', order: 0, data: { '编号': code },
})
const CODE = '编号'

console.log('\n▶ tableCodeValidation')

// ---------- 无编号列 / 空表 ----------
ok('无编号列直接通过', computeCodeDuplicates(undefined, [row('r1', 'A')], {}) === null)
ok('空表通过', computeCodeDuplicates(CODE, [], {}) === null)

// ---------- 唯一 / 重复 ----------
ok('单行唯一编号通过', computeCodeDuplicates(CODE, [row('r1', 'A')], {}) === null)
ok('两行重复报错', computeCodeDuplicates(CODE, [row('r1', 'A'), row('r2', 'A')], {}) === '「A」被 2 行重复使用')
ok('三行重复计数正确', computeCodeDuplicates(CODE, [row('r1', 'A'), row('r2', 'A'), row('r3', 'A')], {}) === '「A」被 3 行重复使用')
ok('删除后的编号允许复用（仅剩一行）', computeCodeDuplicates(CODE, [row('r1', 'A')], {}) === null)

// ---------- draft 优先 ----------
{
  // 已保存唯一，draft 把第二行改成与第一行相同 → 检出重复
  const rows = [row('r1', 'A'), row('r2', 'B')]
  const drafts: DraftMap = { r2: { '编号': 'A' } }
  ok('draft 制造的重复被检出', computeCodeDuplicates(CODE, rows, drafts) === '「A」被 2 行重复使用')
}
{
  // 已保存重复，draft 把第二行改成别的 → 通过
  const rows = [row('r1', 'A'), row('r2', 'A')]
  const drafts: DraftMap = { r2: { '编号': 'B' } }
  ok('draft 化解已保存重复', computeCodeDuplicates(CODE, rows, drafts) === null)
}
{
  // draft 把编号清成空串 → 空串优先于已保存（不是 nullish），该行跳过
  const rows = [row('r1', 'A'), row('r2', 'A')]
  const drafts: DraftMap = { r2: { '编号': '' } }
  ok('draft 空串覆盖已保存编号（该行跳过）', computeCodeDuplicates(CODE, rows, drafts) === null)
}
{
  // draft 只改了别的列，编号键缺席 → 回落已保存编号，重复仍检出
  const rows = [row('r1', 'A'), row('r2', 'A')]
  const drafts: DraftMap = { r2: { '名称': 'X' } }
  ok('draft 未触及编号列时回落已保存值', computeCodeDuplicates(CODE, rows, drafts) === '「A」被 2 行重复使用')
}

// ---------- 空号 / 空白 / trim ----------
ok('空号与纯空白跳过（不算重复）', computeCodeDuplicates(CODE, [row('r1', ''), row('r2', '   ')], {}) === null)
ok('两端空白归一后判重', computeCodeDuplicates(CODE, [row('r1', ' A '), row('r2', 'A')], {}) === '「A」被 2 行重复使用')

// ---------- 多个重复编号 ----------
ok('多个重复编号用；连接', computeCodeDuplicates(CODE, [row('r1', 'A'), row('r2', 'A'), row('r3', 'B'), row('r4', 'B')], {})
  === '「A」被 2 行重复使用；「B」被 2 行重复使用')

// ---------- 纯函数 ----------
{
  const rows = [row('r1', 'A'), row('r2', 'A')]
  const drafts: DraftMap = { r2: { '编号': 'A' } }
  const rowsSnap = JSON.stringify(rows), draftsSnap = JSON.stringify(drafts)
  computeCodeDuplicates(CODE, rows, drafts)
  ok('原 rows / drafts 不被改动（纯函数）', JSON.stringify(rows) === rowsSnap && JSON.stringify(drafts) === draftsSnap)
}

console.log(`\n▶ tableCodeValidation: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)