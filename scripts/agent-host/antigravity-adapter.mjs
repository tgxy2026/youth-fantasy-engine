import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAntigravityComponent } from './antigravity-component.mjs'
import { launchWindowsAcpJob, verifyWindowsJobGone } from './acp-job.mjs'
import { applySessionOptions } from './acp-options.mjs'
import { createModeFilePersistence } from './mode-file.mjs'
import { parseAuthUrl } from './acp-auth-line.mjs'

// Pin the component independently of the ACP wire protocol. Release enablement depends
// on validating the official OAuth flow and the Windows file-access boundary.
export function createAntigravityAdapter({ root, validationEnabled = false, openExternal }) {
  const component = createAntigravityComponent(path.join(root, 'components', 'antigravity'))
  const adapter = {
    id: 'antigravity', name: 'Antigravity', component,
    verifyRun: verifyWindowsJobGone,
  }
  if (!validationEnabled) return adapter

  return {
    ...adapter,
    requiresConnection: true,
    async prepareLaunch({ config, profile, cwd, purpose }) {
      const binary = await component.resolve(config.binary)
      const roaming = path.join(profile, 'AppData', 'Roaming')
      const local = path.join(profile, 'AppData', 'Local')
      for (const directory of [roaming, local]) await fs.mkdir(directory, { recursive: true })
      const authSettings = createModeFilePersistence(path.join(profile, 'antigravity-acp', 'settings.json'))
      if (purpose === 'login') await authSettings.write({ auth: { type: 'oauth-personal' } })
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const env = {
        SystemRoot: systemRoot, WINDIR: systemRoot,
        PATH: path.join(systemRoot, 'System32'),
        USERPROFILE: profile, HOME: profile, APPDATA: roaming, LOCALAPPDATA: local,
        GEMINI_HOME: profile, AGY_ACP_FORCE_FILE_STORAGE: '1',
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
      // The vendor executable unpacks long internal names under TEMP during startup.
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'yfe-acp-'))
      env.TEMP = temp
      env.TMP = temp
      return {
        binary, env, oauth,
        cleanup: () => fs.rm(temp, { recursive: true, force: true, maxRetries: 3 }),
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
