// OPT-010（2026-10-19 主人反馈）：图鉴下拉接入自定义选项
//
// 病灶：图鉴详情用原生 select，只读 schema 预设选项 —— 表格模式（CustomSelect）能加的
// 自定义值看不到、也加不了。修法：详情内置下拉改走 CustomSelect（同一份
// customOption::<pid>::<tabId>::<列名> 存储），封闭枚举由 fixedOptions 挡住增改。
//
// 本文件钉三件事：
//   ① resolved 字段透传 fixedOptions（不传 ⇒ 图鉴会把保密等级这类封闭枚举也放开增改）；
//   ② 详情不再用原生 <select>（防回退）；
//   ③ 详情拿到 tabId（没有它就读不到同列的自定义值）。
import fs from 'node:fs'
import { resolveAtlasFields } from '@/lib/atlas/schema'
import type { TabDef } from '@/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- ① fixedOptions 透传 ----------
{
  const tab = {
    id: 'races', name: '种族生物', group: '世界构建', type: 'table', description: '',
    columns: [
      { name: '编号', type: 'text', width: '80' },
      { name: '名称', type: 'text', width: '120' },
      { name: '保密等级', type: 'select', options: ['S', 'A', 'B'], fixedOptions: true },
      { name: '类别', type: 'select', options: ['魔兽', '灵兽'] },
    ],
  } as unknown as TabDef
  const fields = resolveAtlasFields(tab, { purpose: 'detail' })
  const secret = fields.find(f => f.key === '保密等级')
  const plain = fields.find(f => f.key === '类别')
  ok('fixedOptions 透传：封闭枚举字段带标记', secret?.fixedOptions === true)
  ok('fixedOptions 透传：普通下拉字段不带标记', plain !== undefined && plain.fixedOptions === undefined)
  ok('options 仍然保留（预设候选不丢）', secret?.options?.length === 3 && plain?.options?.length === 2)
}

// ---------- ②③ 源码闸：图鉴详情接 CustomSelect ----------
{
  const detail = fs.readFileSync('src/components/atlas/AtlasDetail.tsx', 'utf8')
  ok('详情引入 CustomSelect', detail.includes("import CustomSelect from '@/components/common/CustomSelect'"))
  ok('🔴 详情不再用原生 <select>（防回退：原生下拉读不到自定义值）', !detail.includes('<select'))
  ok('详情把 tabId 传给字段编辑器', detail.includes('<DetailInput') && detail.includes('tabId={tabId}'))
  ok('详情下拉传 fixedOptions（封闭枚举保护）', detail.includes('field.fixedOptions ? { fixedOptions: true }'))

  const view = fs.readFileSync('src/components/atlas/AtlasView.tsx', 'utf8')
  ok('图鉴视图给详情传 tab.id', /<AtlasDetail[\s\S]{0,200}tabId=\{tab\.id\}/.test(view))
}

// ---------- 负向控制：CustomSelect 的固定选项守卫仍在 ----------
{
  const sel = fs.readFileSync('src/components/common/CustomSelect.tsx', 'utf8')
  ok('CustomSelect 对 fixedOptions 仍拒绝新增（防绕过）',
    sel.includes('if (fixedOptions) { setAdding(false); return }'))
}

console.log(`\natlasCustomOptions: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
