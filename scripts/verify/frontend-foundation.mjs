// Real Edge checks for the first 3.3.0 foundation slice. No author library, model, or remote endpoint.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-foundation-'))
const fingerprint = snapshot(root).fingerprint
const fixtureHash = async () => {
  const hash = createHash('sha256')
  for (const name of ['appearance.html', 'appearance.tsx']) hash.update(await fs.readFile(path.join(root, 'tests/browser', name)))
  return hash.digest('hex')
}
const fixtureFingerprint = await fixtureHash()
const report = { schemaVersion: 1, kind: 'frontend-foundation', at: new Date().toISOString(), fingerprint, run, assertions: [], errors: [], status: 'running' }
let server, browser, page
const check = (name, condition, details) => {
  report.assertions.push({ name, passed: !!condition, details })
  if (!condition) throw new Error(name + ': ' + JSON.stringify(details))
}
try {
  server = await createServer({optimizeDeps:{entries:['index.html','tests/browser/*.html']}, root, logLevel: 'error', cacheDir: path.join(run, 'vite-cache'), server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  await fetch(origin)
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  page = await context.newPage()
  page.setDefaultTimeout(120000)
  page.on('pageerror', error => report.errors.push(error.message))
  const url = origin + '/tests/browser/appearance.html'
  await page.goto(url, { waitUntil: 'commit' })
  await page.getByRole('heading', { name: '外观交互夹具' }).waitFor()
  page.setDefaultTimeout(15000)
  const density = () => page.locator('html').getAttribute('data-density')
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const geometry = () => page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(el => el.textContent === '示例主操作')
    const content = [...document.querySelectorAll('button')].find(el => el.textContent === '内容型操作')
    const text = document.querySelector('.novel-textarea')
    return { button: button.offsetHeight, content: content.offsetHeight, fontSize: getComputedStyle(text).fontSize,
      lineHeight: getComputedStyle(text).lineHeight, panelPadding: getComputedStyle(document.querySelector('[data-ui-panel]')).padding }
  })
  check('missing preference uses compact before interaction', await density() === 'compact')
  const compact = await geometry()
  await page.getByRole('button', { name: '舒适', exact: true }).first().click()
  await frame()
  const comfortable = await geometry()
  check('both mounted controls synchronize', await page.getByRole('button', { name: '舒适', exact: true, pressed: true }).count() === 2)
  check('comfortable control is larger', comfortable.button > compact.button, { compact, comfortable })
  check('manuscript and content-sized controls unchanged', compact.fontSize === comfortable.fontSize && compact.lineHeight === comfortable.lineHeight && compact.content === comfortable.content, { compact, comfortable })
  check('preference is actually persisted', await page.evaluate(() => localStorage.getItem('yfe-ui:density')) === 'comfortable')
  await page.evaluate(() => {
    window.__originalSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function () { throw new DOMException('Test storage full', 'QuotaExceededError') }
  })
  await page.getByRole('button', { name: '紧凑', exact: true }).first().click()
  check('failed persistence still updates both mounted controls', await page.getByRole('button', { name: '紧凑', exact: true, pressed: true }).count() === 2)
  check('failed write does not pretend storage changed', await page.evaluate(() => localStorage.getItem('yfe-ui:density')) === 'comfortable')
  await page.getByRole('button', { name: '暂时关闭第二组设置' }).click()
  await page.getByRole('button', { name: '重新打开第二组设置' }).click()
  check('session preference survives component remount when storage fails', await page.getByRole('button', { name: '紧凑', exact: true, pressed: true }).count() === 2)
  await page.evaluate(() => { Storage.prototype.setItem = window.__originalSetItem; delete window.__originalSetItem })
  await page.reload({ waitUntil: 'commit' })
  await page.getByRole('heading', { name: '外观交互夹具' }).waitFor()
  check('reload restores only the successfully persisted value', await density() === 'comfortable')
  const other = await context.newPage()
  await other.goto(url, { waitUntil: 'commit' })
  await other.getByRole('button', { name: '紧凑', exact: true }).first().click()
  await page.waitForFunction(() => document.documentElement.dataset.density === 'compact')
  check('storage event synchronizes a second window', await page.getByRole('button', { name: '紧凑', exact: true, pressed: true }).count() === 2)
  await other.close()
  const scroll = page.locator('[data-fixture-scroll]')
  await scroll.evaluate(el => { el.scrollTop = 2000 })
  await frame()
  const visibleRow = () => scroll.evaluate(el => [...el.querySelectorAll('[data-fixture-row]')].find(row => row.getBoundingClientRect().bottom > el.getBoundingClientRect().top + 2)?.dataset.fixtureRow)
  const before = await visibleRow()
  const count = await page.locator('[data-fixture-row]').count()
  await page.getByRole('button', { name: '舒适', exact: true }).first().click()
  await frame()
  check('virtual table keeps a bounded row window', count < 50 && await page.locator('[data-fixture-row]').count() < 50, { count })
  check('density remeasurement retains logical scroll row', before === await visibleRow(), { before, after: await visibleRow() })
  await page.screenshot({ path: path.join(run, 'comfortable.png'), animations: 'disabled' })
  const themes = await page.evaluate(async () => (await import('/src/lib/settings/theme.ts')).THEMES.filter(t => t.id !== 'custom').map(t => t.id))
  for (const theme of themes) {
    const color = await page.evaluate(async id => {
      const { applyTheme } = await import('/src/lib/settings/theme.ts')
      applyTheme(id)
      const heading = document.querySelector('[data-page-header] h1')
      const expected = document.createElement('span')
      expected.style.color = 'rgb(var(--ink-100))'
      document.body.appendChild(expected)
      const result = { actual: getComputedStyle(heading).color, expected: getComputedStyle(expected).color }
      expected.remove()
      return result
    }, theme)
    check('semantic heading follows ' + theme, color.actual === color.expected, color)
  }
  // Also verify the two real application entry points, not just the isolated component fixture.
  page.setDefaultTimeout(120000)
  await page.goto(origin, { waitUntil: 'commit' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.locator('nav').waitFor()
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  await later.click()
  await page.getByRole('navigation').waitFor()
  page.setDefaultTimeout(15000)
  await page.getByRole('button', { name: '展开外观设置', exact: true }).click()
  await page.getByRole('button', { name: '紧凑', exact: true }).click()
  check('project sidebar changes application density', await density() === 'compact')
  await page.getByRole('navigation').getByText('正文编辑', { exact: true }).click()
  const editor = page.locator('textarea.novel-textarea')
  await editor.waitFor()
  const manuscript = await editor.inputValue()
  const editorStyle = await editor.evaluate(el => ({ fontSize: getComputedStyle(el).fontSize, lineHeight: getComputedStyle(el).lineHeight }))
  await page.getByRole('button', { name: '舒适', exact: true }).click()
  await frame()
  const nextStyle = await editor.evaluate(el => ({ fontSize: getComputedStyle(el).fontSize, lineHeight: getComputedStyle(el).lineHeight }))
  check('real editor manuscript survives density change', await editor.inputValue() === manuscript)
  check('real editor typography is independent', JSON.stringify(editorStyle) === JSON.stringify(nextStyle), { editorStyle, nextStyle })
  await page.screenshot({ path: path.join(run, 'editor-comfortable.png'), animations: 'disabled' })
  await page.getByRole('button', { name: '切换项目', exact: true }).click()
  await page.getByRole('group', { name: '界面密度', exact: true }).waitFor()
  check('project hub retains density selection', await page.getByRole('button', { name: '舒适', exact: true, pressed: true }).count() === 1)
  await page.getByRole('button', { name: '紧凑', exact: true }).click()
  check('project hub data dock changes density', await density() === 'compact')
  check('no browser errors', report.errors.length === 0, report.errors)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.stack || String(error)
  await page?.screenshot({ path: path.join(run, 'failure.png'), animations: 'disabled' }).catch(() => {})
} finally {
  await browser?.close()
  await server?.close()
  report.fixtureFingerprint = fixtureFingerprint
  report.stale = fingerprint !== snapshot(root).fingerprint || fixtureFingerprint !== await fixtureHash()
  if (report.stale) report.status = 'failed'
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, run, passed: report.assertions.filter(a => a.passed).length, error: report.error, stale: report.stale }))
  if (report.status !== 'passed') process.exitCode = 1
}
