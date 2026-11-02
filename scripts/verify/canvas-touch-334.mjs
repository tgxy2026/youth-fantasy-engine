import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = process.cwd()
const run = path.join(root, '.workbuddy/tmp', `canvas-touch-334-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await fs.mkdir(run, { recursive: true })
const report = { fingerprint: snapshot(root).fingerprint, checks: [], errors: [], status: 'running' }
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name); if (!ok) throw Error(name + ': ' + detail) }
let server, browser
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  for (const width of [320, 375, 430, 768, 1024]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    await context.addInitScript(() => { try { localStorage.setItem('yfe-ui:guide-auto', '0') } catch { /* non-origin document */ } })
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
    const go = async name => {
      const toggle = page.getByRole('button', { name: '打开项目菜单' })
      if (await toggle.isVisible()) await toggle.tap()
      await page.getByRole('navigation').getByRole('button', { name, exact: true }).first().tap()
      await page.keyboard.press('Escape').catch(() => {})
    }
    await go('地图编辑')
    const map = page.locator('[data-adaptive-map] svg[viewBox] > g[transform]').first()
    await map.waitFor()
    const transform = () => map.getAttribute('transform')
    const scale = async () => Number((await transform()).match(/scale\(([^)]+)\)/)?.[1])
    const before = await scale()
    const plus = page.getByRole('button', { name: '放大画面', exact: true })
    const minus = page.getByRole('button', { name: '缩小画面', exact: true })
    await plus.tap()
    await page.waitForFunction(old => { const el = document.querySelector('[data-adaptive-map] svg[viewBox] > g[transform]'); return Number(el?.getAttribute('transform')?.match(/scale\(([^)]+)\)/)?.[1]) > old }, before)
    const enlarged = await scale()
    await minus.tap()
    await page.waitForFunction(old => { const el = document.querySelector('[data-adaptive-map] svg[viewBox] > g[transform]'); return Number(el?.getAttribute('transform')?.match(/scale\(([^)]+)\)/)?.[1]) < old }, enlarged)
    const restored = await scale()
    check(`${width}: 触摸放大缩小改变实际地图比例`, enlarged > before && Math.abs(restored - before) < 0.001, `${before}/${enlarged}/${restored}`)
    await page.getByTitle('重置视图（内容居中）').tap()
    check(`${width}: 重置后地图比例有效`, Number.isFinite(await scale()) && (await scale()) > 0)
    await go('情节推演')
    const surface = page.locator('[data-plot-surface]')
    const surfaceBox = await surface.boundingBox()
    check(`${width}: 推演画布保留可操作宽度`, !!surfaceBox && surfaceBox.width >= 150, JSON.stringify(surfaceBox))
    const connect = page.getByTitle('连接模式：依次点两张卡连成推演链；鼠标移到连线上点 × 取消')
    await connect.tap()
    check(`${width}: 推演连接模式可触摸切换`, /连接中/.test(await connect.innerText()))
    let expectedEdges = null
    if (width === 375) {
      const cards = surface.locator('.group.absolute')
      const n = await cards.count()
      check('375: 推演夹具至少有两张卡', n >= 2, String(n))
      const edges = surface.locator('path[marker-end]')
      const beforeEdges = await edges.count()
      await cards.first().tap()
      await cards.last().tap()
      check('375: 触摸两张卡产生推演连线', await edges.count() === beforeEdges + 1, `${beforeEdges} -> ${await edges.count()}`)
      expectedEdges = beforeEdges + 1
      await page.screenshot({ path: path.join(run, 'plot-375.png') })
    }
    await connect.tap()
    check(`${width}: 推演连接模式可退出`, /连接模式/.test(await connect.innerText()))
    if (expectedEdges !== null) {
      await go('写作面板')
      await go('情节推演')
      await page.waitForFunction(expected => document.querySelectorAll('[data-plot-surface] path[marker-end]').length === expected, expectedEdges, { timeout: 15000 })
      check('375: 离页返回后推演连线仍在', await surface.locator('path[marker-end]').count() === expectedEdges)
      const viewport = surface.locator(':scope > div').first()
      await viewport.scrollIntoViewIfNeeded()
      await viewport.evaluate(el => { el.scrollLeft = 0; el.scrollTop = 0 })
      const point = await viewport.evaluate(el => {
        const r = el.getBoundingClientRect()
        for (let y = Math.ceil(r.top) + 20; y < Math.min(r.bottom, innerHeight) - 20; y += 20) {
          for (let x = Math.ceil(r.left) + 140; x < Math.min(r.right, innerWidth) - 20; x += 20) {
            const hit = document.elementFromPoint(x, y)
            if (hit && el.contains(hit) && !hit.closest('.group.absolute')) return { x, y }
          }
        }
        return null
      })
      check('375: 画布有可触摸空白区域', !!point)
      const cdp = await context.newCDPSession(page)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
      for (let i = 1; i <= 5; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x - i * 20, y: point.y }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      const left = await viewport.evaluate(el => el.scrollLeft)
      check('375: 空白画布可通过触摸拖动平移', left > 20, `scrollLeft=${left}`)
      const card = surface.locator('.group.absolute').first()
      await card.scrollIntoViewIfNeeded()
      const cardBox = await card.boundingBox()
      const oldLeft = await card.evaluate(el => Number.parseFloat(el.style.left))
      const start = { x: cardBox.x + Math.min(cardBox.width - 20, 60), y: cardBox.y + 15 }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] })
      for (let i = 1; i <= 5; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + i * 10, y: start.y + i * 5 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      const newLeft = await card.evaluate(el => Number.parseFloat(el.style.left))
      check('375: 卡片可通过触摸拖动', newLeft > oldLeft + 10, `${oldLeft} -> ${newLeft}`)
    }
    await context.close()
  }
  check('无页面脚本错误', report.errors.length === 0, report.errors.join('; '))
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = String(error?.stack || error); process.exitCode = 1 }
finally { await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ run, ...report })); await browser?.close(); await server?.close() }
