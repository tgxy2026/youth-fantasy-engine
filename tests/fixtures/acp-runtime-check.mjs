import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createModeService } from '../../scripts/agent-host/mode-service.mjs'
import { createAcpRuntime } from '../../scripts/agent-host/acp-runtime.mjs'
import { openOwnedModeManager } from '../../scripts/agent-host/mode-manager.mjs'
import { createModeFilePersistence } from '../../scripts/agent-host/mode-file.mjs'
import { applySessionOptions } from '../../scripts/agent-host/acp-options.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yfe-354-acp-'))
const executable = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url))
const profiles = new Map()
let launches = 0
let stops = 0
const adapters = ['fake-a', 'fake-b'].map(id => ({
  id, name: id,
  async launch({ cwd, profile }) {
    profiles.set(id, profile)
    launches++
    const child = spawn(process.execPath, [executable], { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    child.on('error', () => {})
    const exited = new Promise(resolve => child.once('close', resolve))
    return {
      input: child.stdin, output: child.stdout, exited,
      async stop() { child.kill(); await exited; stops++ },
    }
  },
}))
const boot = async (registered = adapters) => {
  const runtime = createAcpRuntime({ root: path.join(root, 'acp'), adapters: registered })
  const service = await createModeService({ dataDir: root, acp: runtime, callPage: async () => ({}) })
  return { runtime, service }
}
let { runtime, service } = await boot()
try {
  await service.switchTo('acp', 'acp-on')
  const generate = async (text, onChunk) => runtime.generate({
    service, owner: 'fixture', id: 'run', text, expectedGeneration: (await runtime.status()).generation, onChunk,
  })
  const a = { binary: 'a-component', authMethod: 'a-login', model: 'a-model', thinking: 'a-thinking' }
  const b = { binary: 'b-component', authMethod: 'b-login', model: 'b-model', thinking: 'b-thinking' }
  await runtime.configure(service, a)
  const chunks = []
  assert.equal(await generate('write', text => chunks.push(text)), '合成作品')
  assert.deepEqual(chunks, ['合成', '作品'])
  // 3.5.4 纯文本入口的提示词形态（报告 / 摘要）都走同一 ACP 流式会话
  for (const prompt of [
    '【本章正文】合成正文，请输出综合诊断报告。',
    '【本章正文】合成正文，请按爽感管理视角输出报告。',
    '【作品开头（前三章或已有章节）】合成开头，请按黄金三章标准检查。',
    '【当前章节 / 进度】合成进度，请输出本章写作简报。',
    '【本章正文】合成正文，请压缩为约 200 字摘要。',
  ]) {
    assert.equal(await generate(prompt), '合成作品')
  }
  await assert.rejects(generate('tool'), /协议异常/)
  await assert.rejects(generate('invalid'), /协议异常/)
  const late = []
  let arrived
  const firstChunk = new Promise(resolve => { arrived = resolve })
  const oldTask = generate('cancel', text => { late.push(text); arrived() })
  const rejected = assert.rejects(oldTask, /取消/)
  await firstChunk
  const selecting = service.switchAcpAgent('to-b', () => runtime.prepareSelection('fake-b'))
  assert.equal((await service.status()).phase, 'switching')
  assert.equal((await runtime.status()).selected, 'fake-a')
  assert.equal(runtime.cancel('wrong-owner', 'run'), false)
  assert.equal(runtime.cancel('fixture', 'run'), true)
  await rejected
  assert.deepEqual(late, ['合成'])
  assert.equal((await selecting).mode, 'acp')
  assert.equal(launches, stops)
  await runtime.configure(service, b)
  assert.equal(await generate('write'), '合成作品')
  assert.notEqual(profiles.get('fake-a'), profiles.get('fake-b'))
  await service.switchAcpAgent('to-a', () => runtime.prepareSelection('fake-a'))
  assert.deepEqual((await runtime.status()).config, a)
  await service.close()
  ;({ runtime, service } = await boot())
  assert.equal((await service.status()).mode, 'acp')
  assert.equal((await runtime.status()).selected, 'fake-a')
  await service.switchAcpAgent('back-to-b', () => runtime.prepareSelection('fake-b'))
  assert.deepEqual((await runtime.status()).config, b)
  await service.close()
  ;({ runtime, service } = await boot(adapters.slice(0, 1)))
  assert.equal((await runtime.status()).selected, 'fake-b')
  assert.equal((await runtime.status()).config, null)
  await service.close()

  const optionsRoot = path.join(root, 'options')
  const optionsAdapter = {
    ...adapters[0], requiresConnection: true,
    authenticate: ({ client, signal }) => client.request('authenticate', { methodId: 'oauth-personal' }, undefined, signal),
    configureSession: ({ client, session, config, signal }) => applySessionOptions(client, session, config, signal),
  }
  runtime = createAcpRuntime({ root: optionsRoot, adapters: [optionsAdapter] })
  service = await createModeService({ dataDir: root, acp: runtime, callPage: async () => ({}) })
  await runtime.connect({ service, owner: 'fixture', id: 'login' }, true)
  assert.equal((await runtime.status()).options.model.current, 'default-model')
  await runtime.configure(service, { model: 'second-model', thinking: 'high' })
  assert.equal(await generate('model-and-thinking'), 'second-model/high')
  await runtime.configure(service, { model: 'invalid-model' })
  await assert.rejects(generate('model-and-thinking'), /核对模型选项/)
  await service.close()

  let canConfirmExit = false
  const failingAdapter = {
    ...adapters[0],
    async launch(context) {
      const launched = await adapters[0].launch(context)
      return { ...launched, async stop() {
        if (!canConfirmExit) throw new Error('fixture exit unconfirmed')
        await launched.stop()
      } }
    },
    async verifyRun() { assert.ok(canConfirmExit) },
  }
  runtime = createAcpRuntime({ root: path.join(root, 'stop-failure'), adapters: [failingAdapter] })
  service = await createModeService({ dataDir: root, acp: runtime, callPage: async () => ({}) })
  await assert.rejects(generate('write'), /exit unconfirmed/)
  assert.equal((await service.status()).phase, 'blocked')
  assert.equal((await service.status()).active.acp, 1)
  await assert.rejects(service.recover({ confirm: true }), /exit unconfirmed/)
  canConfirmExit = true
  assert.equal((await service.recover({ confirm: true })).mode, 'api')
  await service.close()

  const faultFile = path.join(root, 'fault.json')
  const faultLock = path.join(root, 'fault.lock')
  const storage = createModeFilePersistence(faultFile)
  let targetWritten = false
  const faultyStorage = {
    ...storage,
    async write(value) {
      await storage.write(value)
      targetWritten = value.phase === 'stable'
    },
    async read() {
      if (targetWritten) throw new Error('injected read-back failure')
      return storage.read()
    },
  }
  const manager = await openOwnedModeManager(faultFile, faultLock, { initialMode: 'api', store: faultyStorage })
  await assert.rejects(manager.switchTo('agent', 'fault', async () => {
    assert.equal(manager.canCancel('fault'), true)
    return async () => { assert.equal(manager.canCancel('fault'), false) }
  }), /injected/)
  assert.equal((await storage.read()).mode, 'agent')
  assert.equal(manager.snapshot().phase, 'blocked')
  await manager.close()
  const reopened = await openOwnedModeManager(faultFile, faultLock)
  assert.equal(reopened.snapshot().phase, 'blocked')
  await reopened.close()

  const killedFile = path.join(root, 'killed.json')
  const killedLock = path.join(root, 'killed.lock')
  const modeModule = new URL('../../scripts/agent-host/mode-manager.mjs', import.meta.url).href
  const killed = spawn(process.execPath, ['--input-type=module', '-e', `
    import { openOwnedModeManager } from ${JSON.stringify(modeModule)}
    const manager = await openOwnedModeManager(process.argv[1], process.argv[2], { initialMode: 'api' })
    await manager.switchTo('agent', 'crash-fixture', async () => {
      process.stdout.write('prepared\\n')
      return () => new Promise(() => setInterval(() => {}, 1000))
    })
  `, killedFile, killedLock], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  const killedExit = new Promise(resolve => killed.once('close', resolve))
  const prepared = await Promise.race([
    new Promise(resolve => killed.stdout.once('data', resolve)),
    killedExit.then(() => null),
  ])
  killed.kill()
  await killedExit
  assert.match(String(prepared), /prepared/)
  assert.equal(await createModeFilePersistence(killedFile).hasPending(), true)
  await fs.rename(killedLock, killedLock + '.evidence')
  const crashed = await openOwnedModeManager(killedFile, killedLock)
  assert.equal(crashed.snapshot().phase, 'blocked')
  await crashed.close()
  console.log('PASS ACP 假 Agent 流式、迟到分片、工具拒绝、协议异常、双向切换、重启、配置隔离、提交回读失败')
} finally {
  await service.close()
}
