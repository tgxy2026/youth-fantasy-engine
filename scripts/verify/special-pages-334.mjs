import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = process.cwd(), run = path.join(root, '.workbuddy/tmp', `special-pages-334-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await fs.mkdir(run, { recursive: true })
const report = { fingerprint: snapshot(root).fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name); if (!ok) throw Error(name + ': ' + detail) }
let server, browser
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } }); await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  for (const width of [320, 375, 430]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    await context.addInitScript(() => { try { localStorage.setItem('yfe-ui:guide-auto', '0') } catch { /* non-origin document */ } })
    await context.route('**/*', route => {
      const url = route.request().url()
      if (/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) report.modelRequests.push(url.replace(/\?.*/, ''))
      return url.startsWith(origin + '/') ? route.continue() : route.abort()
    })
    const page = await context.newPage(); page.on('pageerror', e => report.errors.push(`${width}: ${e.message}`))
    await page.goto(origin, { waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: /先看看示例/ }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click(); await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
    await page.getByText('继续写作', { exact: true }).first().waitFor({ timeout: 90000 })
    const later = page.getByRole('button', { name: '稍后再说', exact: true }); if (await later.isVisible()) await later.click()
    const go = async name => { await page.getByRole('button', { name: '打开项目菜单' }).tap(); await page.getByRole('navigation').getByRole('button', { name, exact: true }).tap(); await page.keyboard.press('Escape').catch(() => {}) }
    await go('灵感启发')
    const note = `隔离灵感${width}`
    await page.getByPlaceholder(/记一条灵感/).fill(note); await page.getByRole('button', { name: '记下来', exact: true }).tap()
    await page.getByText(note, { exact: true }).waitFor(); await go('写作面板'); await go('灵感启发')
    await page.getByText(note, { exact: true }).waitFor({ timeout: 15000 })
    check(`${width}: 灵感添加并离页回读`, await page.getByText(note, { exact: true }).isVisible())
    await go('检查工具')
    await page.getByPlaceholder(/输入自定义敏感词/).fill('陈渊'); await page.getByRole('button', { name: '添加', exact: true }).tap()
    await page.getByRole('button', { name: '系统扫描全书', exact: true }).tap()
    const matches = page.getByText(/陈渊\s*×/).first(); await matches.waitFor({ timeout: 15000 })
    check(`${width}: 自定义词扫描示例正文`, await matches.isVisible())
    await go('世界引擎')
    const world = `隔离世界${width}`
    await page.getByPlaceholder('世界名称（留空自动取）').fill(world)
    await page.getByRole('button', { name: '＋ 从当前项目新建世界', exact: true }).tap()
    await page.getByText(world, { exact: true }).first().waitFor({ timeout: 15000 })
    await go('写作面板'); await go('世界引擎')
    await page.getByText(world, { exact: true }).first().waitFor({ timeout: 15000 })
    check(`${width}: 新建世界离页回读`, await page.getByText(world, { exact: true }).first().isVisible())
    await go('创意写作')
    await page.getByRole('button', { name: '只做大纲规划', exact: true }).tap()
    check(`${width}: 创意写作目标可切换`, await page.getByText(/只做大纲规划.*不写正文/).first().isVisible())
    await go('背景设定')
    const extra = page.getByPlaceholder(/例：这是一段双男主/); await extra.fill(`隔离要求${width}`)
    check(`${width}: 背景设定需求可编辑`, await extra.inputValue() === `隔离要求${width}`)
    await context.close()
  }
  check('无模型请求及页面脚本错误', report.modelRequests.length === 0 && report.errors.length === 0, JSON.stringify({ errors: report.errors, modelRequests: report.modelRequests }))
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = String(error?.stack || error); process.exitCode = 1 }
finally { await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ run, ...report })); await browser?.close(); await server?.close() }
