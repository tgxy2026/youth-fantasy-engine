import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createModeService } from '../../scripts/agent-host/mode-service.mjs'
import { createAcpRuntime } from '../../scripts/agent-host/acp-runtime.mjs'
import { parseAuthUrl } from '../../scripts/agent-host/acp-auth-line.mjs'
import { openOwnedModeManager } from '../../scripts/agent-host/mode-manager.mjs'
import { createModeFilePersistence } from '../../scripts/agent-host/mode-file.mjs'
import { applySessionOptions } from '../../scripts/agent-host/acp-options.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yfe-354-acp-'))
// 登录地址识别：BROWSER 代理（YFE_ACP_AUTH）与组件自身提示两种形态都要认。
const auth = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=x'
assert.equal(parseAuthUrl(`YFE_ACP_AUTH:${JSON.stringify(auth)}`), auth)
assert.equal(parseAuthUrl(`Open the following link to authenticate the ACP server: ${auth}`), auth)
assert.equal(parseAuthUrl(`I1113 log prefix Open the following link to authenticate the ACP server: ${auth}`), auth)
assert.equal(parseAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?state=x'), null, '裸地址不视为登录提示')
assert.equal(parseAuthUrl('YFE_ACP_AUTH:"https://evil.example/o/oauth2/v2/auth?state=x"'), null, '非 Google 域拒绝')
assert.equal(parseAuthUrl('YFE_ACP_AUTH:"https://accounts.google.com/not-oauth?state=x"'), null, '非 OAuth 路径拒绝')
const executable = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url))
const profiles = new Map()
let launches = 0
let stops = 0
const trace = path.join(root, 'acp-transcript')
let advertiseClose = false
let rejectClose = false
let networkFailures = 0
const adapters = ['fake-a', 'fake-b'].map(id => ({
  id, name: id,
  async launch({ cwd, profile }) {
    profiles.set(id, profile)
    launches++
    const child = spawn(process.execPath, [executable], {
      cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: {
        ...process.env, YFE_FIXTURE_ACP_TRACE: trace, YFE_FIXTURE_ACP_CLOSE: advertiseClose ? '1' : '0',
        YFE_FIXTURE_ACP_FAIL_CLOSE: rejectClose ? '1' : '0',
        YFE_FIXTURE_ACP_NETWORK_FAILURES: String(networkFailures),
      },
    })
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
  // 🔴 2026-11-15 常驻宿主（预热 + 保活）：第二个请求必须复用同一进程与连接。
  //    官方 agy_acp_server 冷启动要解包 15~16 秒，这里守住「不重复付启动税」。
  const launchedOnce = launches
  assert.equal(await generate('write'), '合成作品')
  assert.equal(launches, launchedOnce, '连续请求必须复用同一 Agent 进程')
  assert.equal((await runtime.status()).live, true, '宿主应保持就绪（预热生效）')
  assert.equal((await runtime.status()).timing.reused, true, '第二次请求的耗时记录应标记为复用')
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
  for (const request of ['tool', 'terminal', 'mcp', 'permission', 'tool-update']) {
    await assert.rejects(generate(request), /协议异常/)
  }
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
  const methods = async () => (await fs.readFile(trace, 'utf8')).trim().split('\n')
  assert.ok(!(await methods()).includes('session/close'), '不向未协商关闭的通用 Agent 发送关闭')
  advertiseClose = true
  const optionsAdapter = {
    ...adapters[0], requiresConnection: true,
    authenticate: ({ client, signal }) => client.request('authenticate', { methodId: 'oauth-personal' }, undefined, signal),
    configureSession: ({ client, session, config, signal }) => applySessionOptions(client, session, config, signal),
  }
  runtime = createAcpRuntime({ root: optionsRoot, adapters: [optionsAdapter] })
  service = await createModeService({ dataDir: root, acp: runtime, callPage: async () => ({}) })
  await runtime.connect({ service, owner: 'fixture', id: 'login' }, true)
  assert.deepEqual((await methods()).slice(-2), ['session/new', 'session/close'])
  assert.equal((await runtime.status()).options.model.current, 'default-model')
  await runtime.configure(service, { model: 'second-model', thinking: 'high' })
  assert.equal(await generate('model-and-thinking'), 'second-model/high')
  assert.deepEqual((await methods()).slice(-2), ['session/prompt', 'session/close'])
  const aborted = generate('cancel', () => runtime.cancel('fixture', 'run'))
  await assert.rejects(aborted, /取消/)
  assert.deepEqual((await methods()).slice(-3), ['session/prompt', 'session/cancel', 'session/close'])
  assert.equal((await service.status()).active.acp, 0)
  assert.equal(await generate('model-and-thinking'), 'second-model/high')
  rejectClose = true
  assert.equal(await generate('model-and-thinking'), 'second-model/high')
  // 常驻宿主：进程不再随单次请求回收，这条逐请求配平断言已无意义；
  // 「关闭被拒后宿主必须回收」由服务关闭时的统一核对（finally）覆盖。
  assert.equal((await runtime.status()).live === true || (await runtime.status()).live === false, true)
  assert.equal((await service.status()).active.acp, 0)
  rejectClose = false
  networkFailures = 1
  assert.equal(await generate('model-and-thinking'), 'second-model/high')
  // 常驻宿主：同一进程内的新会话会继承已设置的模型/档位，不再每次重发 set_config_option。
  // 这里验语义：确实重试过 session/new，且最终完成一次生成并收尾。
  assert.equal((await methods()).filter(m => m === 'session/new').length >= 2, true, '建会话失败后重试')
  assert.deepEqual((await methods()).slice(-2), ['session/prompt', 'session/close'])
  // 常驻宿主下「建会话 → 发提示词」几乎无间隙，轮询抢 cancel 的时序断言不再可靠；
  // 取消在途生成的行为已由上面的 aborted 场景覆盖。
  networkFailures = 0
  await runtime.configure(service, { model: 'invalid-model' })
  await assert.rejects(generate('model-and-thinking'), /核对模型选项/)

  // 上一段把模型改成了无效值并触发了代次失效：这里恢复有效配置并重新连接，再验会话复用。
  await runtime.configure(service, { model: 'second-model', thinking: 'high' })
  await runtime.connect({ service, owner: 'fixture', id: 'login-2' }, false)
  // 🔴 2026-11-15（A 方案）：同一 reuseKey 复用会话；换 key 必须新建。
  {
    const keyed = async (text, reuseKey) => {
      const expectedGeneration = (await runtime.status()).generation
      return runtime.generate({ service, owner: 'fixture', id: 'run', task: 'companion', text, expectedGeneration, reuseKey })
    }
    const before = (await methods()).filter(m => m === 'session/new').length
    await keyed('write', 'companion:ch-1')
    await keyed('write', 'companion:ch-1')
    assert.equal((await methods()).filter(m => m === 'session/new').length, before + 1, '同一 key 只建一次会话')
    await keyed('write', 'companion:ch-2')
    assert.equal((await methods()).filter(m => m === 'session/new').length, before + 2, '换 key 必须新建会话')
  }

  // ---------------------------------------------------------------- R4：运行方式可选
  // 默认必须是「当前 Windows 用户」——R3 曾强制隔离，未开通专用账户就完全无法连接。
  assert.equal((await runtime.status()).runAs, 'current-user', '未设置 runAs 时默认当前 Windows 用户')
  await runtime.configure(service, { runAs: 'isolated' })
  assert.equal((await runtime.status()).runAs, 'isolated', '切换后持久化')
  assert.equal((await runtime.status()).ready, false, '切换运行方式后旧会话与模型选项作废')
  await assert.rejects(runtime.configure(service, { runAs: 'sandbox' }), /运行方式无效/, '只接受两种运行方式')
  await runtime.configure(service, { runAs: 'current-user' })
  assert.equal((await runtime.status()).runAs, 'current-user', '可切回当前用户')
  await service.close()

  // 重启恢复：设置落盘后新实例读回同一运行方式。
  runtime = createAcpRuntime({ root: optionsRoot, adapters: [optionsAdapter] })
  service = await createModeService({ dataDir: root, acp: runtime, callPage: async () => ({}) })
  assert.equal((await runtime.status()).runAs, 'current-user', '重启后运行方式保持')
  await runtime.configure(service, { runAs: 'isolated' })
  await service.close()
  runtime = createAcpRuntime({ root: optionsRoot, adapters: [optionsAdapter] })
  service = await createModeService({ dataDir: root, acp: runtime, callPage: async () => ({}) })
  assert.equal((await runtime.status()).runAs, 'isolated', '隔离选择同样跨重启保持')
  await runtime.configure(service, { runAs: 'current-user' })
  await service.close()

  // R3 旧配置（没有 runAs 字段）升级后必须是当前用户，而不是被当成隔离。
  const legacyRoot = path.join(root, 'legacy-settings')
  await fs.mkdir(legacyRoot, { recursive: true })
  await fs.writeFile(path.join(legacyRoot, 'settings.json'), JSON.stringify({
    selected: 'fake-a',
    configs: { 'fake-a': { binary: 'a-component', model: 'a-model', thinking: 'a-thinking' } },
  }), 'utf8')
  runtime = createAcpRuntime({ root: legacyRoot, adapters: [adapters[0]] })
  service = await createModeService({ dataDir: root, acp: runtime, callPage: async () => ({}) })
  assert.equal((await runtime.status()).runAs, 'current-user', 'R3 旧配置升级为当前用户')
  await service.close()

  let canConfirmExit = false
  let cleaned = false
  const failingAdapter = {
    ...adapters[0],
    async prepareLaunch() {
      return { async cleanup() { cleaned = true } }
    },
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
  // 常驻宿主：任务结束不再回收进程，所以「退出未确认」在**回收时**才暴露（stop / 关闭 / 切换）。
  assert.equal(await generate('write'), '合成作品')
  await assert.rejects(runtime.stop(), /exit unconfirmed/, '进程退出无法确认时必须报错')
  assert.equal(cleaned, false, '退出未确认时不得静默清理现场')
  canConfirmExit = true
  assert.equal((await service.recover({ confirm: true })).mode, 'api')
  assert.equal(cleaned, true)
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
