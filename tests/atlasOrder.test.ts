// 3.2.0 · 图鉴卡片排序 · 单测
//
// 盯四件事：
//   ① 三档各自真的排（编号 / 名称 / 最近编辑）；
//   ② 编号比较与表格视图**同口径**（交叉断言 codeKeyOf === codeSortKey，谁改了都红）；
//   ③ 空白编号沉底、无编号列时保持原顺序（不乱排）；
//   ④ 不修改入参数组（组件每次渲染都拿它，改了会造成"越点越乱"的隐性 bug）。
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { sortAtlasRows, codeKeyOf, idColumnOf } from '@/lib/atlas/order'
import { codeSortKey } from '@/components/sheets/tableSheetOrder'
import type { TabDef, TableRow } from '@/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const tab = {
  id: 'races', name: '种族生物', group: '世界构建', type: 'table',
  columns: [{ name: '编号' }, { name: '名称' }],
  displayCol: '名称',
} as unknown as TabDef

const row = (id: string, code: string, name: string, updatedAt: number): TableRow => ({
  id, tabId: 'races', projectId: 'p', order: 0,
  data: { 编号: code, 名称: name }, createdAt: 0, updatedAt,
} as unknown as TableRow)

function main() {
  // ---------- 一、编号 ----------
  {
    const rows = [
      row('c', 'R0010', '丙', 1),
      row('a', 'R0002', '甲', 2),
      row('b', '', '乙', 3),          // 空白编号 ⇒ 沉底
    ]
    const out = sortAtlasRows(tab, rows, 'code')
    ok('① 编号升序（R0002 在 R0010 前）', out.map(r => r.id).join('') === 'acb', out.map(r => r.data['编号']).join(','))
    ok('① 空白编号沉底', out[2].id === 'b')
    ok('① 不修改入参', rows[0].id === 'c', rows.map(r => r.id).join(''))
  }

  // ---------- 二、名称 ----------
  {
    const rows = [row('x', 'R0001', '丙', 1), row('y', 'R0002', '甲', 2), row('z', 'R0003', '乙', 3)]
    const out = sortAtlasRows(tab, rows, 'name')
    // 中文 localeCompare 默认按拼音：丙(bing) < 甲(jia) < 乙(yi) —— 别按笔画/字形想当然
    ok('① 名称按中文拼音排序：丙(bing) → 甲(jia) → 乙(yi)',
      out.map(r => r.data['名称']).join(',') === '丙,甲,乙', out.map(r => r.data['名称']).join(','))
  }

  // ---------- 三、最近编辑 ----------
  {
    const rows = [row('old', 'R0001', '甲', 100), row('new', 'R0002', '乙', 900)]
    const out = sortAtlasRows(tab, rows, 'recent')
    ok('① 最近编辑的排前面', out[0].id === 'new', out.map(r => r.id).join(','))
  }

  // ---------- 四、与表格同口径（交叉断言） ----------
  {
    const samples = ['R0002', 'R0010', 'F2', 'F10', '9', '10', '', '  ', '无编号', 'R-1', 'r0001']
    const same = samples.every(s => codeKeyOf(s) === codeSortKey(s))
    ok('🔴 ② 编号排序键与表格 codeSortKey 逐样本一致（谁改了都会红）', same,
      samples.filter(s => codeKeyOf(s) !== codeSortKey(s)).join('|'))
    ok('② 自然序：F2 < F10', (codeKeyOf('F2') ?? '') < (codeKeyOf('F10') ?? ''), `${codeKeyOf('F2')} vs ${codeKeyOf('F10')}`)
    ok('② 纯文字编号不参与（返回 null）', codeKeyOf('无编号') === null)
    ok('② 空 / 空白返回 null', codeKeyOf('') === null && codeKeyOf('   ') === null)
  }

  // ---------- 五、没有编号列 ----------
  {
    const noCode = { ...tab, columns: [{ name: '名称' }] } as unknown as TabDef
    ok('③ idColumnOf 取不到编号列', idColumnOf(noCode) === null)
    const rows = [row('a', '', '甲', 1), row('b', '', '乙', 2)]
    const out = sortAtlasRows(noCode, rows, 'code')
    ok('③ 无编号列时保持原顺序（不乱排）', out.map(r => r.id).join('') === 'ab', out.map(r => r.id).join(''))
  }

  // ---------- 六、接线断言（这些破了不报错，只会悄悄失效） ----------
  {
    const root = process.cwd()
    const view = readFileSync(path.join(root, 'src/components/atlas/AtlasView.tsx'), 'utf8')
    ok('④ 卡片渲染用排序后的 orderedRows', /orderedRows\.map\(/.test(view) && !/\{rows\.map\(row => \(/.test(view))
    ok('④ 排序状态按页签偏好持久化（atlas-order）', view.includes("'atlas-order'"))
    ok('④ 三档按钮确实渲染在工具条里', view.includes('ATLAS_ORDERS.map('))
    ok('④ 排序只影响展示：不写库（组件里没有 saveTableRow / onSaveImage 之外的数据写入）',
      !/sortAtlasRows[\s\S]{0,80}(saveTableRow|setRows\()/.test(view))
  }

  console.log(`\n▶ atlasOrder: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
