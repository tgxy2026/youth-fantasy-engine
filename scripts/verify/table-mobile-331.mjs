// 示例项目表格的手机布局与横向滚动基线，不访问作者数据或外部网络。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `table-mobile-331-${stamp}`)
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
  await page.getByRole('navigation').getByText('物品资源', { exact: true }).first().click()
  const scroll = page.locator('[data-table-scroll]')
  await scroll.waitFor({ timeout: 30000 })
  await scroll.locator('[data-workspace-record]').first().waitFor()
  for (const [width, height] of [[320, 640], [360, 780], [375, 812], [390, 844], [430, 932], [667, 375], [844, 390]]) {
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(400)
    await scroll.scrollIntoViewIfNeeded()
    const geometry = await scroll.evaluate(el => {
      const rect = el.getBoundingClientRect()
      const x = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2))
      let visibleSamples = 0
      for (let y = 0; y < innerHeight; y += 5) {
        const target = document.elementFromPoint(x, y)
        if (target && (target === el || el.contains(target))) visibleSamples++
      }
      return { viewport: innerWidth, page: document.documentElement.scrollWidth, left: rect.left, right: rect.right, width: rect.width, height: rect.height, visibleHeight: visibleSamples * 5, contentWidth: el.scrollWidth, clientWidth: el.clientWidth }
    })
    check(`${width}×${height} 表格横向滚动局限容器且有可操作区域`, geometry.page <= width + 1 && geometry.left >= -1 && geometry.right <= width + 1 && geometry.width >= 150 && geometry.visibleHeight >= 100 && geometry.contentWidth > geometry.clientWidth, JSON.stringify(geometry))
    await scroll.evaluate(el => { el.scrollLeft = el.scrollWidth })
    const moved = await scroll.evaluate(el => el.scrollLeft)
    check(`${width}×${height} 可横向查看后面的列`, moved > 0, String(moved))
    await scroll.evaluate(el => { el.scrollLeft = 0 })
    if (width === 320 || width === 667) await page.screenshot({ path: path.join(run, `${width}-table.png`) })
  }
  await page.setViewportSize({ width: 375, height: 812 })
  await page.waitForTimeout(400)
  const first = scroll.locator('[data-workspace-record]').first()
  const rowId = await first.getAttribute('data-workspace-record')
  const field = first.locator('textarea').nth(1)
  await field.scrollIntoViewIfNeeded()
  const original = await field.inputValue()
  const updated = `${original}（隔离触摸测试）`
  await field.fill(updated)
  const save = page.getByTitle('保存全部（Ctrl+S）')
  await save.click()
  await page.waitForTimeout(500)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('navigation').getByText('写作面板', { exact: true }).click()
  await page.getByRole('navigation').getByText('物品资源', { exact: true }).first().click()
  const restored = page.locator(`[data-workspace-record="${rowId}"] textarea`).nth(1)
  await restored.waitFor({ timeout: 15000 })
  check('手机编辑保存后离页返回可回读', (await restored.inputValue()) === updated)
  check('无页面脚本错误', errors.length === 0, errors.join(' | '))
} finally {
  const failed = records.filter(record => !record.pass).length
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ records, failed }, null, 2))
  console.log(`结果：${records.length - failed}/${records.length}，${run}`)
  await browser?.close()
  await server.close()
  if (failed) process.exitCode = 1
}
