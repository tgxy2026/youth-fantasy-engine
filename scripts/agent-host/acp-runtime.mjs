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
    // 常驻宿主活着时，pending 表示「正在使用」而不是「上次没退干净」；
    // 照旧走自愈归档会把正常进程的运行标记误清掉。
    if (live && !live.exited) return
    if (live && live.exited) await closeLive().catch(() => undefined)
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

  /**
   * 常驻宿主：**预热 + 进程保活 + 每个任务新会话**。
   *
   * 依据（2026-11-15 查证）：官方 agy_acp_server 是 PyInstaller onefile，Windows 上每次冷启动要
   * 把 Python 解包到 %TEMP%\_MEI*，光这一步 15~16 秒，首个 prompt 前固定付 23~25 秒；
   * 而同一进程里的第二次 prompt 只要约 1.9 秒。我们实测 initialize≈10s、单次任务≈48s，与之吻合。
   *
   * 采用社区通用做法（OpenMausBot / dsh-antigravity-acp）：
   *   · 一次 prepare → launch → initialize，后续任务复用同一进程与 ACP 连接（预热即「连接后不杀进程」）；
   *   · **每个任务仍然新建 session** —— 上下文隔离不变，模型/档位/账号之间不会继承未隔离上下文；
   *   · 空闲 10 分钟自动回收；配置代次变化、进程退出、传输报废都会重建；
   *   · 登录（purpose=login）**不走常驻**：它要临时改写 BROWSER、从 stderr 抓 OAuth 地址，用完必须整进程回收。
   */
  let live = null
  let idleTimer = null
  const LIVE_IDLE_MS = 10 * 60 * 1000

  function scheduleIdleClose() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { void closeLive().catch(() => undefined) }, LIVE_IDLE_MS)
    if (typeof idleTimer?.unref === 'function') idleTimer.unref()
  }

  /** 停掉常驻进程并清除运行标记；幂等。 */
  async function closeLive() {
    const current = live
    if (!current) return
    live = null
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    let stopError = null
    try { await current.launch?.stop() } catch (error) { stopError = error }
    if (stopError) {
      // 进程退出无法确认：保留运行标记作为现场证据，并把错误交给调用方 —— 不能假装已清理干净。
      unconfirmed = true
      unconfirmedLaunch = current.launch
      unconfirmedCleanup = current.cleanup
      sessionReady = false
      throw stopError
    }
    await runFile.clearPending().catch(() => undefined)
    await current.cleanup?.().catch(() => undefined)
    // 进程没了，会话自然失效 —— 否则界面会继续显示「会话已验证」。
    sessionReady = false
  }

  /** 建立（或复用）常驻宿主。 */
  async function ensureLive({ adapter, config, profile, signal }) {
    if (live && !live.exited) {
      // 进程可能刚在上一轮结束后退出（崩溃 / 组件自行退出）：用一次宏任务窗口确认，
      // 避免把请求打到已经死掉或已经报废的传输上。
      const gone = await Promise.race([
        live.exitPromise.then(() => true).catch(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 0)),
      ])
      if (gone || live.client?.isFailed?.()) live.exited = true
    }
    if (live && !live.exited && live.adapterId === adapter.id && live.generation === generation) return live
    if (live) await closeLive()

    const workRoot = path.join(root, 'sessions')
    await fs.mkdir(workRoot, { recursive: true })
    const cwd = await fs.mkdtemp(path.join(workRoot, 'work-'))
    const runId = randomBytes(16).toString('hex')
    const timing = { prepare: 0, launch: 0, initialize: 0 }
    let prepared
    let launch = null
    const cleanup = async () => {
      await prepared?.cleanup?.().catch(() => {})
      await fs.rm(cwd, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    }
    try {
      let mark = Date.now()
      prepared = await adapter.prepareLaunch?.({ config, profile, cwd, signal, purpose: 'session' })
      timing.prepare = Date.now() - mark
      signal.throwIfAborted()
      await runFile.markPending({ version: 1, runId, adapter: adapter.id })
      mark = Date.now()
      launch = await adapter.launch({ runId, config, profile, cwd, prepared, signal })
      timing.launch = Date.now() - mark
      const client = createAcpClient({ ...launch, clientVersion: appVersion })
      mark = Date.now()
      const initialized = await client.initialize(signal)
      timing.initialize = Date.now() - mark
      const host = {
        runId, adapterId: adapter.id, generation, launch, client, initialized,
        cwd, cleanup, exited: false, openedAt: Date.now(), timing,
      }
      live = host
      host.exitPromise = Promise.resolve(launch.exited)
        .then(() => { if (live === host) host.exited = true })
        .catch(() => { if (live === host) host.exited = true })
      scheduleIdleClose()
      return host
    } catch (error) {
      // 进程已拉起但握手失败：必须回收，否则留下没有所有者的 Agent 进程。
      try { await launch?.stop() } catch { /* 已退出 */ }
      await cleanup()
      await runFile.clearPending().catch(() => undefined)
      throw error
    }
  }

  /** 一次性会话（登录用）：保持原行为，用完即停。 */
  async function withOneShot({ adapter, config, profile, signal, work, purpose }) {
    const workRoot = path.join(root, 'sessions')
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
    try {
      prepared = await adapter.prepareLaunch?.({ config, profile, cwd, signal, purpose })
      signal.throwIfAborted()
      await runFile.markPending({ version: 1, runId, adapter: adapter.id }).catch(async error => {
        unconfirmed = await runFile.hasPending().catch(() => true)
        throw error
      })
      marked = true
      signal.throwIfAborted()
      launchAttempted = true
      launch = await adapter.launch({ runId, config, profile, cwd, prepared, signal })
      const client = createAcpClient({ ...launch, clientVersion: appVersion })
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
          unconfirmedCleanup = cleanup
        }
        else await cleanup()
      }
    }
  }

  async function withAgent(signal, work, purpose = 'session') {
    await verifyQuiescent()
    const { selected, configs } = await readSettings()
    const adapter = registry.get(selected)
    if (!adapter?.launch) throw new Error('所选 ACP Agent 暂不可连接。')
    const config = configs[selected] ?? {}
    const profile = path.join(root, 'profiles', selected)
    await fs.mkdir(profile, { recursive: true })
    if (purpose === 'login') return await withOneShot({ adapter, config, profile, signal, work, purpose })

    // 耗时分解：reused=true 表示这次没付启动税（预热/保活生效）。
    const timing = { purpose, reused: false, prepare: 0, launch: 0, initialize: 0, task: 0, total: 0, at: '' }
    const beganAt = Date.now()
    timing.reused = !!(live && !live.exited && live.adapterId === adapter.id && live.generation === generation)
    const host = await ensureLive({ adapter, config, profile, signal })
    try {
      return await work({ client: host.client, initialized: host.initialized, adapter, config, cwd: host.cwd, signal })
    } finally {
      // 传输报废时当场回收，别留一个没有所有者的进程等下一次请求。
      if (host.client?.isFailed?.()) await closeLive().catch(() => undefined)
      timing.prepare = host.timing.prepare
      timing.launch = host.timing.launch
      timing.initialize = host.timing.initialize
      timing.task = Date.now() - beganAt
      timing.total = timing.task
      timing.at = new Date().toISOString()
      await recordTiming(timing)
      scheduleIdleClose()
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
          // 🔴 常驻宿主：会话关闭被拒时不能假设 Agent 侧已清理。
          // 先尝试回收进程；**回收本身失败就按「退出未确认」处理** —— 保留现场与租约并抛错，
          // 不能把它当成「已清理干净」继续跑下一轮。
          const current = live
          if (!current) throw new Error('ACP 会话未能关闭。')
          live = null
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
          try {
            await current.launch?.stop()
          } catch (error) {
            unconfirmed = true
            unconfirmedLaunch = current.launch
            unconfirmedCleanup = current.cleanup
            throw error
          }
          await runFile.clearPending().catch(() => undefined)
          await current.cleanup?.().catch(() => undefined)
          sessionReady = false
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
      await closeLive()
      await verifyQuiescent()
    },
    /**
     * 显式预热：只建宿主、不建会话、不发 prompt。
     * ⚠️ 当前**没有调用点** —— 连接（connect）本身就会建立并保持宿主，等于自动预热；
     *    保留此方法供将来「设置页手动预热」或应用启动时预取使用。
     */
    async warm() {
      await withAgent(undefined, async () => undefined, 'warm')
    },
    async recover() {
      if (operation) throw new Error('请先等待 ACP 操作结束。')
      // 与 verifyQuiescent 共用同一套核对：能证明进程树已退出就归档，证明不了就保留现场。
      await closeLive().catch(() => undefined)
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
        // 常驻宿主是否就绪（预热后为 true，空闲回收/崩溃后回 false）
        live: !!live && !live.exited,
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
