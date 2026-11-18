// ============ 设定检索 · 字段清单并集（3.6.1 修「图鉴改了不同步」）============
//
// 起因（用户反馈）：在设定表单的**图鉴视图**里改了字段，切回正文编辑的设定检索看不到。
// 定位：检索页的表格分支原先只按 `tab.columns`（静态 schema）枚举字段，
//   而图鉴视图新增的自定义字段、采用模板后的字段只活在 `row.data` 里 ⇒ 永远不进索引。
// 修法：字段清单 = schema 列 ∪ 记录里真实存在的键（见 `lib/settings/settingSearchFields`）。
//
// 这里钉六件事：
//   ① 自定义键一定出现（这是本次修的核心）；
//   ② 空值不占位；
//   ③ 认识的列保留原控件类型（下拉 / 跨表引用 / 历法 / 多选角色 / 日期），否则编辑时会退化成纯文本；
//   ④ 不认识的键按文本处理，但仍能用作者起的显示名；
//   ⑤ 键顺序稳定（schema 在前、自定义键按首次出现），不随行内键顺序抖动；
//   ⑥ 只读投影：不改原 `data`。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  collectTableFields, collectTableKeys, type SearchColumnLike,
} from '../src/lib/settings/settingSearchFields'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const COLUMNS: SearchColumnLike[] = [
  { name: '编号' },
  { name: '名称' },
  { name: '类别', type: 'select', options: ['兽类', '灵植'] },
  { name: '栖息地', type: 'tableRef', refTab: 'geography', refCol: '名称' },
  { name: '发现日', type: 'date' },
  { name: '历法日', calendar: true },
  { name: '群体', type: 'characters' },
]
const columnOf = (name: string) => COLUMNS.find(c => c.name === name)

function main() {
  // ① 核心：图鉴里新增的自定义字段（不在 schema 列里）也要出现
  {
    const data = { 编号: 'R-001', 名称: '赤炎狼', 食性: '肉食', 弱点: '畏水' }
    const keys = collectTableKeys([data], COLUMNS.map(c => c.name))
    const fields = collectTableFields({ data, keys, columnOf, labels: {} })
    const names = fields.map(f => f.dataKey)
    ok('自定义字段进入字段清单（本轮修的正是这条）', names.includes('食性') && names.includes('弱点'), JSON.stringify(names))
    ok('schema 列照旧在', names.includes('名称') && names.includes('编号'), JSON.stringify(names))
    ok('自定义字段按文本处理（无控件类型）', fields.find(f => f.dataKey === '食性')?.type === undefined, JSON.stringify(fields.find(f => f.dataKey === '食性')))
  }

  // ② 空值不占位
  {
    const data = { 名称: '赤炎狼', 食性: '   ', 弱点: '' }
    const fields = collectTableFields({ data, keys: ['名称', '食性', '弱点'], columnOf, labels: {} })
    ok('空白与全空格的自定义字段不出现', fields.length === 1 && fields[0].dataKey === '名称', JSON.stringify(fields))
  }

  // ③ 认识的列保留原控件类型（编辑时才不会退化成纯文本）
  {
    const data = { 类别: '兽类', 栖息地: '北境', 发现日: '0012-03-04', 历法日: '0012-03-05', 群体: '狼群A' }
    const fields = collectTableFields({ data, keys: Object.keys(data), columnOf, labels: {} })
    const typeOf = (k: string) => fields.find(f => f.dataKey === k)?.type
    ok('select 列仍是下拉（带候选）', typeOf('类别') === 'select' && (fields.find(f => f.dataKey === '类别')?.options ?? []).length === 2)
    ok('跨表引用列仍带来源表与列', typeOf('栖息地') === 'tableRef'
      && fields.find(f => f.dataKey === '栖息地')?.refTab === 'geography'
      && fields.find(f => f.dataKey === '栖息地')?.refCol === '名称')
    ok('日期列仍是日期控件', typeOf('发现日') === 'date')
    ok('历法列仍是历法控件', typeOf('历法日') === 'calendar-select')
    ok('多选角色列仍是角色选择', typeOf('群体') === 'characters')
  }

  // ④ 显示名（别名）对自定义字段同样生效
  {
    const data = { 食性: '肉食' }
    const fields = collectTableFields({ data, keys: ['食性'], columnOf, labels: { 食性: '吃什么' } })
    ok('自定义字段用作者起的显示名', fields[0].alias === '吃什么', JSON.stringify(fields[0]))
    ok('存储键不变（回写仍按原键）', fields[0].dataKey === '食性')
  }

  // ⑤ 键顺序稳定：schema 在前，自定义按首次出现，且不重复
  {
    const a = { 名称: '甲', 自定义A: '1' }
    const b = { 自定义B: '2', 名称: '乙', 自定义A: '3' }
    const keys = collectTableKeys([a, b], ['编号', '名称'])
    ok('schema 列在最前且顺序不变', keys.slice(0, 2).join(',') === '编号,名称', keys.join(','))
    ok('自定义键按首次出现追加', keys.slice(2).join(',') === '自定义A,自定义B', keys.join(','))
    ok('同一个键不重复', new Set(keys).size === keys.length, keys.join(','))
    ok('没有 schema 列时全部按数据键排序（不崩）', collectTableKeys([{ x: '1' }], []).join(',') === 'x')
    ok('空行不产生键', collectTableKeys([{}], ['名称']).join(',') === '名称')
  }

  // ⑥ 只读：不改原 data
  {
    const data: Record<string, string> = { 名称: '赤炎狼', 食性: '肉食' }
    const before = JSON.stringify(data)
    collectTableFields({ data, keys: ['名称', '食性'], columnOf, labels: {} })
    ok('投影不改原记录', JSON.stringify(data) === before)
  }

  // ⑦ 源码闸：检索页必须走这支纯函数（否则以后又会退回只认 schema）
  {
    const src = readFileSync(path.join(process.cwd(), 'src/components/settings/SettingSearch.tsx'), 'utf8')
    ok('源码闸：检索页用 collectTableFields 建字段', src.includes('collectTableFields('))
    ok('源码闸：检索页用 collectTableKeys 求键并集', src.includes('collectTableKeys('))
    ok('源码闸：不再按 tab.columns 直接枚举字段（防回退）',
      !/fields:\s*colNames\s*\n?\s*\.filter/.test(src))
    ok('源码闸：聚焦 / 可见性变化会重建索引（跨窗口同步）',
      src.includes("window.addEventListener('focus', refresh)") && src.includes("document.addEventListener('visibilitychange', refresh)"))
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} settingSearchFields ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

main()
