// 连接模式互斥 · 隔离集成测试（3.4.3）
//
// 覆盖：
//   ① 全新安装 / 旧配置（启用、停用、损坏、未确认标记）的迁移结果；
//   ② 唯一宿主所有权锁：第二实例失败关闭、遗留锁恢复需要明确确认且保留证据；
//   ③ 租约：模式内租约、错误归属拒绝、切换等待在途任务、取消、失败关闭与恢复；
//   ④ API 模式下 Agent HTTP 调用被模式闸拒绝；
//   ⑤ 渲染层 `runWithModeLease` 的释放未确认语义。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createModeService, recoverConnectionFiles } from '../scripts/agent-host/mode-service.mjs'
import { runWithModeLease } from '../src/lib/agentHost/modeClient'
import { withApiModeLease } from '../src/lib/agentHost/modeBridge'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-mode-'))
const dirOf = (name: string) => {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const callPage = async () => ({ ok: true, value: { projectId: 'p-mode-test' } })

const LEGACY_TOKEN = 'a'.repeat(64)
function legacyConfig(enabled: boolean) {
  return JSON.stringify({ version: 1, enabled, scope: { projects: [{ projectId: 'p-mode-test', actions: ['chapter:create'] }] }, port: 0, token: LEGACY_TOKEN, updatedAt: 0 })
}

async function serviceAt(dir: string) {
  return createModeService({ dataDir: dir, callPage, clientCount: () => 1 })
}

async function agentCall(port: number, token: string) {
  const res = await fetch(`http://127.0.0.1:${port}/api/agent/call`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ call: { tool: 'yfe_list_projects', requestId: `req-mode-${Date.now()}`, args: {} } }),
  })
  return await res.json() as Record<string, unknown>
}

async function main() {
  // ① 全新安装：缺失记录只在旧配置可核对时初始化为 API。
  {
    const dir = dirOf('fresh')
    const service = await serviceAt(dir)
    try {
      const status = await service.status()
      ok('全新安装迁移为 API 模式', status.phase === 'stable' && status.mode === 'api', JSON.stringify(status))
      const record = JSON.parse(fs.readFileSync(path.join(dir, 'connection-mode.json'), 'utf8'))
      ok('模式记录写盘并可回读', record.version === 1 && record.phase === 'stable' && record.mode === 'api')
      ok('唯一宿主锁存在', fs.existsSync(path.join(dir, 'connection-mode.lock')))
      ok('Agent 宿主已监听（模式闸生效）', status.agent?.running === true, JSON.stringify(status.agent))

      const apiLease = service.acquire('api', 'tester')
      ok('API 模式可申请 API 租约', typeof apiLease === 'string' && apiLease.length > 0)
      let agentRejected = false
      try { service.acquire('agent', 'tester') } catch { agentRejected = true }
      ok('API 模式拒绝 Agent 租约', agentRejected)
      ok('错误归属不能释放租约', service.release(apiLease, 'other') === false)
      ok('正确归属释放租约', service.release(apiLease, 'tester') === true)

      const config = JSON.parse(fs.readFileSync(path.join(dir, 'agent-host.json'), 'utf8'))
      const body = await agentCall(Number(config.port), String(config.token))
      ok('API 模式下 Agent HTTP 调用被模式闸拒绝', body.code === 'MODE_BLOCKED', JSON.stringify(body))
      const after = JSON.parse(fs.readFileSync(path.join(dir, 'agent-host.json'), 'utf8'))
      ok('模式闸拒绝不改写授权', after.token === config.token && after.enabled === config.enabled)
      ok('模式闸拒绝不写入账本', !fs.existsSync(path.join(dir, 'agent-host-requests.json')))
    } finally { await service.close() }
  }

  // 旧配置（启用 / 停用）迁移都落在 API 模式：保留授权但不自动进入 Agent 模式。
  for (const [name, enabled] of [['legacy-on', true], ['legacy-off', false]] as const) {
    const dir = dirOf(name)
    fs.writeFileSync(path.join(dir, 'agent-host.json'), legacyConfig(enabled))
    const service = await serviceAt(dir)
    try {
      const status = await service.status()
      ok(`旧配置 enabled=${enabled} 迁移为 API 模式`, status.phase === 'stable' && status.mode === 'api', JSON.stringify(status))
      if (enabled) {
        const agentLease = (() => {
          try { return service.acquire('agent', 'tester') } catch { return null }
        })()
        ok('迁移后不自动放行 Agent 调用', agentLease === null)
        const switched = await service.switchTo('agent', 'legacy-switch')
        ok('迁移后可显式切换到 Agent 模式', switched.mode === 'agent', JSON.stringify(switched))
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'agent-host.json'), 'utf8'))
        ok('切换保留原项目授权', saved.scope?.projects?.[0]?.projectId === 'p-mode-test', JSON.stringify(saved.scope))
      }
    } finally { await service.close() }
  }

  // 旧配置损坏：不得猜测关闭状态，也不得启动宿主改写证据。
  {
    const dir = dirOf('legacy-broken')
    fs.writeFileSync(path.join(dir, 'agent-host.json'), '{ broken json')
    const service = await serviceAt(dir)
    try {
      const status = await service.status()
      ok('损坏旧配置 → blocked', status.phase === 'blocked' && /损坏/.test(status.reason), JSON.stringify(status))
      ok('损坏旧配置时不启动宿主', status.agent === null)
      ok('损坏旧配置时可安全恢复', status.canRecover === true)
      ok('恢复前原文件尚未被覆盖', fs.readFileSync(path.join(dir, 'agent-host.json'), 'utf8') === '{ broken json')
      const recovered = await service.recover({ confirm: true })
      ok('用户确认后恢复为 API 模式', recovered.phase === 'stable' && recovered.mode === 'api', JSON.stringify(recovered))
      const evidence = fs.readdirSync(dir).filter(n => n.startsWith('agent-host.json.broken-'))
      ok('损坏配置留档为证据', evidence.length === 1, evidence.join(','))
      const repaired = JSON.parse(fs.readFileSync(path.join(dir, 'agent-host.json'), 'utf8'))
      ok('恢复后 Agent 连接保持停用', repaired.enabled === false)
      ok('恢复后宿主重新监听', recovered.agent?.running === true)
    } finally { await service.close() }
  }

  // 未确认的配置更新标记：拒绝启动，恢复时留档并停用。
  {
    const dir = dirOf('legacy-pending')
    fs.writeFileSync(path.join(dir, 'agent-host.json'), legacyConfig(true))
    fs.writeFileSync(path.join(dir, 'agent-host.json.pending'), 'pending\n')
    const service = await serviceAt(dir)
    try {
      const status = await service.status()
      ok('未确认标记 → blocked', status.phase === 'blocked' && /未确认/.test(status.reason), JSON.stringify(status))
      const recovered = await service.recover({ confirm: true })
      ok('未确认标记恢复为 API', recovered.phase === 'stable' && recovered.mode === 'api', JSON.stringify(recovered))
      ok('未确认标记留档', fs.readdirSync(dir).some(n => n.startsWith('agent-host.json.pending.stale-')))
      const repaired = JSON.parse(fs.readFileSync(path.join(dir, 'agent-host.json'), 'utf8'))
      ok('未确认标记恢复后连接停用', repaired.enabled === false)
    } finally { await service.close() }
  }

  // ② 同一资料范围的第二实例不能取得所有权。
  {
    const dir = dirOf('stable-mode-corrupt-config')
    fs.writeFileSync(path.join(dir, 'connection-mode.json'), JSON.stringify({ version: 1, phase: 'stable', mode: 'api' }))
    fs.writeFileSync(path.join(dir, 'agent-host.json'), '{broken')
    const service = await serviceAt(dir)
    try {
      ok('稳定模式记录不能掩盖损坏的旧授权配置', (await service.status()).phase === 'blocked')
      assert.throws(() => service.acquire('api', 'tester'))
      await assert.rejects(service.switchTo('agent', 'corrupt-config'))
      ok('旧授权无法确认时拒绝租约和切换', true)
    } finally { await service.close() }
  }

  {
    const dir = dirOf('dup')
    const first = await serviceAt(dir)
    const second = await serviceAt(dir)
    try {
      const status = await second.status()
      ok('第二实例 blocked', status.phase === 'blocked' && status.ownsLock === false, JSON.stringify(status))
      ok('第二实例读到锁归属', status.lock !== null && typeof status.lock?.pid === 'number')
      ok('第一实例仍稳定', (await first.status()).phase === 'stable')
    } finally { await second.close(); await first.close() }
  }

  // ③ 切换等待在途任务、取消与恢复。
  {
    const dir = dirOf('switch')
    const service = await serviceAt(dir)
    try {
      const lease = service.acquire('api', 'tester')
      const switching = service.switchTo('agent', 'switch-1')
      await new Promise(resolve => setTimeout(resolve, 20))
      const during = await service.status()
      ok('切换中 phase=switching', during.phase === 'switching', JSON.stringify(during))
      let blockedBoth = true
      for (const mode of ['api', 'agent'] as const) {
        try { service.acquire(mode, 'tester'); blockedBoth = false } catch { /* 预期 */ }
      }
      ok('切换中两侧都不能启动新任务', blockedBoth)
      ok('在途任务未结束时切换不提交', service.release(lease, 'tester') === true)
      const done = await switching
      ok('排空后切换为 Agent 模式', done.phase === 'stable' && done.mode === 'agent', JSON.stringify(done))
      const agentConfig = JSON.parse(fs.readFileSync(path.join(dir, 'agent-host.json'), 'utf8'))
      const agentBody = await agentCall(Number(agentConfig.port), String(agentConfig.token))
      ok('Agent 模式下模式闸放行，宿主按未开启返回 HOST_DISABLED', agentBody.code === 'HOST_DISABLED', JSON.stringify(agentBody))
      let apiRejected = false
      try { service.acquire('api', 'tester') } catch { apiRejected = true }
      ok('Agent 模式拒绝 API 租约', apiRejected)

      const agentLease = service.acquire('agent', 'tester')
      await assert.rejects(service.recover({ confirm: true }), /在途任务/)
      const afterRefusedRecovery = await service.status()
      ok('在途任务阻止恢复且宿主仍运行', afterRefusedRecovery.agent?.running === true && afterRefusedRecovery.mode === 'agent')
      const abort = new AbortController()
      const canceled = service.switchTo('api', 'switch-2', abort.signal)
      await new Promise(resolve => setTimeout(resolve, 20))
      abort.abort()
      await assert.rejects(canceled, /取消/)
      const blocked = await service.status()
      ok('取消等待后失败关闭', blocked.phase === 'blocked', JSON.stringify(blocked))
      ok('取消后仍保留在途租约', service.release(agentLease, 'tester') === true)
      const recovered = await service.recover({ confirm: true })
      ok('取消后可安全恢复 API', recovered.phase === 'stable' && recovered.mode === 'api', JSON.stringify(recovered))
    } finally { await service.close() }
  }

  // 稳定 Agent 状态下的显式恢复必须回到 API，而不是保留旧状态。
  {
    const dir = dirOf('recover-stable-agent')
    const service = await serviceAt(dir)
    try {
      await service.switchTo('agent', 'stable-agent')
      const recovered = await service.recover({ confirm: true })
      ok('稳定 Agent 状态恢复到 API', recovered.phase === 'stable' && recovered.mode === 'api')
    } finally { await service.close() }
  }

  // ④ 遗留锁 / 中断记录恢复：必须明确确认、保留证据、拒绝伪造。
  {
    const dir = dirOf('stale')
    fs.writeFileSync(path.join(dir, 'connection-mode.lock'), JSON.stringify({ version: 1, pid: 999999, token: 'stale-token' }) + '\n')
    fs.writeFileSync(path.join(dir, 'connection-mode.json'), JSON.stringify({ version: 1, phase: 'switching', from: 'api', to: 'agent', transitionId: 'lost' }) + '\n')
    const service = await serviceAt(dir)
    try {
      const status = await service.status()
      ok('遗留锁 → blocked', status.phase === 'blocked' && status.ownsLock === false, JSON.stringify(status))
      ok('遗留锁 PID 被如实展示', status.lock?.pid === 999999, JSON.stringify(status.lock))
      await assert.rejects(recoverConnectionFiles({ dataDir: dir, confirm: false }), /明确确认/)
      await assert.rejects(service.recover({ confirm: true, confirmPid: 123 }), /归属已变化/)
      const recovered = await service.recover({ confirm: true, confirmPid: 999999 })
      ok('确认后恢复为 API', recovered.phase === 'stable' && recovered.mode === 'api', JSON.stringify(recovered))
      ok('遗留锁移入证据文件', fs.readdirSync(dir).some(n => n.startsWith('connection-mode.lock.stale-')))
      ok('中断记录移入证据文件', fs.readdirSync(dir).some(n => n.startsWith('connection-mode.json.broken-')))
      const record = JSON.parse(fs.readFileSync(path.join(dir, 'connection-mode.json'), 'utf8'))
      ok('恢复记录为稳定 API', record.phase === 'stable' && record.mode === 'api')
    } finally { await service.close() }
  }

  // ⑤ 租约包装：释放必须确认，否则不能报告任务安全完成。
  {
    let released = 0
    const good = {
      async acquire() { return 'lease-1' },
      async release(id: string) { released++; return id === 'lease-1' },
    }
    const value = await runWithModeLease(good, 'api', async () => 42)
    ok('租约包装返回任务结果', value === 42 && released === 1)

    const bad = { async acquire() { return 'lease-2' }, async release() { return false } }
    await assert.rejects(runWithModeLease(bad, 'api', async () => 1), /释放未确认/)
    await assert.rejects(
      runWithModeLease(bad, 'api', async () => { throw new Error('业务失败') }),
      (error: unknown) => error instanceof AggregateError && String(error.message).includes('未能确认释放'),
    )
    ok('任务失败且释放未确认时显式报错', true)
  }

  {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
    try {
      let sent = false
      await assert.rejects(withApiModeLease(async () => { sent = true }), /不支持连接模式互斥/)
      ok('桌面缺少宿主接口时不发送模型请求', !sent)
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  }

  console.log(`RESULT ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
