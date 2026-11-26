// ============ 3.7.4 · W0 `wcp-output/v1` 契约与校验 ============
//
// 盯四件事：
//   ① Schema 是 Draft 2020-12、必填字段与本项目解析口径一致；
//   ② 正例可被自身校验通过；
//   ③ 类型错误 / 缺字段 / 空数组字段缺失都有可读错误；
//   ④ 样例生成会替换 projectId / projectName，且不污染模块级常量。
import {
  WCP_OUTPUT_EXAMPLE,
  WCP_OUTPUT_SCHEMA,
  WCP_OUTPUT_SCENES,
  validateWcpOutputJson,
  wcpOutputExampleFor,
} from '../src/lib/wcp/wcpWorkspaceSchema'
import { WCP_OUTPUT_SCHEMA_VERSION } from '../src/lib/wcp/wcpTypes'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function main() {
  ok('Schema 使用 Draft 2020-12', WCP_OUTPUT_SCHEMA.$schema === 'https://json-schema.org/draft/2020-12/schema')
  ok('Schema 版本常量固定为 wcp-output/v1', WCP_OUTPUT_SCHEMA_VERSION === 'wcp-output/v1')
  ok('Schema 必填项与解析口径一致',
    JSON.stringify(WCP_OUTPUT_SCHEMA.required) === JSON.stringify(['schemaVersion', 'projectId', 'scene', 'body']))
  ok('场景枚举与 WCP_SCENARIOS 同源', WCP_OUTPUT_SCENES.length === 5 && WCP_OUTPUT_SCENES.includes('chapter-continue'))
  ok('Schema changes 覆盖 6 类候选',
    ['entities', 'statusChanges', 'resourceTransfers', 'foreshadows', 'relations', 'bioNodes']
      .every(k => Object.prototype.hasOwnProperty.call(WCP_OUTPUT_SCHEMA.properties.changes.properties, k)))

  ok('正例本身通过校验', validateWcpOutputJson(WCP_OUTPUT_EXAMPLE).length === 0)

  {
    const missingVersion = clone(WCP_OUTPUT_EXAMPLE) as Record<string, unknown>
    delete missingVersion.schemaVersion
    const errors = validateWcpOutputJson(missingVersion)
    ok('缺 schemaVersion：报错', errors.some(e => e.includes('schemaVersion')))
  }
  {
    const badScene = clone(WCP_OUTPUT_EXAMPLE) as Record<string, unknown>
    badScene.scene = 'unknown-scene'
    ok('非法 scene：报错', validateWcpOutputJson(badScene).some(e => e.includes('scene')))
  }
  {
    const badNo = clone(WCP_OUTPUT_EXAMPLE) as Record<string, unknown>
    badNo.targetChapterNo = -1
    ok('targetChapterNo 为负：报错', validateWcpOutputJson(badNo).some(e => e.includes('targetChapterNo')))
  }
  {
    const badItem = clone(WCP_OUTPUT_EXAMPLE) as Record<string, unknown>
    ;(badItem.changes as Record<string, unknown>).entities = [{ name: '', type: '物品' }]
    ok('实体缺 name：按路径报错', validateWcpOutputJson(badItem).some(e => e.includes('changes.entities[0].name')))
  }
  {
    const badArray = clone(WCP_OUTPUT_EXAMPLE) as Record<string, unknown>
    ;(badArray.changes as Record<string, unknown>).foreshadows = 'not-array'
    ok('字段不是数组：报错', validateWcpOutputJson(badArray).some(e => e.includes('changes.foreshadows 必须是数组')))
  }
  {
    const emptyChanges = clone(WCP_OUTPUT_EXAMPLE) as Record<string, unknown>
    emptyChanges.changes = {}
    ok('changes 没有任何已知字段：报错', validateWcpOutputJson(emptyChanges).some(e => e.includes('至少应包含')))
  }
  ok('非对象输入：直接拒绝', validateWcpOutputJson('x').length === 1)

  {
    const ex = wcpOutputExampleFor('proj_now', '当前书')
    ok('样例生成：替换 projectId / projectName',
      ex.projectId === 'proj_now' && ex.projectName === '当前书')
    ok('样例生成：深拷贝，不污染模块级常量',
      WCP_OUTPUT_EXAMPLE.projectId === 'proj_demo'
      && (ex.changes as { entities: { name: string }[] }).entities[0].name === '青锋剑')
    ;(ex.changes as { entities: { name: string }[] }).entities[0].name = '改过'
    ok('样例生成：二次修改不回写常量',
      (WCP_OUTPUT_EXAMPLE.changes.entities[0] as { name: string }).name === '青锋剑')
    ok('样例生成：自身仍通过校验', validateWcpOutputJson(ex).length === 0)
  }

  console.log(`\nwcpWorkspaceSchema: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main()