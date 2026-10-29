// Real editor in an isolated sample project; all nonlocal and model requests are blocked.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-editor-toolbar-')), fingerprint = snapshot(root).fingerprint
const report = { run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
let server, browser, page
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw Error(name + ': ' + JSON.stringify(details))
}
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', optimizeDeps: { entries: ['index.html'] },
    server: { host: 'localhost', port: 0, watch: { ignored: ['**/.workbuddy/**', '**/release/**', '**/dist/**'] } } })
  await server.listen(); const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => {
    const url = route.request().url()
    if (/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) { report.modelRequests.push('blocked'); return route.abort() }
    return url.startsWith(origin + '/') ? route.continue() : route.abort()
  })
  page = await context.newPage(); page.setDefaultTimeout(120000); page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(origin, { waitUntil: 'commit' }); await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click(); await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  const nav = page.getByRole('navigation')
  for (let attempt = 0; attempt < 100; attempt++) {
    const later = page.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.isVisible()) await later.click()
    if (await nav.isVisible()) break
    await page.waitForTimeout(100)
  }
  await nav.waitFor(); await nav.getByText('正文编辑', { exact: true }).click()
  const editor = page.locator('textarea.novel-textarea'), toolbar = page.locator('[data-editor-toolbar]')
  await editor.waitFor(); page.setDefaultTimeout(20000)
  const original = await editor.inputValue()
  const status = toolbar.getByRole('combobox', { name: '章节状态', exact: true }), save = toolbar.getByRole('button', { name: '保存正文', exact: true })
  for (const density of ['compact', 'comfortable']) for (const width of [1366, 1000]) for (const zoom of [100, 125, 160]) {
    await page.setViewportSize({ width, height: 800 })
    await page.evaluate(async ({ density, zoom }) => {
      ;(await import('/src/lib/settings/density.ts')).applyDensity(density)
      ;(await import('/src/lib/settings/theme.ts')).applyZoom(zoom, { manual: true })
    }, { density, zoom })
    const sizes = { status: await status.boundingBox(), save: await save.boundingBox() }
    check(`${density} ${width}px zoom ${zoom}: chapter status and save have matching height`, sizes.status && sizes.save && Math.abs(sizes.status.height - sizes.save.height) < 1, sizes)
  }
  await page.setViewportSize({ width: 1366, height: 900 })
  await page.evaluate(async () => { (await import('/src/lib/settings/density.ts')).applyDensity('comfortable'); (await import('/src/lib/settings/theme.ts')).applyZoom(100, { manual: true }) })
  check('companion no longer occupies a separate button in the editor toolbar', await toolbar.getByRole('button', { name: /AI 伴写/ }).count() === 0)
  const tools = toolbar.getByRole('button', { name: '编辑工具', exact: true })
  await tools.click()
  const menu = page.getByRole('group', { name: '编辑工具选项', exact: true }), companion = menu.locator('[data-editor-companion]')
  await companion.waitFor()
  const grouped = await companion.evaluate(el => el.parentElement?.querySelector(':scope > h3')?.textContent === '辅助创作')
  check('companion is grouped under the peer heading 辅助创作', grouped && await menu.getByRole('heading', { name: '整理与检查', exact: true }).count() === 1 && await menu.getByRole('heading', { name: '版本与检索', exact: true }).count() === 1)
  const companionSummary = companion.locator(':scope > summary')
  check('companion appears inside the tools disclosure', await companionSummary.isVisible() && (await companionSummary.innerText()).includes('AI 伴写'))
  await companionSummary.click()
  const lengths = companion.locator('button[title^="不超过"]')
  check('expanding companion reveals its existing settings', await lengths.count() === 3 && await lengths.first().isVisible())
  await lengths.nth(2).click()
  check('companion setting remains operable and is actually stored', await page.evaluate(() => localStorage.getItem('novel-companion-len')) === 'two' && await lengths.nth(2).getAttribute('aria-pressed') === 'true')
  check('opening settings leaves the manuscript unchanged', await editor.inputValue() === original)
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' })
  check('Escape closes the tools disclosure and restores its trigger focus', await tools.evaluate(el => el === document.activeElement))
  await tools.click(); await companionSummary.click()
  check('reopening preserves the selected companion setting', await lengths.nth(2).getAttribute('aria-pressed') === 'true')
  check('no actual model requests or unexpected browser errors', !report.modelRequests.length && !report.errors.length, { models: report.modelRequests, errors: report.errors })
  await page.screenshot({ path: path.join(run, 'editor-tools.png'), animations: 'disabled' }); report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); await page?.screenshot({ path: path.join(run, 'failure.png'), animations: 'disabled' }).catch(() => {}) }
finally {
  report.stale = fingerprint !== snapshot(root).fingerprint; if (report.stale) report.status = 'failed'
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close()
  console.log(JSON.stringify({ run, status: report.status, passed: report.checks.filter(c => c.passed).length, total: report.checks.length, stale: report.stale, failure: report.failure })); if (report.status !== 'passed') process.exitCode = 1
}
