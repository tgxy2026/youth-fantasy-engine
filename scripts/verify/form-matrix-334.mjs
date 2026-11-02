// Isolated demo: edit one existing form field, save, leave, return, and read back.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = process.cwd()
const pageType = process.argv[2] || 'form'
if (!['form', 'card'].includes(pageType)) throw Error('supported page types: form, card')
const run = path.join(root, '.workbuddy/tmp', `${pageType}-matrix-334-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await fs.mkdir(run, { recursive: true })
const report = { fingerprint: snapshot(root).fingerprint, cases: [], errors: [], status: 'running' }
let server, browser
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  for (const width of [320, 375, 430]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    await context.addInitScript(() => { try { localStorage.setItem('yfe-ui:guide-auto', '0') } catch { /* non-origin document */ } })
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    const page = await context.newPage()
    page.on('pageerror', error => report.errors.push(`${width}: ${error.message}`))
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /先看看示例/ }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
    await page.getByText('继续写作', { exact: true }).first().waitFor({ timeout: 90000 })
    const later = page.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.isVisible()) await later.click()
    const tabs = await page.evaluate(async type => { const s = await import('/src/lib/schema.ts'); return s.TABS.filter(t => t.type === type && s.tabVisible(t.id, { type: 'full', features: [] })).map(t => ({ id: t.id, name: t.name })) }, pageType)
    const go = async name => {
      await page.getByRole('button', { name: '打开项目菜单' }).click({ timeout: 10000 })
      await page.getByRole('navigation').getByRole('button', { name, exact: true }).first().click({ timeout: 10000 })
      await page.keyboard.press('Escape').catch(() => {})
    }
    for (const tab of tabs) {
      const record = { width, ...tab, status: 'running' }
      report.cases.push(record)
      try {
        await go(tab.name)
        const selectParallel = async () => {
          if (!['politics', 'economy', 'belief', 'justice'].includes(tab.id)) return
          await page.locator('main button[title^="编辑「"]').first().click({ timeout: 10000 })
        }
        await selectParallel()
        const field = page.locator('main textarea:not([readonly]):not([disabled])').first()
        await field.waitFor({ timeout: 10000 })
        await field.scrollIntoViewIfNeeded()
        const value = (await field.inputValue()) + `测试${width}`
        const label = await field.getAttribute('aria-label') || await field.getAttribute('placeholder') || ''
        await field.fill(value)
        await page.keyboard.press('Control+s')
        await go('写作面板'); await go(tab.name); await selectParallel()
        const restored = page.locator('main textarea:not([readonly]):not([disabled])').first()
        await restored.waitFor({ timeout: 10000 })
        const actual = await restored.inputValue()
        if (actual !== value) throw Error(`回读不一致 expected suffix=测试${width} actual suffix=${actual.slice(-20)}`)
        record.status = 'passed'; record.field = label
        console.log('PASS', width, tab.id)
      } catch (error) {
        record.status = 'failed'; record.error = String(error?.message || error).slice(0, 600)
        console.log('FAIL', width, tab.id, record.error.slice(0, 180))
        await page.keyboard.press('Escape').catch(() => {})
      }
    }
    await context.close()
  }
  report.status = report.cases.every(c => c.status === 'passed') && report.errors.length === 0 ? 'passed' : 'failed'
  if (report.status !== 'passed') process.exitCode = 1
} catch (error) { report.status = 'failed'; report.failure = String(error?.stack || error); process.exitCode = 1 }
finally { await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ run, status: report.status, passed: report.cases.filter(c => c.status === 'passed').length, total: report.cases.length, errors: report.errors, failure: report.failure })); await browser?.close(); await server?.close() }
