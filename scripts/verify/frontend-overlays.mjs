// UX12 combination checks. The fixture passes options explicitly and never opens an author library.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-overlays-'))
const fingerprint = snapshot(root).fingerprint
const fixtureHash = async () => {
  const hash = createHash('sha256')
  for (const file of ['overlays.html', 'overlays.tsx']) hash.update(await fs.readFile(path.join(root, 'tests/browser', file)))
  return hash.digest('hex')
}
const fixtureFingerprint = await fixtureHash()
const report = { at: new Date().toISOString(), kind: 'frontend-overlays', fingerprint, fixtureFingerprint, run, checks: [], errors: [], status: 'running' }
let server, browser, page
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  await fetch(origin)
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  page = await context.newPage()
  page.setDefaultTimeout(120000)
  page.on('pageerror', e => report.errors.push(e.message))
  const url = origin + '/tests/browser/overlays.html'
  await page.goto(url, { waitUntil: 'commit' })
  await page.evaluate(() => { document.body.style.overflow = 'clip'; document.getElementById('fixture-root').setAttribute('aria-hidden', 'false') })
  await page.getByRole('button', { name: '打开父弹窗', exact: true }).click()
  page.setDefaultTimeout(15000)
  const parent = page.getByRole('dialog', { name: '父弹窗', exact: true, includeHidden: true })
  await parent.getByRole('button', { name: '甲', exact: true }).click()
  const search = page.getByPlaceholder('搜索选项…', { exact: true })
  await search.waitFor()
  await search.focus()
  await search.press('Tab')
  check('Tab from dropdown search stays with dropdown options', await page.getByRole('button', { name: '甲', exact: true }).last().evaluate(el => el === document.activeElement))
  await page.keyboard.press('Escape')
  check('Escape closes dropdown only', await parent.isVisible() && !await search.isVisible())
  check('Escape returns focus to dropdown trigger', await parent.getByRole('button', { name: '甲', exact: true }).evaluate(el => el === document.activeElement))
  await parent.getByRole('button', { name: '甲', exact: true }).click()
  await search.waitFor()
  await parent.getByRole('textbox', { name: '父弹窗输入', exact: true }).click()
  await search.waitFor({ state: 'hidden' })
  check('clicking elsewhere in dialog closes popup and keeps input focus', await parent.getByRole('textbox', { name: '父弹窗输入', exact: true }).evaluate(el => el === document.activeElement))
  await parent.getByRole('button', { name: '选择日期', exact: true }).click()
  await parent.getByRole('button', { name: '清除日期', exact: true }).waitFor()
  check('calendar popup belongs to the dialog DOM', await parent.getByRole('button', { name: '清除日期', exact: true }).isVisible())
  await page.keyboard.press('Escape')
  check('Escape closes calendar without closing parent', await parent.isVisible() && !await page.getByRole('button', { name: '清除日期', exact: true }).isVisible())
  await parent.getByRole('button', { name: '浮层帮助', exact: true }).click()
  await parent.getByRole('button', { name: '从帮助打开子弹窗', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  check('Escape closes help only', await parent.isVisible() && !await page.getByRole('button', { name: '从帮助打开子弹窗', exact: true }).isVisible())
  for (const [trigger, popup] of [['测试历', '测试历 (365)'], ['选择角色', null], ['选择宗门', '宗门甲']]) {
    await parent.getByRole('button', { name: trigger, exact: true }).click()
    const content = popup ? parent.getByRole('button', { name: popup, exact: true }) : parent.getByPlaceholder('搜索角色…')
    await content.waitFor()
    check(`${trigger} popup belongs to parent`, await content.isVisible())
    await page.keyboard.press('Escape')
    check(`${trigger} Escape returns focus`, await parent.getByRole('button', { name: trigger, exact: true }).evaluate(el => el === document.activeElement) && await parent.isVisible())
  }
  await parent.getByRole('button', { name: '丙', exact: true }).click()
  await parent.getByRole('button', { name: '添加新值…', exact: false }).click()
  const draft = parent.getByPlaceholder('输入新选项')
  await draft.fill('未提交选项')
  await draft.press('Escape')
  check('inline edit consumes first Escape without closing popup', await parent.getByPlaceholder('搜索选项…').isVisible() && !await draft.isVisible())
  await page.keyboard.press('Escape')
  await parent.getByRole('button', { name: '打开独立确认', exact: true }).click()
  const independent = page.getByRole('dialog', { name: '独立确认', exact: true })
  await independent.waitFor()
  check('independent React root isolates parent from accessibility tree', await page.getByRole('dialog', { name: '父弹窗', exact: true }).count() === 0 && await page.locator('[role="dialog"]').count() >= 2)
  await page.keyboard.press('Escape')
  check('independent confirmation closes alone and restores focus', await parent.isVisible() && await parent.getByRole('button', { name: '打开独立确认', exact: true }).evaluate(el => el === document.activeElement))
  await parent.getByRole('button', { name: '打开子弹窗', exact: true }).click()
  const child = page.getByRole('dialog', { name: '子弹窗', exact: true })
  await child.waitFor()
  await page.keyboard.press('Escape')
  check('nested Escape closes one dialog', await parent.isVisible() && !await child.isVisible())
  await parent.getByRole('button', { name: '打开禁止Esc的子弹窗', exact: true }).click()
  await child.waitFor()
  await page.keyboard.press('Escape')
  check('non-dismissible child protects parent from Escape', await parent.isVisible() && await child.isVisible())
  await child.getByRole('button', { name: '关闭', exact: true }).click()
  await parent.getByRole('button', { name: '甲', exact: true }).click()
  await search.waitFor()
  await search.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })))
  check('composing Escape does not dismiss overlays', await parent.isVisible() && await search.isVisible())
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '打开隐藏标题弹窗', exact: true }).click()
  check('hidden-header dialog has a resolvable accessible name', await page.getByRole('dialog', { name: '隐藏标题检索', exact: true }).isVisible())
  await page.keyboard.press('Escape')
  check('body lock restores previous overflow after all dialogs close', await page.evaluate(() => document.body.style.overflow === 'clip'))
  await page.getByRole('button', { name: '页面帮助', exact: true }).click()
  await page.getByRole('button', { name: '从页面帮助打开父弹窗', exact: true }).click()
  await parent.waitFor()
  check('page popup is below and inert behind new modal', await page.locator('[data-ui-popup-root]').evaluate(el => el.inert && Number(getComputedStyle(el).zIndex) < 2000))
  await page.keyboard.press('Escape')
  check('page popup becomes accessible when modal closes', await page.getByRole('button', { name: '从页面帮助打开父弹窗', exact: true }).isVisible())
  await page.keyboard.press('Escape')
  check('background isolation restores original attributes', await page.locator('#fixture-root').evaluate(el => !el.inert && el.getAttribute('aria-hidden') === 'false'))
  for (const zoom of [100, 125, 160]) {
    await page.setViewportSize({ width: 1000, height: 640 })
    await page.evaluate(async value => (await import('/src/lib/settings/theme.ts')).applyZoom(value, { manual: true }), zoom)
    await page.getByRole('button', { name: '打开父弹窗', exact: true }).click()
    await parent.getByRole('button', { name: '甲', exact: true }).click()
    await search.waitFor()
    const rect = await search.boundingBox()
    check(`popup position is in viewport at ${zoom}%`, rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 1001 && rect.y + rect.height <= 641, rect)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  }
  await page.goto(url + '?nested=1', { waitUntil: 'commit' })
  await page.getByRole('dialog', { name: '子弹窗', exact: true }).waitFor()
  await page.keyboard.press('Tab')
  check('simultaneously mounted child owns focus', await page.getByRole('dialog', { name: '子弹窗', exact: true }).evaluate(el => el.contains(document.activeElement)))
  await page.keyboard.press('Escape')
  check('simultaneous child closes before its parent', await page.getByRole('dialog', { name: '父弹窗', exact: true }).isVisible() && !await page.getByRole('dialog', { name: '子弹窗', exact: true }).isVisible())
  check('no browser errors', report.errors.length === 0, report.errors)
  await page.screenshot({ path: path.join(run, 'final.png'), animations: 'disabled' })
  report.status = 'passed'
} catch (e) {
  report.status = 'failed'
  report.error = e.stack || String(e)
  await page?.screenshot({ path: path.join(run, 'failure.png'), animations: 'disabled' }).catch(() => {})
} finally {
  await browser?.close()
  await server?.close()
  report.stale = fingerprint !== snapshot(root).fingerprint || fixtureFingerprint !== await fixtureHash()
  if (report.stale) report.status = 'failed'
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, run, checks: report.checks.length, passed: report.checks.filter(c => c.passed).length, error: report.error, stale: report.stale }))
  if (report.status !== 'passed') process.exitCode = 1
}
