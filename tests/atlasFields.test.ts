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
  defaultSummaryKeys, emptyAtlasSchema, isAtlasTab, resolveAtlasFields,
} from '@/lib/atlas/schema'
import { atlasColumnsOf } from '@/lib/atlas/columns'
import {
  ATLAS_TOTAL_LIMIT, atlasImageUsageOf, atlasUsageLabel, atlasUsageRatio, atlasUsageText,
  checkAtlasBudget, formatBytes,
} from '@/lib/atlas/quota'
import { ATLAS_PACKAGE_MAX_ROWS, buildAtlasPackage, parseAtlasPackage, planAtlasImport, previewAtlasImport } from '@/lib/atlas/packageIO'
import { buildImportPrepared, exportRowsCsv, mapHeaders, parseImportText } from '@/lib/storage/tableIO'
import { collectIndexDocs } from '@/lib/semantic/indexer'
import {
  formatBooleanValue, formatCustomValue, formatMultiSelectValues,
  isEmptyValue, parseMultiSelectValues, coerceAiValue,
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
  ok('⑧ 图鉴把字段配置传进解析层', /resolveAtlasFields\(tab, \{ aliases, config, purpose: 'detail' \}\)/.test(view))
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
  ok('⑫ 交给 AI 的字段清单来自 effectiveColumns（含自定义字段）',
    /const tableFields = useMemo<TemplateField\[\]>\(\s*\(\) => effectiveColumns/.test(model))
  ok('⑫ 未开放「允许 AI 填写」的自定义字段不进清单', /c\.atlasField\.aiWritable/.test(model))
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
  ok('⑲ 导入前有确认弹窗（不当场默默写入）', /previewAtlasImport[\s\S]{0,600}confirmDialog/.test(sheet))
  ok('⑲ 导出用含草稿的 sortedRows', /buildAtlasPackage\(tab, atlasConfig, sortedRows\)/.test(sheet))
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
  ok('⑳ AI 上下文表头用字段名（cf_ 键不给模型看）', ctx.includes('labelOf') && ctx.includes('?.label ?? key'))
  ok('⑳ AI 上下文按类型格式化值（多选不用 JSON 碎片）', ctx.includes('formatCustomValue(f.customType, raw, f.unit)'))
  // 加载与过滤抽到了 ai/atlasContext（aiContext 已贴 1200 行上限）
  const atlasCtx = read('src/lib/ai/atlasContext.ts')
  ok('⑳ AI 上下文按 aiReadable 过滤（口径在 atlasContext）',
    atlasCtx.includes("purpose: 'aiRead'") && ctx.includes('loadAtlasFieldsForAI'))
  ok('⑳ 负向：保密等级 / 作者侧字段的过滤对图鉴字段同样生效',
    ctx.includes('SYSTEM_META_FIELDS.has(c)') && ctx.includes('AUTHOR_SIDE_FIELDS.has(c)'))
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
  const mk = (data: Record<string, string>, fieldLabels?: Record<string, string>) => collectIndexDocs({
    chapters: [],
    tables: [{ tabId: 'races', tabName: '种族生物', rows: [{ id: 'r1', data }], fieldLabels }],
    cards: [],
  })[0]?.text ?? ''

  // R1：cf_* 键名绝不能进索引文本（它会被〖语义召回〗原样注回提示词）
  const withMap = mk({ 名称: '霜狼', cf_abc: '肉食' }, { cf_abc: '食性' })
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
    ctxSrc.includes('const capOf = (key: string) => cellCap(key, atlasFields?.find(x => x.key === key)?.customType)')
    && ctxSrc.includes('capOf(c)'))
  // 索引侧也要拿到映射（否则前面那些纯函数对了，实际跑起来仍然是 raw key）
  const idxSrc = read('src/lib/semantic/indexer.ts')
  ok('㉓ 索引器为图鉴表加载字段映射', idxSrc.includes('fieldLabelsOf') && idxSrc.includes('loadAtlasSchema'))
  ok('㉓ 负向：读不到字段配置时不影响索引（退化成 undefined 而不是抛错）',
    /catch \{\s*return undefined\s*\}/.test(idxSrc))
}

console.log(`\n—— atlasFields 用例结束：${pass} 通过 / ${fail} 失败 ——`)
if (fail > 0) process.exit(1)
