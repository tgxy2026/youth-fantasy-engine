// ============ 图鉴字段底座闸（3.1.3 · 图鉴 + 自定义字段骨架）============
//
// 钉住四类**会静默漂移**的东西（都不会报错，只会让图鉴「显示不对」）：
//   ① 空值口径：`'0'` / `'false'` 不是空 —— 写错就会把「威胁等级 0」「是否敌对 否」显示成空白；
//   ② 分组键命中率：`GROUP_SPEC` 写的是**存储键（列名）**，列名改一个字，字段就静默掉进「补充资料」；
//   ③ 字段身份：别名只许改 label，`key` 必须仍是存储键（否则改名就丢数据）；
//   ④ 数据来源唯一：图鉴不许自己读库，必须吃调用方传进来的 filteredRows（已含草稿 + 筛选）。
import fs from 'node:fs'
import path from 'node:path'
import { TABS } from '@/lib/schema'
import type { TabDef } from '@/lib/types'
import type { AtlasFieldDefinition, AtlasSchemaConfig, CustomFieldType } from '@/lib/atlas/types'
import {
  ATLAS_TABS, atlasBadgeKeys, atlasCardBadges, atlasSections, atlasSummaryFields, atlasSearchText,
  atlasAiVisibilityChanged, atlasFieldsForCategory,
  defaultSummaryKeys, emptyAtlasSchema, isAtlasTab, resolveAtlasFields,
} from '@/lib/atlas/schema'
import { atlasColumnsOf } from '@/lib/atlas/columns'
import { ATLAS_FORMAT_VERSION, checkAtlasWritable } from '@/lib/atlas/persistence'
import { atlasFieldHintForAI } from '@/lib/ai/atlasContext'
import {
  ATLAS_TOTAL_LIMIT, atlasImageUsageOf, atlasUsageLabel, atlasUsageRatio, atlasUsageText,
  checkAtlasBudget, formatBytes,
} from '@/lib/atlas/quota'
import {
  ATLAS_PACKAGE_MAX_IMAGE_CHARS, ATLAS_PACKAGE_MAX_ROWS,
  buildAtlasPackage, packageRowId, parseAtlasPackage, planAtlasImport, previewAtlasImport,
  sameAtlasFieldDefinition, uniqueFieldLabel,
} from '@/lib/atlas/packageIO'
import { dataUrlBytes } from '@/lib/media/imagePortrait'
import {
  buildImportPrepared, csvCell, exportRowsCsv, mapHeaders, parseCsvGrid, parseImportText,
} from '@/lib/storage/tableIO'
import { collectIndexDocs, type AtlasIndexFieldRule } from '@/lib/semantic/indexer'
import {
  formatBooleanValue, formatCustomValue, formatMultiSelectValues,
  isEmptyValue, parseMultiSelectValues, coerceAiValue, parseTypedImportValue,
} from '@/lib/atlas/values'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ROOT = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const tabOf = (id: string): TabDef => {
  const t = TABS.find(x => x.id === id)
  if (!t) throw new Error(`找不到页签 ${id}`)
  return t
}

console.log('—— atlasFields：图鉴字段底座闸（3.1.3）——')

// ---------- ① 空值口径 ----------
{
  ok('① 空串 / 纯空白 = 空', isEmptyValue('') && isEmptyValue('   '))
  ok('① 负向：`0` 不是空', !isEmptyValue('0'))
  ok('① 负向：`false` 不是空', !isEmptyValue('false'))
  ok('① 负向：空数组串 `[]` 不是空', !isEmptyValue('[]'))
}

// ---------- ② 多选 / 布尔 / 数字 ----------
{
  ok('② 多选解析：合法 JSON 数组', JSON.stringify(parseMultiSelectValues('["刀","盾"]')) === '["刀","盾"]')
  ok('② 负向：非 JSON 串解析为空（不猜）', parseMultiSelectValues('刀,盾').length === 0)
  ok('② 负向：JSON 但不是数组 ⇒ 空', parseMultiSelectValues('{"a":1}').length === 0)
  ok('② 多选写回：空数组存空串（不留 `[]`）', formatMultiSelectValues([]) === '')
  ok('② 多选写回：保持顺序', formatMultiSelectValues(['盾', '刀']) === '["盾","刀"]')
  ok('② 布尔：true/false 翻成是/否', formatBooleanValue('true') === '是' && formatBooleanValue('false') === '否')
  ok('② 负向：布尔脏值原样透出（不静默当「否」）', formatBooleanValue('yes') === 'yes')
  ok('② 多选显示：顿号连接', formatCustomValue('multiSelect', '["刀","盾"]') === '刀、盾')
  ok('② 数字：保留用户原串 + 单位', formatCustomValue('number', '3.50', '年') === '3.50 年')
  ok('② 负向：空值不拼单位', formatCustomValue('number', '', '年') === '')
}

// ---------- ③ 只开放两个页签 ----------
{
  ok('③ ATLAS_TABS = 四个世界构建页签',
    ATLAS_TABS.length === 4
    && ['races', 'items', 'nations', 'geography'].every(id => ATLAS_TABS.includes(id as never)))
  ok('③ 负向：其他页签不算图鉴页签', !isAtlasTab('history') && !isAtlasTab('items-x'))
}

// ---------- ④ 分组键命中：内置字段不许静默掉进「补充资料」 ----------
// 🔴 这是本闸的核心：GROUP_SPEC 里写的是列名（存储键）。part2.ts 改了列名而这里没跟上时，
//    界面只是「字段位置不对」，没有任何报错 —— 所以必须钉住。
{
  for (const tabId of ['races', 'items'] as const) {
    const tab = tabOf(tabId)
    const builtin = resolveAtlasFields(tab, { purpose: 'detail' }).filter(f => f.source === 'builtin')
    const visibleCols = (tab.columns ?? []).filter(c => !c.hidden)
    ok(`④ ${tabId}：内置字段数 = 非隐藏列数`, builtin.length === visibleCols.length, `${builtin.length} vs ${visibleCols.length}`)

    const allowedInExtra = tabId === 'races' ? ['备注'] : ['备注']
    const strays = builtin.filter(f => f.groupId === 'extra' && !allowedInExtra.includes(f.key))
    ok(`④ ${tabId}：除「备注」外没有字段掉进「补充资料」`, strays.length === 0, strays.map(f => f.key).join(','))

    // 关键业务字段必须落在预期分组（分组标题是方案 §3.2 那张表）
    const groupOf = (k: string) => builtin.find(f => f.key === k)?.groupId
    if (tabId === 'races') {
      ok('④ races：威胁等级 → 能力与弱点', groupOf('威胁等级') === 'ability')
      ok('④ races：分布区域 → 生态与社会', groupOf('分布区域') === 'eco')
      ok('④ races：契约/驯化关系 → 契约关系', groupOf('契约/驯化关系') === 'pact')
    } else {
      ok('④ items：品级 → 基本资料', groupOf('品级') === 'basic')
      ok('④ items：能力/效果 → 来源与效果', groupOf('能力/效果') === 'source')
      ok('④ items：当前持有者 → 持有与流转', groupOf('当前持有者') === 'hold')
    }
  }
}

// ---------- ⑤ 字段身份：别名只改显示名 ----------
{
  const races = tabOf('races')
  const fields = resolveAtlasFields(races, { aliases: { 威胁等级: '危险度' }, purpose: 'detail' })
  const f = fields.find(x => x.key === '威胁等级')
  ok('⑤ 别名改的是 label', f?.label === '危险度')
  ok('⑤ 负向：key 仍是存储键（改名不丢数据）', f?.key === '威胁等级')
}

// ---------- ⑥ 自定义字段：归档 / 类别适用 / 可见性 ----------
{
  const races = tabOf('races')
  const mk = (over: Partial<AtlasFieldDefinition>): AtlasFieldDefinition => ({
    id: 'cf_test', label: '食性', type: 'text', description: '', appliesTo: '*',
    groupId: 'extra', order: 100, tableVisible: true, detailVisible: true,
    searchable: true, aiReadable: true, aiWritable: false, archived: false, ...over,
  })
  const cfg = (fields: AtlasFieldDefinition[]): AtlasSchemaConfig => ({ ...emptyAtlasSchema(), fields })

  const active = resolveAtlasFields(races, { config: cfg([mk({})]) }).filter(f => f.source === 'custom')
  ok('⑥ 自定义字段默认出现', active.length === 1 && active[0].key === 'cf_test')

  const archived = resolveAtlasFields(races, { config: cfg([mk({ archived: true })]) }).filter(f => f.source === 'custom')
  ok('⑥ 负向：归档字段不出现', archived.length === 0)

  const limited = cfg([mk({ appliesTo: ['魔兽'] })])
  ok('⑥ 类别匹配 ⇒ 出现', resolveAtlasFields(races, { config: limited, category: '魔兽' }).some(f => f.key === 'cf_test'))
  ok('⑥ 负向：类别不匹配 ⇒ 不出现', !resolveAtlasFields(races, { config: limited, category: '人族' }).some(f => f.key === 'cf_test'))
  ok('⑥ 负向：没填类别时只留「不限类别」字段', !resolveAtlasFields(races, { config: limited }).some(f => f.key === 'cf_test'))

  const hiddenInTable = cfg([mk({ tableVisible: false })])
  ok('⑥ 负向：tableVisible=false 在表格用途下被过滤', !resolveAtlasFields(races, { config: hiddenInTable, purpose: 'table' }).some(f => f.key === 'cf_test'))
  ok('⑥ 但详情用途仍然可见', resolveAtlasFields(races, { config: hiddenInTable, purpose: 'detail' }).some(f => f.key === 'cf_test'))
}

// ---------- ⑦ 分组聚合与摘要 ----------
{
  const races = tabOf('races')
  const fields = resolveAtlasFields(races, { purpose: 'detail' })
  const secs = atlasSections(races, fields)
  const ids = secs.map(s => s.id)
  ok('⑦ 分组顺序：基本资料在最前', ids[0] === 'basic')
  ok('⑦ 分组顺序：能力与弱点在生态与社会之前', ids.indexOf('ability') < ids.indexOf('eco'))
  ok('⑦ 分组里没有空组', secs.every(s => s.fields.length > 0))

  const summary = atlasSummaryFields('races', fields)
  ok('⑦ 摘要默认 3 项', summary.length === 3)
  // 2026-10-18：默认摘要不再含徽标字段（顶上「类别 + 威胁等级」已经显示过，重复就是同一行字出现两次）
  ok('⑦ 摘要默认顺序（已避开徽标字段）', summary.map(f => f.key).join('|') === '分布区域|能力特性|社会结构')
  ok('⑦ 负向：默认摘要里不许出现徽标字段', !summary.some(f => atlasBadgeKeys('races').includes(f.key)))
  ok('⑦ 负向：摘要不超过 3 项', atlasSummaryFields('items', resolveAtlasFields(tabOf('items'), { purpose: 'detail' })).length <= 3)

  ok('⑦ 卡片徽标：空值不占位', atlasCardBadges('races', {}).length === 0)
  ok('⑦ 卡片徽标：类别 + 威胁等级', atlasCardBadges('races', { 类别: '魔兽', 威胁等级: '中' }).join('/') === '魔兽/中')
  ok('⑦ 卡片徽标：物品取品级', atlasCardBadges('items', { 类别: '丹药', 品级: '玄阶' }).join('/') === '丹药/玄阶')
}

// ---------- ⑧ 源码闸：入口唯一、数据来源唯一 ----------
{
  const tableSheet = read('src/components/sheets/TableSheet.tsx')
  ok('⑧ 表头有「图鉴」入口且走 isAtlasCapable', tableSheet.includes('isAtlasCapable') && tableSheet.includes('图鉴'))
  ok('⑧ 图鉴吃的是 filteredRows（含草稿 + 筛选）', /rows=\{filteredRows\}/.test(tableSheet))

  const view = read('src/components/atlas/AtlasView.tsx')
  ok('⑧ 负向：图鉴组件不许自己读库（绕过草稿就会「表格改了图鉴看不见」）',
    !view.includes('getTableRows') && !view.includes("@/lib/db"))
  // 🔴 实测踩过：图鉴少传 config ⇒ 表格里新建的字段图鉴完全看不见，且不报错
  ok('⑧ 图鉴把字段配置传进解析层', /resolveAtlasFields\(tab, \{ aliases, config, purpose: 'detail'/.test(view))
  // 3.1.3 · R02：详情必须**按选中条目的类别**过滤（不传类别 ⇒ 类别限定字段一律消失）
  ok('⑧ R02：详情按选中条目的类别取字段', view.includes('atlasFieldsForCategory'))
  ok('⑧ R02：表结构取全量（类别不适用也不该整列消失）',
    read('src/lib/atlas/columns.ts').includes('ignoreAppliesTo: true'))
  ok('⑧ R02：检索逐行按类别过滤', read('src/lib/search/search.ts').includes('atlasFieldsForCategory'))
  ok('⑧ 表格把字段配置传给图鉴', /config=\{atlasConfig\}/.test(read('src/components/sheets/TableSheet.tsx')))

  // 负向：字段解析只能有一个入口，组件里不许再自己筛 columns 拼字段
  const card = read('src/components/atlas/AtlasCard.tsx')
  ok('⑧ 负向：卡片不直接读 tab.columns（一律走 resolveAtlasFields）',
    !card.includes('tab.columns'))
}

// ---------- ⑨ 列映射：自定义字段 → 表格列（F3） ----------
{
  const races = tabOf('races')
  const base = atlasColumnsOf(races)
  ok('⑨ 无配置时列数 = 非隐藏列数', base.length === (races.columns ?? []).filter(c => !c.hidden).length)
  ok('⑨ 无配置时没有自定义列标记', base.every(c => !c.atlasField))

  const mk = (over: Partial<AtlasFieldDefinition>): AtlasFieldDefinition => ({
    id: 'cf_diet', label: '食性', type: 'select', description: '吃什么', options: ['肉食', '草食'],
    appliesTo: '*', groupId: 'ability', order: 10, tableVisible: true, detailVisible: true,
    searchable: true, aiReadable: true, aiWritable: false, archived: false, ...over,
  })
  const cfg = (fields: AtlasFieldDefinition[]): AtlasSchemaConfig => ({ ...emptyAtlasSchema(), fields })

  const cols = atlasColumnsOf(races, cfg([mk({})]))
  ok('⑨ 自定义列追加在末尾', cols.length === base.length + 1 && cols[cols.length - 1].name === 'cf_diet')
  const last = cols[cols.length - 1]
  ok('⑨ 列名＝存储键（不是显示名）', last.name === 'cf_diet' && last.atlasField?.label === '食性')
  ok('⑨ 单选映射为 select 且带选项', last.type === 'select' && (last.options ?? []).join('/') === '肉食/草食')

  const boolCol = atlasColumnsOf(races, cfg([mk({ id: 'cf_b', label: '敌对', type: 'boolean', options: undefined })])).pop()
  ok('⑨ 布尔列固定两值 + 不给自定义选项入口',
    (boolCol?.options ?? []).join('/') === 'true/false' && boolCol?.fixedOptions === true)

  const hiddenCol = atlasColumnsOf(races, cfg([mk({ tableVisible: false })])).pop()
  ok('⑨ 负向：tableVisible=false 不进表格列', hiddenCol?.name !== 'cf_diet')

  ok('⑨ 归档字段不进表格列',
    atlasColumnsOf(races, cfg([mk({ archived: true })])).every(c => c.name !== 'cf_diet'))

  // 负向守卫：内置列必须原样（含存储键与 hidden 过滤），不能被自定义映射顺手改掉
  const builtinKept = cols.slice(0, base.length).every((c, i) => c.name === base[i].name && c.type === base[i].type)
  ok('⑨ 内置列原样保留（顺序 / 键 / 类型都不动）', builtinKept)
}

// ---------- ⑩ 源码闸：配置面板与单元格分流 ----------
{
  const mgr = read('src/components/atlas/AtlasFieldManager.tsx')
  ok('⑩ 配置面板有归档与恢复（本版不做永久删除）', mgr.includes('归档') && mgr.includes('恢复'))
  ok('⑩ 负向：配置面板不提供「永久删除字段」入口（方案 §5.2 要求先备份）',
    !/删除字段/.test(mgr))

  const row = read('src/components/sheets/TableSheetRow.tsx')
  ok('⑩ 行渲染：自定义字段走 AtlasCellInput 分流', row.includes('col.atlasField') && row.includes('AtlasCellInput'))
  ok('⑩ 行渲染：列来源是 effectiveColumns（不再直接读 tab.columns）', row.includes('effectiveColumns.map'))

  const sheet = read('src/components/sheets/TableSheet.tsx')
  ok('⑩ 表头有「字段」设置入口且只在图鉴页签出现',
    sheet.includes('setShowFieldMgr') && /isAtlasCapable && \(\s*<Button variant="secondary" onClick=\{\(\) => setShowFieldMgr\(true\)\}/.test(sheet))
}

// ---------- ⑪ AI 回填值校验（方案 §7.3：不合法值不写库） ----------
{
  const f = (type: CustomFieldType, options?: string[]) => ({ type, options, label: '食性' })

  ok('⑪ 空值合法（AI 说「没提到」不该算错误）', coerceAiValue(f('text'), '').ok === true && (coerceAiValue(f('text'), '') as { value: string }).value === '')
  ok('⑪ 数字：合法数字保留原写法', (coerceAiValue(f('number'), '3.50') as { value: string }).value === '3.50')
  ok('⑪ 负向：非数字被拒（否则排序 / 图表会出 NaN）', coerceAiValue(f('number'), '很多').ok === false)
  ok('⑪ 布尔：是/否 与 true/false 都收', (coerceAiValue(f('boolean'), '是') as { value: string }).value === 'true'
    && (coerceAiValue(f('boolean'), false) as { value: string }).value === 'false')
  ok('⑪ 负向：布尔模糊值被拒（不能替作者默认成「否」）', coerceAiValue(f('boolean'), '也许').ok === false)
  ok('⑪ 单选命中选项', coerceAiValue(f('select', ['肉食', '草食']), '草食').ok === true)
  ok('⑪ 负向：单选自创选项被拒（不许静默长草）', coerceAiValue(f('select', ['肉食', '草食']), '光合作用').ok === false)
  ok('⑪ 多选：只留命中项并保序',
    (coerceAiValue(f('multiSelect', ['刀', '盾']), ['盾', '非法', '刀']) as { value: string }).value === '["盾","刀"]')
  ok('⑪ 负向：多选一项都不命中则整体拒绝', coerceAiValue(f('multiSelect', ['刀', '盾']), ['非法']).ok === false)
  ok('⑪ 短文本超 200 字截断', (coerceAiValue(f('text'), 'x'.repeat(260)) as { value: string }).value.length === 200)
  ok('⑪ 长文本 260 字不截断（上限 10000）', (coerceAiValue(f('longText'), 'x'.repeat(260)) as { value: string }).value.length === 260)
}

// ---------- ⑫ AI 接入与多选控件（源码闸） ----------
{
  const model = read('src/components/sheets/useTableSheetModel.ts')
  // 3.1.3 · R12：清单改为按 `purpose:'aiWrite'` 独立解析（不再从"表格可见列"派生）
  ok('⑫ 交给 AI 的字段清单按 aiWrite 解析（含自定义字段）',
    /const tableFields = useMemo<TemplateField\[\]>/.test(model)
    && /purpose: 'aiWrite'/.test(model))
  ok('⑫ 未开放「允许 AI 填写」的自定义字段不进清单（口径在 resolveAtlasFields 里）',
    /purpose: 'aiWrite'/.test(model) && /aiWriteFieldsOf/.test(model)
    // 口径仍只有一处：解析侧按 aiWritable 过滤，投影侧只收 source==='custom'
    // 🔴 断言「同一行里按 aiWrite 口径读 aiWritable」而非整行字面量：
    //    过滤条件可能因其他选项（如 !raw 快照视图）调整前缀，约束点不应随之假红
    && /purpose === 'aiWrite'.*aiWritable/.test(read('src/lib/atlas/schema.ts'))
    && read('src/lib/templates/consumers.ts').includes("if (f.source === 'custom')"))
  ok('⑫ 三条 AI 写入路径都过类型校验（新增 / 补全 / 整理）',
    (model.match(/coerceAiValue\(/g) ?? []).length >= 3)

  const cell = read('src/components/atlas/AtlasCellInput.tsx')
  ok('⑫ 多选字段用勾选控件（不再只靠手打分隔符）', /type="checkbox"/.test(cell) && cell.includes('parseMultiSelectValues'))
  ok('⑫ 负向：多选勾选保持选择顺序（不排序、不去重打乱）',
    cell.includes('selected.includes(o) ? selected.filter') && !cell.includes('.sort()'))
}

// ---------- ⑬ 卡片摘要可配置 + 类别适用豁免（方案 §3.2） ----------
{
  const races = tabOf('races')
  const def = (over: Partial<AtlasFieldDefinition>): AtlasFieldDefinition => ({
    id: 'cf_diet', label: '食性', type: 'text', description: '', appliesTo: '*', groupId: 'extra',
    order: 100, tableVisible: true, detailVisible: true, searchable: true,
    aiReadable: true, aiWritable: false, archived: false, ...over,
  })
  const cfg: AtlasSchemaConfig = { ...emptyAtlasSchema(), fields: [def({})], summaryKeys: ['cf_diet', '威胁等级'] }
  const wide = resolveAtlasFields(races, { config: cfg, purpose: 'export', ignoreAppliesTo: true })
  const sum = atlasSummaryFields('races', wide, cfg)
  ok('⑬ 摘要按作者勾选顺序取', sum.map(f => f.key).join('|') === 'cf_diet|威胁等级')
  ok('⑬ 摘要最多 3 项', atlasSummaryFields('races', wide, { ...cfg, summaryKeys: ['cf_diet', '威胁等级', '分布区域', '能力特性'] }).length === 3)

  const limitedCfg: AtlasSchemaConfig = { ...emptyAtlasSchema(), fields: [def({ id: 'cf_x', label: '只在魔兽', appliesTo: ['魔兽'] })] }
  ok('⑬ 摘要候选忽略类别适用（否则作者根本选不到它）',
    resolveAtlasFields(races, { config: limitedCfg, purpose: 'export', ignoreAppliesTo: true }).some(f => f.key === 'cf_x'))
  ok('⑬ 负向：详情用途仍按类别过滤（没填类别时只留不限类别的字段）',
    !resolveAtlasFields(races, { config: limitedCfg, purpose: 'detail' }).some(f => f.key === 'cf_x'))
}

// ---------- ⑭ 检索正文：字段名可搜、内部键不外露（方案 §8.1） ----------
{
  const races = tabOf('races')
  const cfg: AtlasSchemaConfig = {
    ...emptyAtlasSchema(),
    fields: [
      { id: 'cf_diet', label: '食性', type: 'text', description: '', appliesTo: '*', groupId: 'extra', order: 10, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: false, archived: false },
      { id: 'cf_weak', label: '弱点类型', type: 'multiSelect', description: '', options: ['怕火', '怕水'], appliesTo: '*', groupId: 'extra', order: 20, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: false, archived: false },
    ],
  }
  const fields = resolveAtlasFields(races, { config: cfg, purpose: 'search' })
  const text = atlasSearchText(fields, { 名称: '墨鳞蟒', 威胁等级: '中', cf_diet: '肉食', cf_weak: '["怕水","怕火"]' })
  ok('⑭ 正文含可读字段名（搜字段名也能命中）', text.includes('名称：墨鳞蟒') && text.includes('威胁等级：中'))
  ok('⑭ 自定义字段值进正文', text.includes('食性：肉食'))
  ok('⑭ 负向：`cf_` 内部键不外露', !text.includes('cf_diet') && !text.includes('cf_weak'))
  ok('⑭ 多选按顿号展开（JSON 括号不污染分词）', text.includes('怕水、怕火'))

  // searchable=false 的字段不进检索正文
  cfg.fields[0].searchable = false
  const filtered = resolveAtlasFields(races, { config: cfg, purpose: 'search' })
  ok('⑭ 负向：关掉「可被搜索」的字段不进正文',
    !atlasSearchText(filtered, { cf_diet: '肉食' }).includes('食性'))
}

// ---------- ⑮ 视图 / 密度偏好记忆（方案 §3.4） ----------
{
  const model = read('src/components/sheets/useTableSheetModel.ts')
  ok('⑮ 视图偏好按项目 + 页签记忆', model.includes('usePersistedEnum<TableViewMode>') && model.includes('table-view::'))
  ok('⑮ 负向：切页签不再强制重置成表格（否则记忆永远失效）',
    !/^\s*setViewMode\('table'\)\s*$/m.test(model))
  const view = read('src/components/atlas/AtlasView.tsx')
  ok('⑮ 卡片密度持久化且三档', view.includes("'atlas-density'") && view.includes('compact') && view.includes('loose'))
}

// ---------- ⑯ 详情「显示未填写字段」（方案 §3.2） ----------
{
  const detail = read('src/components/atlas/AtlasDetail.tsx')
  ok('⑯ 详情提供「显示未填写字段」开关', detail.includes('显示未填写字段') && detail.includes('showEmpty'))
  ok('⑯ 负向：默认收起未填字段（不是默认全展开）', /useState\(false\)/.test(detail))
}

// ---------- ⑰ 图鉴主图：规格、安全与"重建不丢图"（方案 §6） ----------
{
  const img = read('src/lib/atlas/image.ts')
  ok('⑰ 最长边 1024 / 单张 200KB / 原图 8MB（与方案 §6.2 一致）',
    img.includes('ATLAS_IMAGE_MAX_EDGE = 1024')
    && img.includes('ATLAS_IMAGE_TARGET_BYTES = 200 * 1024')
    && img.includes('ATLAS_IMAGE_MAX_INPUT_BYTES = 8 * 1024 * 1024'))
  ok('⑰ 负向：显式拒绝 SVG（可执行内容）', img.includes('image/svg+xml') && img.includes("不支持 SVG"))
  ok('⑰ 超限不返回半成品（压不下去就报错换图）', /达不到|压到最小/.test(img))
  ok('⑰ 复用 fitInside（不放大）与 dataUrlBytes（字节口径单一真源）',
    img.includes('fitInside') && img.includes('dataUrlBytes'))

  ok('⑰ TableRow 有顶层 atlasImage 字段', /atlasImage\?: AtlasImage/.test(read('src/lib/types.ts')))
  ok('⑰ 保存主图用展开写（不会顺手抹掉其他顶层字段）',
    /const next: TableRow = \{ \.\.\.row \}/.test(read('src/components/sheets/useTableSheetModel.ts')))
  ok('⑰ 卡片有图时等比完整显示（不裁切）', read('src/components/atlas/AtlasCard.tsx').includes('object-contain'))
  ok('⑰ 备份分片认得图鉴图（row:*:atlas）', read('src/lib/backup/shards.ts').includes('row:${row.id}:atlas'))

  // 🔴 这条是"图不丢"的总闸：src/lib 下所有写回 tableRows 的地方都必须展开原行
  const files = fs.readdirSync(path.join(ROOT, 'src/lib/db')).filter(f => f.endsWith('.ts'))
  const offenders: string[] = []
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/db', f), 'utf8')
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      if (!line.includes("put('tableRows'")) return
      // 允许两种：展开写 `{ ...x, ...}`（安全）或"新建行"（紧随其后出现 id: uid()/新 id 且没有展开）
      const block = lines.slice(i, i + 8).join('\n')
      const spreads = block.includes('...r') || block.includes('...row') || block.includes('...rest')
      const isNewRow = /id: (uid\(\)|`ch-|'MAP)/.test(block)
      if (!spreads && !isNewRow) offenders.push(`${f}:${i + 1}`)
    })
  }
  ok('⑰ 所有 tableRows 写回都是展开写或新建行（否则图会静默丢）', offenders.length === 0, offenders.join(','))
}

// ---------- ⑱ 项目图片容量闸（方案 §6.2） ----------
{
  const rows: Array<{ atlasImage?: { bytes: number } }> = [
    { atlasImage: { bytes: 200 * 1024 } },
    { atlasImage: { bytes: 300 * 1024 } },
    {},                       // 无图条目不计数
  ]
  const usage = atlasImageUsageOf(rows as never[])
  ok('⑱ 用量累加（无图条目不计）', usage.used === 500 * 1024 && usage.count === 2)

  const under = checkAtlasBudget(0, 1024)
  ok('⑱ 远低于上限 ⇒ ok', under.level === 'ok' && under.after === 1024)

  const warn = checkAtlasBudget(Math.floor(ATLAS_TOTAL_LIMIT * 0.7), Math.floor(ATLAS_TOTAL_LIMIT * 0.15))
  ok('⑱ 超过 80% ⇒ warn（提前预警）', warn.level === 'warn')

  const over = checkAtlasBudget(ATLAS_TOTAL_LIMIT - 10, 100)
  ok('⑱ 超上限 ⇒ over 且给出原因', over.level === 'over' && !!over.reason)

  const shrink = checkAtlasBudget(ATLAS_TOTAL_LIMIT - 10, -100)
  // 注意：总量本身已接近满时，负增量后仍可能落在 warn 区（该提示就提示）——
  // 这条要钉的是「不会被判超限」，不是「一定显示 ok」
  ok('⑱ 负增量（换小图 / 删图）永远放行', shrink.level !== 'over' && shrink.after < ATLAS_TOTAL_LIMIT)

  ok('⑱ 体积文案与备份列表同口径', formatBytes(1024) === '1 KB' && formatBytes(3 * 1024 * 1024) === '3.0 MB')
  ok('⑱ 用量百分比文案', atlasUsageLabel(ATLAS_TOTAL_LIMIT / 4).includes('25%'))

  const detail = read('src/components/atlas/AtlasDetail.tsx')
  ok('⑱ 替换图片按净增量判断（换小图不会被误判超限）',
    detail.includes('projectImageBytes - before'))
  ok('⑱ 超限时拒绝写入（只提示，不落库）',
    /check\.level === 'over'\) \{[\s\S]{0,200}return/.test(detail))
  ok('⑱ 用量提示有 80% 琥珀 / 超限红 三档', detail.includes("usageRatio >= 0.8") && detail.includes('text-danger'))
}

// ---------- ⑲ CSV 与图鉴资料包（方案 §8.2 / §8.3） ----------
{
  const races = tabOf('races')
  const extras = [{ name: 'cf_diet', label: '食性' }]

  // 列映射
  const m = mapHeaders(['名称', '食性', '不存在的列'], races, extras)
  ok('⑲ 内置列优先命中', m[0] === '名称')
  ok('⑲ 自定义字段按字段名命中（返回存储键）', m[1] === 'cf_diet')
  ok('⑲ 负向：未知列 → null（导入会明确报"未识别"而不是静默丢）', m[2] === null)
  ok('⑲ 负向：手改过的 CSV 直接写 cf 键也认', mapHeaders(['cf_diet'], races, extras)[0] === 'cf_diet')

  // CSV 导出
  const rows = [{
    id: 'r1', projectId: 'p1', tabId: 'races', order: 0,
    data: { 名称: '墨鳞蟒', 保密等级: 'S', cf_diet: '肉食', cf_weak: '["怕水","怕火"]' },
  }] as never[]
  const cols = [
    { name: '名称' },
    { name: '保密等级' },
    { name: 'cf_diet', label: '食性' },
    { name: 'cf_weak', label: '弱点类型' },
  ]
  const csv = exportRowsCsv(races, rows, {
    columns: cols,
    textOf: (n, raw) => (n === 'cf_weak' ? '怕水、怕火' : raw),
  })
  const head = csv.split('\n')[0]
  ok('⑲ 列头用字段名（不把 cf_ 暴露给作者）', head.includes('食性') && !head.includes('cf_'))
  ok('⑲ 自定义值按可读形态导出（多选→顿号）', csv.includes('怕水、怕火'))
  ok('⑲ 负向：内置值原样（保密等级仍是 S，不是长文案）', csv.includes('S') && !csv.includes('绝密'))

  // 资料包
  const field: AtlasFieldDefinition = {
    id: 'cf_diet', label: '食性', type: 'text', description: '', appliesTo: '*', groupId: 'extra',
    order: 0, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: false, archived: false,
  }
  const cfg: AtlasSchemaConfig = { ...emptyAtlasSchema(), fields: [field] }
  const pkg = buildAtlasPackage(races, cfg, rows as never, { now: 1 })
  ok('⑲ 造包：带字段定义与条目', pkg.schema.fields.length === 1 && pkg.rows.length === 1)
  ok('⑲ 造包：归档字段不进包', buildAtlasPackage(races, { ...cfg, fields: [{ ...field, archived: true }] }, rows as never).schema.fields.length === 0)

  const okParse = parseAtlasPackage(JSON.stringify(pkg))
  ok('⑲ 合法包可解析', okParse.ok)
  ok('⑲ 负向：普通 JSON 被拒', !parseAtlasPackage('{"a":1}').ok)
  ok('⑲ 负向：非 JSON 被拒', !parseAtlasPackage('这不是 json').ok)
  ok('⑲ 负向：更高版本被拒', !parseAtlasPackage(JSON.stringify({ ...pkg, formatVersion: 99 })).ok)
  ok('⑲ 负向：非法页签被拒', !parseAtlasPackage(JSON.stringify({ ...pkg, tabId: 'history' })).ok)
  ok('⑲ 负向：条目超上限被拒',
    !parseAtlasPackage(JSON.stringify({ ...pkg, rows: new Array(ATLAS_PACKAGE_MAX_ROWS + 1).fill({ data: {} }) })).ok)

  const pvEmpty = previewAtlasImport(pkg, emptyAtlasSchema())
  ok('⑲ 预览：目标没有该字段 ⇒ 新建 1 个', pvEmpty.createdFields === 1 && pvEmpty.reusedFields === 0)
  const pvSame = previewAtlasImport(pkg, cfg)
  ok('⑲ 预览：同名字段 ⇒ 复用', pvSame.reusedFields === 1 && pvSame.createdFields === 0)

  const plan = planAtlasImport(pkg, emptyAtlasSchema(), () => 'cf_new')
  ok('⑲ 字段映射：旧 cf 键 → 新 id', plan.fieldMap.cf_diet === 'cf_new')
  ok('⑲ 行数据键已重映射', plan.rows[0].data.cf_new === '肉食')
  ok('⑲ 负向：内置键不动', plan.rows[0].data['名称'] === '墨鳞蟒')

  const planReuse = planAtlasImport(pkg, cfg, () => 'cf_new')
  ok('⑲ 同名字段复用时不重复建字段', planReuse.created.length === 0 && planReuse.fieldMap.cf_diet === 'cf_diet')

  // 源码闸
  const sheet = read('src/components/sheets/TableSheet.tsx')
  ok('⑲ 导入先校验再落库（parse → 预览确认 → import）',
    sheet.indexOf('parseAtlasPackage') < sheet.indexOf('importAtlasPackage(r.pkg)'))
  ok('⑲ 导入前有确认弹窗（不当场默默写入）', /previewAtlasImport[\s\S]{0,1200}confirmDialog/.test(sheet))
  ok('⑲ 导出用含草稿的 sortedRows', /buildAtlasPackage\(tab, atlasConfig, sortedRows\)/.test(sheet))
}

// ---------- ㉕ R05（2026-10-19 修）：外来资料包逐字段深校验，不再靠强转放行 ----------
//
// 病根：`parseAtlasPackage` 只做浅断言（是不是数组 / 超不超限），然后直接 `as` 强转。
// 实测 `rows=[{data:{名称:42}}]` 被判合法 —— 而界面与检索到处对单元格值调 `.trim()`，
// 数字/对象会直接崩，且崩在**写库之后**，作者项目已经脏了。图片体积还信包里自报的 bytes。
{
  const races = TABS.find(t => t.id === 'races')!
  const rows = [{ id: 'r1', projectId: 'p1', tabId: 'races', order: 0, data: { 名称: '墨鳞蟒', cf_diet: '肉食' } }]
  const field: AtlasFieldDefinition = {
    id: 'cf_diet', label: '食性', type: 'text', description: '', appliesTo: '*', groupId: 'extra',
    order: 0, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: false, archived: false,
  }
  const pkg = buildAtlasPackage(races, { ...emptyAtlasSchema(), fields: [field] }, rows as never, { now: 1 })
  const P = (o: Record<string, unknown>) => parseAtlasPackage(JSON.stringify({ ...pkg, ...o }))
  const okIs = (name: string, o: Record<string, unknown>) => ok(name, P(o).ok)
  const badIs = (name: string, o: Record<string, unknown>) => ok(name, !P(o).ok)

  // ① 单元格值必须是文本（验收已复现的那一条）
  badIs('㉕ R05：`{名称: 42}` 被拒（非文本值会崩在 .trim() 上）', { rows: [{ data: { 名称: 42 } }] })
  badIs('㉕ R05：对象值被拒', { rows: [{ data: { 名称: { a: 1 } } }] })
  badIs('㉕ R05：null 值被拒', { rows: [{ data: { 名称: null } }] })
  badIs('㉕ R05：数组值被拒', { rows: [{ data: { 名称: ['a'] } }] })
  okIs('㉕ R05：正常的文本值放行', { rows: [{ data: { 名称: '墨鳞蟒' } }] })
  okIs('㉕ R05：空字符串放行（空值是合法的）', { rows: [{ data: { 名称: '' } }] })

  // ② 字段定义逐项校验
  badIs('㉕ R05：字段缺 id 被拒', { schema: { fields: [{ ...field, id: undefined }] } })
  badIs('㉕ R05：字段缺名称被拒', { schema: { fields: [{ ...field, label: '' }] } })
  badIs('㉕ R05：未知字段类型被拒', { schema: { fields: [{ ...field, type: 'richtext' }] } })
  badIs('㉕ R05：appliesTo 不合法被拒', { schema: { fields: [{ ...field, appliesTo: '魔兽' }] } })
  badIs('㉕ R05：appliesTo 数组含非文本被拒', { schema: { fields: [{ ...field, appliesTo: [1] }] } })
  badIs('㉕ R05：下拉候选含非文本被拒', { schema: { fields: [{ ...field, type: 'select', options: ['a', 2] }] } })
  badIs('㉕ R05：开关不是布尔被拒', { schema: { fields: [{ ...field, aiReadable: 'yes' }] } })
  badIs('㉕ R05：排序不是数字被拒', { schema: { fields: [{ ...field, order: '1' }] } })
  badIs('㉕ R05：字段 id 重复被拒（两个字段共用一个键会串味）',
    { schema: { fields: [field, { ...field, label: '食性2' }] } })
  badIs('㉕ R05：字段不是对象被拒', { schema: { fields: ['食性'] } })
  okIs('㉕ R05：合法字段放行', { schema: { fields: [field, { ...field, id: 'cf_b', label: '栖息地' }] } })

  // ③ 图片：格式、编码、体积（自报 bytes 一律不信）
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const img = (over: Partial<Record<string, unknown>> = {}) => ({ dataUrl: png, mime: 'image/png', width: 1, height: 1, bytes: 70, ...over })
  okIs('㉕ R05：合法图片放行', { rows: [{ data: { 名称: '墨鳞蟒' }, atlasImage: img() }] })
  badIs('㉕ R05：SVG 被拒（可执行内容）', { rows: [{ data: {}, atlasImage: img({ dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }) }] })
  badIs('㉕ R05：假 MIME（声称 png 实为 svg）被拒 —— 按 dataUrl 实际内容判',
    { rows: [{ data: {}, atlasImage: img({ dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', mime: 'image/png' }) }] })
  badIs('㉕ R05：非 base64 数据被拒', { rows: [{ data: {}, atlasImage: img({ dataUrl: 'data:image/png,abc' }) }] })
  badIs('㉕ R05：不是 dataURL 被拒', { rows: [{ data: {}, atlasImage: img({ dataUrl: 'https://x/y.png' }) }] })
  badIs('㉕ R05：单张超限被拒',
    { rows: [{ data: {}, atlasImage: img({ dataUrl: 'data:image/png;base64,' + 'A'.repeat(ATLAS_PACKAGE_MAX_IMAGE_CHARS + 100) }) }] })

  // ④ 自报 bytes 必须被重算覆盖（伪造体积是绕过容量闸的入口）
  const withImg = P({ rows: [{ data: { 名称: '墨鳞蟒' }, atlasImage: img({ bytes: 1 }) }] })
  const gotBytes = withImg.ok ? Number(withImg.pkg.rows[0]?.atlasImage?.bytes ?? 0) : 0
  ok('㉕ R05：伪造的 bytes 被重算覆盖（不再信自报）', gotBytes > 1, String(gotBytes))
  ok('㉕ R05：重算出的体积按内容算（等于 dataUrlBytes）', gotBytes === dataUrlBytes(png), `${gotBytes} vs ${dataUrlBytes(png)}`)

  // ⑤ 源码闸：校验必须在造 pkg 之前（不能"先转了再说"）
  const psrc2 = read('src/lib/atlas/packageIO.ts')
  ok('㉕ R05：解析里先过完整校验再组装（不是先强转再"顺便"校验）',
    psrc2.indexOf('const problem = atlasPackageProblem(o)') > 0
    && psrc2.indexOf('const problem = atlasPackageProblem(o)') < psrc2.indexOf('tabId: o.tabId'))
  ok('㉕ R05：图片体积重算（dataUrlBytes）', psrc2.includes('dataUrlBytes'))
}

// ---------- ㉖ R07（2026-10-19 修）：四个图鉴页签自产自读 ----------
{
  const races = TABS.find(t => t.id === 'races')!
  const field: AtlasFieldDefinition = {
    id: 'cf_x', label: '特性', type: 'text', description: '', appliesTo: '*', groupId: 'extra',
    order: 0, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: false, archived: false,
  }
  const cfg = { ...emptyAtlasSchema(), fields: [field] }
  for (const id of ATLAS_TABS) {
    const tab = TABS.find(t => t.id === id)!
    const p = buildAtlasPackage(tab, cfg, [], { now: 1 })
    const r = parseAtlasPackage(JSON.stringify(p))
    ok(`㉖ R07：${tab.name} 导出的包能被自己读回`, r.ok, r.ok ? '' : r.reason)
  }
  const psrc3 = read('src/lib/atlas/packageIO.ts')
  ok('㉖ R07：页签白名单取自 ATLAS_TABS（不再写死两个）',
    psrc3.includes('ATLAS_TABS.includes') && !/'races' && o\.tabId !== 'items'/.test(psrc3))
  ok('㉖ R07 负向：未知页签仍被拒',
    !parseAtlasPackage(JSON.stringify(buildAtlasPackage(
      { ...races, id: 'history' } as never, cfg, [], { now: 1 }))).ok)
}

// ---------- ⑳ 外来列建字段 / 类别冲突 / 世界包 / AI 上下文（收尾组） ----------
{
  const races = tabOf('races')

  // 外来列：buildImportPrepared 必须把认不出的列**报出来**（否则作者以为整份都导进来了）
  const parsed = parseImportText('名称,食性,新列\n墨鳞蟒,肉食,随便')
  const prep = buildImportPrepared(parsed, races, null, [{ name: 'cf_diet', label: '食性' }])
  ok('⑳ 外来列被列出（供"建成字段"）', (prep.unmapped ?? []).includes('新列'))
  ok('⑳ 负向：已识别的列不算外来列', !(prep.unmapped ?? []).includes('食性') && !(prep.unmapped ?? []).includes('名称'))
  ok('⑳ 已识别列的值正确落到存储键', prep.rows[0]?.cf_diet === '肉食')

  // 类别冲突预览
  const pkg = buildAtlasPackage(races, emptyAtlasSchema(), [{
    id: 'r1', projectId: 'p', tabId: 'races', order: 0, data: { 名称: 'x', 类别: '外来族' },
  }] as never)
  ok('⑳ 未知类别值被预览出来', previewAtlasImport(pkg, emptyAtlasSchema(), ['魔兽']).unknownCategories.includes('外来族'))
  ok('⑳ 负向：已知类别不算冲突', previewAtlasImport(pkg, emptyAtlasSchema(), ['外来族']).unknownCategories.length === 0)

  // 世界包：随条目带字段定义与主图
  const wp = read('src/lib/world/worldPack.ts')
  ok('⑳ 世界包抽包时带字段定义（只带用到的）', wp.includes('usedKeys') && wp.includes('atlasFields'))
  ok('⑳ 世界包抽包时带主图', wp.includes('atlasImage: c.atlasImage'))
  const wi = read('src/lib/world/worldImport.ts')
  ok('⑳ 引入时重新发字段 id 并重映射数据键（不沿用源项目 id）',
    wi.includes('idMap') && wi.includes('newFieldId()') && wi.includes('delete data[oldKey]'))
  ok('⑳ 引入时写入主图', wi.includes('atlasImage: src.atlasImage'))

  // AI 上下文：字段名与格式化
  const ctx = read('src/lib/ai/aiContext.ts')
  // 表格渲染在 3.1.3 抽到 ai/tableRender（aiContext 贴 1200 行上限）；断言跟着搬，并防回退
  const renderSrc = read('src/lib/ai/tableRender.ts')
  ok('⑳ AI 上下文表头用字段名（cf_ 键不给模型看）', renderSrc.includes('labelOf') && renderSrc.includes('?.label ?? key'))
  // WT0-4：单元格格式化改读投影的 kind（customType 兼容支已收口删除）
  ok('⑳ AI 上下文按类型格式化值（多选不用 JSON 碎片）',
    renderSrc.includes('formatCustomValue(') && renderSrc.includes('kindOf('))
  ok('⑳ 负向：aiContext 不许再自己实现一份 renderTable', !/function renderTable\(/.test(ctx))
  // 加载与过滤抽到了 ai/atlasContext（aiContext 已贴 1200 行上限）
  const atlasCtx = read('src/lib/ai/atlasContext.ts')
  ok('⑳ AI 上下文按 aiReadable 过滤（口径在 atlasContext）',
    atlasCtx.includes("purpose: 'aiRead'") && ctx.includes('loadAtlasFieldsForAI'))
  ok('⑳ 负向：保密等级 / 作者侧字段的过滤对图鉴字段同样生效',
    renderSrc.includes('SYSTEM_META_FIELDS.has(c)') && renderSrc.includes('AUTHOR_SIDE_FIELDS.has(c)'))
}

// ---------- ㉑ 32MiB 只对云端账号模式生效（本地不限） ----------
{
  const MB = 1024 * 1024
  const used = 31 * MB
  const add = 5 * MB

  // 云端档位（默认参数 = 云端口径）：超了就拒
  ok('㉑ 云端档位：31MB + 5MB 判超限', checkAtlasBudget(used, add).level === 'over')
  // 本机档位（Infinity）：永远放行
  const local = checkAtlasBudget(used, add, Number.POSITIVE_INFINITY)
  ok('㉑ 本机档位：同样的量放行（桌面 / 便携 / 游客网页版不该被 32MB 卡）', local.level === 'ok')
  ok('㉑ 本机档位不算比例（不显示 0% 这种假进度）', atlasUsageRatio(used, Number.POSITIVE_INFINITY) === 0)

  // 文案：两种形态各说各话
  ok('㉑ 云端文案带上限与百分比', /\/ 32\.0 MB（\d+%）/.test(atlasUsageText(used, ATLAS_TOTAL_LIMIT)))
  ok('㉑ 本机文案说"本机存储，不限"', atlasUsageText(used, Number.POSITIVE_INFINITY).includes('本机存储，不限'))
  ok('㉑ 负向：本机文案里不该出现"32"', !atlasUsageText(used, Number.POSITIVE_INFINITY).includes('32'))

  // 源码闸：判定放在调用侧，纯函数层不许 import platform
  const quotaSrc = read('src/lib/atlas/quota.ts')
  // 只认真正的 import 语句（注释里解释"为什么不 import"是正常的，别把说明算成违规）
  ok('㉑ 负向：quota.ts 不 import platform（纯函数层保持可单测）',
    !/^import[^\n]*@\/lib\/app\/platform/m.test(quotaSrc) && !/^import[^\n]*\bWEB_CLOUD\b/m.test(quotaSrc))
  const model = read('src/components/sheets/useTableSheetModel.ts')
  ok('㉑ 上限按运行形态取（WEB_CLOUD ? 32MiB : Infinity）',
    /atlasImageLimit\s*=\s*WEB_CLOUD\s*\?\s*ATLAS_TOTAL_LIMIT\s*:\s*Number\.POSITIVE_INFINITY/.test(model))
  ok('㉑ 负向：导入资料包的容量判断用同一个 limit（不漏第二个入口）',
    model.includes('checkAtlasBudget(atlasImageUsage, incomingImages, atlasImageLimit)'))
  const detail = read('src/components/atlas/AtlasDetail.tsx')
  ok('㉑ 详情用传入的 limit（不再硬编码 32MiB）',
    detail.includes('checkAtlasBudget(projectImageBytes - before, r.image.bytes, imageLimit)')
    && detail.includes('atlasUsageText(projectImageBytes, imageLimit)'))
  ok('㉑ 负向：详情不许再拿 ATLAS_TOTAL_LIMIT 直接算比例',
    !detail.includes('projectImageBytes / ATLAS_TOTAL_LIMIT'))
  ok('㉑ 页签把 limit 一路传到详情', read('src/components/sheets/TableSheet.tsx').includes('imageLimit={atlasImageLimit}')
    && read('src/components/atlas/AtlasView.tsx').includes('imageLimit={imageLimit}'))
}

// ---------- ㉒ 国家势力 / 地理风物接入图鉴 + 「导入导出」命名 + 入口合并（2026-10-18） ----------
{
  /**
   * 🔴 最关键的一条：分组表写的是**存储键**，与真实列名逐字对应。
   *    列名改了而分组没跟着改，字段会**静默掉进「补充资料」组**（不报错、只是位置不对）。
   *    所以这里不比对常量，而是拿真实 TABS 解析一遍，看有没有字段落错地方。
   */
  for (const [tabId, note] of [['nations', '国家势力'], ['geography', '地理风物']] as const) {
    const fields = resolveAtlasFields(tabOf(tabId), {})
    const extra = fields.filter(f => f.groupId === 'extra').map(f => f.key)
    ok(`㉒ ${note}：除「备注 / 所属地图」外没有字段掉进补充资料组（分组键命中真实列名）`,
      extra.every(k => k === '备注' || k === '所属地图'))
    ok(`㉒ ${note}：分组至少 5 组（不是一锅端）`, new Set(fields.map(f => f.groupId)).size >= 5)
    const sum = defaultSummaryKeys(tabId as never)
    ok(`㉒ ${note}：默认摘要 3 项且都真实存在`,
      sum.length === 3 && sum.every(k => fields.some(f => f.key === k)))
  }

  // 徽标：按表取「类别 + 最有区分度的那列」
  ok('㉒ 势力徽标＝类别+实力等级',
    atlasCardBadges('nations', { 类别: '宗门', 实力等级: '一流' }).join('/') === '宗门/一流')
  ok('㉒ 地理徽标＝类别+危险等级',
    atlasCardBadges('geography', { 类别: '秘境', 危险等级: '高' }).join('/') === '秘境/高')
  ok('㉒ 负向：非图鉴表不给徽标（不再退回 races 口径）',
    atlasCardBadges('history', { 类别: 'x', 威胁等级: 'y' }).length === 0)

  // 四个页签都算图鉴页签（界面入口 / 搜索 / AI / 世界包 全走这个判据）
  ok('㉒ nations / geography 算图鉴页签', isAtlasTab('nations') && isAtlasTab('geography'))
  ok('㉒ 图片容量统计覆盖全部图鉴页签（不是只差一个）',
    read('src/components/sheets/useTableSheetModel.ts').includes('ATLAS_TABS.filter(id => id !== tab.id)'))

  // 四个页签的默认摘要一律不得与徽标重复（加新页签时最容易在这里翻车）
  for (const id of ATLAS_TABS) {
    const keys = defaultSummaryKeys(id)
    ok(`㉒ ${id}：默认摘要不重复徽标字段`, !keys.some(k => atlasBadgeKeys(id).includes(k)))
  }

  // 「清空全部」已挪出菜单 ⇒ 菜单永远只有导入导出（所以按钮名可以统一叫「导入导出」）
  const sheetSrc = read('src/components/sheets/TableSheet.tsx')
  ok('㉒ 菜单里不再有危险项（清空全部已独立成 icon-danger 图标键）',
    !/key: 'clear'/.test(sheetSrc) && sheetSrc.includes('variant="icon-danger"') && sheetSrc.includes('canClear'))

  // 「更多」按钮：没危险项就叫「导入导出」
  const more = read('src/components/sheets/TableMoreMenu.tsx')
  ok('㉒ 菜单里只有导入/导出时按钮叫「导入导出」',
    more.includes("'导入导出'") && more.includes('hasDanger') && more.includes('ArrowDownUp'))
  ok('㉒ 负向：含「清空全部」的表仍叫「更多」（否则等于承诺里面没有删除入口）',
    /hasDanger \? '更多' : '导入导出'/.test(more))

  // 图鉴工具栏三块等高
  const view = read('src/components/atlas/AtlasView.tsx')
  ok('㉒ 图鉴工具栏三块等高（外壳统一 h-8 + 内部 h-full）',
    view.includes('三块等高') && (view.match(/h-8 rounded-lg border/g) ?? []).length >= 2 && view.includes('h-full rounded text-10'))

  // 字段显示名并入字段设置：图鉴页签不再并排两个入口
  const sheet = read('src/components/sheets/TableSheet.tsx')
  ok('㉒ 图鉴页签不再并排「字段名」与「字段设置」',
    sheet.includes('aliasCols.length > 0 && !isAtlasCapable'))
  ok('㉒ 字段设置面板收到别名三件套（键 / 当前值 / 保存）',
    sheet.includes('aliasKeys={aliasCols}') && sheet.includes('aliases={aliasMap}') && sheet.includes('onSaveAliases={saveAliases}'))
  const mgr = read('src/components/atlas/AtlasFieldManager.tsx')
  ok('㉒ 显示名编辑在字段设置面板里（同一套校验与清洗）',
    mgr.includes('内置字段显示名') && mgr.includes('sanitizeAliases') && mgr.includes('validateAliasInput'))
}

// ---------- ㉓ AI 两条链路口径一致：索引文本与提示词都用字段名（2026-10-18 修 R1/R2） ----------
{
  const mk = (data: Record<string, string>, fieldRules?: Record<string, AtlasIndexFieldRule>) => collectIndexDocs({
    chapters: [],
    tables: [{ tabId: 'races', tabName: '种族生物', rows: [{ id: 'r1', data }], fieldRules }],
    cards: [],
  })[0]?.text ?? ''

  // R1：cf_* 键名绝不能进索引文本（它会被〖语义召回〗原样注回提示词）
  const withMap = mk({ 名称: '霜狼', cf_abc: '肉食' }, { cf_abc: { label: '食性', aiReadable: true, appliesTo: '*' } })
  ok('㉓ 索引文本用字段名（cf_ 换成「食性」）', withMap.includes('食性：肉食'))
  ok('㉓ 负向：索引文本里不出现 cf_ 键名', !withMap.includes('cf_abc'))
  // 拿不到映射时退化，也绝不漏内部键（宁可重名）
  const noMap = mk({ 名称: '霜狼', cf_abc: '肉食' })
  ok('㉓ 无映射时退化成「自定义字段」', noMap.includes('自定义字段：肉食'))
  ok('㉓ 负向：无映射时也不露 cf_ 键名', !noMap.includes('cf_abc'))
  // 内置列名照旧（不能被映射逻辑连累）
  ok('㉓ 内置列名原样保留', withMap.includes('名称：霜狼'))

  // R2：自定义长文本按 600 字放宽（内置名单判不到 cf_*，必须按类型判）
  // 额度表与 cellCap 在 `ai/fieldCap.ts`（aiContext 贴 1200 行结构闸，纯数据另立文件）
  const ctxSrc = read('src/lib/ai/aiContext.ts')
  const capSrc = read('src/lib/ai/fieldCap.ts')
  ok('㉓ 单元格上限认自定义字段类型（longText → 600）',
    /export function cellCap\(name: string, customType\?:/.test(capSrc)
    && capSrc.includes("if (customType === 'longText') return CELL_CAP_LONG"))
  ok('㉓ 内置长字段名单仍在（不能因为抽文件把它丢了）', capSrc.includes('LONG_FIELDS') && capSrc.includes('CELL_CAP_LONG = 600'))
  ok('㉓ aiContext 用的是抽出去的那一份（不许自己另写一个 cellCap）',
    ctxSrc.includes("from '@/lib/ai/fieldCap'") && !/function cellCap\(/.test(ctxSrc))
  ok('㉓ 表格渲染按字段类型取上限（不是只按列名）',
    read('src/lib/ai/tableRender.ts').includes('cellCap(key, kindOf(')
    && read('src/lib/ai/tableRender.ts').includes('capOf(c)'))
  // ---------- R04（2026-10-19 修）：作者关掉的字段不许从语义召回绕回来 ----------
  // 病根：索引侧只有"cf_ → 名字"的映射，aiReadable / archived / appliesTo 一律不管
  // ⇒ 提示词里被拦下的内容，〖语义召回〗照样能捞出来注回提示词（已复现）。
  {
    const secretRule = { cf_secret: { label: '密文', aiReadable: false, appliesTo: '*' as const } }
    const r = (data: Record<string, string>, rules?: Record<string, AtlasIndexFieldRule>) =>
      mk(data, rules)

    // ① 作者关掉「允许 AI 参考」
    const off = r({ 名称: '霜狼', cf_secret: '不应进入AI的密文' }, secretRule)
    ok('㉓ R04：aiReadable=false 的字段不进索引', !off.includes('密文'), off)
    ok('㉓ R04：同行的其他字段照常进索引', off.includes('名称：霜狼'))

    // ② 归档字段：规则表里没有它（resolveAtlasFields 已排除归档），值属于历史残留
    const archived = r({ 名称: '霜狼', cf_gone: '已归档的旧值' }, { cf_other: { label: '别的', aiReadable: true, appliesTo: '*' } })
    ok('㉓ R04：已归档/已删除字段的值不进索引', !archived.includes('已归档的旧值'), archived)
    ok('㉓ R04：负向——规则里没有的 cf_ 键绝不退化成「自定义字段」兜底', !archived.includes('自定义字段'))

    // ③ 类别不适用：食性只对魔兽有效，这条已改成灵兽 ⇒ 残留值不算数
    const scoped = { cf_diet: { label: '食性', aiReadable: true, appliesTo: ['魔兽'] } }
    ok('㉓ R04：类别匹配 ⇒ 进索引', r({ 类别: '魔兽', cf_diet: '冰晶' }, scoped).includes('食性：冰晶'))
    ok('㉓ R04：类别不匹配 ⇒ 不进索引（历史残留不该被召回）',
      !r({ 类别: '灵兽', cf_diet: '冰晶' }, scoped).includes('冰晶'))
    ok('㉓ R04：不限类别的字段不受影响',
      r({ 类别: '灵兽', cf_any: '通用' }, { cf_any: { label: '通用项', aiReadable: true, appliesTo: '*' } }).includes('通用项：通用'))

    // ④ 拿不到规则（配置读失败）时**不**因此丢内容 —— 权限信息缺失不是"一律禁止"的理由
    ok('㉓ R04：无规则时仍保守入索引（只换名字，不静默丢作者的资料）',
      r({ 名称: '霜狼', cf_abc: '肉食' }).includes('自定义字段：肉食'))

    // ⑥ 权限改动 ⇒ 必须作废旧索引（否则改了开关旧向量照样能召回）
    const f = (id: string, aiReadable = true, archived = false) => ({ id, aiReadable, archived })
    ok('㉓ R04：关掉「允许 AI 参考」⇒ 判定为需作废', atlasAiVisibilityChanged([f('a')], [f('a', false)]))
    ok('㉓ R04：字段归档 ⇒ 判定为需作废', atlasAiVisibilityChanged([f('a')], [f('a', true, true)]))
    ok('㉓ R04：字段被删掉 ⇒ 判定为需作废（旧索引里还有它）', atlasAiVisibilityChanged([f('a')], []))
    ok('㉓ R04：只改名/改顺序/加新字段 ⇒ 不需要作废（不该逼作者重建）',
      !atlasAiVisibilityChanged([f('a'), f('b')], [f('b'), f('a'), f('c')]))
    ok('㉓ R04：新旧都是"不给 AI" ⇒ 不需要作废', !atlasAiVisibilityChanged([f('a', false)], [f('a', false)]))
    ok('㉓ R04：空对空 ⇒ 不需要作废', !atlasAiVisibilityChanged([], []))

    // ⑦ 源码闸：界面保存配置时真的接了"作废索引"
    const model = read('src/components/sheets/useTableSheetModel.ts')
    ok('㉓ R04：保存字段配置时校验 AI 可见性变化',
      model.includes('atlasAiVisibilityChanged') && model.includes('invalidateIndex'))

    // ⑤ 负向守卫：同一份数据、只是**不给规则**（修复前的状态）⇒ 密文照样进来
    //    证明上面几条"不见了"不是因为值碰巧为空 —— 闸本身有效。
    const leaky = r({ 名称: '霜狼', cf_secret: '不应进入AI的密文' })
    ok('㉓ R04 负向：不给规则 ⇒ 密文确实会进索引（闸本身有效）', leaky.includes('不应进入AI的密文'), leaky)
  }

  // 索引侧也要拿到映射（否则前面那些纯函数对了，实际跑起来仍然是 raw key）
  const idxSrc = read('src/lib/semantic/indexer.ts')
  ok('㉓ 索引器为图鉴表加载字段规则', idxSrc.includes('fieldRulesOf') && idxSrc.includes('loadAtlasSchema'))
  // 🔴 2026-10-20（WT0-4）：索引侧改走**有效模板**（`resolveTemplateCached` + `indexRulesOf`），
  //    与提示词侧同一口径；闸同步改成认"调用了什么函数"，不认字面参数（搬过三次，别再踩）。
  ok('㉓ 索引侧走有效模板（不自己读配置原文，避免两套口径）',
    idxSrc.includes('resolveTemplateCached') && idxSrc.includes('indexRulesOf') && !/cfg\.fields/.test(idxSrc))
  ok('㉓ 负向：读不到字段配置时不影响索引（退化成 undefined 而不是抛错）',
    /catch \{\s*return undefined\s*\}/.test(idxSrc))
}

// ---------- ㉓b R02（2026-10-19 修）：类别限定字段在表格/详情/检索里不再整体消失 ----------
//
// 病根：`resolveAtlasFields` 要求 category 匹配才算数，但表格列、图鉴详情、普通检索
// 三个调用点**一个都没传类别** ⇒ 只要字段不是"不限类别"，在所有地方都被排除。
// 验收实测：给魔兽建了"食性"并存了"冰晶"，表格没这一列、详情没这一项、搜索也搜不到
//（值一直在库里，作者只会以为"我存的东西丢了"）。
{
  const races = TABS.find(t => t.id === 'races')!
  const def = (over: Partial<AtlasFieldDefinition>): AtlasFieldDefinition => ({
    id: 'cf_diet', label: '食性', type: 'text', description: '', appliesTo: '*', groupId: 'extra',
    order: 100, tableVisible: true, detailVisible: true, searchable: true,
    aiReadable: true, aiWritable: false, archived: false, ...over,
  })
  const cfg: AtlasSchemaConfig = {
    ...emptyAtlasSchema(),
    fields: [def({ appliesTo: ['魔兽'] }), def({ id: 'cf_free', label: '通用项', appliesTo: '*' })],
  }

  // ① 表格列：全量（不再因为"只适用魔兽"就整列消失）
  const cols = atlasColumnsOf(races, cfg)
  ok('㉓b R02：类别限定字段在表格里有列（修前整列消失）', cols.some(c => c.name === 'cf_diet'),
    cols.map(c => c.name).join('|'))
  ok('㉓b R02：不限类别的字段照旧', cols.some(c => c.name === 'cf_free'))
  ok('㉓b R02：列的存储键仍是 cf_（不是显示名）', !cols.some(c => c.name === '食性'))

  // ② 逐行决定适用（同一张表：魔兽行看得到、灵兽行看不到）
  const all = resolveAtlasFields(races, { config: cfg, purpose: 'detail', ignoreAppliesTo: true })
  ok('㉓b R02：全量清单里两个字段都在', all.some(f => f.key === 'cf_diet') && all.some(f => f.key === 'cf_free'))
  const forBeast = atlasFieldsForCategory(all, '魔兽')
  const forSpirit = atlasFieldsForCategory(all, '灵兽')
  const forNone = atlasFieldsForCategory(all, '')
  ok('㉓b R02：魔兽条目看得到「食性」', forBeast.some(f => f.key === 'cf_diet'))
  ok('㉓b R02：灵兽条目看不到「食性」（不把别人的字段塞给它）', !forSpirit.some(f => f.key === 'cf_diet'))
  ok('㉓b R02：不限类别的字段两类都看得到',
    forBeast.some(f => f.key === 'cf_free') && forSpirit.some(f => f.key === 'cf_free'))
  ok('㉓b R02：没填类别 ⇒ 只留不限类别的（保守，不猜）',
    !forNone.some(f => f.key === 'cf_diet') && forNone.some(f => f.key === 'cf_free'))
  ok('㉓b R02 负向：appliesTo 为空数组 ⇒ 谁都看不到（不是"谁都看得到"）',
    !atlasFieldsForCategory(
      [{ key: 'a', appliesTo: [] }], '魔兽').length)

  // ③ 检索：作者存了值就搜得到（修复前这条是红的）
  const beastRow = { 名称: '墨鳞蟒', 类别: '魔兽', cf_diet: '冰晶' }
  const searchable = atlasSearchText(atlasFieldsForCategory(all, beastRow['类别']), beastRow)
  ok('㉓b R02：魔兽条目的「食性」能被检索到', searchable.includes('冰晶') && searchable.includes('食性'), searchable)
  // 类别不匹配的历史残留不该被当成这一条的内容
  const spiritRow = { 名称: '青鸾', 类别: '灵兽', cf_diet: '冰晶（旧值）' }
  ok('㉓b R02：灵兽条目不把「食性」的旧值算进去',
    !atlasSearchText(atlasFieldsForCategory(all, spiritRow['类别']), spiritRow).includes('冰晶'))
}

// ---------- ㉓c R12（2026-10-19 修）：AI 回填有基准、字段定义完整交给模型 ----------
{
  const races = TABS.find(t => t.id === 'races')!
  const def = (over: Partial<AtlasFieldDefinition>): AtlasFieldDefinition => ({
    id: 'cf_x', label: '战力', type: 'number', description: '大致战力，用于排序', unit: '级',
    appliesTo: '*', groupId: 'extra', order: 10, tableVisible: true, detailVisible: true,
    searchable: true, aiReadable: true, aiWritable: true, archived: false, ...over,
  })
  const cfg: AtlasSchemaConfig = { ...emptyAtlasSchema(), fields: [def({})] }

  // ① 输出目标按 aiWrite 独立解析：**不看** tableVisible（隐藏列 ≠ 不许 AI 写）
  const hiddenButWritable = { ...cfg, fields: [def({ tableVisible: false })] }
  const writes = resolveAtlasFields(races, { config: hiddenButWritable, purpose: 'aiWrite', ignoreAppliesTo: true })
    .filter(f => f.source === 'custom')
  ok('㉓c R12：隐藏了但仍允许 AI 写的字段**仍是**输出目标（解耦"隐藏"与"禁写"）',
    writes.some(f => f.key === 'cf_x'), writes.map(f => f.key).join('|'))
  const notWritable = { ...cfg, fields: [def({ aiWritable: false })] }
  ok('㉓c R12：关掉「允许 AI 填写」⇒ 不再是输出目标',
    !resolveAtlasFields(races, { config: notWritable, purpose: 'aiWrite', ignoreAppliesTo: true })
      .some(f => f.source === 'custom' && f.key === 'cf_x'))
  ok('㉓c R12 负向：表格可见列仍按 tableVisible 过滤（两件事真的分开了）',
    !atlasColumnsOf(races, hiddenButWritable).some(c => c.name === 'cf_x'))

  // ② 字段定义完整交给模型（类型 / 单位 / 候选 / 说明 / 类别范围）
  const f = resolveAtlasFields(races, { config: cfg, purpose: 'aiWrite', ignoreAppliesTo: true })
    .find(x => x.key === 'cf_x')!
  const hint = atlasFieldHintForAI(f)
  ok('㉓c R12：提示里有类型', hint.includes('数字'), hint)
  ok('㉓c R12：提示里有单位', hint.includes('级'))
  ok('㉓c R12：提示里有作者的说明', hint.includes('大致战力'))
  ok('㉓c R12：提示里不出现 cf_ 内部键', !hint.includes('cf_x'))
  const sel = resolveAtlasFields(races, {
    config: { ...cfg, fields: [def({ type: 'select', options: ['高', '中', '低'], unit: undefined })] },
    purpose: 'aiWrite', ignoreAppliesTo: true,
  }).find(x => x.key === 'cf_x')!
  ok('㉓c R12：单选把候选值交给模型（否则它只能瞎编）',
    atlasFieldHintForAI(sel).includes('高 / 中 / 低'), atlasFieldHintForAI(sel))
  const scoped = resolveAtlasFields(races, {
    config: { ...cfg, fields: [def({ appliesTo: ['魔兽'] })] }, purpose: 'aiWrite', ignoreAppliesTo: true,
  }).find(x => x.key === 'cf_x')!
  ok('㉓c R12：类别限定也告诉模型（只对哪类有意义）', atlasFieldHintForAI(scoped).includes('魔兽'))

  // ③ 源码闸：应用前核基准、未知键不再默默写入
  const model = read('src/components/sheets/useTableSheetModel.ts')
  ok('㉓c R12：三条回填路径都先核基准',
    (model.match(/verifyAiWriteBase\(\)/g) ?? []).length >= 3)
  ok('㉓c R12：应用前重读配置（不是拿内存里的旧清单）', model.includes('loadAtlasAiWriteTargets'))
  ok('㉓c R12：revision 不一致 ⇒ 作废', model.includes('targets.revision !== atlasConfig.revision'))
  ok('㉓c R12：未知键不再默默写进草稿',
    (model.match(/allowedKeys\.has\(k\)/g) ?? []).length >= 2)
  ok('㉓c R12：补全本行还校验"这一行内容在生成期间变没变"',
    model.includes('JSON.stringify(now.data) !== JSON.stringify(row.data)'))
  // WT0-4：提示实现统一到 templates/consumers.fieldHintForAI（旧入口已改为委托）
  ok('㉓c R12：字段清单把说明交给模型', model.includes('fieldHintForAI'))
}

// ---------- ㉔ R06（2026-10-19 修）：未知版本 / 读失败 / 损坏配置，写入服务必须拒写 ----------
//
// 病根：只读只在「字段管理器」那一颗按钮上（禁用），写入服务 `saveAtlasSchema` 是无条件写的。
// 于是资料包导入、CSV 建字段、世界包导入这几条不经过按钮的路径照样能覆盖 ——
// 验收实测：formatVersion=99 的配置被写回 1，未来版本才有的 futureOnly 字段直接丢失。
{
  const v1 = { formatVersion: 1, revision: 3, fields: [] }
  ok('㉔ 正常版本 ⇒ 允许写入', checkAtlasWritable(v1).allow)
  ok('㉔ 还没存过（null）⇒ 允许全新写入', checkAtlasWritable(null).allow)
  ok('㉔ 未来版本 ⇒ 拒写', !checkAtlasWritable({ formatVersion: 99, fields: [], futureOnly: 'x' }).allow)
  ok('㉔ 未来版本的提示里带双方版本号',
    (checkAtlasWritable({ formatVersion: 99, fields: [] }).reason ?? '').includes('99')
    && (checkAtlasWritable({ formatVersion: 99, fields: [] }).reason ?? '').includes(String(ATLAS_FORMAT_VERSION)))
  ok('㉔ 当前版本 ⇒ 不误拒（只挡更高的）', checkAtlasWritable({ formatVersion: ATLAS_FORMAT_VERSION, fields: [] }).allow)
  ok('㉔ 读取失败 ⇒ 拒写（不知道磁盘上是什么就不许写）', !checkAtlasWritable(v1, 'IDB 读失败').allow)
  ok('㉔ 读失败时 null 也算拒写（不能当成"没存过"放行）', !checkAtlasWritable(null, 'IDB 读失败').allow)
  ok('㉔ 结构损坏（fields 不是数组）⇒ 拒写', !checkAtlasWritable({ formatVersion: 1, fields: 'oops' }).allow)
  ok('㉔ 整个不是对象 ⇒ 拒写', !checkAtlasWritable('一个字符串').allow)
  ok('㉔ 数组也算损坏 ⇒ 拒写', !checkAtlasWritable([{ id: 'cf_a' }]).allow)
  ok('㉔ 没带 fields 字段（老数据）⇒ 放行（normalize 会补空，不算覆盖）', checkAtlasWritable({ formatVersion: 1 }).allow)

  // 源码闸：拒写判定必须落在**领域写入接口**里，不能只靠界面禁用按钮
  const psrc = read('src/lib/atlas/persistence.ts')
  ok('㉔ saveAtlasSchema 写入前先过守卫',
    /const check = checkAtlasWritable\(raw\)/.test(psrc) && /if \(!check\.allow\) throw/.test(psrc))
  ok('㉔ 写入前自己重读一次（不靠调用方把状态传进来）', /getSettingFor<unknown>\(projectId, atlasSchemaKey\(tabId\)/.test(psrc))
  ok('㉔ 负向：守卫**在**真正落库之前（不是写完再补一句判断）',
    psrc.indexOf('checkAtlasWritable(raw)') > 0
    && psrc.indexOf('checkAtlasWritable(raw)') < psrc.indexOf('await setSettingFor('))
  // 抛错必须被界面接住，否则变成"点了保存什么反馈都没有"
  const mgrSrc = read('src/components/atlas/AtlasFieldManager.tsx')
  ok('㉔ 字段管理器接住写入服务的拒写错误（不变成未处理 Promise）',
    /} catch \(e\) \{[\s\S]{0,200}setErr\(/.test(mgrSrc))
}

// ---------- ㉗ R10（2026-10-19 修）：主图必须等落库真成功才提示 ----------
{
  const detail = read('src/components/atlas/AtlasDetail.tsx')
  ok('㉗ R10：回调返回 Promise（不再是 void 丢掉）',
    /onImageChange: \(image: AtlasImage \| null\) => void \| Promise<void>/.test(detail))
  ok('㉗ R10：上传 await 落库结果后才提示"已更新"', /await commitImage\(r\.image\)/.test(detail))
  ok('㉗ R10：移除也 await（移除失败时不能先说已移除）', /await commitImage\(null\)/.test(detail))
  ok('㉗ R10：落库失败如实报错（不谎报成功）', /主图保存失败/.test(detail))
  ok('㉗ R10：上传与移除串行（连点不互相覆盖）', /chainRef\.current/.test(detail))
  ok('㉗ R10 负向：不再把 Promise 丢进 void', !/void onImageChange\(/.test(detail))
  const view = read('src/components/atlas/AtlasView.tsx')
  ok('㉗ R10 负向：父组件不再 void 掉保存 Promise（否则 catch 不到失败）',
    !/void onSaveImage\?\.\(/.test(view))
}

// ---------- ㉘ R11（2026-10-19 修）：分批导入中断后已成功的行要进界面，重试不翻倍 ----------
{
  const races = TABS.find(t => t.id === 'races')!
  const pkg = buildAtlasPackage(races, emptyAtlasSchema(), [
    { id: 'r1', projectId: 'p1', tabId: 'races', order: 0, data: { 名称: '甲' } },
    { id: 'r2', projectId: 'p1', tabId: 'races', order: 1, data: { 名称: '乙' } },
  ] as never, { now: 1700000000000 })

  // ① 稳定 id：同一份包两次算出同一批 id ⇒ 重导是"覆盖/补齐"，不是翻倍
  const ids1 = pkg.rows.map((_, i) => packageRowId(pkg, i))
  const ids2 = pkg.rows.map((_, i) => packageRowId(pkg, i))
  ok('㉘ R11：同一份包算出的 id 稳定', ids1.join('|') === ids2.join('|'), ids1.join('|'))
  ok('㉘ R11：不同行的 id 不同', ids1[0] !== ids1[1])
  ok('㉘ R11：id 带包指纹前缀（不与手工建的行撞）', ids1.every(id => id.startsWith('atk-')))
  const other = buildAtlasPackage(races, emptyAtlasSchema(), pkg.rows as never, { now: 1700000000001 })
  ok('㉘ R11：另一份包（时间不同）算出不同 id ⇒ 不会互相覆盖',
    packageRowId(other, 0) !== ids1[0])

  // ② 源码闸：中途失败也要并入已成功的行，并如实报数
  const model = read('src/components/sheets/useTableSheetModel.ts')
  ok('㉘ R11：单行失败不中断（记下来继续）', /catch \(e\) \{\s*\n\s*\/\/ 🔴 单行失败/.test(model))
  ok('㉘ R11：finally 里把已成功的行并入界面（不再只在全部成功时 setRows）',
    /\} finally \{[\s\S]{0,400}if \(created\.length\) setRows\(/.test(model))
  ok('㉘ R11：返回结果带失败数与原因', /failed,\s*\n\s*failure,/.test(model))
  ok('㉘ R11：条目 id 用稳定 id（不是 uid）', model.includes('id: packageRowId(pkg, i)'))
  const sheet = read('src/components/sheets/TableSheet.tsx')
  ok('㉘ R11：界面如实显示"部分成功 + 可再导一次补齐"', /res\.failed > 0/.test(sheet))
}

// ---------- ㉙ R08（2026-10-19 修）：同名异义字段不再自动复用 ----------
{
  const races = TABS.find(t => t.id === 'races')!
  const def = (over: Partial<AtlasFieldDefinition>): AtlasFieldDefinition => ({
    id: 'cf_diet', label: '食性', type: 'select', description: '', options: ['食肉'],
    appliesTo: '*', groupId: 'extra', order: 10, tableVisible: true, detailVisible: true,
    searchable: true, aiReadable: true, aiWritable: false, archived: false, ...over,
  })

  // ① 同义判定必须比完整定义
  ok('㉙ R08：定义完全一致 ⇒ 算同一个字段', sameAtlasFieldDefinition(def({}), def({})))
  ok('㉙ R08：候选不同 ⇒ 不算同一个（同名异义）',
    !sameAtlasFieldDefinition(def({}), def({ options: ['食草'] })))
  ok('㉙ R08：单位不同 ⇒ 不算同一个',
    !sameAtlasFieldDefinition(def({ type: 'number', unit: '级' }), def({ type: 'number', unit: '阶' })))
  ok('㉙ R08：类别范围不同 ⇒ 不算同一个',
    !sameAtlasFieldDefinition(def({ appliesTo: ['魔兽'] }), def({ appliesTo: ['灵兽'] })))
  ok('㉙ R08：类型不同 ⇒ 不算同一个',
    !sameAtlasFieldDefinition(def({ type: 'text' }), def({ type: 'select' })))
  ok('㉙ R08：候选顺序不同仍算同一个（顺序不是语义）',
    sameAtlasFieldDefinition(def({ options: ['食肉', '杂食'] }), def({ options: ['杂食', '食肉'] })))
  ok('㉙ R08 负向：不同名就一定不算同一个',
    !sameAtlasFieldDefinition(def({ label: '食性' }), def({ label: '栖息地' })))

  // ② 导入计划：撞车 ⇒ 另建 + 改名，且把值映射到新字段
  const target = { ...emptyAtlasSchema(), fields: [def({ id: 'cf_local', options: ['食草'] })] }
  const pkg = buildAtlasPackage(races, { ...emptyAtlasSchema(), fields: [def({})] },
    [{ id: 'r1', projectId: 'p1', tabId: 'races', order: 0, data: { 名称: '墨鳞蟒', cf_diet: '食肉' } }] as never, { now: 1 })
  const plan = planAtlasImport(pkg, target, () => 'cf_new')
  ok('㉙ R08：同名异义 ⇒ 不复用（新建）', plan.reused.length === 0 && plan.created.length === 1)
  ok('㉙ R08：新建的字段改了名（不留两个同名同姓的字段）',
    plan.created[0].label === '食性（2）', plan.created[0].label)
  ok('㉙ R08：撞车原因如实报出来（说清是候选不同）',
    plan.conflicts.length === 1 && plan.conflicts[0].reason.includes('候选'), JSON.stringify(plan.conflicts))
  ok('㉙ R08：值映射到新字段（不是塞进目标那个异义字段）', plan.rows[0].data.cf_new === '食肉')
  ok('㉙ R08：目标原有字段的值没被碰', plan.rows[0].data.cf_local === undefined)

  // ③ 定义一致 ⇒ 照旧复用（不该每次都新建）
  const sameTarget = { ...emptyAtlasSchema(), fields: [def({ id: 'cf_local' })] }
  const plan2 = planAtlasImport(pkg, sameTarget, () => 'cf_new')
  ok('㉙ R08：定义一致 ⇒ 复用（不重复造字段）',
    plan2.reused.length === 1 && plan2.created.length === 0 && plan2.conflicts.length === 0)

  // ④ 改名函数
  ok('㉙ R08：不撞车时原名保留', uniqueFieldLabel(['已有'], '食性') === '食性')
  ok('㉙ R08：撞车时递增改名', uniqueFieldLabel(['食性', '食性（2）'], '食性') === '食性（3）')

  // ⑤ 预览要提前说清
  const pv = previewAtlasImport(pkg, target, [])
  ok('㉙ R08：预览里报出撞车（导入前就告诉作者）', pv.conflicts.length === 1)
  const sheet = read('src/components/sheets/TableSheet.tsx')
  ok('㉙ R08：确认弹窗里显示撞车说明', /p\.conflicts\.length > 0/.test(sheet))
  const wi = read('src/lib/world/worldImport.ts')
  ok('㉙ R08：世界包导入也用同一套判定（不自己另写一份）', wi.includes('sameAtlasFieldDefinition'))
}

// ---------- ㉚ R09（2026-10-19 修）：CSV 往返等值（换行 / 类型化值） ----------
{
  // ① 换行：修前 `csvCell` 先把换行换成空格 ⇒ 导出去再导回来永远回不来
  ok('㉚ R09：带换行的单元格用引号包裹（不再被压成空格）',
    csvCell('第一行\n第二行') === '"第一行\n第二行"', JSON.stringify(csvCell('第一行\n第二行')))
  ok('㉚ R09 负向：不含特殊字符时不加引号（不无谓膨胀）', csvCell('普通') === '普通')
  ok('㉚ R09：逗号 / 引号照旧处理', csvCell('a,b') === '"a,b"' && csvCell('a"b') === '"a""b"')

  const line = [csvCell('名称'), csvCell('备注')].join(',')
  const csv = [line, [csvCell('墨鳞蟒'), csvCell('第一行\n第二行')].join(',')].join('\n')
  const grid = parseCsvGrid(csv)
  ok('㉚ R09：完整解析出 2 条记录（引号内换行不算换行）', grid.length === 2, String(grid.length))
  ok('㉚ R09：换行往返等值', grid[1][1] === '第一行\n第二行', JSON.stringify(grid[1][1]))
  ok('㉚ R09：引号转义往返等值', parseCsvGrid('a,"x""y"')[0][1] === 'x"y')
  ok('㉚ R09 负向：按行拆会把它切成两条脏行（闸本身有效）', csv.split('\n').length === 3)

  // ② 类型化回导：导出的是显示值，导入要还原成存储值
  ok('㉚ R09：布尔「是」→ true', parseTypedImportValue('是', { customType: 'boolean' }) === 'true')
  ok('㉚ R09：布尔「否」→ false（不是"否"这个字符串）', parseTypedImportValue('否', { customType: 'boolean' }) === 'false')
  ok('㉚ R09：布尔脏值不猜（原样保留）', parseTypedImportValue('大概是', { customType: 'boolean' }) === '大概是')
  ok('㉚ R09：多选「怕火、怕水」→ JSON 数组',
    parseTypedImportValue('怕火、怕水', { customType: 'multiSelect' }) === JSON.stringify(['怕火', '怕水']),
    parseTypedImportValue('怕火、怕水', { customType: 'multiSelect' }))
  ok('㉚ R09：多选已是存储形态时不二次拆分',
    parseTypedImportValue(JSON.stringify(['怕火']), { customType: 'multiSelect' }) === JSON.stringify(['怕火']))
  ok('㉚ R09：带单位数字「18 级」→ 18', parseTypedImportValue('18 级', { customType: 'number', unit: '级' }) === '18')
  ok('㉚ R09：不带单位的数字', parseTypedImportValue('3.50', { customType: 'number' }) === '3.50')
  ok('㉚ R09：数字位解析不出来就原样（不静默归零）',
    parseTypedImportValue('未知', { customType: 'number' }) === '未知')
  ok('㉚ R09：没有类型信息就当纯文本（保守，不猜）', parseTypedImportValue(' 是 ') === '是')

  // ③ 端到端：导出 → 导入 → 等值
  const display = (raw: string, type: CustomFieldType, unit?: string) => formatCustomValue(type, raw, unit)
  const roundTrip = (stored: string, type: CustomFieldType, unit?: string) =>
    parseTypedImportValue(display(stored, type, unit), { customType: type, unit })
  ok('㉚ R09：布尔往返等值', roundTrip('true', 'boolean') === 'true' && roundTrip('false', 'boolean') === 'false')
  ok('㉚ R09：多选往返等值',
    roundTrip(JSON.stringify(['怕火', '怕水']), 'multiSelect') === JSON.stringify(['怕火', '怕水']))
  ok('㉚ R09：带单位数字往返等值', roundTrip('18', 'number', '级') === '18')

  // ④ 源码闸：导入端用完整 CSV 解析器 / 类型信息已接进界面
  const io = read('src/lib/storage/tableIO.ts')
  ok('㉚ R09：导入用 parseCsvGrid（不再先按行切）', io.includes('parseCsvGrid(text)'))
  ok('㉚ R09：矩阵转行时按类型还原', /parseTypedImportValue\(/.test(io))
  const sheet = read('src/components/sheets/TableSheet.tsx')
  ok('㉚ R09：界面把字段类型传给导入弹窗', sheet.includes('fieldTypes={atlasFieldTypes}'))
  const dlg = read('src/components/sheets/TableImportDialog.tsx')
  ok('㉚ R09：弹窗把类型信息一路传下去', dlg.includes('fieldTypes'))
}

console.log(`\n—— atlasFields 用例结束：${pass} 通过 / ${fail} 失败 ——`)
if (fail > 0) process.exit(1)
