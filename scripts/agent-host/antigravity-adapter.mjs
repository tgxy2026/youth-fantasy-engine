import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAntigravityComponent } from './antigravity-component.mjs'
import { launchWindowsAcpJob, verifyWindowsJobGone } from './acp-job.mjs'
import { applySessionOptions } from './acp-options.mjs'
import { createModeFilePersistence } from './mode-file.mjs'
import { parseAuthUrl } from './acp-auth-line.mjs'
import { createAcpSandbox } from './acp-sandbox.mjs'

// Pin the component independently of the ACP wire protocol. Release enablement depends
// on validating the official OAuth flow and the Windows file-access boundary.
export function createAntigravityAdapter({ root, validationEnabled = false, openExternal }) {
  const component = createAntigravityComponent(path.join(root, 'components', 'antigravity'))
  const sandbox = createAcpSandbox(root)
  const adapter = {
    id: 'antigravity', name: 'Antigravity', component,
    verifyRun: verifyWindowsJobGone,
  }
  if (!validationEnabled) return adapter

  return {
    ...adapter,
    requiresConnection: true,
    isolationConfigured: sandbox.configured,
    setupIsolation: sandbox.setup,
    // The hash-pinned 1.5.0 ACP executable acknowledges session/close but omits
    // the capability. Require both the pinned release and its verified wire identity.
    supportsSessionClose({ agentInfo }) {
      return component.version === '1.5.0' && agentInfo?.name === 'antigravity-acp' && agentInfo.version === component.version
    },
    /**
     * 运行方式：`isolated` 走专用 Windows 标准账户；**其它值（含未设置）一律按当前 Windows 用户运行**。
     *
     * 🔴 2026-11-14 R4：隔离改为**可选**。R3 曾强制隔离，未开通专用账户就完全无法连接，
     *    而开通要 UAC + 新账户 + 重新登录 Google，把「先用起来」这条路堵死了。
     *    现在默认沿用 R3 之前的当前用户路径，与既有 ACP 登录资料兼容。
     *
     * 两条路径**各用自己的 profile 目录**，切换时不复制、不覆盖、不清理另一侧的登录资料：
     *   · current-user → `<root>/profiles/<id>`（R3 之前的位置，既有登录态在这里）
     *   · isolated     → `<root>/isolated-profiles/<id>`
     * 两条路径都保留官方组件校验、Job Object 回收、外发确认与三模式互斥。
     */
    async prepareLaunch({ config, profile: baseProfile, cwd, purpose, signal }) {
      if (config.runAs !== 'isolated') {
        // ── 当前 Windows 用户：官方组件原位启动，Agent 及其子进程拥有当前用户的文件权限。
        const binary = await fs.realpath(await component.resolve(config.binary))
        const profile = baseProfile
        await fs.mkdir(profile, { recursive: true })
        const work = await fs.realpath(cwd)
        const home = await fs.realpath(profile)
        const roaming = path.join(profile, 'AppData', 'Roaming')
        const local = path.join(profile, 'AppData', 'Local')
        for (const directory of [roaming, local]) await fs.mkdir(directory, { recursive: true })
        const systemRoot = process.env.SystemRoot ?? 'C://Windows'
        const env = {
          SystemRoot: systemRoot, WINDIR: systemRoot,
          PATH: path.join(systemRoot, 'System32'),
          USERPROFILE: home, HOME: home, APPDATA: roaming, LOCALAPPDATA: local,
          GEMINI_HOME: home, AGY_ACP_FORCE_FILE_STORAGE: '1',
          ANTIGRAVITY_HARNESS_PATH: path.join(path.dirname(binary), 'localharness_external.exe'),
          PYTHONUNBUFFERED: '1',
        }
        const oauth = purpose === 'login' && typeof openExternal === 'function' ? { active: true, opened: false } : null
        if (oauth) {
          const browser = fileURLToPath(new URL('./acp-browser.cjs', import.meta.url))
          env.BROWSER = [process.execPath, browser, '%s']
            .map(value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\"'\"'") + "'").join(' ')
          if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
        }
        const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'yfe-acp-'))
        env.TEMP = temp
        env.TMP = temp
        const cleanup = () => fs.rm(temp, { recursive: true, force: true, maxRetries: 3 })
        if (purpose === 'login') {
          const settingsDir = path.join(profile, 'antigravity-acp')
          await fs.mkdir(settingsDir, { recursive: true })
          await createModeFilePersistence(path.join(settingsDir, 'settings.json')).write({ auth: { type: 'oauth-personal' } })
        }
        // `sandbox: null` ⇒ 启动器以当前用户拉起进程，仍套 Job Object 回收与退出核对。
        return { binary, cwd: work, env, oauth, sandbox: null, cleanup }
      }

      if (!(await sandbox.configured())) throw new Error('请先在「ACP 连接」开通 Windows 隔离，再连接 Agent。')
      const source = await component.resolve(config.binary)
      const staging = path.join(root, 'isolated-components', 'antigravity-' + component.version)
      const profile = path.join(root, 'isolated-profiles', 'antigravity')
      const realRoot = await fs.realpath(root)
      for (const directory of [staging, profile]) {
        await fs.mkdir(directory, { recursive: true })
        const expected = path.join(realRoot, path.relative(root, directory)).toLowerCase()
        if (path.resolve(await fs.realpath(directory)).toLowerCase() !== expected) {
          throw new Error('ACP 隔离目录不能使用链接或目录重定向。')
        }
      }
      const binary = path.join(staging, 'agy_acp_server.exe')
      for (const name of ['localharness_external.exe', 'agy_acp_server.exe']) {
        const target = path.join(staging, name)
        try { await fs.copyFile(path.join(path.dirname(source), name), target, fs.constants.COPYFILE_EXCL) }
        catch (error) { if (error.code !== 'EEXIST') throw error }
      }
      await component.resolve(binary)
      const executable = await fs.realpath(binary)
      const work = await fs.realpath(cwd)
      const home = await fs.realpath(profile)
      const roaming = path.join(profile, 'AppData', 'Roaming')
      const local = path.join(profile, 'AppData', 'Local')
      for (const directory of [roaming, local]) await fs.mkdir(directory, { recursive: true })
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const env = {
        SystemRoot: systemRoot, WINDIR: systemRoot,
        PATH: path.join(systemRoot, 'System32'),
        USERPROFILE: home, HOME: home, APPDATA: await fs.realpath(roaming), LOCALAPPDATA: await fs.realpath(local),
        GEMINI_HOME: home, AGY_ACP_FORCE_FILE_STORAGE: '1',
        ANTIGRAVITY_HARNESS_PATH: path.join(path.dirname(executable), 'localharness_external.exe'),
        PYTHONUNBUFFERED: '1',
      }
      const oauth = purpose === 'login' && typeof openExternal === 'function' ? { active: true, opened: false } : null
      if (oauth) {
        const browser = fileURLToPath(new URL('./acp-browser.cjs', import.meta.url))
        env.BROWSER = [process.execPath, browser, '%s']
          .map(value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\"'\"'") + "'").join(' ')
        if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
      }
      // The vendor executable unpacks long internal names under TEMP during startup.
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'yfe-acp-'))
      env.TEMP = await fs.realpath(temp)
      env.TMP = env.TEMP
      const cleanup = () => fs.rm(temp, { recursive: true, force: true, maxRetries: 3 })
      try {
        const identity = await sandbox.prepare({ profile, cwd, temp, component: staging, signal })
        if (purpose === 'login') {
          const settingsDir = path.join(profile, 'antigravity-acp')
          await fs.mkdir(settingsDir, { recursive: true })
          const expected = path.join(realRoot, path.relative(root, settingsDir)).toLowerCase()
          if (path.resolve(await fs.realpath(settingsDir)).toLowerCase() !== expected) throw new Error('ACP 登录配置目录不能使用链接。')
          await createModeFilePersistence(path.join(settingsDir, 'settings.json')).write({ auth: { type: 'oauth-personal' } })
        }
        return { binary: executable, cwd: work, env, oauth, sandbox: identity, cleanup }
      } catch (error) {
        await cleanup().catch(() => {})
        throw error
      }
    },
    launch({ runId, cwd, prepared, signal }) {
      // The official executable controls its native OAuth flow. Any brokered URL
      // is accepted only during a login operation and never returned to the page.
      const oauth = prepared.oauth
      let line = ''
      return launchWindowsAcpJob({
        runId, cwd, ...prepared,
        onStderr(chunk) {
          if (!oauth?.active || signal.aborted) return
          line += chunk.toString('utf8')
          if (line.length > 32_768) { line = ''; return }
          const lines = line.split('\n')
          line = lines.pop()
          for (const entry of lines) {
            if (oauth.opened) break
            const href = parseAuthUrl(entry)
            if (!href) continue
            oauth.opened = true
            void Promise.resolve(openExternal(href)).catch(() => {})
          }
        },
      })
    },
    async authenticate({ client, initialized, signal }) {
      const methodId = 'oauth-personal'
      if (!initialized.authMethods?.some(method => method.id === methodId && (!method.type || method.type === 'agent'))) {
        throw new Error('此组件未提供 Google 个人账号登录。')
      }
      await client.request('authenticate', { methodId }, 300_000, signal)
    },
    async logout({ client, initialized, signal }) {
      if (!initialized.agentCapabilities?.auth?.logout) {
        throw new Error('此组件未提供 ACP 注销。可在 Google 账号的第三方连接管理中撤销授权。')
      }
      await client.request('logout', {}, undefined, signal)
    },
    configureSession({ client, session, config, signal }) {
      return applySessionOptions(client, session, config, signal)
    },
  }
}
