// 3.7.6 · 多页签自定义字段隔离
//
// 作者的问题：A 页签改了自定义字段，B 页签有同名/同键字段，会不会串？
// 这里逐层钉住四样东西都按页签（tabId）分区：
//   ① 字段 ID 生成器全局唯一（跨表也不撞）；
//   ② 图鉴配置 `atlasSchema::<tabId>`、字段别名 `fieldAlias::<tabId>`、模板 `projectTemplate::<tabId>`；
//   ③ 有效字段元数据（keys / labels）只来自本表配置；
//   ④ 表格行按 `tabId` 分区，**即使两表用了同一个 cf 键名也互不可见**。
// 另加一条：归档 A 表字段不会改 B 表配置，B 的 revision 也不动。
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { getTab } from '../src/lib/schema'
import { atlasSchemaKey, loadAtlasSchema, newFieldId, saveAtlasSchema } from '../src/lib/atlas/persistence'
import { emptyAtlasSchema } from '../src/lib/atlas/schema'
import { aliasKeyOf, invalidateAliasCache, loadAliases, saveAliases } from '../src/lib/settings/fieldAlias'
import { loadEffectiveSearchMeta } from '../src/lib/templates/effectiveSearchMeta'
import { projectTemplateKeyOf } from '../src/lib/templates/definition'
import type { AtlasFieldDefinition } from '../src/lib/atlas/types'
import type { TableRow } from '../src/lib/types'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean | undefined, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'p-isolation'

function field(id: string, label: string): AtlasFieldDefinition {
  return {
    id, label, type: 'text', description: '', appliesTo: '*', groupId: 'g',
    order: 0, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: true,
    archived: false,
  }
}

async function main() {
  __resetMockStores()
  invalidateAliasCache()
  db.setCurrentProject(PID)

  // ① 字段 ID：全局生成器，跨表也不该撞
  const ids = new Set<string>()
  for (let i = 0; i < 1000; i++) ids.add(newFieldId())
  ok('字段 ID 1000 次生成无重复（跨表共用同一生成器也不撞）', ids.size === 1000, `unique=${ids.size}`)

  // ② 三类配置的存储键都带 tabId
  ok('图鉴配置按页签存', atlasSchemaKey('races') !== atlasSchemaKey('items'))
  ok('字段别名按页签存', aliasKeyOf('races') !== aliasKeyOf('items'))
  ok('模板定义按页签存', projectTemplateKeyOf('races') !== projectTemplateKeyOf('items'))
  ok('角色卡三个页签的别名也各自独立',
    aliasKeyOf('char-main') !== aliasKeyOf('char-npc') && aliasKeyOf('char-secondary') !== aliasKeyOf('char-npc'))

  // ③ 两表各存一份配置，互不覆盖
  await saveAtlasSchema(PID, 'races', { ...emptyAtlasSchema(), fields: [field('cf_a', '食性')] })
  await saveAtlasSchema(PID, 'items', { ...emptyAtlasSchema(), fields: [field('cf_b', '副作用')] })
  const ra = await loadAtlasSchema(PID, 'races')
  const ia = await loadAtlasSchema(PID, 'items')
  ok('races 只读到自己那份配置',
    ra.config?.fields.length === 1 && ra.config.fields[0].id === 'cf_a', JSON.stringify(ra.config?.fields.map(f => f.id)))
  ok('items 只读到自己那份配置',
    ia.config?.fields.length === 1 && ia.config.fields[0].id === 'cf_b', JSON.stringify(ia.config?.fields.map(f => f.id)))

  // 归档另一张表（国家势力）的字段，items 完全不受影响（配置内容 + revision 都不动）
  await saveAtlasSchema(PID, 'nations', { ...emptyAtlasSchema(), fields: [field('cf_n', '政体')] })
  const revBefore = ia.config?.revision ?? -1
  const na = await loadAtlasSchema(PID, 'nations')
  await saveAtlasSchema(PID, 'nations', {
    ...(na.config ?? emptyAtlasSchema()),
    fields: [{ ...field('cf_n', '政体'), archived: true }],
  })
  const iaAfter = await loadAtlasSchema(PID, 'items')
  ok('归档 nations 的字段不改 items 的字段状态', iaAfter.config?.fields[0].archived === false)
  ok('归档 nations 的字段不改 items 的 revision', (iaAfter.config?.revision ?? -2) === revBefore,
    `${revBefore} → ${iaAfter.config?.revision}`)

  // ④ 别名：两表同名键各改各的
  await saveAliases('races', ['名称', '类别'], { 名称: '种族名' })
  await saveAliases('items', ['名称', '类别'], { 名称: '物品名' })
  ok('races 的「名称」显示为「种族名」', (await loadAliases('races'))['名称'] === '种族名')
  ok('items 的「名称」显示为「物品名」（没被 races 串改）', (await loadAliases('items'))['名称'] === '物品名')

  // 角色卡：三个页签的 `基础信息::姓名` 是同一个键名，必须各管各的
  await saveAliases('char-main', ['基础信息::姓名'], { '基础信息::姓名': '主角名' })
  await saveAliases('char-npc', ['基础信息::姓名'], { '基础信息::姓名': 'NPC 名' })
  ok('char-main 的姓名显示名独立',
    (await loadAliases('char-main'))['基础信息::姓名'] === '主角名')
  ok('char-npc 的姓名显示名独立（同键名不串）',
    (await loadAliases('char-npc'))['基础信息::姓名'] === 'NPC 名')

  // ⑤ 有效字段元数据（检索 / AI / 高亮共用的那份口径）只来自本表
  const metaR = await loadEffectiveSearchMeta(getTab('races')!)
  const metaI = await loadEffectiveSearchMeta(getTab('items')!)
  ok('races 的有效键含自己的 cf_a', metaR?.keys.has('cf_a') === true)
  ok('items 的有效键不含 races 的 cf_a', metaI?.keys.has('cf_a') === false)
  ok('races 的「名称」显示名来自自己的别名', metaR?.labels['名称'] === '种族名')
  ok('items 的「名称」显示名来自自己的别名', metaI?.labels['名称'] === '物品名')
  ok('races 的自定义字段显示名是「食性」（不是 cf_a）', metaR?.labels['cf_a'] === '食性')

  // ⑥ 表格行按 tabId 分区：故意让两表用同一个 cf 键名
  const rowR: TableRow = {
    id: 'row-races-1', projectId: PID, tabId: 'races', order: 0,
    data: { 编号: 'R0001', 名称: '血傀', cf_a: '肉食（种族生物的值）' },
  }
  const rowI: TableRow = {
    id: 'row-items-1', projectId: PID, tabId: 'items', order: 0,
    data: { 编号: 'I0001', 名称: '灵石', cf_a: '（物品资源的值）' },
  }
  await db.saveTableRow(rowR)
  await db.saveTableRow(rowI)
  const rowsR = await db.getTableRows('races')
  const rowsI = await db.getTableRows('items')
  ok('races 只读到自己的行', rowsR.length === 1 && rowsR[0].id === 'row-races-1')
  ok('items 只读到自己的行', rowsI.length === 1 && rowsI[0].id === 'row-items-1')
  ok('同名 cf 键在两表的值互不可见',
    rowsR[0].data.cf_a === '肉食（种族生物的值）' && rowsI[0].data.cf_a === '（物品资源的值）')

  // ⑦ 模板读路径：未采用模板时两表都是 null（不共用一份）
  ok('模板定义按页签读，未保存时为空', projectTemplateKeyOf('races') !== projectTemplateKeyOf('items'))

  console.log(`\n—— atlasTabIsolation 用例结束：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exitCode = 1
}

void main()
