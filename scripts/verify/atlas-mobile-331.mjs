// 图鉴手机触摸浏览：示范项目，独立浏览器上下文，不接外网。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `atlas-mobile-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })
const server = await createServer({ root: process.cwd(), cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
const records = []
const check = (name, pass, detail = '') => { records.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`) }
let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 60000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible()) await later.click()
  const guide = page.locator('[data-guide-card]').first()
  if (await guide.waitFor({ timeout: 3000 }).then(() => true).catch(() => false)) await page.getByRole('button', { name: '跳过本页' }).click()
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })
  for (const label of ['种族生物', '物品资源', '国家势力', '地理风物']) {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole('navigation').getByText(label, { exact: true }).first().click()
    await page.getByRole('button', { name: '图鉴', exact: true }).click()
    const cards = page.locator('[data-workspace-record]')
    await cards.first().waitFor({ timeout: 30000 })
    for (const [width, height] of [[320, 640], [375, 812], [667, 375]]) {
      await page.setViewportSize({ width, height })
      await page.waitForTimeout(500)
      await cards.first().tap()
      const nav = page.locator('[data-atlas-nav]')
      await nav.waitFor()
      const initial = await nav.getAttribute('aria-label')
      const next = nav.getByRole('button', { name: '下一条', exact: true })
      const back = page.locator('[data-atlas-close]')
      const dimensions = await Promise.all([next, back].map(locator => locator.evaluate(el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, left: r.left, right: r.right } })))
      check(`${label} ${width}×${height} 下一条及返回触摸目标`, dimensions.every(r => r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= width), JSON.stringify(dimensions))
      await next.tap()
      const moved = await nav.getAttribute('aria-label')
      check(`${label} ${width}×${height} 点下一条切换详情`, initial !== moved, `${initial} → ${moved}`)
      await back.tap()
      check(`${label} ${width}×${height} 返回列表`, !(await page.locator('[data-atlas-nav]').isVisible()))
      if (label === '物品资源' && width === 320) await page.screenshot({ path: path.join(run, '320-list.png') })
    }
  }
  check('无页面脚本错误', errors.length === 0, errors.join(' | '))
} finally {
  const failed = records.filter(record => !record.pass).length
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ records, failed }, null, 2))
  console.log(`结果：${records.length - failed}/${records.length}，${run}`)
  await browser?.close()
  await server.close()
  if (failed) process.exitCode = 1
}
