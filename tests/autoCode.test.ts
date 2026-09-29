// ============ 自动编号：补最小空号（2026-09-29）============
//
// 规则变更：旧版是「最大序号 +1」＋已删除编号不复用（退役池）；
// 社区反馈删错了想补回来补不回来，现改为**顺序补缺**：
//   0001~0005 全在 → 0006；删 0005 → 新增 0005；删 0003 → 新增 0003。
// 这些断言是那条产品决策的唯一钉子 —— 别让它悄悄退回「最大 +1」。
import { nextAutoCode } from '../src/lib/autoCode'
import type { TableRow } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const row = (id: string, code: string): TableRow =>
  ({ id, projectId: 'p', tabId: 'geography', data: { 编号: code }, order: 0 }) as unknown as TableRow

const codes = (...list: string[]) => list.map((c, i) => row(`r${i}`, c))

// ---------- 顺序补缺（核心）----------
{
  ok('空表 → 0001（用表默认前缀 G）', nextAutoCode('geography', []) === 'G0001', nextAutoCode('geography', []))
  ok('0001~0005 全在 → 0006（顺延）',
    nextAutoCode('geography', codes('G0001', 'G0002', 'G0003', 'G0004', 'G0005')) === 'G0006')
  ok('删掉末尾 0005 → 新增仍是 0005（补末尾空位）',
    nextAutoCode('geography', codes('G0001', 'G0002', 'G0003', 'G0004')) === 'G0005')
  ok('🔴 删掉中间 0003 → 新增是 0003（补中间缺口）',
    nextAutoCode('geography', codes('G0001', 'G0002', 'G0004', 'G0005')) === 'G0003',
    nextAutoCode('geography', codes('G0001', 'G0002', 'G0004', 'G0005')))
  ok('多个缺口时补最小的那个',
    nextAutoCode('geography', codes('G0001', 'G0003', 'G0007')) === 'G0002')
  ok('只删了 0001 → 新增补 0001',
    nextAutoCode('geography', codes('G0002', 'G0003')) === 'G0001')
}

// ---------- 前缀 ----------
{
  ok('用表默认前缀（nations → N）', nextAutoCode('nations', []) === 'N0001')
  ok('前缀 IDEA（灵感素材）也能补缺',
    nextAutoCode('ideas', codes('IDEA0001', 'IDEA0003')) === 'IDEA0002')
  ok('表内编号带别的前缀时沿用该前缀',
    nextAutoCode('geography', codes('X0001', 'X0002')) === 'X0003')
}

// ---------- 草稿优先 + 健壮性 ----------
{
  const rows = codes('G0001', 'G0002')
  ok('未落盘草稿参与计算（草稿改了编号也算已占用）',
    nextAutoCode('geography', rows, { r0: { 编号: 'G0009' } }) === 'G0003')
  ok('空编号行不影响（跳过）', nextAutoCode('geography', [...rows, row('rx', '')]) === 'G0003')
  ok('编号无数字部分（纯字母）不影响续号',
    nextAutoCode('geography', [...rows, row('ry', 'GABC')]) === 'G0003')
}
{
  // 自定义编号列名
  const rows = [{ id: 'a', projectId: 'p', tabId: 'geography', data: { 序号: 'G0002' }, order: 0 }] as unknown as TableRow[]
  ok('支持自定义编号列名', nextAutoCode('geography', rows, {}, '序号') === 'G0001')
}

console.log(`\nautoCode: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
