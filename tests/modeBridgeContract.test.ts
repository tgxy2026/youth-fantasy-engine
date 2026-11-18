// ============ 连接模式切换状态机 + 页面侧契约（3.6.1 · B6）============
//
// 背景：`agentHost/modeAuthority.ts`（51 行）是**渲染层再造的第二份模式真源**，3.6.1 已删除。
// 它原来的单测里藏着几条别处没有的语义（切换中重复请求、回读不匹配即失败关闭），
// 删文件不能把语义一起删掉 —— 那些语义的真实实现是宿主侧 `scripts/agent-host/mode-manager.mjs`
// （桌面主进程与便携服务共用），页面唯一入口是 `modeBridge`。
//
// 所以这里对着**真状态机**（假 store）钉四条，外加页面侧「没有宿主时绝不假装可用」：
//   ① 稳定态切换成功；
//   ② 切换中重复请求被拒（busy）；
//   ③ blocked 时需先恢复，不能直接切换；
//   ④ 持久化回读不匹配 ⇒ 失败关闭（变 blocked，且 prepare 不得执行）；
//   ⑤ 页面侧：无本机宿主时读状态/切换/恢复一律失败关闭，租约包装直通（网页语义）。
import assert from 'node:assert/strict'
import { createModeManager } from '../scripts/agent-host/mode-manager.mjs'
import {
  cancelConnectionModeSwitch, connectionModeStatus, hasLocalModeHost, recoverConnectionMode,
  switchConnectionMode, withApiModeLease,
} from '../src/lib/agentHost/modeBridge'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const STABLE_API = { version: 1, phase: 'stable', mode: 'api' }

/** 假持久化：字段与 `mode-file.mjs` 的 createModeFilePersistence 逐项对齐 */
function fakeStore(initial: unknown) {
  let saved: unknown = initial
  let pending: unknown = null
  let writeNoop = false
  let readOverride: (() => unknown) | null = null
  return {
    store: {
      async hasPending() { return pending !== null },
      async markPending(value: unknown) { pending = value },
      async readPending() { return pending },
      async clearPending() { pending = null },
      async read() { return readOverride ? readOverride() : saved },
      async initialize(mode: string) { saved = { version: 1, phase: 'stable', mode } },
      async initializeApi() { saved = { version: 1, phase: 'stable', mode: 'api' } },
      async write(value: unknown) { if (!writeNoop) saved = value },
    },
    setWriteNoop(value: boolean) { writeNoop = value },
    setReadOverride(fn: (() => unknown) | null) { readOverride = fn },
    pending: () => pending,
    saved: () => saved,
  }
}

const manager = async (initial: unknown = STABLE_API) => {
  const fake = fakeStore(initial)
  const mgr = await createModeManager(fake.store, 'api', ['api', 'agent'], async () => undefined)
  return { mgr, fake, store: fake.store }
}

async function main() {
  // ① 稳定态切换成功
  {
    const { mgr, fake } = await manager()
    ok('初始状态为 stable/api', JSON.stringify(mgr.snapshot()) === JSON.stringify({ phase: 'stable', mode: 'api', busy: false, active: { api: 0, agent: 0, acp: 0 } }), JSON.stringify(mgr.snapshot()))
    const after = await mgr.switchTo('agent', 't-success', async () => true)
    ok('切换成功后状态落到 agent', after.phase === 'stable' && after.mode === 'agent', JSON.stringify(after))
    ok('切换成功后模式记录已落盘', (fake.saved() as { mode?: string }).mode === 'agent', JSON.stringify(fake.saved()))
    ok('切换成功后未确认标记已清掉', fake.pending() === null, JSON.stringify(fake.pending()))
  }

  // ② 切换中重复请求被拒
  {
    const { mgr } = await manager()
    const lease = mgr.acquire('api', 'owner-1')       // 让 drain 挂住
    assert.ok(lease)
    const first = mgr.switchTo('agent', 't-first', async () => true)
    await tick()
    let dupError = ''
    try { await mgr.switchTo('agent', 't-second', async () => true) } catch (e) { dupError = e instanceof Error ? e.message : String(e) }
    ok('切换进行中时第二次请求被拒', dupError.includes('正在进行'), dupError)
    mgr.release(lease, 'owner-1')
    const done = await first
    ok('第一次切换仍能完成（不被重复请求打断）', done.phase === 'stable' && done.mode === 'agent', JSON.stringify(done))
  }

  // ③ blocked 时需先恢复
  {
    const { mgr } = await manager({ version: 1, phase: 'switching', from: 'api', to: 'agent', transitionId: 'left-over' })
    ok('中断的切换记录使状态为 blocked', mgr.snapshot().phase === 'blocked', JSON.stringify(mgr.snapshot()))
    let error = ''
    try { await mgr.switchTo('agent', 't-any', async () => true) } catch (e) { error = e instanceof Error ? e.message : String(e) }
    ok('blocked 时拒绝切换并要求先恢复', error.includes('需要恢复'), error)
  }

  // ④-a 切换记录回读不匹配 ⇒ 失败关闭，且准备动作不得执行
  {
    const { mgr, fake } = await manager()
    fake.setWriteNoop(true)                            // 写盘静默失效（磁盘满 / 权限 / 被外部改写）
    let prepared = false
    let error = ''
    try { await mgr.switchTo('agent', 't-write-lost', async () => { prepared = true; return true }) } catch (e) { error = e instanceof Error ? e.message : String(e) }
    ok('切换记录回读不上时报错', error.includes('回读失败'), error)
    ok('回读失败时不执行准备动作（不提前放行）', prepared === false)
    ok('回读失败后状态为 blocked（不假装已切换）', mgr.snapshot().phase === 'blocked', JSON.stringify(mgr.snapshot()))
    let followUp = ''
    try { await mgr.switchTo('agent', 't-again', async () => true) } catch (e) { followUp = e instanceof Error ? e.message : String(e) }
    ok('回读失败后再切换必须先恢复', followUp.includes('需要恢复'), followUp)
  }

  // ④-b 稳定记录回读不匹配（写到一半被改回切换中）⇒ 同样失败关闭
  {
    const { mgr, fake } = await manager()
    let error = ''
    try {
      await mgr.switchTo('agent', 't-readback', async () => {
        // prepare 阶段之后，落盘内容被"外部"改回切换中记录 ⇒ 稳定记录回读不上
        fake.setReadOverride(() => ({ version: 1, phase: 'switching', from: 'api', to: 'agent', transitionId: 't-readback' }))
        return true
      })
    } catch (e) { error = e instanceof Error ? e.message : String(e) }
    ok('稳定记录回读不上时报错', error.includes('模式回读失败'), error)
    ok('稳定记录回读失败后状态为 blocked', mgr.snapshot().phase === 'blocked', JSON.stringify(mgr.snapshot()))
  }

  // ⑤ 页面侧：没有本机宿主时一律失败关闭，绝不假装可用
  {
    ok('Node 测试环境没有本机模式宿主', hasLocalModeHost() === false)
    const status = await connectionModeStatus()
    ok('无宿主时状态为 blocked 且 mode 为 null', status.phase === 'blocked' && status.mode === null, JSON.stringify(status))
    ok('无宿主时说明原因（不静默）', status.reason.length > 0, status.reason)
    const switched = await switchConnectionMode('agent', 'page-1')
    ok('无宿主时切换被拒并给原因', switched.ok === false && !!switched.error, JSON.stringify(switched))
    ok('无宿主时取消切换返回 false', (await cancelConnectionModeSwitch('page-1')) === false)
    const recovered = await recoverConnectionMode(null)
    ok('无宿主时恢复被拒并给原因', recovered.ok === false && !!recovered.error, JSON.stringify(recovered))
    const probe = { ran: false }
    const value = await withApiModeLease(async () => { probe.ran = true; return 7 })
    ok('无宿主（网页/开发）时模型租约直通，不拦正常请求', probe.ran === true && value === 7)
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} modeBridgeContract ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

await main()
