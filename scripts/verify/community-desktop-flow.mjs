// Isolated Electron profile, appData, local server and current Vite source.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { createServer } from 'vite'
import { _electron } from 'playwright'

const root = process.cwd()
const run = await mkdtemp(path.resolve('.workbuddy/tmp/community-desktop-flow-'))
const profile = path.join(run, 'profile'), appData = path.join(run, 'appdata'), data = path.join(run, 'data')
for (const dir of [profile, appData, data]) await mkdir(dir)
await writeFile(path.join(run, 'package.json'), JSON.stringify({ name: 'yfe-isolated-test', version: '1.0.0', main: 'bootstrap.cjs' }))
await writeFile(path.join(run, 'bootstrap.cjs'), `const {app}=require('electron');app.setPath('appData',${JSON.stringify(appData)});require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});`)
const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data, YFE_REGISTER: 'open', YFE_SCHEDULER: 'off', YFE_CLOUD_BASE: base }
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete env[key]
const backend = spawn(process.execPath, ['server/index.mjs'], { env, windowsHide: true, stdio: 'ignore' })
let vite, electron
try {
  let ready = false
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/ping`)).ok) { ready = true; break } } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!ready) throw new Error('隔离服务未启动')
  vite = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
  await vite.listen()
  const url = `http://127.0.0.1:${vite.httpServer.address().port}`
  electron = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [run, '--no-sandbox', '--no-proxy-server', `--user-data-dir=${profile}`], env: { ...env, ELECTRON_START_URL: url } })
  const page = await electron.firstWindow()
  page.setDefaultTimeout(15000)
  const actualPaths = await electron.evaluate(({ app }) => ({ appData: app.getPath('appData'), userData: app.getPath('userData') }))
  if (path.resolve(actualPaths.appData) !== appData || path.resolve(actualPaths.userData) !== profile) throw new Error('桌面测试资料区未隔离')
  await page.getByRole('button', { name: '跳过，直接进入项目管理' }).click()
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  await page.getByRole('button', { name: '投稿广场', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '投稿广场' })
  await dialog.waitFor()
  await dialog.getByText('广场需要连接云端账号', { exact: false }).waitFor()
  await dialog.getByRole('button', { name: '登录云端账号' }).waitFor()
  if (await dialog.getByLabel('写评论').count()) throw new Error('未连接时出现评论输入')
  await page.screenshot({ path: path.join(run, 'desktop.png') })
  console.log(`PASS 隔离桌面实际入口、未连接提示与登录入口：${run}`)
} finally {
  await electron?.close()
  await vite?.close()
  backend.kill()
}
