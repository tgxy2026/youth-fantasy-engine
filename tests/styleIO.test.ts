// ============ 3.3.3 · B4 写作规范导入 / 导出 ============
//
// 钉住：
//   ① 导出只带本页已知字段，**空值也保留**（"清空过"这个事实不能在往返中丢失）；
//   ② 导入只认本页字段：`模块::字段` 优先，字段名唯一时可只给字段名，重名不猜；
//   ③ 未知字段忽略并如实列出，不能整批失败，也不能塞进不存在的键；
//   ④ 别的页签 / 别类文件整批拒绝（不是"导进来一半"）；
//   ⑤ 差异预览：只列"导入值非空且与当前不同"的项，空值不覆盖当前（不误清空）；
//   ⑥ 采用可以只取一部分，其余字段保持当前值。
import { STYLE_SHEET_KIND, applyStyleValues, diffStyleValues, exportStyleSheet, parseStyleSheet, parseStyleSuggestions } from '../src/lib/forms/styleIO'
import type { TabDef } from '../src/lib/types'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const TAB = {
  id: 'style',
  name: '写作规范',
  description: '',
  modules: [
    {
      name: '叙述口径', fields: [
        { name: '人称', desc: '', example: '' },
        { name: '时态', desc: '', example: '' },
      ],
    },
    {
      name: '语言质感', fields: [
        { name: '句长', desc: '', example: '' },
        { name: '章末', desc: '', example: '' },
      ],
    },
  ],
} as unknown as TabDef

const OTHER = {
  id: 'world', name: '世界设定',
  modules: [{ name: '世界观', fields: [{ name: '规则', desc: '', example: '' }] }],
} as unknown as TabDef

function main() {
  // ① 往返：多行 / 中文 / 空值
  const cur: Record<string, string> = {
    '叙述口径::人称': '第三人称限知',
    '叙述口径::时态': '现在时',
    '语言质感::句长': '短句为主\n偶尔长句',
    '语言质感::章末': '',
    '历史残留键::旧字段': '不该被带走',
  }
  const file = exportStyleSheet(TAB, cur)
  ok('导出 kind/版本', file.kind === STYLE_SHEET_KIND && file.version === 1)
  ok('导出只带已知字段', Object.keys(file.fields).length === 4 && !('历史残留键::旧字段' in file.fields))
  ok('导出保留空值', file.fields['语言质感::章末'] === '')

  const back = parseStyleSheet(JSON.parse(JSON.stringify(file)), TAB)
  ok('往返可读', back.ok && back.unknown.length === 0 && back.invalid.length === 0, back.reason)
  ok('往返值一致（含多行）', back.values['语言质感::句长'] === '短句为主\n偶尔长句' && back.values['叙述口径::时态'] === '现在时')

  // ② 只给字段名：唯一时认，重名不猜
  const byLabel = parseStyleSheet({ kind: STYLE_SHEET_KIND, tabId: 'style', fields: { 人称: '第一人称', 句长: '长句' } }, TAB)
  ok('只给字段名可认', byLabel.ok && byLabel.values['叙述口径::人称'] === '第一人称' && byLabel.values['语言质感::句长'] === '长句')

  // ③ 未知字段忽略并回报
  const mixed = parseStyleSheet({
    kind: STYLE_SHEET_KIND, tabId: 'style',
    fields: { '叙述口径::人称': '第二人称', '不存在::字段': 'x', '叙述口径::时态': 3 },
  }, TAB)
  ok('未知字段被忽略并列出', mixed.ok && mixed.unknown.length === 1 && mixed.unknown[0] === '不存在::字段')
  ok('非字符串值不写入并列出', mixed.invalid.length === 1 && !('叙述口径::时态' in mixed.values))
  ok('已知字段照常导入', mixed.values['叙述口径::人称'] === '第二人称')

  // ④ 别的页签 / 别类文件整批拒绝
  const wrongTab = parseStyleSheet({ kind: STYLE_SHEET_KIND, tabId: 'world', tabName: '世界设定', fields: { '世界观::规则': 'x' } }, TAB)
  ok('别的页签拒绝', !wrongTab.ok && wrongTab.reason.includes('世界设定'))
  const wrongKind = parseStyleSheet({ kind: 'yfe-backup', fields: {} }, TAB)
  ok('别类文件拒绝', !wrongKind.ok)
  const noFields = parseStyleSheet({ kind: STYLE_SHEET_KIND, fields: [] }, TAB)
  ok('fields 不是对象拒绝', !noFields.ok)
  ok('不是对象拒绝', !parseStyleSheet('{"kind":"yfe-style-sheet"}', TAB).ok)

  // ⑤ 差异预览：空值不覆盖、相同不列
  const d = diffStyleValues(cur, {
    '叙述口径::人称': '第三人称限知', // 相同
    '叙述口径::时态': '',            // 空 ⇒ 不覆盖
    '语言质感::句长': '长句为主',     // 改
    '语言质感::章末': '',            // 当前也空 ⇒ 不算 skipped
  }, TAB)
  ok('只列真正变化的字段', d.changed.length === 1 && d.changed[0].key === '语言质感::句长', JSON.stringify(d.changed))
  ok('相同项计入 unchanged', d.unchanged === 1)
  ok('导入空值不覆盖当前（有值才算 skip）', d.skippedEmpty === 1)

  // ⑥ 采用可选子集
  const merged = applyStyleValues(cur, { '叙述口径::人称': '第二人称', '语言质感::句长': '长句' }, ['语言质感::句长'])
  ok('只采用选中的一条', merged['语言质感::句长'] === '长句' && merged['叙述口径::人称'] === '第三人称限知')
  ok('未涉及的字段不动', merged['历史残留键::旧字段'] === '不该被带走')
  const all = applyStyleValues(cur, { '叙述口径::人称': '第二人称' })
  ok('不传 keys 时全量采用', all['叙述口径::人称'] === '第二人称')

  ok('空表单也能导出', Object.keys(exportStyleSheet(TAB, {}).fields).length === 4)
  ok('其它页签导出不受影响', Object.keys(exportStyleSheet(OTHER, { '世界观::规则': 'r' }).fields).length === 1)

  // ⑦ AI 反推结果：只认已知 key、去重、空值丢弃
  const known = ['叙述口径::人称', '语言质感::句长']
  const sug = parseStyleSuggestions(JSON.stringify({
    suggestions: [
      { key: '叙述口径::人称', value: '第三人称限知', reason: '通篇"他"', quote: '他抬头' },
      { key: '叙述口径::人称', value: '重复条目应去重' },
      { key: '编造::字段', value: '不该出现' },
      { key: '语言质感::句长', value: '   ' },
      { key: '语言质感::句长', value: '短句为主' },
    ],
  }), known)
  ok('只保留已知 key 且去重', sug.length === 2 && sug[0].value === '第三人称限知' && sug[1].value === '短句为主', JSON.stringify(sug))
  ok('保留理由与引文', sug[0].reason === '通篇"他"' && sug[0].quote === '他抬头')
  ok('空值/编造字段丢弃', !sug.some(s => s.key === '编造::字段'))
  ok('代码块包裹也能解析', parseStyleSuggestions('```json\n{"suggestions":[{"key":"语言质感::句长","value":"长句"}]}\n```', known).length === 1)
  ok('形状不对当没有建议', parseStyleSuggestions('not json', known).length === 0 && parseStyleSuggestions({ suggestions: 'x' }, known).length === 0)
  ok('兼容「建议」键名', parseStyleSuggestions({ 建议: [{ key: '语言质感::句长', value: '中句' }] }, known).length === 1)

  console.log(`\nstyleIO: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()