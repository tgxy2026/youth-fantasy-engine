// ============ 3.2.0 · T3：伴写上下文带出改名后字段名 ============
//
// 验证：作者把「姓名」改名为「名字」后，伴写上下文应带出「名字」而非「姓名」。
// 链路：buildInlineBriefing → buildProjectContext → sectionOf → loadFieldGating → renderForm
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import { TEMPLATE_DEF_VERSION, type TemplateDef } from '@/lib/templates/definition'
import { saveTemplateDef } from '@/lib/templates/store'
import { buildInlineBriefing } from '@/lib/ai/aiContext'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-ghost-rename'

async function caseGhostRename() {
  __resetMockStores()
  await db.setCurrentProject(PID)

  // 1. 建一个项目，采用 char-main 模板（buildInlineBriefing 只带 char-main）
  const def: TemplateDef = {
    formatVersion: TEMPLATE_DEF_VERSION,
    templateId: 't:char-main',
    name: '主要角色',
    tabId: 'char-main',
    origin: { kind: 'builtin' },
    groups: [{ id: 'g1', label: '基础', order: 0 }],
    fields: [
      { id: '姓名', sourceKey: '角色档案::姓名', source: 'builtin', label: '姓名', type: 'text', groupId: 'g1', order: 0, appliesTo: '*', archived: false, permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: true } },
      { id: '别称', sourceKey: '角色档案::别称', source: 'builtin', label: '别称', type: 'text', groupId: 'g1', order: 0, appliesTo: '*', archived: false, permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: true } },
      { id: '身份定位', sourceKey: '角色档案::定位', source: 'builtin', label: '身份定位', type: 'text', groupId: 'g1', order: 0, appliesTo: '*', archived: false, permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: true } },
    ],
    nameFieldId: '姓名',
    semanticDigest: 's1',
    revision: 1,
    updatedAt: 1,
    bindings: {},
  }
  const saved = await saveTemplateDef(PID, def)
  ok('模板保存成功', saved.ok === true, JSON.stringify(saved))

  // 2. 写一条角色卡数据
  const rec = {
    id: 'r1',
    projectId: PID,
    tabId: 'char-main',
    name: '林昭',
    data: {
      '角色档案::姓名': '林昭',
      '角色档案::定位': '主角',
    },
    order: 0,
  }
  await db.saveCardRecord(rec)

  // 3. 改名：把「姓名」改名为「名字」（通过模板字段的 label）
  // 注意：这里我们直接修改模板字段的 label，模拟作者在「字段名」弹窗里改名
  const renamedDef: TemplateDef = {
    ...def,
    fields: [
      { ...def.fields[0], label: '名字' }, // 改名：姓名 → 名字
      def.fields[1],
      def.fields[2],
    ],
    revision: 2,
    updatedAt: Date.now(),
  }
  await saveTemplateDef(PID, renamedDef)

  // 4. 调用 buildInlineBriefing，检查输出是否带出「名字」
  const ctx = await buildInlineBriefing({ focusChapterId: undefined })
  ok('伴写上下文生成成功', ctx.length > 0, ctx)

  // 5. 验证：上下文应包含「名字：林昭」，不应包含「姓名：林昭」
  ok('上下文带出改名后字段名「名字」', ctx.includes('名字：林昭'), ctx)
  ok('上下文不带旧字段名「姓名」', !ctx.includes('姓名：林昭'), ctx)
}

async function main() {
  await caseGhostRename()
  console.log(`\nghostRename: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
