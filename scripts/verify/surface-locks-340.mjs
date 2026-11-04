// 3.4.0 · 同源写锁在桌面 / 便携运行面的可用性
//
// 用法：
//   node scripts/verify/surface-locks-340.mjs --surface=web
//   node scripts/verify/surface-locks-340.mjs --surface=desktop   # Electron 开发态 + 文件后端
//   node scripts/verify/surface-locks-340.mjs --surface=portable  # dist + portable-server（先 npm run build）
//
// 判据：
//   1. 该运行面 `navigator.locks.request` 可用（否则收藏集 / 导出方案 / 灵感写入会被拒）；
//   2. 真实 UI 创建收藏集成功（写入路径包在 projectSettingsLock 内）；
//   3. 刷新重进后收藏集仍在（锁内读—比—写没有破坏持久化）。
// 🔴 不覆盖「无 Web Locks 时拒写」——该路径由 settings-lock-340 在网页形态覆盖，
//    桌面 / 便携不可能出现「没有 Web Locks」，硬注入也无法代表真实环境。
import { createServer } from 'vite'
import { chromium, _electron } from 'playwright'
import { mkdtemp, mkdir, writeFile, cp } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const ROOT = process.cwd()
const arg = process.argv.find(a => a.startsWith('--surface='))?.slice('--surface='.length)
const surface = arg === 'desktop' || arg === 'portable' ? arg : 'web'
const run = await mkdtemp(path.join(ROOT, '.workbuddy/tmp/surface-locks-340-'))
let server
let portable
let browser
let app
let page
const checks = []
const check = (id, ok, detail = '') => {
  checks.push({ id, ok: !!ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok || !detail ? '' : ` :: ${detail}`))
  if (!ok) throw new Error(`${id}${detail ? ' :: ' + detail : ''}`)
}

try {
  let url
  if (surface === 'portable') {
    const appRoot = path.join(run, 'app')
    await mkdir(appRoot)
    await cp(path.join(ROOT, 'dist'), path.join(appRoot, 'dist'), { recursive: true })
    const port = 8901
    portable = spawn(process.execPath, [path.join(ROOT, 'scripts/portable-server.mjs'), '--root', appRoot, '--no-open', '--port', String(port)], { stdio: 'ignore' })
    url = `http://127.0.0.1:${port}`
    let ready = false
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (r.ok) { ready = true; break } } catch { /* 等待启动 */ }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!ready) throw new Error('便携服务没有在 30s 内就绪')
  } else {
    server = await createServer({ cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
    await server.listen()
    url = `http://127.0.0.1:${server.httpServer.address().port}`
  }

  if (surface === 'desktop') {
    const profile = path.join(run, 'profile')
    const appData = path.join(run, 'appdata')
    await mkdir(profile)
    await mkdir(appData)
    await writeFile(path.join(run, 'package.json'), JSON.stringify({ name: 'yfe-locks', version: '3.4.0', main: 'bootstrap.cjs' }))
    await writeFile(path.join(run, 'bootstrap.cjs'), `const {app}=require('electron');app.setPath('appData',${JSON.stringify(appData)});require(${JSON.stringify(path.join(ROOT, 'electron/main.cjs'))});`)
    app = await _electron.launch({
      executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
      args: [run, '--no-sandbox', '--no-proxy-server', '--user-data-dir=' + profile],
      env: { ...process.env, ELECTRON_START_URL: url },
      timeout: 90000,
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(30000)
  } else {
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  }

  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => localStorage.setItem('yfe-ui:guide-auto', '0'))
  await page.goto(url, { waitUntil: 'domcontentloaded' })

  const locks = await page.evaluate(async () => {
    if (!navigator.locks || typeof navigator.locks.request !== 'function') return { ok: false }
    let granted = false
    await navigator.locks.request('yfe-probe', async () => { granted = true })
    return { ok: granted }
  })
  check(`${surface}：navigator.locks 可用`, locks.ok)

  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  await page.getByRole('navigation').getByRole('button', { name: '写作面板', exact: true }).click()

  const openSets = async () => {
    const toggle = page.getByRole('button', { name: /章节收藏集/ })
    await toggle.waitFor({ timeout: 30000 })
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  }
  await openSets()
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await page.getByPlaceholder(/收藏集名称/).fill(`锁验证-${surface}`)
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(`锁验证-${surface}`) }).waitFor({ timeout: 15000 })
  check(`${surface}：经写锁创建收藏集成功`, true)

  // 便携后端是整库 JSON 落盘，给防抖写入留出时间；桌面 / 网页是即时写入，不需要。
  await page.waitForTimeout(3000)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-project-hub]').waitFor({ timeout: 60000 }).catch(async () => {
    console.log('DEBUG 刷新后 URL:', page.url())
    console.log('DEBUG 刷新后页面文本:', (await page.locator('body').innerText()).slice(0, 800))
    throw new Error(`${surface}：刷新后没有回到项目列表`)
  })
  const card = page.locator('[data-project-card]').filter({ hasText: '吞天神脉' })
  await card.getByLabel('打开项目').click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  await page.getByRole('navigation').getByRole('button', { name: '写作面板', exact: true }).click()
  await openSets()
  await page.getByRole('button', { name: new RegExp(`锁验证-${surface}`) }).click()
  check(`${surface}：刷新重进后收藏集仍在`, true)

  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`\nPASS ${checks.length} checks · surface-locks-340 (${surface})`)
} finally {
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  portable?.kill()
  await server?.close().catch(() => {})
}