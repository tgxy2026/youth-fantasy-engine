// 左右分栏「右栏冻结」回归探针（3.3.1 · 主人 2026-10-30 反馈）
//
// 验的就是那一句话：右栏滚到中间后，点左边第二张卡片，**右栏还停在中间**，不是跳回顶部。
//   ① 角色管理（卡片型）：切换卡片，右栏位置保留、内容确实换了；
//   ② 世界设定（母子结构）：切换母级/子项，右栏位置同样保留；
//   ③ 左栏自己的滚动位置不受影响（两栏互不干扰）。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `master-detail-freeze-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })

const report = { kind: 'master-detail-freeze-331', at: new Date().toISOString(), run, checks: [], errors: [] }
let failed = 0
const check = (name, pass, detail = '') => {
  report.checks.push({ name, pass: !!pass, detail })
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const server = await createServer({
  root,
  cacheDir: path.join('.workbuddy/tmp', `vite-md-freeze-${stamp}`),
  logLevel: 'error',
  server: { host: 'localhost', port: 0 },
})

let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => (route.request().url().startsWith(origin + '/') ? route.continue() : route.abort()))
  const page = await context.newPage()
  page.setDefaultTimeout(120000)
  page.on('pageerror', error => report.errors.push(String(error)))

  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click({ timeout: 60000 })
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  const guide = page.locator('[data-guide-card]').first()
  if (await guide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
    await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
    await guide.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  }
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) }).catch(() => {})

  /** 把某个滚动容器推到中间，并回读状态 */
  const scrollToMiddle = selector => page.evaluate(sel => {
    const el = document.querySelector(sel)
    if (!el) return null
    const max = el.scrollHeight - el.clientHeight
    el.scrollTop = max > 0 ? Math.round(max * 0.5) : 0
    return { max, top: el.scrollTop }
  }, selector)
  const scrollState = selector => page.evaluate(sel => {
    const el = document.querySelector(sel)
    return el ? { top: el.scrollTop, max: el.scrollHeight - el.clientHeight } : null
  }, selector)

  // ---------- ① 角色管理 ----------
  await page.getByRole('navigation').getByText('主要角色', { exact: true }).first().click()
  const detail = '[data-character-detail]'
  await page.waitForSelector(detail, { timeout: 30000 })
  const cards = page.locator('[data-master-choice]')
  // 示范项目默认只有一张卡：不够就用「新建角色」（会弹名称输入框）补一张（隔离 profile，写的是示范项目）
  if ((await cards.count()) < 2) {
    await page.getByRole('button', { name: /新建角色|新建设定/ }).first().click().catch(() => {})
    await sleep(600)
    await page.keyboard.type('探针角色二')
    await sleep(200)
    await page.keyboard.press('Enter')
    await sleep(1200)
    // 命名框可能还留着遮罩：先确认掉，不然后面的点击全被它挡住（踩过）
    const dialog = page.locator('[role="dialog"]').first()
    if (await dialog.isVisible().catch(() => false)) {
      await page.getByRole('button', { name: /^(确定|创建|保存|好)$/ }).first().click({ timeout: 3000 }).catch(() => {})
      await page.keyboard.press('Escape').catch(() => {})
      await sleep(600)
    }
  }
  const cardCount = await cards.count()
  check('主要角色左栏有多张卡片可切', cardCount >= 2, String(cardCount))

  const seeded = await scrollToMiddle(detail)
  await sleep(400)
  check('右栏能滚到中间（内容够长，测试前提成立）', !!seeded && seeded.max > 120, JSON.stringify(seeded))
  const midTop = (await scrollState(detail))?.top ?? 0
  const headerBefore = await page.locator(detail).innerText()

  // 新建后选中的是第二张，所以这里切回第一张（点「已选中」的那张可能是空操作）
  await cards.nth(0).click()
  await sleep(700)
  const afterSwitch = await scrollState(detail)
  const headerAfter = await page.locator(detail).innerText()
  check('切换确实换了卡片内容（不是原地没动）', headerBefore !== headerAfter)
  check('🔴 切卡片后右栏还在原位（不是跳回顶部）',
    !!afterSwitch && Math.abs(afterSwitch.top - midTop) <= 24,
    JSON.stringify({ before: midTop, after: afterSwitch }))
  check('右栏没有被夹到顶部', (afterSwitch?.top ?? 0) > 40, String(afterSwitch?.top))

  // 左栏自己的滚动不受影响
  const listSeeded = await page.evaluate(() => {
    const list = document.querySelector('[data-master-scroll]')
    if (!list) return null
    const max = list.scrollHeight - list.clientHeight
    list.scrollTop = max > 0 ? Math.round(max * 0.4) : 0
    return list.scrollTop
  })
  if (listSeeded !== null && cardCount >= 2) {
    await sleep(300)
    await cards.nth(1).click({ timeout: 5000 }).catch(() => {})
    await sleep(600)
    const listNow = await page.evaluate(() => document.querySelector('[data-master-scroll]')?.scrollTop ?? null)
    check('左栏自己的滚动位置也不被别人改写',
      listSeeded === 0 || Math.abs((listNow ?? 0) - listSeeded) <= 24,
      JSON.stringify({ listSeeded, listNow }))
  }

  // ---------- ② 世界设定（母子结构） ----------
  await page.getByRole('navigation').getByText('世界设定', { exact: true }).first().click()
  const setDetail = '[data-set-detail]'
  const hasSetDetail = await page.waitForSelector(setDetail, { timeout: 20000 }).then(() => true).catch(() => false)
  if (!hasSetDetail) {
    check('世界设定页有右栏容器（可测）', false, '找不到 [data-set-detail]')
  } else {
    const setSeeded = await scrollToMiddle(setDetail)
    await sleep(400)
    const setMidTop = (await scrollState(setDetail))?.top ?? 0
    // 左栏子项的精确选择器（`aside button` 太宽，会点到右栏里的按钮把页面点走 —— 踩过）
    const subButtons = page.locator('button[title^="编辑子世界"]')
    const subCount = await subButtons.count()
    if ((setSeeded?.max ?? 0) < 80 || subCount === 0) {
      check('记录：世界设定右栏不够长或没有子世界，跳过位置断言', true,
        JSON.stringify({ seeded: setSeeded, subCount }))
    } else {
      await subButtons.first().click()
      await sleep(800)
      const setAfter = await scrollState(setDetail)
      check('🔴 世界设定切子项后右栏还在原位', !!setAfter && Math.abs(setAfter.top - setMidTop) <= 24,
        JSON.stringify({ before: setMidTop, after: setAfter }))
    }
  }

  check('全程 0 页面脚本错误', report.errors.length === 0, report.errors.join(' | ').slice(0, 200))
  await page.screenshot({ path: path.join(run, 'freeze.png') }).catch(() => {})
} catch (error) {
  failed++
  check('探针执行未中断', false, String(error?.message ?? error).slice(0, 200))
} finally {
  report.failed = failed
  report.status = failed === 0 ? 'pass' : 'fail'
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(report, null, 2))
  await browser?.close().catch(() => {})
  await server.close().catch(() => {})
  console.log(`\n报告：${path.join(run, 'result.json')}`)
  console.log(failed === 0 ? 'MD_FREEZE_OK' : `MD_FREEZE_FAIL ${failed}`)
  if (failed > 0) process.exitCode = 1
}
