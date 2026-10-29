// 3.3.1 · P3 实机探针：App 层托管的页签引导
//
// 验的是「不用逐页改组件也能覆盖」这条路：
//   写作面板（手写 + 锚点）→ 表格页（模板 + table-body 锚点）→ 卡片页（模板 + master-detail）
//   → 专用页（兜底居中说明，没有锚点也不假装有）→ 侧栏「本页指引」能重看 → 跳过之后不重弹。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const run = await mkdtemp(path.join(root, '.workbuddy/tmp/page-guide-app-331-'))
const server = await createServer({ root, cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
const checks = []
const check = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond, extra })
  if (!cond) console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`)
}
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))

  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过,直接开始|跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 60000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible()) await later.click()

  const card = page.locator('[data-guide-card]')
  const nav = page.getByRole('navigation')
  const skipGuide = async () => {
    if (await page.locator('[data-guide-card]').count() === 0) return
    await page.getByRole('button', { name: '跳过本页' }).click()
    await card.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  }

  // ① 写作面板：App 层托管 + 手写步骤 + 真锚点
  await card.waitFor({ timeout: 20000 })
  const dashText = await card.innerText()
  check('写作面板首次进入自动出现引导（App 层托管）', dashText.includes('先看今天写了多少'), dashText.slice(0, 60))
  check('手写引导带高亮锚点（不是居中说明）', await page.locator('[data-guide-hole]').count() === 1)
  check('侧栏有「本页指引」入口', await page.getByRole('button', { name: '本页指引' }).count() > 0)
  await page.screenshot({ path: path.join(run, 'dashboard.png') })
  await skipGuide()

  // ② 表格页：模板生成的 3 步
  await nav.getByText('物品资源', { exact: true }).first().click()
  await card.waitFor({ timeout: 15000 })
  const tableText = await card.innerText()
  check('表格页用模板引导（一行一条记录）', /一行一条记录|这一页是《物品资源》/.test(tableText), tableText.slice(0, 80))
  check('表格模板高亮了表格本体', await page.locator('[data-guide-hole]').count() === 1)
  await page.getByRole('button', { name: '下一步' }).click()
  const tableText2 = await card.innerText()
  check('表格模板第 2 步指到「新增一行」', /第 2 \/ 3 步/.test(tableText2))
  await skipGuide()

  // ③ 卡片页：模板 + master-detail
  await nav.getByText('主要角色', { exact: true }).first().click()
  await card.waitFor({ timeout: 15000 })
  const cardText = await card.innerText()
  check('卡片页用模板引导（左边目录 / 右边详情）', /左边是目录|这一页是《主要角色》/.test(cardText), cardText.slice(0, 80))
  check('卡片模板高亮了主从区域', await page.locator('[data-guide-hole]').count() === 1)
  await skipGuide()

  // ④ 专用页：第 1 步整页说明（无高亮），第 2 步高亮页头
  await nav.getByText('灵感启发', { exact: true }).first().click()
  await card.waitFor({ timeout: 15000 })
  const fallbackText = await card.innerText()
  check('专用页给出整页说明', /这一页是《灵感启发》/.test(fallbackText), fallbackText.slice(0, 80))
  check('专用页第 1 步没有锚点时就不画高亮框（不假装有）', await page.locator('[data-guide-hole]').count() === 0)
  await page.getByRole('button', { name: '下一步' }).click()
  check('专用页第 2 步高亮了页头（标题旁的问号）', await page.locator('[data-guide-hole]').count() === 1)
  await page.screenshot({ path: path.join(run, 'fallback.png') })

  // ⑤ 跳过之后不重弹；「本页指引」仍可重看
  await skipGuide()
  await nav.getByText('物品资源', { exact: true }).first().click()
  await page.waitForTimeout(1200)
  check('🔴 看过的页签不再自动弹', await page.locator('[data-guide-card]').count() === 0)
  await page.getByRole('button', { name: '本页指引' }).click()
  await card.waitFor({ timeout: 5000 })
  check('侧栏「本页指引」可以随时重看', (await card.innerText()).includes('第 1 / 3 步') || (await card.innerText()).includes('物品资源'))
  await page.keyboard.press('Escape')
  await card.waitFor({ state: 'detached', timeout: 5000 })

  // ⑥ 记录数会涨：进过几个页签就记几条
  await nav.getByText('使用指南', { exact: true }).first().click()
  await page.locator('[data-guide-settings]').waitFor({ timeout: 15000 })
  const settingsText = await page.locator('[data-guide-settings]').innerText()
  check('引导设置里能看到记录数量', /已记录 \d+ 个页签/.test(settingsText), settingsText.slice(0, 80))

  check('全程无 pageerror', errors.length === 0, errors.join(' ｜ '))
  const failed = checks.filter(item => !item.ok)
  const evidence = { run, total: checks.length, passed: checks.length - failed.length, failed: failed.length, pageErrors: errors, checks }
  await writeFile(path.join(run, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ ...evidence, checks: undefined }, null, 2))
  if (failed.length || errors.length) process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
}
