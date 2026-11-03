import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readTestPlan } from '../scripts/verify/test-plan.mjs'
import { runTests } from './run-all.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-test-plan-'))
const tests = path.join(root, 'tests'); fs.mkdirSync(tests)
let passed = 0
function check(name: string, value: unknown) { assert.ok(value, name); passed++; console.log('PASS ' + name) }
const manifest = 'BATCH_A="one"\nBATCH_B="two"\nBATCH_C="three"\nBATCH_D="four"\n'
function reset() {
  for (const name of fs.readdirSync(tests)) fs.unlinkSync(path.join(tests, name))
  fs.writeFileSync(path.join(tests, 'run-batches.sh'), manifest)
  for (const name of ['one', 'two', 'three', 'four']) fs.writeFileSync(path.join(tests, name + '.test.ts'), '// fixture')
  fs.writeFileSync(path.join(tests, 'build-test.mjs'), 'if(process.argv[2]==="two"&&process.env.YFE_PLAN_NEGATIVE==="1")process.exit(9)')
  for (const file of ['seed-schema-check.mjs', 'feature-deps-check.mjs']) fs.writeFileSync(path.join(tests, file), '// standalone fixture')
}
function rejects(name: string) { assert.throws(() => readTestPlan(root)); passed++; console.log('PASS ' + name) }
try {
  reset()
  const all = readTestPlan(root)
  check('全量使用唯一分批名单并包括两项独立闸', all.actualEntries === 4 && all.jobs.length === 6)
  check('定向批次仅运行所选入口', readTestPlan(root, ['B']).jobs.length === 1 && readTestPlan(root, ['B']).jobs[0].id === 'two')
  assert.throws(() => readTestPlan(root, ['A', 'A'])); passed++
  assert.throws(() => readTestPlan(root, ['all', 'A'])); passed++
  assert.throws(() => readTestPlan(root, ['unknown'])); passed++
  fs.writeFileSync(path.join(tests, 'extra.test.ts'), '// forgotten')
  rejects('文件未归批必须失败关闭')
  reset(); fs.unlinkSync(path.join(tests, 'one.test.ts')); rejects('名单残留入口必须失败关闭')
  reset(); fs.appendFileSync(path.join(tests, 'run-batches.sh'), 'BATCH_A="one"\n'); rejects('重复批次定义拒绝')
  reset(); fs.writeFileSync(path.join(tests, 'run-batches.sh'), manifest.replace('BATCH_B="two"', 'BATCH_B="two one"')); rejects('跨批重复入口拒绝')
  reset(); fs.unlinkSync(path.join(tests, 'seed-schema-check.mjs')); rejects('独立闸不能缺失后静默跳过')
  reset()
  const reportPath = path.join(root, 'report.json')
  const success = await runTests({ root, reportPath })
  check('真实夹具子进程全部执行且机器报告匹配', success.ok && success.passed === 6 && JSON.parse(fs.readFileSync(reportPath, 'utf8')).planned === 6)
  process.env.YFE_PLAN_NEGATIVE = '1'
  try {
    const failed = await runTests({ root, batches: ['A', 'B'] })
    check('真实子测试非零使总结果失败', !failed.ok && failed.failed === 1 && failed.passed === 1)
  } finally { delete process.env.YFE_PLAN_NEGATIVE }
  const controller = new AbortController(); controller.abort()
  const cancelled = await runTests({ root, batches: ['A'], signal: controller.signal })
  check('未执行不能冒充通过', !cancelled.ok && cancelled.notRun === 1 && cancelled.passed === 0)
  console.log('testPlan: ' + passed + ' passed')
} finally {
  const target = fs.realpathSync(root)
  if (path.dirname(target) !== fs.realpathSync(os.tmpdir()) || !path.basename(target).startsWith('yfe-test-plan-')) throw new Error('Refusing unsafe fixture cleanup')
  fs.rmSync(target, { recursive: true })
}
