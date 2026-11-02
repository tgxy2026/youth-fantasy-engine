import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = process.cwd()
const run = path.join(root, '.workbuddy/tmp', `plot-conversation-334-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await fs.mkdir(run, { recursive: true })
const report = { fingerprint: snapshot(root).fingerprint, checks: [], errors: [], status: 'running' }
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name); if (!ok) throw Error(name + ': ' + detail) }
let server, browser
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen(); const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  for (const width of [320, 375, 430, 768, 1024]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    await context.addInitScript(() => { try { localStorage.setItem('yfe-ui:guide-auto', '0') } catch { /* non-origin document */ } })
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    const page = await context.newPage(); page.on('pageerror', error => report.errors.push(`${width}: ${error.message}`))
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /先看看示例/ }).click(); await page.getByRole('button', { name: '下一步', exact: true }).click()
    await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
    await page.getByText('继续写作', { exact: true }).first().waitFor({ timeout: 90000 })
    const later = page.getByRole('button', { name: '稍后再说', exact: true }); if (await later.isVisible()) await later.click()
    const toggle = page.getByRole('button', { name: '打开项目菜单' }); if (await toggle.isVisible()) await toggle.tap()
    await page.getByRole('navigation').getByRole('button', { name: '剧情推演', exact: true }).tap(); await page.keyboard.press('Escape').catch(() => {})
    const layout = page.locator('[data-plot-conversation]'), list = layout.locator(':scope > aside').first()
    await list.waitFor(); const existing = list.getByRole('button').nth(1); await existing.waitFor(); await existing.tap()
    const chat = layout.locator(':scope > div').last(); const input = chat.locator('textarea').first()
    await input.waitFor({ timeout: 15000 }); await input.scrollIntoViewIfNeeded()
    const geometry = await page.evaluate(() => {
      const layout = document.querySelector('[data-plot-conversation]'), list = layout?.querySelector(':scope > aside'), chat = [...(layout?.children || [])].find(el => el.tagName === 'DIV')
      const a = list?.getBoundingClientRect(), b = chat?.getBoundingClientRect()
      return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, list: a && { left: a.left, right: a.right, width: a.width }, chat: b && { left: b.left, right: b.right, width: b.width } }
    })
    check(`${width}: 场次与对话区域不被挤窄或撑出页面`, geometry.list?.width >= 150 && geometry.chat?.width >= 150 && geometry.documentWidth <= width + 1, JSON.stringify(geometry))
    await input.fill('隔离对话草稿，不发送')
    check(`${width}: 对话输入框可编辑`, await input.inputValue() === '隔离对话草稿，不发送')
    if (width === 375) await page.screenshot({ path: path.join(run, 'plot-session-375.png') })
    await context.close()
  }
  check('无页面脚本错误', report.errors.length === 0, report.errors.join('; ')); report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = String(error?.stack || error); process.exitCode = 1 }
finally { await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ run, ...report })); await browser?.close(); await server?.close() }
