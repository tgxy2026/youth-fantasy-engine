// 3.3.0 UX00: reproducible inventory and visual baseline in a fresh browser context.
// Reads synthetic demo data only; builds into a new evidence directory, never dist/release.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { build, createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-baseline-'))
const fingerprint = snapshot(root).fingerprint
const report = { schemaVersion: 1, kind: 'frontend-baseline', at: new Date().toISOString(), fingerprint, run, status: 'running', errors: [], blockedRequests: [] }
let browser, server, page
try {
  report.head = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim()
  report.packageVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version
  await build({ root, logLevel: 'error', cacheDir: path.join(run, 'build-cache'), build: { outDir: path.join(run, 'build'), emptyOutDir: false } })
  const assets = []
  async function inventoryAssets(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await inventoryAssets(file)
      else {
        const bytes = await fs.readFile(file)
        assets.push({ file: path.relative(path.join(run, 'build'), file).replaceAll('\\', '/'), bytes: bytes.length,
          gzipBytes: /\.(?:js|css)$/.test(file) ? gzipSync(bytes).length : undefined,
          sha256: createHash('sha256').update(bytes).digest('hex') })
      }
    }
  }
  await inventoryAssets(path.join(run, 'build'))
  await fs.writeFile(path.join(run, 'assets.json'), JSON.stringify(assets, null, 2))
  console.log('Production assets recorded')
  report.assets = { count: assets.length, jsGzipBytes: assets.filter(a => a.file.endsWith('.js')).reduce((n, a) => n + a.gzipBytes, 0),
    cssGzipBytes: assets.filter(a => a.file.endsWith('.css')).reduce((n, a) => n + a.gzipBytes, 0) }
  // All-chunk totals are informational, not a claim about startup bytes or performance.
  server = await createServer({ root, logLevel: 'error', cacheDir: path.join(run, 'vite-cache'), server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  await fetch(origin)
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 })
  await context.route('**/*', route => {
    const url = route.request().url()
    if (url.startsWith(origin + '/') || /^(data|blob):/.test(url)) return route.continue()
    report.blockedRequests.push(new URL(url).origin)
    return route.abort()
  })
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('frontend-baseline-initialized')) {
      localStorage.setItem('yfe-theme', 'eye-care')
      localStorage.setItem('yfe-ui-zoom', '100')
      localStorage.setItem('yfe-ui-zoom-manual', '1')
      sessionStorage.setItem('frontend-baseline-initialized', '1')
    }
  })
  page = await context.newPage()
  page.setDefaultTimeout(120000)
  page.on('pageerror', e => report.errors.push(e.message))
  await page.goto(origin, { waitUntil: 'commit', timeout: 120000 })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.locator('nav').waitFor()
  console.log('Isolated demo ready')
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  await later.click()
  await page.getByRole('navigation').waitFor()
  const inventory = await page.evaluate(async () => {
    const schema = await import('/src/lib/schema.ts')
    const { THEMES } = await import('/src/lib/settings/theme.ts')
    const pages = [schema.EDITOR_TAB, ...schema.TABS, ...schema.getVolumeTabs()]
    return { pages: [...new Map(pages.map(t => [t.id, { id: t.id, name: t.name, group: t.group, type: t.type,
      full: schema.tabVisible(t.id, { type: 'full', features: [] }), customLocked: schema.tabVisible(t.id, { type: 'custom', features: [] }) }])).values()],
      themes: THEMES.map(t => ({ id: t.id, name: t.name })), groups: schema.GROUPS,
      specialSurfaces: ['project-hub', 'welcome', 'migration', 'boot-loading', 'boot-error', 'render-error', 'module-error', 'login', 'register', 'reset-password', 'guest-banner', 'mobile-hint', 'tab-guard'],
      preferences: Object.keys(localStorage).filter(k => /^(yfe-|novel-)/.test(k)).sort() }
  })
  await fs.writeFile(path.join(run, 'inventory.json'), JSON.stringify(inventory, null, 2))
  report.inventory = { pages: inventory.pages.length, full: inventory.pages.filter(p => p.full).length, themes: inventory.themes.length, specialSurfaces: inventory.specialSurfaces.length }
  report.samples = []
  for (const tab of ['dashboard', 'editor', 'char-main']) {
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('yfe:navigate', { detail: id })), tab)
    await page.getByText('加载中…', { exact: true }).waitFor({ state: 'hidden' })
    if (tab !== 'editor') await page.getByRole('heading', { name: tab === 'dashboard' ? '写作面板' : '主要角色', exact: true }).waitFor()
    else await page.locator('main').getByText('章节', { exact: true }).first().waitFor()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const screenshot = `${tab}.png`
    await page.screenshot({ path: path.join(run, screenshot), animations: 'disabled' })
    report.samples.push({ tab, screenshot, measurement: await page.locator('main').evaluate(el => ({ width: el.clientWidth, height: el.clientHeight, scrollWidth: el.scrollWidth, buttons: el.querySelectorAll('button').length })) })
  }
  report.environment = { browser: browser.version(), viewport: { width: 1366, height: 768 }, uiZoom: 100, theme: 'eye-care', fixture: 'isolated-demo', buildMode: 'production', screenshotsMode: 'development' }
  report.status = report.errors.length ? 'failed' : 'baseline-recorded'
} catch (e) {
  report.status = 'failed'
  report.error = e.stack || String(e)
  await page?.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {})
} finally {
  await browser?.close()
  await server?.close()
  report.stale = fingerprint !== snapshot(root).fingerprint
  if (report.stale) report.status = 'failed'
  report.blockedRequests = [...new Set(report.blockedRequests)]
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, run, inventory: report.inventory, error: report.error, stale: report.stale }))
  if (report.status !== 'baseline-recorded') process.exitCode = 1
}
