import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = process.cwd()
const run = path.join(root, '.workbuddy/tmp', `browser-capabilities-334-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await fs.mkdir(run, { recursive: true })
const report = { fingerprint: snapshot(root).fingerprint, checks: [], errors: [], status: 'running' }
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); if (!ok) throw new Error(name + ': ' + detail); console.log('PASS', name) }
let server, browser
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage()
  page.on('pageerror', e => report.errors.push(e.message))
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByText('继续写作', { exact: true }).first().waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible()) await later.click()
  const guide = page.locator('[data-guide-card]').first()
  if (await guide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) await page.getByRole('button', { name: '跳过本页' }).click()
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })
  await page.getByText('继续写作', { exact: true }).first().click()
  const editor = page.locator('textarea.novel-textarea')
  await editor.waitFor()
  const original = await editor.inputValue()
  const draft = `${original}\n全屏隔离测试草稿。`
  await editor.fill(draft)
  await editor.evaluate(el => { window.__fullscreenEditor = el; el.focus(); el.setSelectionRange(3, 8, 'forward') })
  const tools = page.locator('[data-sidebar-tools]')
  if (!await tools.isVisible()) await page.getByRole('button', { name: '展开左下角工具栏' }).click()
  const appearance = page.getByRole('button', { name: '展开外观设置' })
  if (await appearance.isVisible()) await appearance.click()
  await page.getByTitle('进入浏览器全屏').click()
  await page.waitForFunction(() => document.fullscreenElement === document.documentElement)
  check('浏览器全屏使用文档根', await page.evaluate(() => document.fullscreenElement === document.documentElement))
  await page.getByTitle('退出全屏（Esc）').waitFor()
  await page.evaluate(() => document.exitFullscreen())
  await page.getByTitle('进入浏览器全屏').waitFor()
  check('外部退出后开关同步', await page.evaluate(() => document.fullscreenElement === null))
  check('全屏往返保留编辑器节点、草稿和选区', await editor.evaluate((el, value) => el === window.__fullscreenEditor && el.value === value && el.selectionStart === 3 && el.selectionEnd === 8, draft))
  await page.evaluate(() => { document.documentElement.requestFullscreen = () => Promise.reject(new Error('test denied')) })
  await page.getByTitle('进入浏览器全屏').click()
  await page.getByText(/这次全屏请求被拒绝了/).waitFor()
  check('拒绝请求后明确提示且未进入全屏', await page.evaluate(() => document.fullscreenElement === null))
  const nav = page.getByRole('navigation')
  const trajectory = nav.getByRole('button', { name: '创作轨迹', exact: true })
  if (!await trajectory.isVisible()) {
    const parent = nav.getByRole('button', { name: '正文写作', exact: true })
    if (await parent.isVisible()) await parent.click()
  }
  await trajectory.click()
  const exportButton = page.getByRole('button', { name: '导出证据包' })
  if (!await exportButton.isVisible()) await page.locator('main aside button').last().click()
  await exportButton.click()
  const printButton = page.getByRole('button', { name: /打印 \/ 另存 PDF/ })
  const popupPromise = page.waitForEvent('popup')
  await printButton.click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded')
  check('打印页写入本地证据并断开 opener', await popup.evaluate(() => document.body.innerText.trim().length > 0 && window.opener === null))
  await popup.close()
  await exportButton.click()
  await page.evaluate(() => { window.open = () => null })
  const downloadPromise = page.waitForEvent('download')
  await printButton.click()
  const download = await downloadPromise
  check('弹窗受阻后回退下载 HTML', download.suggestedFilename().toLowerCase().endsWith('.html'), download.suggestedFilename())
  check('页面无脚本错误', report.errors.length === 0, report.errors.join('; '))
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.failure = String(error?.stack || error); process.exitCode = 1
} finally {
  await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ run, ...report }))
  await browser?.close(); await server?.close()
}
