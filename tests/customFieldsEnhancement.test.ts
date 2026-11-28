// 3.7.6 · 自定义字段完善与强化（P0 + P1 + P2）
import { __resetMockStores } from './mock-memory'
import * as db from '../src/lib/db'
import { getTab } from '../src/lib/schema'
import { emptyAtlasSchema } from '../src/lib/atlas/schema'
import { loadAtlasSchema, saveAtlasSchema } from '../src/lib/atlas/persistence'
import { builtinFieldNameConflict } from '../src/lib/atlas/fieldNameGuard'
import { CUSTOM_TEMPLATE_TYPES } from '../src/components/templates/TemplateFieldEditor'
import {
  supportsModuleCustomFields,
  moduleGroupsOf,
  resolveModuleCustomFields,
} from '../src/lib/forms/customFields'
import { loadEffectiveSearchMeta } from '../src/lib/templates/effectiveSearchMeta'
import { loadFieldRules } from '../src/lib/semantic/fieldRules'
import { resolveTemplateForTab } from '../src/lib/templates/resolve'
import { snapshotOfBuiltin } from '../src/lib/templates/snapshot'
import { addCustomField, finalizeTemplateDef } from '../src/lib/templates/draftOps'
import { saveTemplateDef } from '../src/lib/templates/store'
import {
  cardFieldsOf,
  cardRecordsToTableRows,
  buildCardRecords,
  exportCardsCsv,
} from '../src/lib/storage/cardIO'
import { parseCsvGrid } from '../src/lib/storage/tableIO'
import { runDataHealthCheck } from '../src/lib/storage/dataHealth'
import type { AtlasFieldDefinition } from '../src/lib/atlas/types'
import type { CardRecord, TableRow } from '../src/lib/types'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean | undefined, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'p-376-cf'

function makeCustom(id: string, label: string, overrides: Partial<AtlasFieldDefinition> = {}): AtlasFieldDefinition {
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
  db.setCurrentProject(PID)

  // P0-1 & P0-3: 同名冲突拦截 & 自定义类型收敛
  ok('P0-1 builtinFieldNameConflict 拦截同名字段', builtinFieldNameConflict('姓名', ['姓名', '年龄']) !== '')
  ok('P0-1 builtinFieldNameConflict 拦截名称类近义', builtinFieldNameConflict('种族名称', ['名称', '类别']) !== '')
  ok('P0-1 builtinFieldNameConflict 放行普通字段', builtinFieldNameConflict('瞳色', ['姓名', '年龄']) === '')
  ok('P0-3 CUSTOM_TEMPLATE_TYPES 仅含六种安全类型', CUSTOM_TEMPLATE_TYPES.length === 6 && !CUSTOM_TEMPLATE_TYPES.includes('other'))

  // P0-4: 角色卡 CSV 导出/导入对齐有效模板
  const charMain = getTab('char-main')!
  let charDef = snapshotOfBuiltin(charMain, { name: '测试角色模板' })
  const added = addCustomField(charDef, { id: 'cf_eye', label: '瞳色', type: 'text', groupId: charDef.groups[0].id })
  charDef = finalizeTemplateDef(added.def, { revision: 1 })
  await saveTemplateDef(PID, charDef)

  const exportTpl = resolveTemplateForTab(charMain, { def: charDef, purpose: 'export', ignoreAppliesTo: true })
  const fieldsWithCustom = cardFieldsOf(charMain, exportTpl)
  ok('P0-4 cardFieldsOf 包含模板自定义字段', fieldsWithCustom.some(f => f.path === 'cf_eye' && f.label === '瞳色'))

  const sampleRec: CardRecord = {
    id: 'c1',
    projectId: PID,
    tabId: 'char-main',
    name: '林小羽',
    data: { '一、基础信息::姓名': '林小羽', cf_eye: '琥珀金' },
    order: 0,
  }
  const csv = exportCardsCsv(charMain, [sampleRec], exportTpl)
  const parsed = parseCsvGrid(csv)
  ok('P0-4 exportCardsCsv 表头含自定义字段名', parsed[0]?.includes('瞳色'))
  ok('P0-4 exportCardsCsv 数据行含自定义字段值', parsed[1]?.includes('琥珀金'))

  const tblRows = cardRecordsToTableRows(charMain, [sampleRec], exportTpl)
  const rebuilt = buildCardRecords(
    [{ data: tblRows[0].data, index: 1, dupExisting: false, dupInBatch: false, missing: [], dangling: [], codeConflict: false }],
    charMain,
    [],
    PID,
    () => 'c2',
    exportTpl,
  )
  ok('P0-4 buildCardRecords 导入写回 cf_eye', rebuilt[0]?.data.cf_eye === '琥珀金')

  // P0-5: 孤儿自定义字段体检
  const orphanRow: TableRow = {
    id: 'r-orphan',
    projectId: PID,
    tabId: 'races',
    data: { 编号: 'R0001', 名称: '雪妖', cf_deleted_from_tpl: '冰原' },
    order: 0,
  }
  await db.saveTableRow(orphanRow)
  const health = await runDataHealthCheck()
  ok('P0-5 dataHealth 检出孤儿 cf_* 字段', health.issues.some(i => i.category === '孤儿自定义字段' && i.detail.includes('cf_deleted_from_tpl')))

  // P1: 纯表单 / 卡片 / 大纲自定义字段
  const posTab = getTab('positioning')!
  const volTab = getTab('volume-outline')!
  const relTab = getTab('relations')!
  ok('P1 supportsModuleCustomFields 对纯表单为 true', supportsModuleCustomFields(posTab))
  ok('P1 supportsModuleCustomFields 对分卷大纲为 true', supportsModuleCustomFields(volTab))
  ok('P1 supportsModuleCustomFields 对常规表格为 false', !supportsModuleCustomFields(relTab))
  ok('P1 moduleGroupsOf 包含内置模块与 extra', moduleGroupsOf(posTab).some(g => g.id === 'extra'))

  const posSchema = {
    ...emptyAtlasSchema(),
    fields: [
      makeCustom('cf_pos_1', '核心爽点', { groupId: posTab.modules![0].name, aiReadable: true, aiWritable: true }),
      makeCustom('cf_pos_hidden', '私密笔记', { groupId: 'extra', searchable: false, aiReadable: false }),
      makeCustom('cf_pos_arch', '已归档项', { archived: true }),
    ],
  }
  await saveAtlasSchema(PID, 'positioning', posSchema)
  const loadedPos = await loadAtlasSchema(PID, 'positioning')
  ok('P1 saveAtlasSchema/loadAtlasSchema 读写纯表单自定义字段', loadedPos.config.fields.length === 3 && loadedPos.config.revision === 1)

  const detailFields = resolveModuleCustomFields(loadedPos.config, { purpose: 'detail' })
  ok('P1 resolveModuleCustomFields 过滤归档字段', detailFields.length === 2 && !detailFields.some(f => f.key === 'cf_pos_arch'))

  const aiWriteFields = resolveModuleCustomFields(loadedPos.config, { purpose: 'aiWrite' })
  ok('P1 resolveModuleCustomFields 按 aiWritable 过滤', aiWriteFields.length === 1 && aiWriteFields[0].key === 'cf_pos_1')

  // P2: 有效检索元数据 & 语义索引规则
  const posMeta = await loadEffectiveSearchMeta(posTab)
  ok('P2 effectiveSearchMeta 纳入纯表单可检索自定义字段', posMeta?.keys.has('cf_pos_1') && posMeta.labels.cf_pos_1 === '核心爽点')
  ok('P2 effectiveSearchMeta 排除不可检索与归档字段', !posMeta?.keys.has('cf_pos_hidden') && !posMeta?.keys.has('cf_pos_arch'))

  const posRules = await loadFieldRules(PID, posTab)
  ok('P2 loadFieldRules 支持纯表单自定义字段权限', posRules.kind === 'rules'
    && posRules.rules.cf_pos_1?.aiReadable === true
    && posRules.rules.cf_pos_hidden?.aiReadable === false)

  const charRules = await loadFieldRules(PID, charMain)
  ok('P2 loadFieldRules 支持角色卡模板快照', charRules.kind === 'rules' && Boolean(charRules.rules.cf_eye))

  console.log(`\nDONE pass=${pass} fail=${fail}`)
  if (fail > 0) process.exit(1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
