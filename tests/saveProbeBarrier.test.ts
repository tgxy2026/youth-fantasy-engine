import assert from 'node:assert/strict'
import { createSaveBarrier } from '../scripts/audit/probes/save-barrier.cjs'

let passed = 0
const check = (name: string, ok: boolean) => { assert.ok(ok, name); passed++; console.log('PASS ' + name) }
const deferred = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
const barrier = createSaveBarrier(), first = deferred(), second = deferred()
const events: string[] = []
const saveA = barrier.run(async () => { events.push('A-start'); await first.promise; events.push('A-end'); return 'actual-A' })
let drained = false
const paused = barrier.pause().then(() => { drained = true })
const saveB = barrier.run(async () => { events.push('B-start'); await second.promise; events.push('B-end'); return 'actual-B' })
await Promise.resolve()
check('暂停后新请求等待，旧请求仍在途', barrier.state.paused && barrier.state.active === 1 && barrier.state.waiting === 1 && !drained)
check('业务函数不会被跳过或提前标完成', events.join() === 'A-start')
assert.throws(() => barrier.resume(), /active writes/); passed++; console.log('PASS 未排空不可释放')
await assert.rejects(() => barrier.pause(), /already owned/); passed++; console.log('PASS 禁止两处同时修改故障环境')
first.release()
await paused
check('屏障仅在真实在途请求完成后放行环境操作', drained && barrier.state.active === 0 && events.join() === 'A-start,A-end')
events.push('remove-blocker')
barrier.resume()
await Promise.resolve()
check('撤挡板后原请求才执行', events.join() === 'A-start,A-end,remove-blocker,B-start')
second.release()
check('返回业务原始结果', await saveA === 'actual-A' && await saveB === 'actual-B')
check('完成后没有遗留写入', !barrier.state.paused && barrier.state.active === 0 && barrier.state.waiting === 0)

const failing = createSaveBarrier()
const original = new Error('real-save-error')
await assert.rejects(() => failing.run(async () => { throw original }), error => error === original)
passed++; console.log('PASS 真实保存异常不被改成成功')
await failing.pause()
check('异常请求也释放在途计数', failing.state.active === 0)
let ran = false
const retry = failing.run(() => { ran = true; return false })
await Promise.resolve()
check('异常后仍能暂停并等待', !ran && failing.state.waiting === 1)
failing.resume()
check('失败返回值不被改写且可恢复', await retry === false && ran)

// Re-pausing immediately after resume must retain already queued requests until the new owner releases.
await failing.pause()
let lateRan = false
const late = failing.run(() => { lateRan = true })
failing.resume()
await failing.pause()
await Promise.resolve()
check('快速重新暂停不让等待请求穿过新屏障', !lateRan && failing.state.active === 0)
failing.resume(); await late
check('最后释放后请求执行一次', lateRan && failing.state.waiting === 0)
console.log('saveProbeBarrier: ' + passed + ' passed')
