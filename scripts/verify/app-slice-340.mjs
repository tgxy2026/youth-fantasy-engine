// 3.4.0 · 整页纵切（真实应用 + 示例项目，不是组件夹具）
// 覆盖：规划板筛选 → 进章 → 返回后筛选/展开恢复 → 本章资料抽屉 Esc/焦点回流
//       → 时光机命名快照（真实落库）。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'

const run = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/app-slice-340-'))
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => localStorage.setItem('yfe-ui:guide-auto', '0'))
  await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'domcontentloaded' })

  // ---- 进入示例项目 ----
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  const nav = page.getByRole('navigation')

  // ---- A：规划板筛选 ----
  const board = page.getByRole('button', { name: /章节规划板/ })
  await board.waitFor({ timeout: 30000 })
  await board.click()
  const search = page.getByLabel('搜索章节标题或摘要')
  await search.waitFor()
  const volumeSelect = page.getByLabel('筛选分卷')
  const volumeOptions = await volumeSelect.locator('option').evaluateAll(opts => opts.map(o => ({ value: o.value, label: o.textContent || '' })))
  check('规划板有分卷筛选选项', volumeOptions.length > 1, JSON.stringify(volumeOptions))

  // 用「关键词 + 分卷」组合筛，保证结果非空：先取第一张卡标题里的两字词
  const cards = page.locator('[data-board-card]')
  const firstTitle = (await cards.first().innerText()).split('\n')[0].trim()
  if (!firstTitle) throw new Error('规划板没有可点章节')
  const keyword = firstTitle.slice(0, Math.min(2, firstTitle.length))
  await search.fill(keyword)
  const pickedVolume = volumeOptions[1]
  await volumeSelect.selectOption(pickedVolume.value)
  const filteredCount = await cards.count()
  if (filteredCount === 0) await volumeSelect.selectOption('all')
  const beforeCount = await cards.count()
  check('筛选后仍有章节可进入', beforeCount > 0, `count=${beforeCount}`)

  // ---- A：进章 ----
  const openedId = await cards.first().getAttribute('data-board-card')
  await cards.first().click()
  await page.getByPlaceholder(/自动保存已开启/).waitFor({ timeout: 30000 })

  // ---- A：返回写作面板，筛选与展开必须还在 ----
  await nav.getByRole('button', { name: '写作面板', exact: true }).click()
  await search.waitFor({ timeout: 30000 })
  check('返回后规划板仍是展开的', await search.isVisible())
  check('返回后关键词筛选被恢复', await search.inputValue() === keyword, `value=${await search.inputValue()}`)
  const restoredVolume = await volumeSelect.inputValue()
  const expectedVolume = filteredCount === 0 ? 'all' : pickedVolume.value
  check('返回后分卷筛选被恢复', restoredVolume === expectedVolume, `value=${restoredVolume} expected=${expectedVolume}`)
  const restoredIds = await cards.evaluateAll(els => els.map(el => el.getAttribute('data-board-card')))
  check('返回后仍按同一条件筛出章节', restoredIds.length > 0 && restoredIds.includes(openedId), `ids=${restoredIds.length}`)

  // ---- B：本章资料抽屉（Esc 收起 + 焦点回入口） ----
  await nav.getByRole('button', { name: '正文编辑', exact: true }).click()
  await page.getByPlaceholder(/自动保存已开启/).waitFor({ timeout: 30000 })
  await page.getByTitle(/^本章资料/).click()
  const drawer = page.getByRole('region', { name: '本章资料' })
  await drawer.waitFor({ timeout: 15000 })
  check('本章资料抽屉可打开', await drawer.isVisible())
  await page.keyboard.press('Escape')
  await drawer.waitFor({ state: 'hidden', timeout: 10000 })
  check('Esc 能收起本章资料', await drawer.isHidden())
  check('收起后焦点回到「本章资料」入口', await page.evaluate(() => document.activeElement?.hasAttribute('data-refs-trigger')))

  // ---- C：时光机命名快照（真实写入） ----
  await page.getByRole('button', { name: '编辑工具', exact: true }).click()
  await page.getByRole('button', { name: /时光机 · 版本历史/ }).click()
  await page.getByLabel('快照名称').fill('纵切测试快照')
  await page.getByLabel('快照备注').fill('app-slice-340 自动写入')
  await page.getByRole('button', { name: '保存命名快照' }).click()
  await page.getByText('命名快照已保存。').waitFor({ timeout: 15000 })
  await page.getByText('纵切测试快照').first().waitFor({ timeout: 10000 })
  check('命名快照保存后出现在列表里', true)

  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`\nPASS ${checks.length} checks · app-slice-340`)
} finally {
  await browser?.close()
  await server.close()
}
