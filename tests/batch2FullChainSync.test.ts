// 3.7.6 第二批 · 全链路真源对齐与显式 pid 隔离
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { emptyAtlasSchema } from '../src/lib/atlas/schema'
import { loadAtlasSchema, saveAtlasSchema } from '../src/lib/atlas/persistence'
import { loadAliasesFor, saveAliases, invalidateAliasCache } from '../src/lib/settings/fieldAlias'
import { buildSettingCompendium } from '../src/lib/storage/exporter'
import { buildProjectContext } from '../src/lib/ai/aiContext'
import { collectWorldPack } from '../src/lib/world/worldPack'
import { importWorldIntoProject } from '../src/lib/world/worldImport'
import { loadIndexDocsDetailed } from '../src/lib/semantic/indexer'
import { getTab } from '../src/lib/schema'
import { snapshotOfBuiltin } from '../src/lib/templates/snapshot'
import { addCustomField, finalizeTemplateDef, setFieldPermissions } from '../src/lib/templates/draftOps'
import { saveTemplateDef } from '../src/lib/templates/store'
import type { AtlasFieldDefinition } from '../src/lib/atlas/types'
import type { CardRecord, TableRow } from '../src/lib/types'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean | undefined, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID_A = 'p-b2-a'
const PID_B = 'p-b2-b'

function customField(id: string, label: string, overrides: Partial<AtlasFieldDefinition> = {}): AtlasFieldDefinition {
  return {
    id,
    label,
    type: 'text',
    description: '',
    appliesTo: '*',
    groupId: 'extra',
    order: 0,
    tableVisible: true,
    detailVisible: true,
    searchable: true,
    aiReadable: true,
    aiWritable: false,
    archived: false,
    ...overrides,
  }
}

async function main() {
  __resetMockStores()
  invalidateAliasCache()
  db.setCurrentProject(PID_A)

  // 1. 准备纯表单自定义字段（worldbase）+ 别名 + 归档 + aiReadable=false
  const wbTab = getTab('worldbase')!
  const wbMod = wbTab.modules![0].name
  await saveAtlasSchema(PID_A, 'worldbase', {
    ...emptyAtlasSchema(),
    fields: [
      customField('cf_wb_pub', '法则基石', { groupId: wbMod, aiReadable: true }),
      customField('cf_wb_secret', '作者私密伏笔', { groupId: wbMod, aiReadable: false }),
      customField('cf_wb_arch', '已归档法则', { groupId: wbMod, archived: true }),
    ],
  })
  await saveFormDataForOrLegacy()

  async function saveFormDataForOrLegacy() {
    await db.saveFormDataFor(PID_A, 'worldbase', {
      [`${wbMod}::世界名称`]: '苍穹界',
      cf_wb_pub: '灵气潮汐十年一轮回',
      cf_wb_secret: '天道其实是AI核心',
      cf_wb_arch: '废弃设定',
    })
  }

  // 2. 准备角色卡模板自定义字段（char-main）
  const charTab = getTab('char-main')!
  let charDef = snapshotOfBuiltin(charTab, { name: '角色模板' })
  const c1 = addCustomField(charDef, { id: 'cf_char_pub', label: '灵根属性', type: 'text', groupId: charDef.groups[0].id })
  charDef = setFieldPermissions(c1.def, 'cf_char_pub', { aiRead: true })
  const c2 = addCustomField(charDef, { id: 'cf_char_priv', label: '隐藏身世', type: 'text', groupId: charDef.groups[0].id })
  charDef = setFieldPermissions(c2.def, 'cf_char_priv', { aiRead: false })
  charDef = finalizeTemplateDef(charDef, { revision: 1 })
  await saveTemplateDef(PID_A, charDef)

  const charRec: CardRecord = {
    id: 'card-1',
    projectId: PID_A,
    tabId: 'char-main',
    name: '沈清秋',
    data: {
      '一、基础信息::姓名': '沈清秋',
      cf_char_pub: '冰火双灵根',
      cf_char_priv: '实为魔尊转世',
    },
    order: 0,
  }
  await db.saveCardRecord(charRec)

  // 3. 准备图鉴表格自定义字段（races）
  await saveAtlasSchema(PID_A, 'races', {
    ...emptyAtlasSchema(),
    fields: [
      customField('cf_race_diet', '食性', { type: 'multiSelect', options: ['灵草', '矿石'] }),
      customField('cf_race_arch', '旧食性', { archived: true }),
    ],
  })
  const raceRow: TableRow = {
    id: 'race-1',
    projectId: PID_A,
    tabId: 'races',
    data: {
      编号: 'R0001',
      名称: '星兽',
      cf_race_diet: '["灵草","矿石"]',
      cf_race_arch: '不该导出',
    },
    order: 0,
  }
  await db.saveTableRow(raceRow)

  // B2-P0-1: 设定集导出验证
  const md = await buildSettingCompendium('测试小说')
  ok('B2-P0-1 exporter 导出纯表单自定义字段可读名', md.includes('法则基石') && md.includes('灵气潮汐十年一轮回'))
  ok('B2-P0-1 exporter 排除已归档表单字段', !md.includes('已归档法则') && !md.includes('废弃设定'))
  ok('B2-P0-1 exporter 表格字段翻译 cf_* 为可读名且格式化多选', md.includes('食性：灵草、矿石') && !md.includes('cf_race_diet'))
  ok('B2-P0-1 exporter 表格排除已归档字段', !md.includes('旧食性') && !md.includes('不该导出'))
  ok('B2-P0-1 exporter 角色卡翻译 cf_* 为可读名', md.includes('灵根属性') && md.includes('冰火双灵根') && !md.includes('cf_char_pub'))

  // B2-P0-2: AI 上下文权限过滤验证
  const aiCtx = await buildProjectContext({ budget: 20000 })
  ok('B2-P0-2 aiContext 注入纯表单 aiReadable 字段', aiCtx.text.includes('法则基石：灵气潮汐十年一轮回'))
  ok('B2-P0-2 aiContext 拦截纯表单 aiReadable=false 与归档字段', !aiCtx.text.includes('天道其实是AI核心') && !aiCtx.text.includes('废弃设定'))
  ok('B2-P0-2 aiContext 注入角色卡模板 aiRead 字段', aiCtx.text.includes('灵根属性：冰火双灵根'))
  ok('B2-P0-2 aiContext 拦截角色卡模板 aiRead=false 字段', !aiCtx.text.includes('实为魔尊转世'))

  // B2-P0-3: 世界观打包与导入验证（form 自定义字段）
  const pack = await collectWorldPack({ name: '苍穹世界观' })
  const wbPackTable = pack.tables.find(t => t.tabId === 'worldbase' && t.kind === 'form')
  ok('B2-P0-3 worldPack 随包携带 worldbase 自定义字段定义', Boolean(wbPackTable?.atlasFields?.some(f => f.id === 'cf_wb_pub')))
  await db.saveWorld({ ...pack, versions: [], createdAt: Date.now(), updatedAt: Date.now() })

  db.setCurrentProject(PID_B)
  await importWorldIntoProject(pack.id, 0, PID_B)
  const importedWbSchema = await loadAtlasSchema(PID_B, 'worldbase')
  const importedWbData = await db.getFormDataFor(PID_B, 'worldbase')
  const importedPubField = importedWbSchema.config.fields.find(f => f.label === '法则基石')
  ok('B2-P0-3 worldImport 在新项目合入表单自定义字段定义并重映射数据', Boolean(importedPubField) && importedWbData[importedPubField!.id] === '灵气潮汐十年一轮回')

  // B2-P1: 语义索引覆盖纯表单
  db.setCurrentProject(PID_A)
  const idxDocs = await loadIndexDocsDetailed()
  const wbDoc = idxDocs.docs.find(d => d.refId === 'form::worldbase')
  ok('B2-P1 indexer 索引纯表单页签与 aiReadable 自定义字段', Boolean(wbDoc) && wbDoc!.text.includes('灵气潮汐十年一轮回'))
  ok('B2-P1 indexer 遵循纯表单 aiReadable=false 与归档过滤', Boolean(wbDoc) && !wbDoc!.text.includes('天道其实是AI核心') && !wbDoc!.text.includes('废弃设定'))

  // B2-P2: 显式 pid 别名隔离
  await saveAliases('races', ['名称'], { 名称: '族名A' })
  db.setCurrentProject(PID_B)
  await saveAliases('races', ['名称'], { 名称: '族名B' })
  const aAliases = await loadAliasesFor(PID_A, 'races')
  const bAliases = await loadAliasesFor(PID_B, 'races')
  ok('B2-P2 loadAliasesFor 按显式 pid 隔离', aAliases['名称'] === '族名A' && bAliases['名称'] === '族名B')

  console.log(`\nDONE pass=${pass} fail=${fail}`)
  if (fail > 0) process.exit(1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
