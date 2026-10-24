import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runProcess, processVerdict } from '../scripts/verify/process.mjs'

let passed = 0
function check(name: string, condition: unknown) { assert.ok(condition, name); passed++; console.log('PASS ' + name) }
check('明确退出零才成功', processVerdict({ exitCode: 0 }).ok)
for (const input of [
  { exitCode: null }, { exitCode: null, signal: 'SIGTERM' }, { exitCode: 0, signal: 'SIGTERM' },
  { exitCode: 0, timedOut: true }, { exitCode: 0, aborted: true }, { exitCode: 0, error: 'EBUSY' },
  { exitCode: 0, outputLimit: true }, { exitCode: 1 },
]) check('异常判据不被转换为零：' + JSON.stringify(input), !processVerdict(input).ok && processVerdict(input).code !== 0)

const success = await runProcess(process.execPath, ['-e', 'process.stdout.write("可回读输出");process.stderr.write("diagnostic")'])
check('真实异步子进程正确读取中文和stderr', success.ok && success.stdout === '可回读输出' && success.stderr === 'diagnostic' && success.cleanupComplete)
const failure = await runProcess(process.execPath, ['-e', 'process.stdout.write("old marker");process.exit(7)'])
check('进程有输出但非零退出仍失败', !failure.ok && failure.code === 7 && failure.out.includes('old marker'))
const missing = await runProcess(path.resolve('.workbuddy/tmp/nonexistent-executable-for-process-test'), [], { timeoutMs: 3000 })
check('可执行文件不存在不会挂起或成功', !missing.ok && missing.code !== 0 && missing.error)
const timeout = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 250 })
check('真实超时停止拥有的进程', !timeout.ok && timeout.timedOut && timeout.code === -2 && timeout.cleanupComplete)
const controller = new AbortController()
const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal })
setTimeout(() => controller.abort(), 250)
const cancelled = await pending
check('运行中取消保留失败与清理结果', !cancelled.ok && cancelled.aborted && cancelled.cleanupComplete)
const before = new AbortController(); before.abort()
const notStarted = await runProcess(process.execPath, ['-e', 'process.exit(0)'], { signal: before.signal })
check('预先取消不启动子进程', !notStarted.ok && notStarted.aborted && notStarted.pid === null)
const noisy = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)'], { maxOutputChars: 1024 })
check('输出超预算不截断后报成功', !noisy.ok && noisy.outputLimit && noisy.code === -4 && noisy.out.length <= 1024)

// Run the actual release entry; a plausible stdout marker must not hide a signalled exit.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-release-signal-'))
try {
  fs.mkdirSync(path.join(fixture, 'build/assets'), { recursive: true })
  fs.writeFileSync(path.join(fixture, 'build/index.html'), '<html>negative check fixture</html>')
  fs.writeFileSync(path.join(fixture, 'build/assets/index-fixture.js'), '// fixture')
  const hook = path.join(fixture, 'signal.cjs')
  fs.writeFileSync(hook, `
const cp=require('node:child_process'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const original=cp.spawn;
cp.spawn=(cmd,args,opts)=>{
  if(args[0]==='-e'&&args[1].includes('@@JSON@@')){
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{};
    process.nextTick(()=>{child.stdout.end('@@JSON@@{"n":55,"g":10}');child.stderr.end();child.emit('close',0,'SIGTERM')});
    return child;
  }
  return original(cmd,args,opts);
};
require('node:module').syncBuiltinESMExports();
`)
  const result = await runProcess(process.execPath, ['--require', hook, path.resolve('scripts/release-check.mjs'), '--source-only', '--dist', path.join(fixture, 'build'), '--json'], { timeoutMs: 90000 })
  const report = JSON.parse(result.stdout)
  check('实际发布检查拒绝输出正常但被信号终止的子探针', !result.ok && result.exitCode === 1 && report.verdict === 'FAIL' && report.rows.some((row: { level: string; detail: string }) => row.level === 'FAIL' && row.detail.includes('SIGTERM')))
} finally {
  const target = fs.realpathSync(fixture)
  if (path.dirname(target) !== fs.realpathSync(os.tmpdir()) || !path.basename(target).startsWith('yfe-release-signal-')) throw new Error('Refusing unsafe fixture cleanup')
  fs.rmSync(target, { recursive: true })
}
console.log('processBoundary: ' + passed + ' passed')
