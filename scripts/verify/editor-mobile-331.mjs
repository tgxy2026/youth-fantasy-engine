// 手机视口正文保存回读；独立浏览器上下文、内置示范项目、禁止外部网络。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `editor-mobile-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })
const server = await createServer({ root: process.cwd(), cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
const records = []
const check = (name, pass, detail = '') => { records.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`) }
let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  const dismiss = async () => {
    const later = page.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.isVisible().catch(() => false)) await later.click()
    const card = page.locator('[data-guide-card]').first()
    if (await card.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
      await page.getByRole('button', { name: '跳过本页' }).click()
      await card.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    }
  }
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByText('继续写作', { exact: true }).first().waitFor({ timeout: 60000 })
  await dismiss()
  await page.getByText('继续写作', { exact: true }).first().click()
  await dismiss()
  const editor = page.locator('textarea.novel-textarea')
  await editor.waitFor({ timeout: 30000 })
  const save = page.getByRole('button', { name: '保存正文' })
  const original = await editor.inputValue()
  const added = '\n移动端隔离保存回读：春风吹过。'
  await editor.fill(original + added)
  await page.waitForTimeout(200)
  check('手机输入保留测试文字', (await editor.inputValue()).endsWith(added))
  if (await save.isEnabled()) await save.click()
  await page.waitForTimeout(2000)
  const next = page.getByTitle('下一章', { exact: true })
  const prev = page.getByTitle('上一章', { exact: true })
  if (await next.isEnabled()) {
    await next.click()
    await page.waitForFunction(old => document.querySelector('textarea.novel-textarea')?.value !== old, original + added, { timeout: 15000 })
    await prev.click()
  } else if (await prev.isEnabled()) {
    await prev.click()
    await page.waitForFunction(old => document.querySelector('textarea.novel-textarea')?.value !== old, original + added, { timeout: 15000 })
    await next.click()
  } else throw new Error('示例项目没有可切换的章节')
  await page.waitForFunction(text => document.querySelector('textarea.novel-textarea')?.value.endsWith(text), added, { timeout: 15000 })
  check('切换章节再返回后正文回读一致', (await editor.inputValue()) === original + added)
  for (const [width, height] of [[320, 640], [360, 780], [375, 812], [390, 844], [430, 932], [667, 375], [844, 390]]) {
    await page.setViewportSize({ width, height })
    // 自适应抽屉依赖 ResizeObserver；等待布局稳定，不能读刚切尺寸的上一帧。
    await page.waitForTimeout(350)
    await page.waitForFunction(() => (document.querySelector('textarea.novel-textarea')?.getBoundingClientRect().height ?? 0) >= 100, null, { timeout: 4000 }).catch(() => {})
    const geometry = await page.evaluate(() => {
      const edit = document.querySelector('textarea.novel-textarea').getBoundingClientRect()
      const save = document.querySelector('button[aria-label="保存正文"]').getBoundingClientRect()
      const nodes = []
      for (let node = document.querySelector('textarea.novel-textarea'), i = 0; node && i < 4; node = node.parentElement, i++) {
        const rect = node.getBoundingClientRect()
        nodes.push({ tag: node.tagName, className: node.className, height: rect.height, clientHeight: node.clientHeight, overflow: getComputedStyle(node).overflowY })
      }
      const shell = document.querySelector('[data-guide="body-editor"]')
      const siblings = [...shell.parentElement.children].map(node => ({ text: node.textContent.trim().slice(0, 50), height: node.getBoundingClientRect().height, className: node.className }))
      return { viewport: innerWidth, page: document.documentElement.scrollWidth, edit: { width: edit.width, height: edit.height, left: edit.left, right: edit.right, shellHeight: shell.getBoundingClientRect().height }, save: { width: save.width, height: save.height, left: save.left, right: save.right }, nodes, siblings }
    })
    check(`${width}×${height} 页面不横向溢出，正文与保存可见`, geometry.page <= width + 1 && geometry.edit.width >= 150 && geometry.edit.height >= 100 && geometry.edit.shellHeight >= 100 && geometry.edit.left >= -1 && geometry.edit.right <= width + 1 && geometry.save.left >= -1 && geometry.save.right <= width + 1, JSON.stringify(geometry))
    check(`${width}×${height} 保存按钮触摸区域至少 44px`, geometry.save.width >= 44 && geometry.save.height >= 44, JSON.stringify(geometry.save))
    if (width === 667) {
      const summary = await page.locator('textarea[aria-label="章节压缩摘要"]').evaluate(el => {
        const before = el.value
        el.scrollTop = el.scrollHeight
        return { height: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, unchanged: el.value === before, overflow: getComputedStyle(el).overflowY }
      })
      check('横屏长摘要可在输入框内滚动且内容未变', summary.scrollHeight > summary.height && summary.scrollTop > 0 && summary.unchanged && summary.overflow === 'auto', JSON.stringify(summary))
    }
    if (width === 320 || width === 667) await page.screenshot({ path: path.join(run, `${width}-editor.png`) })
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
