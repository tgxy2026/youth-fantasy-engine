import assert from 'node:assert/strict'
import { makeAgentBridgeConfig, makeAgentConnectionPrompt, makeCodexAgentBridgeConfig, makeBridgeConfig } from '../src/lib/aiCore/backend/bridgeConfig'
import { beginModeTransition, canStartModeWork, createModeCoordinator, finishModeTransition, parsePersistedMode } from '../src/lib/agentHost/modeTransition'
import { createModeAuthority } from '../src/lib/agentHost/modeAuthority'
const script = 'C:\\Program Files\\YFE\\resources\\scripts\\mcp\\yfe-readonly.mjs'
{
  let saved: unknown = { version: 1, phase: 'stable', mode: 'api' }
  const store = { read: async () => saved, write: async (value: unknown) => { saved = value } }
  const authority = await createModeAuthority(store)
  const release = authority.acquire('api')
  assert.ok(release)
  const abort = new AbortController()
  const waiting = authority.switchTo('agent', 'switch-pending', async () => true, abort.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(authority.acquire('api'), null)
  assert.equal(authority.acquire('agent'), null)
  abort.abort()
  await assert.rejects(waiting, /取消/)
  release()
  assert.equal(authority.acquire('api'), null)
  assert.equal(authority.acquire('agent'), null)
  const recovered = await createModeAuthority(store)
  assert.equal(recovered.acquire('api'), null)
  assert.equal(recovered.acquire('agent'), null)
  saved = { version: 1, phase: 'stable', mode: 'api' }
  const valid = await createModeAuthority(store)
  await valid.switchTo('agent', 'switch-success', async () => true)
  assert.ok(valid.acquire('agent'))
  assert.equal(valid.acquire('api'), null)
  const failedWrite = await createModeAuthority({ read: async () => ({ version: 1, phase: 'stable', mode: 'api' }), write: async () => { throw new Error('磁盘失败') } })
  await assert.rejects(failedWrite.switchTo('agent', 'write-failure', async () => true), /磁盘失败/)
  assert.equal(failedWrite.acquire('api'), null)
  assert.equal(failedWrite.acquire('agent'), null)
  const ignoredWrite = await createModeAuthority({ read: async () => ({ version: 1, phase: 'stable', mode: 'api' }), write: async () => {} })
  let prepared = false
  await assert.rejects(ignoredWrite.switchTo('agent', 'ignored-write', async () => { prepared = true; return true }), /切换记录/)
  assert.equal(prepared, false)
  assert.equal(ignoredWrite.acquire('api'), null)
  let releasePrepare!: (value: boolean) => void
  saved = { version: 1, phase: 'stable', mode: 'api' }
  const concurrent = await createModeAuthority(store)
  const pending = concurrent.switchTo('agent', 'first-switch', () => new Promise(resolve => { releasePrepare = resolve }))
  await new Promise(resolve => setTimeout(resolve, 0))
  await assert.rejects(concurrent.switchTo('agent', 'second-switch', async () => true), /正在进行/)
  assert.equal(concurrent.acquire('api'), null)
  releasePrepare(true)
  await pending
  saved = { version: 1, phase: 'stable', mode: 'api' }
  const draining = await createModeAuthority(store)
  const held = draining.acquire('api')!
  const drained = draining.switchTo('agent', 'drain-switch', async () => true)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(draining.acquire('agent'), null)
  held()
  await drained
  assert.ok(draining.acquire('agent'))
  console.log('PASS 持久切换原型在中断与在途任务时失败关闭')
}
{
  const api = { phase: 'stable', mode: 'api' } as const
  const switching = beginModeTransition(api, 'agent', 'switch-1')
  assert.equal(canStartModeWork(switching, 'api'), false)
  assert.equal(canStartModeWork(switching, 'agent'), false)
  const blocked = finishModeTransition(switching, 'switch-1', { previousDrained: false, targetReady: true, persisted: true })
  assert.equal(canStartModeWork(blocked, 'api'), false)
  assert.equal(canStartModeWork(blocked, 'agent'), false)
  assert.throws(() => finishModeTransition(switching, 'wrong', { previousDrained: true, targetReady: true, persisted: true }))
  const agent = finishModeTransition(switching, 'switch-1', { previousDrained: true, targetReady: true, persisted: true })
  assert.equal(canStartModeWork(agent, 'agent'), true)
  assert.equal(canStartModeWork(agent, 'api'), false)
  console.log('PASS 模式状态机在切换与失败时双向关闭')
}
{
  const coordinator = createModeCoordinator({ phase: 'stable', mode: 'api' })
  const release = coordinator.acquire('api')
  assert.ok(release)
  coordinator.begin('agent', 'lease-switch')
  assert.equal(coordinator.acquire('api'), null)
  assert.equal(coordinator.acquire('agent'), null)
  assert.throws(() => coordinator.finish('lease-switch', { targetReady: true, persisted: true }), /在途/)
  release(); release()
  assert.equal(coordinator.snapshot().active.api, 0)
  coordinator.finish('lease-switch', { targetReady: true, persisted: true })
  assert.ok(coordinator.acquire('agent'))
  assert.equal(coordinator.acquire('api'), null)
  console.log('PASS 单进程切换等待在途任务并拒绝新任务')
}
{
  assert.deepEqual(parsePersistedMode({ version: 1, phase: 'stable', mode: 'api' }), { phase: 'stable', mode: 'api' })
  for (const raw of [null, {}, { version: 2, phase: 'stable', mode: 'agent' }, { version: 1, phase: 'switching', from: 'api', to: 'agent' }, { version: 1, phase: 'stable', mode: 'other' }]) {
    const parsed = parsePersistedMode(raw)
    assert.equal(canStartModeWork(parsed, 'api'), false)
    assert.equal(canStartModeWork(parsed, 'agent'), false)
  }
  const coordinator = createModeCoordinator({ phase: 'stable', mode: 'api' })
  const snapshot = coordinator.snapshot()
  if (snapshot.state.phase === 'stable') snapshot.state.mode = 'agent'
  assert.equal(canStartModeWork(coordinator.snapshot().state, 'api'), true)
  console.log('PASS 持久状态损坏或中断时失败关闭且快照不影响协调器')
}
const desktop = JSON.parse(makeBridgeConfig('node', script, { kind: 'desktop' }))
assert.deepEqual(desktop.mcpServers['yfe-readonly'], { command: 'node', args: [script] })
const explicitDesktop = JSON.parse(makeBridgeConfig('node', script, { kind: 'desktop', dataFile: 'D:\\custom\\book.json' }))
assert.deepEqual(explicitDesktop.mcpServers['yfe-readonly'].args, [script, '--data-file', 'D:\\custom\\book.json'])
const portable = JSON.parse(makeBridgeConfig('C:\\node\\node.exe', script, { kind: 'portable', root: 'F:\\作品 便携版' }))
assert.deepEqual(portable.mcpServers['yfe-readonly'].args, [script, '--portable-root', 'F:\\作品 便携版'])
const file = JSON.parse(makeBridgeConfig('node', '/tmp/yfe-readonly.mjs', { kind: 'file', path: '/tmp/data.json' }))
assert.deepEqual(file.mcpServers['yfe-readonly'].args, ['/tmp/yfe-readonly.mjs', '--data-file', '/tmp/data.json'])
assert.throws(() => makeBridgeConfig('node', 'relative.js', { kind: 'desktop' }), /完整路径/)
assert.throws(() => makeBridgeConfig('node', script, { kind: 'portable', root: 'relative' }), /完整路径/)
assert.throws(() => makeBridgeConfig('', script, { kind: 'desktop' }), /Node/)
console.log('PASS 外部桥配置对路径、空格和三种数据来源正确编码')
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
const tempRoot = await fs.realpath(os.tmpdir())
const dir = await fs.mkdtemp(path.join(tempRoot, 'yfe-bridge-config-'))
try {
  const filePath = path.join(dir, 'fixture.json')
  await fs.writeFile(filePath, JSON.stringify({ app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, stores: { projects: [{ id: 'synthetic', name: '合成项目' }] } }))
  const before = await fs.readFile(filePath, 'utf8')
  const generated = JSON.parse(makeBridgeConfig(process.execPath, path.resolve('scripts/mcp/yfe-readonly.mjs'), { kind: 'file', path: filePath })).mcpServers['yfe-readonly']
  const child = spawn(generated.command, generated.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.resume()
  const lines = readline.createInterface({ input: child.stdout })
  const iterator = lines[Symbol.asyncIterator]()
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n')
    assert.equal(JSON.parse((await iterator.next()).value ?? '').id, 1)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'yfe_list_projects', arguments: {} } }) + '\n')
    const response = JSON.parse((await iterator.next()).value ?? '')
    assert.equal(JSON.parse(response.result.content[0].text)[0].name, '合成项目')
    assert.equal(await fs.readFile(filePath, 'utf8'), before)
    console.log('PASS 生成的配置可启动真实只读桥并读取隔离夹具')
  } finally { child.stdin.end(); lines.close(); child.kill() }
} finally {
  const resolved = await fs.realpath(dir)
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('yfe-bridge-config-')) throw new Error('Unsafe fixture cleanup')
  await fs.rm(resolved, { recursive: true, force: true })
}

// 3.4.3：可写桥配置指向**宿主文件**（不是作品数据文件），并支持便携版根目录
{
  const agentScript = 'C:\\Program Files\\YFE\\resources\\scripts\\mcp\\yfe-agent.mjs'
  const host = JSON.parse(makeAgentBridgeConfig('node', agentScript, { kind: 'hostFile', path: 'C:\\Users\\作者\\AppData\\Roaming\\青春幻想引擎\\agent-host.json' }))
  assert.deepEqual(host.mcpServers['yfe-agent'].args, [agentScript, '--host-file', 'C:\\Users\\作者\\AppData\\Roaming\\青春幻想引擎\\agent-host.json'])
  const portable = JSON.parse(makeAgentBridgeConfig('node', '/tmp/yfe-agent.mjs', { kind: 'portable', root: 'F:\\作品 便携版' }))
  assert.deepEqual(portable.mcpServers['yfe-agent'].args, ['/tmp/yfe-agent.mjs', '--portable-root', 'F:\\作品 便携版'])
  assert.throws(() => makeAgentBridgeConfig('node', 'relative.mjs', { kind: 'portable', root: '/tmp' }), /完整路径/)
  assert.throws(() => makeAgentBridgeConfig('node', agentScript, { kind: 'hostFile', path: 'relative.json' }), /完整路径/)
  assert.throws(() => makeAgentBridgeConfig('', agentScript, { kind: 'hostFile', path: '/tmp/agent-host.json' }), /Node/)
  const codex = makeCodexAgentBridgeConfig('C:\\node\\node.exe', agentScript, { kind: 'hostFile', path: 'C:\\Users\\作者\\agent-host.json' })
  assert.ok(codex.startsWith('[mcp_servers.yfe_agent]\n'))
  assert.ok(codex.includes(`command = ${JSON.stringify('C:\\node\\node.exe')}`))
  assert.ok(codex.includes(JSON.stringify('C:\\Users\\作者\\agent-host.json')))
  assert.throws(() => makeCodexAgentBridgeConfig('node', 'relative.mjs', { kind: 'hostFile', path: '/tmp/agent-host.json' }), /完整路径/)
  const prompt = makeAgentConnectionPrompt('C:\\node\\node.exe', agentScript, { kind: 'hostFile', path: 'C:\\Users\\作者\\agent-host.json' })
  assert.ok(prompt.includes(JSON.stringify(agentScript)))
  assert.ok(prompt.includes('docs/agent/MCP第三方开发者适配规范.md'))
  assert.ok(prompt.includes(JSON.stringify('C:\\Users\\作者\\agent-host.json')))
  assert.ok(prompt.includes('yfe_host_info') && prompt.includes('yfe_list_projects'))
  assert.ok(prompt.includes('不要读取、输出或分享宿主配置中的令牌'))
  const portablePrompt = makeAgentConnectionPrompt('node', '/tmp/yfe-agent.mjs', { kind: 'portable', root: 'F:\\作品 便携版' })
  assert.ok(portablePrompt.includes('--portable-root') && portablePrompt.includes(JSON.stringify('F:\\作品 便携版')))
  assert.throws(() => makeAgentConnectionPrompt('node', agentScript, { kind: 'hostFile', path: '' }), /完整路径/)
  console.log('PASS 可写桥配置指向宿主文件并保留空格路径')
}
