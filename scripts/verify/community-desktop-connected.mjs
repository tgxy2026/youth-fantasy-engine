// 真实 Electron、临时资料区、本地服务及一次性测试账号；不访问生产数据。
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { createServer } from 'vite'
import { _electron } from 'playwright'

const root = process.cwd()
const run = await mkdtemp(path.resolve('.workbuddy/tmp/community-desktop-connected-'))
const profile = path.join(run, 'profile'), appData = path.join(run, 'appdata'), data = path.join(run, 'data'), key = path.join(run, 'key')
for (const dir of [profile, appData, data]) await mkdir(dir)
await writeFile(key, randomBytes(32))
await writeFile(path.join(run, 'package.json'), JSON.stringify({ name: 'yfe-isolated-test', version: '1.0.0', main: 'bootstrap.cjs' }))
await writeFile(path.join(run, 'bootstrap.cjs'), `const {app}=require('electron');app.setPath('appData',${JSON.stringify(appData)});require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});`)
const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data, YFE_REGISTER: 'open', YFE_SCHEDULER: 'off', YFE_CLOUD_BASE: base, YFE_COMMUNITY_ANON_KEY_FILE: key }
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete env[k]
const backend = spawn(process.execPath, ['server/index.mjs'], { env, windowsHide: true, stdio: 'ignore' })
let vite, electron
try {
  let ready = false
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/ping`)).ok) { ready = true; break } } catch {} await new Promise((r) => setTimeout(r, 100)) }
  if (!ready) throw new Error('隔离服务未启动')
  const registration = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'desktop-test-352', password: 'Desktop352-test!' }) })
  if (!registration.ok) throw new Error('隔离账号注册失败')
  vite = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
  await vite.listen()
  electron = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [run, '--no-sandbox', '--no-proxy-server', `--user-data-dir=${profile}`], env: { ...env, ELECTRON_START_URL: `http://127.0.0.1:${vite.httpServer.address().port}` } })
  const page = await electron.firstWindow()
  page.setDefaultTimeout(15000)
  const paths = await electron.evaluate(({ app }) => ({ appData: app.getPath('appData'), userData: app.getPath('userData') }))
  if (path.resolve(paths.appData) !== appData || path.resolve(paths.userData) !== profile) throw new Error('桌面资料区未隔离')
  await page.getByRole('button', { name: '跳过，直接进入项目管理' }).click()
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  await page.getByRole('button', { name: '投稿广场', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '投稿广场' })
  await dialog.getByRole('button', { name: '登录云端账号' }).click()
  await page.getByPlaceholder('用户名').fill('desktop-test-352')
  await page.getByPlaceholder('密码', { exact: true }).fill('Desktop352-test!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await dialog.getByRole('button', { name: '设置', exact: true }).click()
  await dialog.getByLabel('昵称', { exact: true }).fill('桌面青灯')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await dialog.getByText('昵称已更新', { exact: false }).waitFor()
  if (!(await dialog.getByRole('button', { name: '修改', exact: true }).isDisabled())) throw new Error('桌面昵称冷却未生效')
  await dialog.getByText('7 天内不能再次修改', { exact: false }).waitFor()
  await page.screenshot({ path: path.join(run, 'desktop-connected.png') })
  console.log(`PASS 桌面实际登录、广场设置和昵称冷却：${run}`)
} finally {
  await electron?.close()
  await vite?.close()
  backend.kill()
}
