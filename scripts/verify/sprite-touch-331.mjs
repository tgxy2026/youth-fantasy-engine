// 手机触摸模拟：精灵拖动不误开，点击可打开答疑。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `sprite-touch-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })
const server = await createServer({ root: process.cwd(), cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
const records = []
const check = (name, pass) => { records.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`) }
let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByText('继续写作', { exact: true }).first().waitFor({ timeout: 60000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible()) await later.click()
  const guide = page.locator('[data-guide-card]').first()
  if (await guide.waitFor({ timeout: 3000 }).then(() => true).catch(() => false)) await page.getByRole('button', { name: '跳过本页' }).click()
  const sprite = page.getByRole('button', { name: '选择颉文姬助手' })
  const before = await sprite.evaluate(el => el.parentElement.style.top)
  const box = await sprite.boundingBox()
  const cdp = await context.newCDPSession(page)
  const x = 365, y = box.y + box.height / 2
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 60 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(400)
  check('模拟触摸拖动改变位置且不打开菜单', await sprite.evaluate((el, old) => el.parentElement.style.top !== old && el.getAttribute('aria-expanded') === 'false', before))
  const moved = await sprite.boundingBox()
  await page.touchscreen.tap(x, moved.y + moved.height / 2)
  const menu = page.getByRole('group', { name: '选择颉文姬助手' })
  await menu.waitFor({ timeout: 10000 })
  const rect = await menu.boundingBox()
  check('模拟触摸点击打开双入口且菜单未横向裁切', rect.x >= 0 && rect.x + rect.width <= 375)
  console.log('菜单几何：' + JSON.stringify(rect))
  await page.screenshot({ path: path.join(run, 'menu.png') })
  await page.setViewportSize({ width: 320, height: 640 })
  const smallRect = await menu.boundingBox()
  check('320px 宽屏幕菜单未横向裁切', smallRect.x >= 0 && smallRect.x + smallRect.width <= 320)
  await menu.getByRole('button', { name: '使用答疑助手' }).tap()
  const dialog = page.getByRole('dialog', { name: '使用答疑助手' })
  await dialog.waitFor()
  check('模拟触摸可进入使用答疑', await dialog.getByLabel('搜索使用手册').isVisible())
  check('无页面脚本错误', errors.length === 0)
} finally {
  const failed = records.filter(record => !record.pass).length
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ records, failed }, null, 2))
  console.log(`结果：${records.length - failed}/${records.length}，${run}`)
  await browser?.close()
  await server.close()
  if (failed) process.exitCode = 1
}
