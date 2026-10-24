import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hashPaths, scopeVerdict, writeReports } from '../scripts/verify/evidence.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yfe-evidence-'))
let passed = 0
function check(name: string, value: unknown) { assert.ok(value, name); passed++; console.log('PASS ' + name) }
const contracts = [{ id: 'foundation', stage: 'foundation', minAssertions: 1 }, { id: 'business', stage: 'business', minAssertions: 2 }]
const good = [{ id: 'foundation', status: 'passed', assertions: 1 }, { id: 'business', status: 'passed', assertions: 2 }]
try {
  await fs.mkdir(path.join(root, 'src')); await fs.mkdir(path.join(root, 'tests'))
  await fs.writeFile(path.join(root, 'src', 'data.ts'), 'fixture-a')
  const before = await hashPaths(root, ['src', 'tests'])
  await fs.writeFile(path.join(root, 'tests', '.generated.test.mjs'), 'generated bundle')
  const generated = await hashPaths(root, ['src', 'tests'])
  check('测试生成包不使源证据失效', before.sha256 === generated.sha256)
  await fs.writeFile(path.join(root, 'src', 'data.ts'), 'fixture-b')
  check('修改输入立即改变指纹', before.sha256 !== (await hashPaths(root, ['src', 'tests'])).sha256)
  await fs.writeFile(path.join(root, 'tests', 'case.test.ts'), 'real source')
  check('未提交的新测试也进入指纹', generated.count < (await hashPaths(root, ['src', 'tests'])).count)
  await assert.rejects(() => hashPaths(root, ['../escape'])); passed++
  await fs.mkdir(path.join(root, 'empty'))
  await assert.rejects(() => hashPaths(root, ['empty'])); passed++
  check('全部必需契约齐全才绿', scopeVerdict(contracts, good).code === 0)
  check('阶段通过不能冒充完整收口', scopeVerdict(contracts, [good[0]], 'foundation').code === 0 && scopeVerdict(contracts, [good[0]]).code === 2)
  check('零断言不能通过', scopeVerdict(contracts, [{ ...good[0], assertions: 0 }], 'foundation').code === 1)
  check('少跑断言不能通过', scopeVerdict(contracts, [good[0], { ...good[1], assertions: 1 }]).code === 1)
  for (const status of ['blocked', 'not-run']) check('未执行状态阻止完整通过：' + status, scopeVerdict(contracts, [good[0], { ...good[1], status }]).code === 2)
  check('必需项不能改为不适用躲避', scopeVerdict(contracts, [good[0], { ...good[1], status: 'not-applicable' }]).code === 1)
  check('重复结果拒绝', scopeVerdict(contracts, [...good, good[0]]).code === 1)
  check('未知结果拒绝', scopeVerdict(contracts, [...good, { id: 'other', status: 'passed', assertions: 10 }]).code === 1)
  check('空执行计划不能通过', scopeVerdict([], []).code === 1)
  check('非法契约门槛拒绝', scopeVerdict([{ id: 'bad', stage: 'foundation', minAssertions: 0 }], []).code === 1)
  const report = { stage: 'foundation', verdict: { code: 0 }, localVerdict: { code: 2 }, inputs: { combined: 'fixture' }, results: [good[0], { ...good[1], status: 'not-run', reason: '<pending & missing>' }] }
  await writeReports(root, report)
  const junit = await fs.readFile(path.join(root, 'junit.xml'), 'utf8')
  const ledger = JSON.parse(await fs.readFile(path.join(root, 'coverage-ledger.json'), 'utf8'))
  check('未接业务在JUnit计跳过且转义文本', junit.includes('skipped="1"') && junit.includes('&lt;pending &amp; missing&gt;'))
  check('阶段报告明确完整收口尚未完成', !ledger.complete && ledger.counts['not-run'] === 1)
  console.log('reliabilityEvidence: ' + passed + ' passed')
} finally {
  const target = await fs.realpath(root)
  if (path.dirname(target) !== await fs.realpath(os.tmpdir()) || !path.basename(target).startsWith('yfe-evidence-')) throw new Error('Refusing unsafe fixture cleanup')
  await fs.rm(target, { recursive: true })
}
