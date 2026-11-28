// 3.7.6 · 自定义字段命名守卫（P2）与名字字段重复判据（P3）
import { builtinFieldNameConflict } from '../src/lib/atlas/fieldNameGuard'
import { duplicateNamePlan, isNameLikeCustomFieldLabel } from '../src/lib/atlas/duplicateNameRules'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const builtin = ['编号', '名称', '上级', '别称', '类别']

// ---------- P2：新增字段命名 ----------
ok('与内置同名「名称」→ 拦截',
  builtinFieldNameConflict('名称', builtin).includes('内置字段已经叫'))
ok('名称类「标题」→ 拦截并指向内置名称列',
  builtinFieldNameConflict('标题', builtin).includes('内置已有名称列'))
ok('合法字段「种族名」→ 不拦（交给体检报告，不误伤）',
  builtinFieldNameConflict('种族名', builtin) === '')
ok('合法字段「食性」→ 不拦', builtinFieldNameConflict('食性', builtin) === '')
ok('合法字段「别称」若内置已有 → 仍拦截（同名优先）',
  builtinFieldNameConflict('别称', builtin).includes('内置字段已经叫'))
ok('空白名不在这里报错（另有必填校验）',
  builtinFieldNameConflict('   ', builtin) === '')
ok('内置没有名称列时允许加「名称」',
  builtinFieldNameConflict('名称', ['编号', '类别']) === '')

// ---------- P3：名字字段重复判据 ----------
ok('「种族名」算名字类', isNameLikeCustomFieldLabel('种族名'))
ok('「名字」算名字类', isNameLikeCustomFieldLabel('名字'))
ok('「别名」不算（天然并存）', !isNameLikeCustomFieldLabel('别名'))
ok('「曾用名」不算', !isNameLikeCustomFieldLabel('曾用名'))
ok('「称号」不算', !isNameLikeCustomFieldLabel('称号'))
ok('「食性」不算', !isNameLikeCustomFieldLabel('食性'))
ok('空标签不算', !isNameLikeCustomFieldLabel('  '))

const keys = ['名称', 'cf_a']
const both = duplicateNamePlan(keys, { 名称: '血傀', cf_a: '血傀（新登记名）' }, '名称')
ok('两边都有值 → 保留内置、归档自定义',
  !!both && both.keepKey === '名称' && both.dropKeys.length === 1 && both.dropKeys[0] === 'cf_a')
ok('只有内置有值 → 不算重复', duplicateNamePlan(keys, { 名称: '血傀' }, '名称') === null)
ok('只有自定义有值 → 不算重复（P1 负责显示）',
  duplicateNamePlan(keys, { 名称: '', cf_a: '测试种族甲' }, '名称') === null)
ok('内置为空、两个自定义都有值 → 保留第一个',
  duplicateNamePlan(['cf_a', 'cf_b'], { cf_a: '甲', cf_b: '乙' }, '名称')?.keepKey === 'cf_a')
ok('少于两个候选键 → 不判', duplicateNamePlan(['名称'], { 名称: '血傀' }, '名称') === null)

console.log(`\n—— atlasNameGuard 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
