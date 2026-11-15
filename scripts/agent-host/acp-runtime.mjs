import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createModeFilePersistence } from './mode-file.mjs'
import { createAcpClient } from './acp-client.mjs'
import { readSessionOptions } from './acp-options.mjs'

// `runAs` 与其它字段一样按字符串持久化与校验，但**不进 `status.config`**：
// `config` 是「会话选项类配置」的投影（binary/model/thinking/authMethod），
// 运行方式换的是整套进程与登录资料，混在一起会让界面拿着旧档位去连另一套账户。
const fields = ['binary', 'authMethod', 'model', 'thinking', 'runAs']
const CONFIG_FIELDS = ['binary', 'authMethod', 'model', 'thinking']
const RUN_AS = new Set(['current-user', 'isolated'])
/** 未设置或值不认识时一律按当前 Windows 用户运行 —— R4 的默认运行方式。 */
const runAsOf = config => (RUN_AS.has(config?.runAs) ? config.runAs : 'current-user')

export function createAcpRuntime({ root, adapters, appVersion = '' }) {
  const registry = new Map()
  for (const adapter of adapters) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(adapter.id) || registry.has(adapter.id)) throw new Error('ACP 适配器标识无效或重复。')
    registry.set(adapter.id, adapter)
  }
  const configFile = createModeFilePersistence(path.join(root, 'settings.json'))
  const runFile = createModeFilePersistence(path.join(root, 'runtime.json'))
  /** 最近一次 ACP 调用的耗时分解（只用于诊断，不影响任何行为） */
  let lastTiming = null

  async function recordTiming(timing) {
    lastTiming = timing
    const line = `[acp-timing] purpose=${timing.purpose} prepare=${timing.prepare}ms launch=${timing.launch}ms initialize=${timing.initialize}ms 会话+生成=${timing.task}ms 总计=${timing.total}ms`
    console.log(line)
    // 打包版没有控制台：同一份分解写到 acp/timing.json，事后可直接查看
    await fs.writeFile(path.join(root, 'timing.json'), JSON.stringify(timing, null, 2)).catch(() => undefined)
  }
  let operation = null
  let generation = randomUUID()
  let sessionOptions = null
  let sessionReady = false
  let unconfirmed = false
  let heldLease = null
  let unconfirmedLaunch = null
  let unconfirmedCleanup = null

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

  /**
   * 上次运行未正常结束（`runtime.json.pending` 残留）时的**自愈核对**。
   *
   * 🔴 2026-11-15 根治「ACP 进程退出未确认」永久卡死：
   *   以前 pending 一存在就一律抛错，只能靠用户点安全恢复；而恢复路径本身也可能被这同一处挡住
   *   （服务启动阶段拿锁失败时 gate 为 null），于是应用彻底卡在「连接模式不可用」，只能手改文件。
   *   现在把「核对」变成常态动作：只有 **Windows Job 确认该 run 的进程树确实已退出** 才归档 pending；
   *   核对不了（记录损坏 / 适配器没有 verifyRun / Job 仍在）一律保持阻断并保留现场。
   *   调用点：verifyQuiescent（首次连接、停止、切换）与 recover（安全恢复）。
   *
   * @returns {Promise<'none'|'recovered'>}
   */
  async function reconcilePendingRun() {
    if (!(await runFile.hasPending())) return 'none'
    const record = await runFile.readPending()
    const adapter = registry.get(record?.adapter)
    if (record?.version !== 1 || !adapter?.verifyRun || !/^[a-f0-9]{32}$/.test(record?.runId ?? '')) {
      throw new Error('ACP 运行标记无法核对，请保留故障现场。')
    }
    await adapter.verifyRun(record.runId)
    await fs.rename(
      path.join(root, 'runtime.json.pending'),
      path.join(root, 'runtime-' + record.runId + '.recovered.json'),
    )
    return 'recovered'
  }

  async function verifyQuiescent() {
    try {
      await reconcilePendingRun()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // 保留原口径文案（既有断言与手册都认它），后面附上具体原因便于定位。
      throw new Error(`ACP 进程退出未确认，请保留现场并核对进程。（${detail}）`)
    }
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
    let prepared
    const cleanup = async () => {
      await prepared?.cleanup?.().catch(() => {})
      await fs.rm(cwd, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    }
    let marked = false
    let launchAttempted = false
    // 耗时分解：四段分别计时，便于下次实测定位「30~40 秒」到底花在哪
    const timing = { purpose, prepare: 0, launch: 0, initialize: 0, task: 0, total: 0, at: '' }
    const beganAt = Date.now()
    try {
      let mark = Date.now()
      prepared = await adapter.prepareLaunch?.({ config, profile, cwd, signal, purpose })
      timing.prepare = Date.now() - mark
      signal.throwIfAborted()
      await runFile.markPending({ version: 1, runId, adapter: selected }).catch(async error => {
        unconfirmed = await runFile.hasPending().catch(() => true)
        throw error
      })
      marked = true
      signal.throwIfAborted()
      launchAttempted = true
      mark = Date.now()
      launch = await adapter.launch({ runId, config, profile, cwd, prepared, signal })
      timing.launch = Date.now() - mark
      const client = createAcpClient({ ...launch, clientVersion: appVersion })
      mark = Date.now()
      const initialized = await client.initialize(signal)
      timing.initialize = Date.now() - mark
      mark = Date.now()
      const result = await work({ client, initialized, adapter, config, cwd, signal })
      timing.task = Date.now() - mark
      return result
    } finally {
      timing.total = Date.now() - beganAt
      timing.at = new Date().toISOString()
      await recordTiming(timing)
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
          unconfirmedCleanup = cleanup
        }
        else await cleanup()
      }
    }
  }

  // Retry only a transient setup error, before any prompt or project material is sent.
  const isTransientSessionError = error => error?.sessionFailure === 'network'
  const readableSessionError = error => {
    if (error?.acpCode !== -32603) return error
    const messages = {
      network: 'ACP 建立会话时网络连接失败。请检查网络连接后重试，本次未发送创作资料。',
      auth: 'ACP 建立会话时账号验证失败。请在 ACP 连接中重新登录。',
      quota: 'ACP Agent 暂时无法分配会话。请检查账号额度，稍后重试。',
      unknown: 'ACP Agent 建立会话失败（-32603）。请重试连接，本次未发送创作资料。',
    }
    const message = messages[error.sessionFailure] ?? messages.unknown
    return Object.assign(
      new Error(message),
      { acpCode: error.acpCode, sessionFailure: error.sessionFailure },
    )
  }
  async function openSession({ client, cwd, signal }) {
    const attempt = async () => {
      const session = await client.request('session/new', { cwd, mcpServers: [] }, undefined, signal)
      if (typeof session?.sessionId !== 'string' || !session.sessionId || session.sessionId.length > 512) throw new Error('ACP 会话未建立。')
      return session
    }
    for (const backoff of [2500, 5000, 0]) {
      try { return await attempt() }
      catch (error) {
        if (signal.aborted || !backoff || !isTransientSessionError(error)) throw readableSessionError(error)
        try { await delay(backoff, undefined, { signal }) }
        catch (abortError) { throw signal.reason ?? abortError }
      }
    }
  }

  async function withSession(context, work) {
    const { adapter, client, initialized, signal } = context
    const session = await openSession(context)
    try {
      signal.throwIfAborted()
      return await work(session)
    } finally {
      const advertised = initialized.agentCapabilities?.sessionCapabilities?.close
      if ((advertised && typeof advertised === 'object' && !Array.isArray(advertised)) ||
          adapter.supportsSessionClose?.(initialized)) {
        try {
          // Cleanup must also run after a cancelled turn. withAgent still verifies process exit.
          await client.request('session/close', { sessionId: session.sessionId }, 2000)
        } catch {
          // Unsupported, disconnected or stalled transports fall back to verified process shutdown.
        }
      }
    }
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
      // 与 verifyQuiescent 共用同一套核对：能证明进程树已退出就归档，证明不了就保留现场。
      await unconfirmedLaunch?.stop()
      await reconcilePendingRun()
      if (heldLease) heldLease.service.release(heldLease.lease, heldLease.owner)
      heldLease = null
      unconfirmed = false
      unconfirmedLaunch = null
      await unconfirmedCleanup?.()
      unconfirmedCleanup = null
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
        // 最近一次调用耗时（界面不展示，供日志 / 诊断）
        timing: lastTiming,
        requiresConnection: adapter?.requiresConnection === true,
        // 运行方式与隔离账户状态分开暴露：默认 current-user 时即使没开通隔离也照常可连。
        runAs: adapter ? runAsOf(configs[selected]) : null,
        isolation: adapter?.isolationConfigured ? (await adapter.isolationConfigured() ? 'configured' : 'required') : null,
        config: adapter
          ? Object.fromEntries(CONFIG_FIELDS.map(field => [field, typeof configs[selected]?.[field] === 'string' ? configs[selected][field] : '']))
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
      // 枚举也要在这里挡一次：IPC 层已经校验，但运行层是被直接调用的公共入口
      //（测试、命令行探针），不能指望上层一定先拦过。
      if ('runAs' in patch && !RUN_AS.has(patch.runAs)) throw new Error('ACP 运行方式无效。')
      if (operation) throw new Error('请等待 ACP 任务结束。')
      return service.switchAcpAgent(randomUUID(), async () => {
        const settings = await readSettings()
        if (!registry.has(settings.selected)) throw new Error('请选择 ACP Agent。')
        return async () => {
          await saveSettings({
            ...settings, configs: { ...settings.configs, [settings.selected]: { ...settings.configs[settings.selected], ...patch } },
          })
          const config = { ...settings.configs[settings.selected], ...patch }
          // 切换运行方式意味着换一套进程与登录资料：旧会话、旧模型选项一律作废，
          // 否则界面会拿着「当前用户」读到的模型档位去连「隔离」账户，看起来能用其实连不上。
          if ('runAs' in patch && runAsOf(settings.configs[settings.selected]) !== runAsOf(config)) {
            sessionOptions = null
            sessionReady = false
            return
          }
          sessionReady = !!sessionOptions && ['model', 'thinking'].every(key =>
            !config[key] || sessionOptions[key]?.values.some(item => item.value === config[key]),
          )
        }
      })
    },
    async disconnect(service) {
      return service.switchAcpAgent(randomUUID(), async () => async () => { invalidateResults() })
    },
    async setupIsolation(request) {
      return runOperation(request, async signal => {
        const { selected } = await readSettings()
        const adapter = registry.get(selected)
        if (!adapter?.setupIsolation) throw new Error('所选 ACP Agent 无需开通 Windows 隔离。')
        await adapter.setupIsolation(signal)
        invalidateResults()
      })
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
            const options = await withSession(context, session => readSessionOptions(session))
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
      return runOperation({ service, owner, id }, async signal => {
        const textResult = await withAgent(signal, async context => {
          const { adapter, client } = context
          if (adapter.requiresConnection && !sessionReady) throw new Error('请先连接 ACP Agent 并核对模型选项。')
          return withSession(context, async session => {
            await adapter.configureSession?.({ ...context, session })
            return client.prompt({ sessionId: session.sessionId, text, signal, onChunk })
          })
        })
        signal.throwIfAborted()
        return textResult
      })
    },
  }
}
