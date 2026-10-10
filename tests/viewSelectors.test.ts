// ============ 窗口选择器单测（3.0 · 建议级③ · 2026-10-10）============
//
// 这 6 个函数原先**内联在弹窗组件里**（`audit-coverage` 的 A 类零覆盖清单）。
// 组件本身没有 React 测试工具、也不打算引（W3-3 的判），所以把「能判错的逻辑」抽出来测 ——
// 与 `BackupReminder.shouldRemind` / `desktop.decideDataFileLoad` 同一条路。
import {
  toFeedbackEntries, pickImportTargetId, tavernExportSummaryText,
  parseVarInputValue, filterNovelChars, countNovelChars,
} from '../src/lib/viewSelectors'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- 1) 反馈条目整形 ----------
{
  const rows = [
    { 数据周期: '第3周', 追读: '1200', 均订: '340', 留存: '', 高频吐槽: '节奏慢', 流失点章节: '第12章', 流失原因分析: '转折太晚' },
    { 日期: '2026-10-01', 追读: '900' },                    // 只填了追读 → 保留
    { 数据周期: '', 追读: '', 均订: '', 留存: '', 高频吐槽: '', 流失点章节: '', 流失原因分析: '' },  // 全空 → 滤掉
  ]
  const e = toFeedbackEntries(rows)
  ok('🔴 全空行被滤掉（不白占上下文）', e.length === 2, String(e.length))
  ok('period 回落到「日期」', e[1].period === '2026-10-01')
  ok('metrics 只连非空项（用 · / ·）', e[0].metrics === '1200 / 340', e[0].metrics)
  ok('metrics 单值时不加分隔符', e[1].metrics === '900', e[1].metrics)
  ok('其余字段原样带出', e[0].complaints === '节奏慢' && e[0].churnChapter === '第12章' && e[0].churnReason === '转折太晚')
  ok('空表 → 空数组', toFeedbackEntries([]).length === 0)
}

// ---------- 2) 导入目标回落 ----------
{
  ok('已选还在 ⇒ 保持不动', pickImportTargetId('s2', ['s1', 's2'], 's1') === 's2')
  ok('🔴 已选已删 ⇒ 回落到优先故事（否则会把不存在的 id 设回去）',
    pickImportTargetId('gone', ['s1', 's2'], 's2') === 's2')
  ok('优先故事也没有 ⇒ 取列表第一个', pickImportTargetId('', ['s1', 's2'], 'nope') === 's1')
  ok('优先故事不在列表 ⇒ 取第一个', pickImportTargetId('', ['s1'], 'other') === 's1')
  ok('列表为空 ⇒ 空串', pickImportTargetId('x', [], 'y') === '')
  ok('无优先故事时也能取第一个', pickImportTargetId('', ['a'], undefined) === 'a')
}

// ---------- 3) 导出摘要文案 ----------
{
  ok('数量 + 隐藏说明', tavernExportSummaryText({ exportedCount: 3, includeHidden: false, hiddenCount: 2, withMeta: false })
    === '将导出 3 条对话（已排除 2 条隐藏的）')
  ok('🔴 勾了「含隐藏」⇒ 不写「已排除」（否则文案自相矛盾）',
    tavernExportSummaryText({ exportedCount: 3, includeHidden: true, hiddenCount: 2, withMeta: false })
    === '将导出 3 条对话')
  ok('没有隐藏项 ⇒ 不写排除说明',
    tavernExportSummaryText({ exportedCount: 5, includeHidden: false, hiddenCount: 0, withMeta: false })
    === '将导出 5 条对话')
  ok('两段用 · 连接', tavernExportSummaryText({ exportedCount: 2, includeHidden: false, hiddenCount: 0, withMeta: true })
    === '将导出 2 条对话 · 附角色与场景信息')
  ok('自定义 metaLabel 优先', tavernExportSummaryText({ exportedCount: 1, includeHidden: false, hiddenCount: 0, withMeta: true, metaLabel: '含时间线' })
    === '将导出 1 条对话 · 含时间线')
  ok('数量未知 ⇒ 只剩 meta 段',
    tavernExportSummaryText({ includeHidden: false, hiddenCount: 0, withMeta: true }) === '附角色与场景信息')
  ok('两段都空 ⇒ 空串',
    tavernExportSummaryText({ includeHidden: false, hiddenCount: 0, withMeta: false }) === '')
}

// ---------- 4) 数值输入解析 ----------
{
  ok('数值项：正常数', parseVarInputValue('num', '45', 0) === 45)
  ok('数值项：负数也行', parseVarInputValue('num', '-10', 0) === -10)
  ok('数值项：小数', parseVarInputValue('num', '3.5', 0) === 3.5)
  ok('🔴 数值项：空 ⇒ 回落出厂值', parseVarInputValue('num', '', 7) === 7)
  ok('数值项：只有空格也算空', parseVarInputValue('num', '   ', 7) === 7)
  ok('🔴 数值项：非数字 ⇒ 回落出厂值（绝不存 NaN）', parseVarInputValue('num', 'abc', 7) === 7)
  ok('数值项：两头空格被 trim', parseVarInputValue('num', '  8  ', 0) === 8)
  ok('🔴 文本项：空串原样（不清成出厂值）', parseVarInputValue('text', '', 7) === '')
  ok('🔴 文本项：原样保留空格（地点名可能带空格）', parseVarInputValue('text', ' 老城区 便利店 ', 0) === ' 老城区 便利店 ')
}

// ---------- 5) 小说角色筛选 ----------
{
  const chars = [
    { id: 'a', name: '洛汐', tabId: 'char-main' },
    { id: 'b', name: '楚楠', tabId: 'char-secondary' },
    { id: 'c', name: 'Loxi', tabId: 'char-npc' },
  ]
  ok('tab=all ⇒ 全部', filterNovelChars(chars, '', 'all').length === 3)
  ok('按分组过滤', filterNovelChars(chars, '', 'char-main').map(c => c.id).join() === 'a')
  ok('关键字按名字过滤', filterNovelChars(chars, '楚', 'all').map(c => c.id).join() === 'b')
  ok('🔴 关键字忽略大小写', filterNovelChars(chars, 'loxi', 'all').map(c => c.id).join() === 'c')
  ok('关键字两头空格被忽略', filterNovelChars(chars, '  洛汐  ', 'all').map(c => c.id).join() === 'a')
  ok('分组 + 关键字叠加（不匹配 ⇒ 空）', filterNovelChars(chars, '洛汐', 'char-npc').length === 0)
}

// ---------- 6) 分组计数 ----------
{
  const chars = [{ tabId: 'char-main' }, { tabId: 'char-main' }, { tabId: 'char-npc' }]
  ok('all ⇒ 总数', countNovelChars(chars, 'all') === 3)
  ok('分组 ⇒ 该组数', countNovelChars(chars, 'char-main') === 2)
  ok('空分组 ⇒ 0', countNovelChars(chars, 'char-secondary') === 0)
}

console.log(`\nviewSelectors: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
