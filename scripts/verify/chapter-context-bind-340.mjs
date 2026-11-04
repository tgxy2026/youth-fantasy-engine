// 3.4.0 · B 补测：本章资料的绑定/解绑、固定/取消，以及关闭抽屉后重开是否仍然生效。
// 前轮 §11.13 明确记录「绑定/解绑、固定/取消未做整页注入」，本脚本补上这一段。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'

const run = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/chapter-context-bind-340-'))
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
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => localStorage.setItem('yfe-ui:guide-auto', '0'))
  await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'domcontentloaded' })

  // 进入示例项目 → 正文
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
  await page.getByPlaceholder(/自动保存已开启/).waitFor({ timeout: 30000 })

  const openDrawer = async () => {
    await page.getByTitle(/^本章资料/).click()
    const drawer = page.getByRole('region', { name: '本章资料' })
    await drawer.waitFor({ timeout: 15000 })
    return drawer
  }
  const closeDrawer = async () => {
    await page.keyboard.press('Escape')
    await page.getByRole('region', { name: '本章资料' }).waitFor({ state: 'hidden', timeout: 10000 })
  }

  let drawer = await openDrawer()
  const bindSelect = page.getByLabel('绑定细纲')
  await bindSelect.waitFor()
  const options = await bindSelect.locator('option').evaluateAll(els => els.map(o => ({ value: o.value, label: o.textContent || '' })))
  const target = options.find(o => o.value)
  check('示例项目有可绑定的细纲卡', !!target, JSON.stringify(options))
  check('未绑定时显示「尚未绑定细纲」', await drawer.getByText(/尚未绑定细纲/).isVisible())

  // ---- 绑定 ----
  await bindSelect.selectOption(target.value)
  await drawer.getByText(/资料来源：章节细纲/).waitFor({ timeout: 15000 })
  check('绑定后显示资料来源与卡名', (await drawer.innerText()).includes(target.label))
  await closeDrawer()

  // ---- 重开仍生效（落库） ----
  drawer = await openDrawer()
  check('重开抽屉后绑定仍在', await page.getByLabel('绑定细纲').inputValue() === target.value)
  check('重开抽屉后仍显示该细纲卡', (await drawer.innerText()).includes(target.label))

  // ---- 固定一条资料 ----
  await drawer.getByRole('button', { name: '关联资料', exact: true }).click()
  const search = drawer.getByPlaceholder('搜索角色、设定、伏笔等资料')
  await search.fill('陈')
  const pinButton = drawer.locator('button', { hasText: '固定' }).first()
  await pinButton.waitFor({ timeout: 15000 })
  await pinButton.click()
  await drawer.getByText(/固定资料 · 1/).waitFor({ timeout: 15000 })
  check('固定一条资料后计数为 1', true)
  await closeDrawer()

  // ---- 重开仍生效 ----
  drawer = await openDrawer()
  await drawer.getByRole('button', { name: '关联资料', exact: true }).click()
  check('重开抽屉后固定项仍在', await drawer.getByText(/固定资料 · 1/).isVisible())

  // ---- 取消固定 ----
  await drawer.getByTitle('移除固定资料').first().click()
  await drawer.getByText(/固定资料 · 0/).waitFor({ timeout: 15000 })
  check('取消固定后计数归零', true)

  // ---- 解绑 ----
  await drawer.getByRole('button', { name: '细纲', exact: true }).click()
  await page.getByLabel('绑定细纲').selectOption('')
  await drawer.getByText(/尚未绑定细纲/).waitFor({ timeout: 15000 })
  check('解绑后回到「尚未绑定细纲」', true)

  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`\nPASS ${checks.length} checks · chapter-context-bind-340`)
} finally {
  await browser?.close()
  await server.close()
}
