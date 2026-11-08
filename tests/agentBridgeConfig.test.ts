import assert from 'node:assert/strict'
import { makeAgentBridgeConfig, makeBridgeConfig } from '../src/lib/aiCore/backend/bridgeConfig'
const script = 'C:\\Program Files\\YFE\\resources\\scripts\\mcp\\yfe-readonly.mjs'
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
  console.log('PASS 可写桥配置指向宿主文件并保留空格路径')
}
