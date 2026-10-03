// ============ 2.7.3：字段显示名（方案 B）—— 只改「给人看的字」，存储键一个字节都不碰 ============
//
// 起因（社区反馈）：想把《种族生物》里「契约/驯化关系」这一列改成自己的说法，
// 前端没有入口，只能点进 asar 手改压缩代码。
//
// 🔴 本方案最大的约束：**列名即存储键**（`cellVal(row, col.name)` / `setCellDraft(row.id, col.name, v)`）。
// 所以显示名只能是「显示层」的东西 —— 一旦碰真列名，已填数据全部读不到且不报错。
// 本测试把这个底线钉死：清洗规则、重名拒绝、脏别名剔除、回退原名、存取往返。
import {
  MAX_ALIAS_LEN,
  aliasCount,
  aliasKeyOf,
  invalidateAliasCache,
  labelMapOf,
  labelOf,
  loadAliases,
  sanitizeAliases,
  saveAliases,
  validateAliasInput,
} from '../src/lib/fieldAlias'
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, '::', e) } }

const COLS = ['编号', '名称', '契约/驯化关系', '威胁等级']

async function main() {
  __resetMockStores()

  // ① 键名：按页签隔离，不进同步排除表
  ok('🔴 键名带页签 id', aliasKeyOf('races') === 'fieldAlias::races', aliasKeyOf('races'))

  // ② 空别名表 → 一律回退原名
  ok('空映射时逐列回退原名', labelOf(COLS, {}, '契约/驯化关系') === '契约/驯化关系')
  ok('空映射时 labelMapOf 全是原名',
    Object.entries(labelMapOf(COLS, {})).every(([k, v]) => k === v))

  // ③ 正常改名：只影响显示，键不变
  const m1 = { '契约/驯化关系': '疯狂星期四v我50' }
  ok('🔴 改名后显示名生效', labelOf(COLS, m1, '契约/驯化关系') === '疯狂星期四v我50')
  ok('🔴 原键仍能取到值（存储键没被动过）', labelOf(COLS, m1, '威胁等级') === '威胁等级')
  ok('🔴 labelMapOf 保留未改列', labelMapOf(COLS, m1)['编号'] === '编号')

  // ②b 🔴 表单 / 卡片键（`模块名::字段名`）：无别名时只显示「字段名」，绝不把模块名一起印出来
  //     —— 2026-10-03 社区反馈：作品信息 › 基本信息 里每行都印成「基本信息::书名」，表头被重复
  const FCOLS = ['基本信息::书名', '基本信息::赛道类型']
  ok('🔴 表单键无别名时只显示字段名（剥掉模块前缀）',
    labelMapOf(FCOLS, {})['基本信息::书名'] === '书名',
    labelMapOf(FCOLS, {})['基本信息::书名'])
  ok('🔴 表单键：整个存储键绝不外泄到界面',
    Object.values(labelMapOf(FCOLS, {})).every(v => !v.includes('::')))
  ok('表单键：填成与默认显示名相同 = 视为未改（回退字段名）',
    labelOf(FCOLS, { '基本信息::书名': '书名' }, '基本信息::书名') === '书名')
  ok('表单键：合法别名照常生效',
    labelMapOf(FCOLS, { '基本信息::书名': '作品名' })['基本信息::书名'] === '作品名')
  ok('🔴 表单键：别名撞了同页别的字段显示名 → 丢弃',
    labelMapOf(FCOLS, { '基本信息::书名': '赛道类型' })['基本信息::书名'] === '书名')
  ok('表单键：改名计数只数真正生效的',
    aliasCount(FCOLS, { '基本信息::书名': '书名', '基本信息::赛道类型': '品类' }) === 1)
  ok('🔴 表单键：改到同页别的字段名会被拦下',
    /重名/.test(validateAliasInput(FCOLS, {}, '基本信息::书名', '赛道类型') ?? ''))

  // ④ 边界输入一律回退原名（宁可不改，也不能让两列显示成同一个字）
  ok('空串回退', labelOf(COLS, { '名称': '   ' }, '名称') === '名称')
  ok('与原名相同视为未改', labelOf(COLS, { '名称': '名称' }, '名称') === '名称')
  ok('超长回退', labelOf(COLS, { '名称': 'x'.repeat(MAX_ALIAS_LEN + 1) }, '名称') === '名称')
  ok('🔴 与别的列存储名撞名 → 丢弃',
    labelOf(COLS, { '名称': '威胁等级' }, '名称') === '名称',
    JSON.stringify(sanitizeAliases(COLS, { '名称': '威胁等级' })))
  ok('🔴 与别的列别名撞名 → 后者丢弃（按列顺序先到先得，靠左的列优先）',
    JSON.stringify(sanitizeAliases(COLS, { '名称': '甲', '编号': '甲' })) === '{"编号":"甲"}',
    JSON.stringify(sanitizeAliases(COLS, { '名称': '甲', '编号': '甲' })))
  ok('脏别名（本表已无此列）被剔除',
    JSON.stringify(sanitizeAliases(COLS, { '已删列': '某名字', '名称': '别名甲' })) === '{"名称":"别名甲"}',
    JSON.stringify(sanitizeAliases(COLS, { '已删列': '某名字', '名称': '别名甲' })))
  ok('非对象输入不炸', JSON.stringify(sanitizeAliases(COLS, null)) === '{}')

  // ⑤ 计数：给页头角标用
  ok('aliasCount 只数真正生效的', aliasCount(COLS, { '名称': '甲', '编号': '', '编号x': '乙' }) === 1)

  // ⑥ 输入校验（前端提示层）
  ok('空输入合法', validateAliasInput(COLS, {}, '名称', '  ') === null)
  ok('合法别名无错', validateAliasInput(COLS, {}, '名称', '种族称') === null)
  ok('🔴 与他列别名重名会被拦下', /重名/.test(validateAliasInput(COLS, { '编号': '同名' }, '名称', '同名') ?? ''))
  ok('超长被拦下', /最多/.test(validateAliasInput(COLS, {}, '名称', 'x'.repeat(MAX_ALIAS_LEN + 1)) ?? ''))
  ok('撞存储名被拦下', /重名/.test(validateAliasInput(COLS, {}, '名称', '威胁等级') ?? ''))

  // ⑦ 存取往返：落盘的是**清洗后**的映射
  invalidateAliasCache()
  await saveAliases('races', COLS, { '契约/驯化关系': '疯狂星期四v我50', '名称': '编号' /* 撞名，应被剔 */ })
  const raw = await db.getSetting<Record<string, string>>(aliasKeyOf('races'), {})
  ok('🔴 落盘剔掉了撞名的脏别名', raw['名称'] === undefined, JSON.stringify(raw))
  ok('🔴 落盘保留了合法别名', raw['契约/驯化关系'] === '疯狂星期四v我50', JSON.stringify(raw))

  // ⑧ 缓存一致性：写完立刻能从别处读到（关系分组视图 / 设定检索共用）
  ok('🔴 同进程内再读命中缓存', (await loadAliases('races'))['契约/驯化关系'] === '疯狂星期四v我50')
  ok('另一张表互不干扰', (await loadAliases('nations'))['契约/驯化关系'] === undefined)

  // ⑨ 换项目（清缓存）后不串味
  invalidateAliasCache()
  ok('清缓存后回库仍在（别名跟着项目走）',
    (await loadAliases('races'))['契约/驯化关系'] === '疯狂星期四v我50')

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed')
  if (fail > 0) process.exit(1)
}
main().catch(e => { console.log('FAIL 未捕获异常:', e?.stack ?? e); process.exit(1) })
