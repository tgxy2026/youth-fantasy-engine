// ============ 3.3.3 · B6 图鉴字段转换与永久删除 ============
//
// 钉住：
//   ① 值一律是字符串：转换只改校验/展示，**不改已填值**；
//   ② 逐值可逆：前导零 / 科学计数法 / 超安全整数 / 非规范小数 → 整批阻止；
//   ③ 文本 ↔ 长文本按长度校验，超限不截断、整批阻止；
//   ④ 删除先出影响数与依赖；被摘要引用就阻止；
//   ⑤ 删定义后再清值：清值失败只留不可见的孤儿键，不会出现类型/值不兼容半状态。
import { __resetMockStores, memoryOps } from './mock-memory'
import * as db from '../src/lib/db'
import {
  TEXT_MAX_CHARS, canonicalNumber, planFieldConversion, planFieldDeletion, purgeFieldValues, sameFieldRows,
} from '../src/lib/atlas/fieldOps'
import type { AtlasFieldDefinition } from '../src/lib/atlas/types'
import { saveAtlasSchema } from '../src/lib/atlas/persistence'
import { emptyAtlasSchema } from '../src/lib/atlas/schema'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-b6-fields'
const TAB = 'races'

function field(over: Partial<AtlasFieldDefinition> = {}): AtlasFieldDefinition {
  return {
    id: 'cf_1', label: '食性', type: 'text', description: '', appliesTo: '*', groupId: 'g',
    order: 0, tableVisible: true, detailVisible: true, searchable: true, aiReadable: true, aiWritable: true,
    archived: false, ...over,
  }
}

const rowsOf = (values: Array<string | null>) =>
  values.map((v, i) => ({ id: `r${i}`, data: v == null ? {} : { cf_1: v, other: 'keep' } as Record<string, string> }))

async function main() {
  __resetMockStores()
  ok('预览检测字段内容改变', !sameFieldRows(rowsOf(['12']), rowsOf(['001'])))
  ok('预览忽略仅有的行顺序变化', sameFieldRows(rowsOf(['12', '34']), rowsOf(['12', '34']).reverse()))
  await memoryOps.put('projects', { id: PID, name: 'B6 字段测试', createdAt: 0, updatedAt: 0 })
  db.setCurrentProject(PID)
  {
    const old = emptyAtlasSchema()
    await saveAtlasSchema(PID, 'races', old)
    let rejected = false
    try { await saveAtlasSchema(PID, 'races', old) } catch { rejected = true }
    ok('字段配置已更新时拒绝旧版本覆盖', rejected)
  }

  // ───────────────── ① 数字字符串必须精确可逆 ─────────────────
  {
    ok('普通整数可逆', canonicalNumber('123').ok)
    ok('负整数可逆', canonicalNumber('-42').ok)
    ok('规范小数可逆', canonicalNumber('12.5').ok)
    ok('空字符串按空值处理', canonicalNumber('').ok)
    ok('前导零阻止', !canonicalNumber('001').ok)
    ok('科学计数法阻止', !canonicalNumber('1e3').ok)
    ok('非数字阻止', !canonicalNumber('十二').ok)
    ok('非规范小数阻止（1.50）', !canonicalNumber('1.50').ok)
    ok('-0 阻止（转回会变 0）', !canonicalNumber('-0').ok)
    ok('超安全整数阻止', !canonicalNumber('9007199254740993').ok)
    ok('原因写清为什么不能转', (canonicalNumber('001').reason ?? '').includes('前导零'))
  }

  // ───────────────── ② 转换预览：整批阻止，不部分写 ─────────────────
  {
    const text = field({ type: 'text' })
    const okPlan = planFieldConversion(text, rowsOf(['12', '-3.5', '', null]), 'number')
    ok('全部可逆 ⇒ 可整批转换', okPlan.ok && okPlan.affected === 2 && okPlan.convertible === 2)
    const badPlan = planFieldConversion(text, rowsOf(['12', '001', 'abc']), 'number')
    ok('有不可逆值 ⇒ 整批阻止', !badPlan.ok && badPlan.blocked.length === 2)
    ok('阻止原因带条数', badPlan.reason.includes('2 条'))

    const long = field({ type: 'longText' })
    const tooLong = planFieldConversion(long, rowsOf(['字'.repeat(TEXT_MAX_CHARS + 1)]), 'text')
    ok('长文→短文本超限阻止', !tooLong.ok && tooLong.blocked.length === 1)
    const fits = planFieldConversion(long, rowsOf(['字'.repeat(TEXT_MAX_CHARS)]), 'text')
    ok('刚好到上限可转换', fits.ok)

    const num = field({ type: 'number' })
    ok('数字→文本总是可逆', planFieldConversion(num, rowsOf(['1', '2.5']), 'text').ok)
    ok('不支持的目标类型阻止', !planFieldConversion(text, rowsOf(['x']), 'select').ok)
    ok('相同类型直接通过', planFieldConversion(text, rowsOf(['x']), 'text').ok)
  }

  // ───────────────── ③ 删除：影响数 + 依赖 ─────────────────
  {
    const f = field()
    const plan = planFieldDeletion(f, rowsOf(['肉食', '', null, '草食']), { summaryKeys: [] })
    ok('影响数只算有值的行', plan.affected === 2 && plan.ok)
    const blocked = planFieldDeletion(f, rowsOf(['肉食']), { summaryKeys: ['cf_1'] })
    ok('被摘要引用 ⇒ 阻止并说明', !blocked.ok && blocked.dependencies.includes('卡片摘要字段'))
    ok('阻止文案让作者先解除依赖', blocked.reason.includes('取消'))
  }

  // ───────────────── ④ 删值只删这个键 ─────────────────
  {
    for (let i = 0; i < 3; i++) {
      await memoryOps.put('tableRows', {
        id: `row${i}`, projectId: PID, tabId: TAB, order: i,
        data: { cf_1: `v${i}`, other: `keep${i}` },
      })
    }
    const n = await purgeFieldValues(PID, TAB, 'cf_1')
    ok('清理了 3 行', n === 3)
    const rows = await memoryOps.getAll<{ data: Record<string, string> }>('tableRows')
    ok('字段值已删', rows.every(r => !('cf_1' in r.data)))
    ok('其它字段原样保留', rows.every((r, i) => r.data.other === `keep${i}`))
    ok('再跑一次没有可清理的', (await purgeFieldValues(PID, TAB, 'cf_1')) === 0)
  }

  // ───────────────── ⑤ 静态契约：入口与安全文案 ─────────────────
  {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const manager = fs.readFileSync(path.join(process.cwd(), 'src/components/atlas/AtlasFieldManager.tsx'), 'utf8')
    ok('字段管理器有类型转换入口', /转换类型/.test(manager) && /预览影响/.test(manager))
    ok('字段管理器有永久删除入口', /永久删除/.test(manager) && /requestDeleteField/.test(manager))
    ok('删除前要备份且失败即中止', /backupBeforeAtlasFieldChange/.test(manager) && /备份没有建成，本次没有删除/.test(manager))
    ok('推荐归档而不是删除的提示还在', /归档.*保留定义与全部内容/.test(manager))
    ok('转换不改值的文案', /不改已填的值/.test(manager))
  }

  console.log(`\nATLAS_FIELD_OPS ${pass} passed, ${fail} failed`)
  process.exitCode = fail === 0 ? 0 : 1
}

main().catch(e => { console.error(e); process.exitCode = 1 })
