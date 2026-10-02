// ============ 表格导入 · AI 智能拆分（2.7.0）============
//
// 锁四件事：
//   ① 提示词契约：id / 分组 / 关键约束（不合并成一条、不得编造、逐字挑候选值）；
//   ② 🔴 立场红线：注入文本里绝不出现「过检测 / 降 AI 率 / 绕过检测」字样；
//   ③ 「四处注册」到位：门面（设置页可见）+ aiDataSources + aiWriterBudget；
//   ④ 空内容不触发模型调用（无 provider 也不会炸）。
import { TABLE_IMPORT_PROMPTS, aiSplitTableRows } from '../src/lib/aiTasks/tableImport'
import { listPrompts } from '../src/lib/promptSettings'
import { AI_DATA_SOURCES } from '../src/lib/aiDataSources'
import { budgetForKind, WRITER_BUDGET_KINDS } from '../src/lib/aiWriterBudget'
import { tableImportSplit } from '../src/lib/tableImportAI'
import '../src/lib/aiTasks' // 触发门面注册（必须在 listPrompts 之前）
import type { TabDef } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- ① 提示词契约 ----------
{
  const def = TABLE_IMPORT_PROMPTS[0]
  ok('提示词 id 是 table-import-split', def.meta.id === 'table-import-split')
  ok('分组归「设定与资料」', def.meta.group === '设定与资料')
  ok('展示名非空', def.meta.name.trim().length > 0)

  const sys = def.read()
  ok('🔴 写了「不把多个对象合并成一条」（社区核心痛点）', sys.includes('合并成一条'))
  ok('写了「只依据粘贴内容、严禁编造」', sys.includes('严禁虚构'))
  ok('要求 key 用列名原文', sys.includes('列名原文'))
  ok('要求候选值逐字挑（避免悬空引用）', sys.includes('逐字'))
  ok('提醒按表头对齐列', sys.includes('表头'))
  ok('要求只输出 JSON 数组', sys.includes('JSON 数组'))

  // 🔴 立场红线：这是文风/数据功能，绝不能沾「反检测」口径
  ok('🔴 注入文本不含「过检测 / 降 AI 率 / 绕过检测 / 反检测」',
    !/过检测|降\s*AI\s*率|绕过检测|反检测/.test(sys))

  // setter 真的能改（否则「提示词可编辑」是假的）
  const before = def.read()
  def.write(before + '\n// probe')
  ok('write 能改到模块级变量', def.read().endsWith('// probe'))
  def.write(before)
  ok('还原后与原文一致', def.read() === before)
}

// ---------- ② 门面注册（不注册 = 设置页看不到）----------
{
  const ids = listPrompts().map(p => p.id)
  ok('🔴 门面已注册 table-import-split（设置页可见）', ids.includes('table-import-split'))
  ok('注册数量 > 20（防线：注入被回滚后测试仍绿）', ids.length > 20, String(ids.length))
}

// ---------- ③ 「会读哪些数据」与预算档 ----------
{
  const f = AI_DATA_SOURCES['table-import-split']
  ok('🔴 aiDataSources 已登记（作者才看得到"本次会读"）', !!f)
  ok('声明了 excludes（不读章节正文）', !!f?.excludes?.some(x => x.includes('章节正文')))
  ok('🔴 预算档 table-import 存在', 'table-import' in WRITER_BUDGET_KINDS)
  ok('出厂基准下 table-import = 9000（与 AI 整理同档）', budgetForKind('table-import', 8000) === 9000,
    String(budgetForKind('table-import', 8000)))
}

// ---------- ④ 空内容短路（不触发模型调用）----------
{
  const tab: TabDef = {
    id: 'nations', name: '国家势力', group: '世界构建', type: 'table', description: '',
    displayCol: '名称',
    columns: [{ name: '编号' }, { name: '名称' }, { name: '类别' }],
  }
  const empty = await tableImportSplit(tab, { sourceText: '   \n  ' })
  ok('空内容直接返回、不触发模型调用', empty.rows.length === 0 && empty.chunks === 0, JSON.stringify(empty.rows.length))
  ok('空内容也带上原文快照（面板恢复用）', empty.sourceText === '   \n  ')

  // 导出确实存在（门面再导出，防止被 tree-shake 掉调用入口）
  ok('aiSplitTableRows 可导入', typeof aiSplitTableRows === 'function')
}

console.log(`\ntableImportAI: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
