// 3.7.6 · 设定表标题统一取值（resolveRowTitle）
//
// 背景：设定检索原来只认 schema 的 displayCol，值空就回退「第一个非空」——新增行最先写入的是
// 自动编号，于是标题变成 R0001；名字写进自定义字段时又完全看不见（用户 2026-11-28 反馈）。
import { resolveRowTitle } from '../src/lib/settings/rowTitle'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const races = { displayCol: '名称' } as const

// ① 标准数据：名称有值 → 永远用名称（不因为编号排在前面而改变）
ok('名称有值 → 取名称', resolveRowTitle(races, { 编号: 'R0001', 名称: '血傀' }) === '血傀')

// ② 用户场景：内置名称留空，名字写在自定义字段
const custom = resolveRowTitle(races, { 编号: 'R0007', 名称: '', cf_abc: '测试种族甲' }, {
  keys: ['编号', '名称', 'cf_abc'],
  labels: { 编号: '编号', 名称: '名称', cf_abc: '种族名' },
})
ok('名称空 + 自定义字段有值 → 取自定义值，不取编号', custom === '测试种族甲', custom)

// ③ 没有 labels（本章引用 / 高亮路径）：靠键名判断，仍不取编号
ok('无 labels 时跳过编号取自定义值',
  resolveRowTitle(races, { 编号: 'R0007', cf_abc: '测试种族甲' }) === '测试种族甲')

// ④ 只剩编号时，编号是最后的兜底（不能返回空）
ok('只有编号 → 兜底用编号', resolveRowTitle(races, { 编号: 'R0007' }) === 'R0007')

// ⑤ 模板改过显示名：labels 里「事件名称」要能被认出
const history = { displayCol: '事件名称' } as const
ok('模板显示名含「名称」→ 优先于其它非空字段',
  resolveRowTitle(history, { 编号: 'H0001', 事件名称: '天裂之夜', 影响与后果: '三方混战' }) === '天裂之夜')

// ⑥ 内置「别称」不能抢标题
ok('别称不抢标题',
  resolveRowTitle(races, { 编号: 'R0002', 名称: '', 别称: '血魔傀儡' }) === '血魔傀儡')

// ⑦ 「对应伏笔编号」这类编码列要被跳过，不能当标题
ok('编码类列跳过（对应伏笔编号）',
  resolveRowTitle(history, { 编号: 'H0002', 事件名称: '', 对应伏笔编号: 'F0001' }) === 'H0002')

// ⑧ 空数据
ok('空数据返回空串', resolveRowTitle(races, {}) === '')
ok('undefined 数据返回空串', resolveRowTitle(races, undefined) === '')

console.log(`\n—— rowTitle 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
