// 使用真实应用和隔离示例项目，检查手机视口下的手册与答疑。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `help-mobile-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })
const server = await createServer({ root: process.cwd(), cacheDir: path.join('.workbuddy/tmp', `vite-help-mobile-${stamp}`), logLevel: 'error', server: { host: 'localhost', port: 0 } })
const records = []
const check = (name, pass, detail = '') => { records.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`) }
let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 60000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible()) await later.click()
  const guide = page.locator('[data-guide-card]').first()
  await guide.waitFor({ timeout: 2500 }).catch(() => {})
  if (await guide.isVisible()) await page.getByRole('button', { name: '跳过本页' }).click()
  await page.getByTitle('返回项目列表').click()
  await page.getByRole('button', { name: /使用手册/ }).first().click()
  const dialog = page.getByRole('dialog').first()
  await dialog.waitFor()
  const center = dialog.locator('section').filter({ has: page.getByRole('heading', { name: '使用答疑助手', exact: true }) }).first()
  for (const [width, height] of [[320, 640], [360, 780], [375, 812], [390, 844], [430, 932], [667, 375], [844, 390]]) {
    await page.setViewportSize({ width, height })
    const search = dialog.getByLabel('搜索使用手册')
    await search.fill('字太小怎么放大')
    const hit = center.getByRole('button').filter({ hasText: /缩放/ }).first()
    await hit.waitFor()
    const geometry = await dialog.evaluate(el => {
      const search = el.querySelector('input[aria-label="搜索使用手册"]')?.getBoundingClientRect()
      const close = el.querySelector('button[aria-label="关闭"]')?.getBoundingClientRect()
      const rect = el.getBoundingClientRect()
      return { documentWidth: document.documentElement.scrollWidth, viewport: innerWidth, dialogLeft: rect.left, dialogRight: rect.right, searchWidth: search?.width ?? 0, closeWidth: close?.width ?? 0, closeHeight: close?.height ?? 0 }
    })
    check(`${width}×${height} 手册与搜索框可见且不撑宽页面`, geometry.documentWidth <= geometry.viewport + 1 && geometry.dialogLeft >= -1 && geometry.dialogRight <= width + 1 && geometry.searchWidth >= 100, JSON.stringify(geometry))
    check(`${width}×${height} 关闭按钮触摸区域至少 44px`, geometry.closeWidth >= 44 && geometry.closeHeight >= 44, JSON.stringify(geometry))
    await hit.click()
    check(`${width}×${height} 搜索结果可打开文章`, await center.locator('[data-help-article]').isVisible())
    await center.getByRole('button', { name: /返回/ }).first().click()
    await center.getByRole('button', { name: '问 AI' }).click()
    const box = center.getByLabel('向答疑助手提问')
    check(`${width}×${height} 答疑说明模型服务的数据发送范围`, await center.getByText('使用 AI 回答时，问题和相关手册片段会发送给所选模型服务。', { exact: false }).isVisible())
    await box.fill('字太小怎么放大')
    await center.getByRole('button', { name: '提问', exact: true }).click()
    await center.getByText(/这一条不是 AI 回答/).waitFor({ timeout: 30000 })
    const controls = await center.locator('[data-ask-panel]').evaluate(el => [...el.querySelectorAll('textarea, button')].filter(node => node.getAttribute('aria-label') === '向答疑助手提问' || /^(提问|清空)$/.test(node.textContent.trim())).map(node => { const r = node.getBoundingClientRect(); return { text: node.getAttribute('aria-label') || node.textContent.trim(), width: r.width, height: r.height, left: r.left, right: r.right } }))
    check(`${width}×${height} 输入框和操作按钮不裁切`, controls.length === 3 && controls.every(c => c.width > 0 && c.left >= -1 && c.right <= width + 1), JSON.stringify(controls))
    if (width <= 430) check(`${width}×${height} 输入框保留足够宽度`, controls.find(c => c.text === '向答疑助手提问')?.width >= 140, JSON.stringify(controls))
    if (width <= 430) check(`${width}×${height} 常用提问及清空触摸区域至少 44px`, controls.filter(c => c.text !== '向答疑助手提问').every(c => c.width >= 44 && c.height >= 44), JSON.stringify(controls))
    if (width === 320) await page.screenshot({ path: path.join(run, '320-answer.png') })
    await center.getByRole('button', { name: '清空', exact: true }).click()
    await center.getByRole('button', { name: '查手册' }).click()
  }
  check('无页面脚本错误', errors.length === 0, errors.join(' | '))
  await page.screenshot({ path: path.join(run, 'final.png') })
} finally {
  const failed = records.filter(record => !record.pass).length
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ records, failed }, null, 2))
  console.log(`结果：${records.length - failed}/${records.length}，${run}`)
  await browser?.close()
  await server.close()
  if (failed) process.exitCode = 1
}
