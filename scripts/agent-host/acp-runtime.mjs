import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { createModeFilePersistence } from './mode-file.mjs'
import { createAcpClient } from './acp-client.mjs'
import { readSessionOptions } from './acp-options.mjs'

const fields = ['binary', 'authMethod', 'model', 'thinking']

export function createAcpRuntime({ root, adapters }) {
  const registry = new Map()
  for (const adapter of adapters) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(adapter.id) || registry.has(adapter.id)) throw new Error('ACP 适配器标识无效或重复。')
    registry.set(adapter.id, adapter)
  }
  const configFile = createModeFilePersistence(path.join(root, 'settings.json'))
  const runFile = createModeFilePersistence(path.join(root, 'runtime.json'))
  let operation = null
  let generation = randomUUID()
  let sessionOptions = null
  let sessionReady = false
  let unconfirmed = false
  let heldLease = null
  let unconfirmedLaunch = null

  async function readSettings() {
    let saved
    try { saved = await configFile.read() }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return { selected: adapters[0]?.id ?? null, configs: {} }
    }
    if (!saved || typeof saved.selected !== 'string' || !saved.configs || typeof saved.configs !== 'object' || Array.isArray(saved.configs)) {
      throw new Error('ACP 设置无法核对。')
    }
    return saved
  }

  async function saveSettings(settings) {
    await configFile.write(settings)
    if (JSON.stringify(await configFile.read()) !== JSON.stringify(settings)) throw new Error('ACP 设置回读失败。')
    generation = randomUUID()
  }

  async function verifyQuiescent() {
    if (await runFile.hasPending()) throw new Error('ACP 进程退出未确认，请保留现场并核对进程。')
  }

  function runOperation({ service, owner, id }, work) {
    if (operation) throw new Error('已有 ACP 操作在途。')
    const lease = service.acquire('acp', owner)
    const controller = new AbortController()
    const finished = Promise.resolve().then(() => work(controller.signal)).finally(() => {
      if (unconfirmed) {
        heldLease = { service, lease, owner }
        service.blockAcpRuntime()
      } else {
        service.release(lease, owner)
      }
      operation = null
    })
    operation = { owner, id, controller, finished }
    return finished
  }

  async function withAgent(signal, work, purpose = 'session') {
    await verifyQuiescent()
    const { selected, configs } = await readSettings()
    const adapter = registry.get(selected)
    if (!adapter?.launch) throw new Error('所选 ACP Agent 暂不可连接。')
    const config = configs[selected] ?? {}
    const profile = path.join(root, 'profiles', selected)
    const workRoot = path.join(root, 'sessions')
    await fs.mkdir(profile, { recursive: true })
    await fs.mkdir(workRoot, { recursive: true })
    const cwd = await fs.mkdtemp(path.join(workRoot, 'work-'))
    const runId = randomBytes(16).toString('hex')
    let launch
    let marked = false
    let launchAttempted = false
    try {
      const prepared = await adapter.prepareLaunch?.({ config, profile, cwd, signal, purpose })
      signal.throwIfAborted()
      await runFile.markPending({ version: 1, runId, adapter: selected }).catch(async error => {
        unconfirmed = await runFile.hasPending().catch(() => true)
        throw error
      })
      marked = true
      signal.throwIfAborted()
      launchAttempted = true
      launch = await adapter.launch({ runId, config, profile, cwd, prepared, signal })
      const client = createAcpClient(launch)
      const initialized = await client.initialize(signal)
      return await work({ client, initialized, adapter, config, cwd, signal })
    } finally {
      try {
        if (marked) {
          if (launch) await launch.stop()
          else if (launchAttempted) {
            if (!adapter.verifyRun) throw new Error('ACP 启动结果无法核对。')
            await adapter.verifyRun(runId)
          }
          await runFile.clearPending()
          marked = false
        }
      } finally {
        if (marked) {
          unconfirmed = true
          unconfirmedLaunch = launch
        }
        else await fs.rm(cwd, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
      }
    }
  }

  async function openSession({ client, cwd, signal }) {
    const session = await client.request('session/new', { cwd, mcpServers: [] }, undefined, signal)
    if (typeof session?.sessionId !== 'string' || !session.sessionId || session.sessionId.length > 512) throw new Error('ACP 会话未建立。')
    return session
  }

  function invalidateResults() {
    generation = randomUUID()
    sessionOptions = null
    sessionReady = false
  }

  return {
    verifyQuiescent,
    invalidateResults,
    async stop() {
      operation?.controller.abort(new Error('ACP 任务已取消。'))
      await operation?.finished.catch(() => {})
      await verifyQuiescent()
    },
    async recover() {
      if (operation) throw new Error('请先等待 ACP 操作结束。')
      if (await runFile.hasPending()) {
        const record = await runFile.readPending()
        const adapter = registry.get(record?.adapter)
        if (record?.version !== 1 || !adapter?.verifyRun || !/^[a-f0-9]{32}$/.test(record.runId)) {
          throw new Error('ACP 运行标记无法核对，请保留故障现场。')
        }
        await unconfirmedLaunch?.stop()
        await adapter.verifyRun(record.runId)
        await fs.rename(path.join(root, 'runtime.json.pending'), path.join(root, 'runtime-' + record.runId + '.recovered.json'))
      }
      if (heldLease) heldLease.service.release(heldLease.lease, heldLease.owner)
      heldLease = null
      unconfirmed = false
      unconfirmedLaunch = null
      invalidateResults()
    },
    cancel(owner, id) {
      if (operation?.owner !== owner || operation?.id !== id) return false
      operation.controller.abort(new Error('ACP 任务已取消。'))
      return true
    },
    cancelPage(contentsId, pageGeneration) {
      const owner = operation?.owner
      if (owner?.startsWith('engine-renderer:' + contentsId + ':') && owner.endsWith(':' + pageGeneration)) {
        operation.controller.abort(new Error('ACP 页面已离开。'))
      }
    },
    async status() {
      const { selected, configs } = await readSettings()
      const adapter = registry.get(selected)
      return {
        adapters: adapters.map(({ id, name, launch, component }) => ({
          id, name, available: typeof launch === 'function', componentVersion: component?.version ?? null,
        })),
        selected, generation, busy: !!operation, options: sessionOptions, ready: sessionReady,
        requiresConnection: adapter?.requiresConnection === true,
        config: adapter
          ? Object.fromEntries(fields.map(field => [field, typeof configs[selected]?.[field] === 'string' ? configs[selected][field] : '']))
          : null,
      }
    },
    async prepareSelection(id) {
      if (!registry.has(id)) throw new Error('请选择当前平台支持的 ACP Agent。')
      const settings = await readSettings()
      return async () => {
        await saveSettings({ ...settings, selected: id })
        sessionOptions = null
        sessionReady = false
      }
    },
    async configure(service, patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.entries(patch).some(
        ([key, value]) => !fields.includes(key) || typeof value !== 'string' || value.length > 4096,
      )) throw new Error('ACP 配置无效。')
      if (operation) throw new Error('请等待 ACP 任务结束。')
      return service.switchAcpAgent(randomUUID(), async () => {
        const settings = await readSettings()
        if (!registry.has(settings.selected)) throw new Error('请选择 ACP Agent。')
        return async () => {
          await saveSettings({
            ...settings, configs: { ...settings.configs, [settings.selected]: { ...settings.configs[settings.selected], ...patch } },
          })
          const config = { ...settings.configs[settings.selected], ...patch }
          sessionReady = !!sessionOptions && ['model', 'thinking'].every(key =>
            !config[key] || sessionOptions[key]?.values.some(item => item.value === config[key]),
          )
        }
      })
    },
    async disconnect(service) {
      return service.switchAcpAgent(randomUUID(), async () => async () => { invalidateResults() })
    },
    async install(request) {
      return runOperation(request, async signal => {
        const settings = await readSettings()
        const adapter = registry.get(settings.selected)
        if (!adapter?.component) throw new Error('所选 ACP Agent 暂无可安装组件。')
        const binary = await adapter.component.install(signal)
        signal.throwIfAborted()
        await saveSettings({
          ...settings, configs: { ...settings.configs, [settings.selected]: { ...settings.configs[settings.selected], binary } },
        })
        sessionOptions = null
        sessionReady = false
      })
    },
    async selectBinary(request, pick) {
      return runOperation(request, async signal => {
        const settings = await readSettings()
        const adapter = registry.get(settings.selected)
        if (!adapter?.component?.resolve) throw new Error('所选 ACP Agent 暂不支持手选组件。')
        const chosen = await pick()
        if (!chosen) return
        signal.throwIfAborted()
        const binary = await adapter.component.resolve(chosen)
        signal.throwIfAborted()
        await saveSettings({
          ...settings, configs: { ...settings.configs, [settings.selected]: { ...settings.configs[settings.selected], binary } },
        })
        sessionOptions = null
        sessionReady = false
      })
    },
    async connect(request, authenticate = false) {
      return runOperation(request, async signal => {
        invalidateResults()
        const { options, ready } = await withAgent(signal, async context => {
          if (authenticate) {
            if (!context.adapter.authenticate) throw new Error('当前 ACP Agent 未提供登录。')
            await context.adapter.authenticate(context)
          }
          try {
            const options = readSessionOptions(await openSession(context))
            const ready = ['model', 'thinking'].every(key =>
              !context.config[key] || options[key]?.values.some(item => item.value === context.config[key]),
            )
            return { options, ready }
          }
          catch (error) {
            if (error?.acpCode === -32000) throw Object.assign(new Error('ACP Agent 要求登录，请登录 Google 账号后重试。'), { acpCode: -32000 })
            throw error
          }
        }, authenticate ? 'login' : 'session')
        signal.throwIfAborted()
        sessionOptions = options
        sessionReady = ready
      })
    },
    async logout(request) {
      return runOperation(request, async signal => {
        invalidateResults()
        await withAgent(signal, async context => {
          if (!context.adapter.logout) throw new Error('当前 ACP Agent 未提供注销。')
          await context.adapter.logout(context)
        })
      })
    },
    async generate({ service, owner, id, text, expectedGeneration, onChunk }) {
      if (expectedGeneration !== generation) throw new Error('ACP 设置已变更。')
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 256 * 1024) throw new Error('ACP 请求文本无效。')
      return runOperation({ service, owner, id }, signal => withAgent(signal, async context => {
        const { adapter, client } = context
        if (adapter.requiresConnection && !sessionReady) throw new Error('请先连接 ACP Agent 并核对模型选项。')
        const session = await openSession(context)
        await adapter.configureSession?.({ ...context, session })
        return client.prompt({ sessionId: session.sessionId, text, signal, onChunk })
      }))
    },
  }
}
