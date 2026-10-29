// 手机页面覆盖基线：隔离示例项目逐页导航并记录实际主区域几何；不是全功能或真机验收。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `mobile-pages-baseline-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })
const server = await createServer({ root: process.cwd(), cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
const records = []
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
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })
  const tabs = await page.evaluate(async () => {
    const schema = await import('/src/lib/schema.ts')
    return [schema.EDITOR_TAB, ...schema.TABS.filter(t => schema.tabVisible(t.id, { type: 'full', features: [] }))].map(t => ({ id: t.id, name: t.name }))
  })
  for (const tab of tabs) {
    try {
      await page.getByRole('button', { name: '打开项目菜单' }).click({ timeout: 5000 })
      const nav = page.getByRole('navigation')
      const target = nav.getByRole('button', { name: tab.name, exact: true }).first()
      await target.click({ timeout: 5000 })
      await page.waitForTimeout(400)
      await page.getByRole('button', { name: '打开项目菜单' }).click({ timeout: 5000 })
      await target.waitFor({ timeout: 5000 })
      const active = await target.getAttribute('aria-current') === 'page'
      await page.keyboard.press('Escape')
      const geometry = await page.evaluate(() => {
        const main = document.querySelector('main')
        const r = main?.getBoundingClientRect()
        return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, mainLeft: r?.left, mainRight: r?.right, mainWidth: r?.width, mainHeight: r?.height, text: main?.innerText.slice(0, 100) }
      })
      const pass = active && geometry.documentWidth <= geometry.viewport + 1 && geometry.mainWidth >= 150 && geometry.mainHeight >= 100 && !!geometry.text?.trim() && !/正在加载|页面加载失败/.test(geometry.text)
      records.push({ ...tab, status: pass ? 'observed' : 'needs-review', geometry })
      console.log(`${pass ? 'OBSERVED' : 'REVIEW'} ${tab.id} ${tab.name}`)
    } catch (error) {
      records.push({ ...tab, status: 'blocked', reason: String(error).slice(0, 350) })
      console.log(`BLOCKED ${tab.id} ${tab.name}`)
      // 失败时继续其他页；关闭可能仍打开的抽屉，不清理任何数据。
      await page.keyboard.press('Escape').catch(() => {})
    }
  }
  const summary = { total: tabs.length, observed: records.filter(r => r.status === 'observed').length, needsReview: records.filter(r => r.status === 'needs-review').length, blocked: records.filter(r => r.status === 'blocked').length, errors, records, scope: '375px 触摸模拟与示范项目；仅主区域粗查，不覆盖所有功能、保存或真机' }
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify({ run, total: summary.total, observed: summary.observed, needsReview: summary.needsReview, blocked: summary.blocked, pageErrors: errors.length }))
  if (summary.blocked || summary.needsReview || errors.length) process.exitCode = 2
} finally {
  await browser?.close()
  await server.close()
}
