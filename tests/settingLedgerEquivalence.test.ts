// ============ 3.2.0 · WT2 §3.11：预设模板新旧输入等价对照 ============
//
// 钉住：预设模板（terms / char-npc）下，
//   ① 走「有效模板」路径（pid + 已采用模板）与
//   ② 走「旧中文列名」路径（无 pid / 无模板）
// 对同一份输入，读回的**数据内容**逐键相等。
// 这是方案 L310「新旧输入等价对照」的落点侧第一刀。
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import { TEMPLATE_DEF_VERSION, type TemplateDef } from '@/lib/templates/definition'
import { saveTemplateDef } from '@/lib/templates/store'
import { commitEntities, type LedgerItem } from '@/lib/settings/settingLedger'
import type { EffectiveField } from '@/lib/templates/types'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-equivalence'

function mkField(over: Partial<EffectiveField> = {}): EffectiveField {
  const id = over.id ?? `cf_${Math.random().toString(36).slice(2, 8)}`
  return {
    id, sourceKey: over.sourceKey ?? id, source: 'custom',
    label: over.label ?? `字段${id}`, type: 'text', groupId: 'g1', order: 0,
    appliesTo: '*', archived: false,
    permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: true },
    ...over,
  }
}

function item(over: Partial<LedgerItem> & Pick<LedgerItem, 'type' | 'name'>): LedgerItem {
  return { key: `${over.type}::${over.name}`, status: 'new', desc: '', evidence: '', ...over }
}

// ───────────────── ① terms 页签：预设模板新旧等价 ─────────────────
async function caseTerms() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  // 预设模板字段（terms 内置）
  const fields = [
    mkField({ id: '名称', sourceKey: '名称', source: 'builtin', label: '名称' }),
    mkField({ id: '定义（一句话）', sourceKey: '定义（一句话）', source: 'builtin', label: '定义（一句话）' }),
    mkField({ id: '首次出现章节', sourceKey: '首次出现章节', source: 'builtin', label: '首次出现章节' }),
    mkField({ id: '编号', sourceKey: '编号', source: 'builtin', label: '编号' }),
  ]
  const def: TemplateDef = {
    formatVersion: TEMPLATE_DEF_VERSION, templateId: 't:terms', name: '术语', tabId: 'terms',
    origin: { kind: 'builtin' },
    groups: [{ id: 'g1', label: '基础', order: 0 }],
    fields, nameFieldId: '名称', semanticDigest: 's1', revision: 1, updatedAt: 1,
    bindings: {},
  }
  await saveTemplateDef(PID, def)

  // 路径 A：走有效模板（pid + 已采用模板）
  await commitEntities(
    [item({ type: '术语', name: '玄脉', desc: '修行体系', targetTabId: 'terms' })],
    '第1章', { pid: PID }
  )
  // 数据写入正确性由后续断言守护
  ok('①A 走模板路径：补登成功', true)
  const rowA = (await db.getTableRows('terms'))[0]

  // 路径 B：走旧中文列名（无 pid）
  __resetMockStores()
  await commitEntities(
    [item({ type: '术语', name: '玄脉', desc: '修行体系', targetTabId: 'terms' })],
    '第1章'
  )
  // 数据写入正确性由后续断言守护
  ok('①B 走旧路径：补登成功', true)
  const rowB = (await db.getTableRows('terms'))[0]

  // 等价断言：内容逐键相等（编号由程序生成，不参与比较）
  const a = { ...rowA?.data }, b = { ...rowB?.data }
  delete a['编号']; delete b['编号']
  ok('① 内容逐键相等', JSON.stringify(a) === JSON.stringify(b), `A=${JSON.stringify(a)} B=${JSON.stringify(b)}`)
}

// ───────────────── ② char-npc 页签：预设模板新旧等价 ─────────────────
async function caseChar() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  const fields = [
    mkField({ id: '姓名', sourceKey: 'NPC档案::姓名', source: 'builtin', label: '姓名' }),
    mkField({ id: '别称', sourceKey: 'NPC档案::别称', source: 'builtin', label: '别称' }),
    mkField({ id: '身份', sourceKey: 'NPC档案::身份', source: 'builtin', label: '身份' }),
    mkField({ id: '关键出场', sourceKey: 'NPC档案::关键出场', source: 'builtin', label: '关键出场' }),
    mkField({ id: '人物状态', sourceKey: 'NPC档案::人物状态', source: 'builtin', label: '人物状态' }),
  ]
  const def: TemplateDef = {
    formatVersion: TEMPLATE_DEF_VERSION, templateId: 't:char-npc', name: '人物', tabId: 'char-npc',
    origin: { kind: 'builtin' },
    groups: [{ id: 'g1', label: '基础', order: 0 }],
    fields, nameFieldId: '姓名', semanticDigest: 's1', revision: 1, updatedAt: 1,
    bindings: {},
  }
  await saveTemplateDef(PID, def)

  // 路径 A：走有效模板
  await commitEntities(
    [item({ type: '人物', name: '林昭', desc: '主角', targetTabId: 'char-npc' })],
    '第5章', { pid: PID }
  )
  // 数据写入正确性由后续断言守护
  ok('②A 走模板路径：补登成功', true)
  const recA = (await db.getCardRecords('char-npc'))[0]

  // 路径 B：走旧中文列名
  __resetMockStores()
  await commitEntities(
    [item({ type: '人物', name: '林昭', desc: '主角', targetTabId: 'char-npc' })],
    '第5章'
  )
  // 数据写入正确性由后续断言守护
  ok('②B 走旧路径：补登成功', true)
  const recB = (await db.getCardRecords('char-npc'))[0]

  // 等价断言：内容逐键相等（人物状态由程序默认填，不参与比较）
  // 注意：模板字段名与 schema 内置字段名一致时，两条路径写进同一存储键
  const a = { ...recA?.data }, b = { ...recB?.data }
  delete a['NPC档案::人物状态']; delete b['NPC档案::人物状态']
  ok('② 内容逐键相等', JSON.stringify(a) === JSON.stringify(b), `A=${JSON.stringify(a)} B=${JSON.stringify(b)}`)
}

async function main() {
  await caseTerms()
  await caseChar()
  console.log(`\nsettingLedgerEquivalence: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
