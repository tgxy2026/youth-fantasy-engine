// ============ 自定义下拉「有效选项」解析（resolveOptions · 2026-09-29 补测）============
//
// 为什么补这份：resolveOptions 是「某一列到底有哪些合法取值」的**唯一口径**，
// 四个消费方必须一致（行内下拉 / 表头筛选 / 地图图例 / AI 整理候选值）。
// 2026-09-29 社区反馈「改名内置项后界面显示的还是原值」，根因就在这条口径的
// 应用范围不一致（下拉列表应用了改名，而单元格按钮与表头筛选漏了）。
//
// 钉住的规则：内置项去掉 hidden、应用 renamed（显示名），再拼用户自定义项，同名去重；
// builtinOrigin 必须保留原名（配色/存储都靠它认）。
import { resolveOptions } from '../src/lib/customOptions'
import type { CustomOptionPayload } from '../src/lib/db'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const BUILTIN = ['师徒', '血亲', '仇敌']
const EMPTY: CustomOptionPayload = { items: [], hidden: [] }

// ---------- 无自定义时的基线 ----------
{
  const out = resolveOptions(BUILTIN, EMPTY)
  ok('无自定义：内置原样输出且带 builtinOrigin',
    out.map(o => o.name).join(',') === '师徒,血亲,仇敌' && out.every(o => o.kind === 'builtin' && o.builtinOrigin)
  )
}

// ---------- 改名内置项 ----------
{
  const out = resolveOptions(BUILTIN, { ...EMPTY, renamed: { 师徒: '师徒关系' } })
  ok('改名后列表显示新名', out[0].name === '师徒关系', out[0].name)
  ok('🔴 改名后 builtinOrigin 仍是原名（存储值不受影响）', out[0].builtinOrigin === '师徒', String(out[0].builtinOrigin))
  ok('未改名的项不受影响', out[1].name === '血亲' && out[1].builtinOrigin === '血亲')
}

// ---------- 隐藏内置项 ----------
{
  const out = resolveOptions(BUILTIN, { ...EMPTY, hidden: ['血亲'] })
  ok('隐藏项不出现在有效选项里', out.map(o => o.name).join(',') === '师徒,仇敌', out.map(o => o.name).join(','))
}

// ---------- 自定义项 ----------
{
  const out = resolveOptions(BUILTIN, { ...EMPTY, items: ['道侣', '同门'] })
  ok('自定义项追加在后且 kind=user（无 builtinOrigin）',
    out.length === 5 && out[3].name === '道侣' && out[3].kind === 'user' && out[3].builtinOrigin === undefined)
}

// ---------- 同名去重（改后的显示名撞上自定义项）----------
{
  const out = resolveOptions(BUILTIN, { ...EMPTY, renamed: { 师徒: '师徒关系' }, items: ['师徒关系', '道侣'] })
  const names = out.map(o => o.name)
  ok('改后的显示名与自定义项同名时只保留一个（内置优先）',
    names.filter(n => n === '师徒关系').length === 1 && names[0] === '师徒关系', names.join(','))
}

// ---------- 改名 + 隐藏 + 自定义 三合一 ----------
{
  const out = resolveOptions(BUILTIN, { renamed: { 仇敌: '宿敌' }, hidden: ['血亲'], items: ['道侣'] })
  ok('三合一：改名生效 / 隐藏剔除 / 自定义追加',
    out.map(o => o.name).join(',') === '师徒,宿敌,道侣', out.map(o => o.name).join(','))
  ok('三合一：宿敌的 builtinOrigin 仍是「仇敌」', out[1].builtinOrigin === '仇敌')
}

// ---------- 空 payload 健壮性 ----------
{
  const out = resolveOptions([], EMPTY)
  ok('无内置无自定义 → 空列表', out.length === 0)
  const out2 = resolveOptions(BUILTIN, { items: [], hidden: [], renamed: {} })
  ok('renamed 为空对象不影响输出', out2.map(o => o.name).join(',') === BUILTIN.join(','))
}

console.log(`\ncustomOptions: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
