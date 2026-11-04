// 3.4.0 · 本章资料窄窗 / 宽窗让位 / 键盘往返（整页）
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'

const run = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/chapter-context-narrow-340-'))
const server = await createServer({ cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
const checks = []
const check = (id, ok, detail = '') => {
  checks.push({ id, ok: !!ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok || !detail ? '' : ` :: ${detail}`))
  if (!ok) throw new Error(`${id}${detail ? ' :: ' + detail : ''}`)
}

try {
  await server.listen()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => localStorage.setItem('yfe-ui:guide-auto', '0'))
  await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'domcontentloaded' })

  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
  const editor = page.getByPlaceholder(/自动保存已开启/)
  await editor.waitFor({ timeout: 30000 })
  const drawer = page.getByRole('region', { name: '本章资料' })
  const trigger = page.getByTitle(/^本章资料/)

  // ---- 宽窗：打开后正文让位，收起后恢复 ----
  await page.waitForTimeout(500)
  await trigger.click()
  await drawer.waitFor({ timeout: 15000 })
  await page.waitForTimeout(600)
  const eb = await editor.boundingBox()
  const db = await drawer.boundingBox()
  const overlap = eb && db
    ? !(eb.x + eb.width <= db.x || db.x + db.width <= eb.x || eb.y + eb.height <= db.y || db.y + db.height <= eb.y)
    : true
  check('宽窗打开本章资料后不与正文列重叠', !overlap, `editor=${JSON.stringify(eb)} drawer=${JSON.stringify(db)}`)
  await page.keyboard.press('Escape')
  await drawer.waitFor({ state: 'hidden', timeout: 10000 })
  await page.waitForTimeout(600)
  check('收起后本章资料抽屉消失', await drawer.isHidden())
  check('收起后焦点回到「本章资料」入口', await page.evaluate(() => document.activeElement?.hasAttribute('data-refs-trigger')))

  // ---- 窄窗：以可收起抽屉呈现，Esc 可收起 ----
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.waitForTimeout(700)
  await trigger.click()
  await drawer.waitFor({ timeout: 15000 })
  check('窄窗本章资料仍可打开', await drawer.isVisible())
  await page.keyboard.press('Escape')
  await drawer.waitFor({ state: 'hidden', timeout: 10000 })
  check('窄窗 Esc 能收起本章资料', await drawer.isHidden())
  check('窄窗收起后正文仍可见、可编辑', await editor.isVisible())

  // ---- 键盘：Tab 到入口 + Enter 打开 ----
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.waitForTimeout(500)
  await trigger.focus()
  await page.keyboard.press('Enter')
  await drawer.waitFor({ timeout: 15000 })
  check('键盘 Enter 可打开本章资料', await drawer.isVisible())
  await page.keyboard.press('Escape')

  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`\nPASS ${checks.length} checks · chapter-context-narrow-340`)
} finally {
  await browser?.close().catch(() => {})
  await server.close().catch(() => {})
}