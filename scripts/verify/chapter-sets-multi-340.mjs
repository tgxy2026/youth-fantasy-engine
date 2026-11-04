// 3.4.0 · 章节收藏集：同一章多集 / 空集 / 重名 / 删集不删章（整页）
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'

const run = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/chapter-sets-multi-340-'))
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

  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  await page.getByRole('navigation').getByRole('button', { name: '写作面板', exact: true }).click()

  const openSets = async () => {
    const toggle = page.getByRole('button', { name: /章节收藏集/ })
    await toggle.waitFor({ timeout: 30000 })
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  }
  const createSet = async name => {
    await page.getByRole('button', { name: '新建', exact: true }).click()
    await page.getByPlaceholder(/收藏集名称/).fill(name)
    await page.getByRole('button', { name: '创建', exact: true }).click()
  }

  await openSets()
  await createSet('集甲')
  await page.getByRole('button', { name: /集甲/ }).waitFor({ timeout: 15000 })
  await createSet('集乙')
  await page.getByRole('button', { name: /集乙/ }).waitFor({ timeout: 15000 })
  await createSet('集丙')
  await page.getByRole('button', { name: /集丙/ }).waitFor({ timeout: 15000 })

  // 重名拒绝
  await createSet('集甲')
  await page.getByText('同一项目内已存在同名收藏集').waitFor({ timeout: 10000 })
  check('重名收藏集被拒绝并提示', true)
  const setCount = await page.getByRole('button', { name: /^集[甲乙丙]/ }).count()
  check('重名没有创建出第四份收藏集', setCount === 3, `count=${setCount}`)

  // 同一章加入两个集
  await page.getByRole('button', { name: /集甲/ }).click()
  await page.getByRole('button', { name: /添加章节/ }).click()
  const memberButton = page.locator('div.border.rounded.p-2 button').nth(1)
  await memberButton.waitFor({ timeout: 15000 })
  const chapterTitle = (await memberButton.innerText()).trim()
  await memberButton.click()
  await page.getByTitle('进入章节正文').first().waitFor({ timeout: 15000 })

  await page.getByRole('button', { name: /集乙/ }).click()
  await page.getByRole('button', { name: /添加章节/ }).click()
  await page.locator('div.border.rounded.p-2 button').filter({ hasText: chapterTitle }).first().click()
  await page.getByTitle('进入章节正文').first().waitFor({ timeout: 15000 })

  await page.getByRole('button', { name: /集甲/ }).click()
  check('同一章可以同时属于两个收藏集（集甲）', await page.getByTitle('进入章节正文').first().isVisible())
  await page.getByRole('button', { name: /集乙/ }).click()
  check('同一章可以同时属于两个收藏集（集乙）', await page.getByTitle('进入章节正文').first().isVisible())

  // 空集
  await page.getByRole('button', { name: /集丙/ }).click()
  await page.getByText(/暂无成员/).waitFor({ timeout: 10000 })
  check('空收藏集显示明确空态', true)

  // 删集不删章
  await page.getByRole('button', { name: /集乙/ }).click()
  await page.getByTitle('删除收藏集（不删章节）').click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await page.getByRole('button', { name: /集乙/ }).waitFor({ state: 'detached', timeout: 15000 })
  check('删除收藏集后该集消失', true)
  await page.getByRole('button', { name: /集甲/ }).click()
  check('删集不影响另一个集里的同一章', await page.getByTitle('进入章节正文').first().isVisible())

  await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
  await page.getByPlaceholder(/自动保存已开启/).waitFor({ timeout: 30000 })
  check('删集后章节本身仍在（正文可正常打开）', await page.getByPlaceholder(/自动保存已开启/).isVisible())

  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`\nPASS ${checks.length} checks · chapter-sets-multi-340`)
} finally {
  await browser?.close().catch(() => {})
  await server.close().catch(() => {})
}