import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = process.cwd(), run = path.join(root, '.workbuddy/tmp', `tavern-layout-334-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await fs.mkdir(run, { recursive: true })
const report = { fingerprint: snapshot(root).fingerprint, checks: [], errors: [], status: 'running' }
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name); if (!ok) throw Error(name + ': ' + detail) }
let server, browser
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } }); await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  for (const width of [320, 375, 430, 768, 1024]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    await context.addInitScript(() => { try { localStorage.setItem('yfe-ui:guide-auto', '0') } catch { /* non-origin document */ } })
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    const page = await context.newPage(); page.on('pageerror', e => report.errors.push(`${width}: ${e.message}`))
    await page.goto(origin, { waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: /先看看示例/ }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click(); await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
    await page.getByText('继续写作', { exact: true }).first().waitFor({ timeout: 90000 })
    const later = page.getByRole('button', { name: '稍后再说', exact: true }); if (await later.isVisible()) await later.click()
    const go = async name => {
      const toggle = page.getByRole('button', { name: '打开项目菜单' }); if (await toggle.isVisible()) await toggle.tap()
      await page.getByRole('navigation').getByRole('button', { name, exact: true }).first().tap(); await page.keyboard.press('Escape').catch(() => {})
    }
    const geometry = async () => page.evaluate(() => {
      const layout = document.querySelector('[data-conversation-layout]'), children = [...(layout?.children || [])].map(el => { const r = el.getBoundingClientRect(); return { tag: el.tagName, left: r.left, right: r.right, width: r.width } })
      return { viewport: innerWidth, document: document.documentElement.scrollWidth, children }
    })
    const layoutCheck = async name => {
      await page.locator('[data-conversation-layout]').waitFor({ timeout: 15000 })
      const g = await geometry()
      check(`${width}: ${name}各栏宽度可用且页面无横向溢出`, g.children.length >= 2 && g.children.every(c => c.width >= 150 && c.left >= -1 && c.right <= width + 1) && g.document <= width + 1, JSON.stringify(g))
    }
    await go('故事剧本'); await page.getByRole('button', { name: '＋ 新建故事', exact: true }).tap()
    const title = page.getByPlaceholder('例：云州江湖'); await title.waitFor(); await title.fill(`隔离故事${width}`)
    await layoutCheck('故事剧本')
    await page.getByRole('button', { name: '保存', exact: true }).tap()
    await go('角色卡片'); await layoutCheck('角色卡片')
    await page.getByRole('button', { name: '新建角色卡', exact: true }).tap()
    const dialog = page.getByRole('dialog'); await dialog.waitFor(); await dialog.getByRole('button', { name: '创建角色卡', exact: true }).tap()
    const cardName = page.getByPlaceholder('角色名')
    await cardName.waitFor({ timeout: 15000 }); await cardName.fill(`隔离角色${width}`)
    await page.keyboard.press('Control+s')
    check(`${width}: 角色卡可创建并编辑`, await cardName.inputValue() === `隔离角色${width}`)
    await go('跑团互动'); await layoutCheck('跑团互动')
    await page.getByPlaceholder('这一局的名字').fill(`隔离跑团${width}`)
    await page.getByRole('button', { name: '＋ 新建一局', exact: true }).tap()
    await page.getByText(`隔离跑团${width}`, { exact: true }).first().waitFor({ timeout: 15000 })
    check(`${width}: 可创建隔离跑团`, await page.getByText(`隔离跑团${width}`, { exact: true }).count() > 0)
    if (width === 375) await page.screenshot({ path: path.join(run, 'run-375.png') })
    await go('故事剧本')
    await page.getByRole('button', { name: new RegExp(`隔离故事${width}`) }).first().tap()
    await page.getByPlaceholder('例：云州江湖').waitFor()
    check(`${width}: 故事离页返回后回读`, await page.getByPlaceholder('例：云州江湖').inputValue() === `隔离故事${width}`)
    await go('角色卡片')
    await page.getByRole('button', { name: new RegExp(`隔离角色${width}`) }).first().tap()
    await page.getByPlaceholder('角色名').waitFor()
    check(`${width}: 角色卡离页返回后回读`, await page.getByPlaceholder('角色名').inputValue() === `隔离角色${width}`)
    await context.close()
  }
  check('无页面脚本错误', report.errors.length === 0, report.errors.join('; ')); report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = String(error?.stack || error); process.exitCode = 1 }
finally { await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ run, ...report })); await browser?.close(); await server?.close() }
