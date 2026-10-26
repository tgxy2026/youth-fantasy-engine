// UX05 关联跳转与返回来源：真实浏览器取证。
// 场景：角色页「查看提及」→ 点某章 → 正文里出现「返回：<角色>」→ 点它回到同一张卡；
// 另外证明普通侧栏切换**不会**冒出返回入口。全程隔离示例项目、0 模型请求。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-navigation-back-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-navigation-back', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}
const CARD = '返程甲'
const MARKER = '返程取证标记：这一句里提到了'

let server, browser, page
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => {
    const url = route.request().url()
    if (/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) report.modelRequests.push({ method: route.request().method(), origin: new URL(url).origin })
    return url.startsWith(origin + '/') ? route.continue() : route.abort()
  })
  page = await context.newPage()
  page.setDefaultTimeout(120000)
  page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(origin, { waitUntil: 'commit' })
  await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 180000 })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  // 备份提醒是异步挂的：先等导航进 DOM，再循环关提醒到真的可见
  await page.locator('nav').waitFor({ state: 'attached', timeout: 60000 })
  const dismiss = async () => {
    for (const name of ['稍后再说', '知道了', '跳过，直接开始']) {
      await page.getByRole('button', { name, exact: true }).click({ timeout: 1200 }).catch(() => {})
    }
  }
  const navRole = page.getByRole('navigation')
  const deadline = Date.now() + 45000
  while (Date.now() < deadline && !(await navRole.isVisible().catch(() => false))) {
    await dismiss()
    await page.waitForTimeout(200)
  }
  await navRole.waitFor({ timeout: 10000 })
  page.setDefaultTimeout(20000)

  // ---------- 播种：一张卡 + 一段提到它的正文 ----------
  const seeded = await page.evaluate(async ({ card, marker }) => {
    const db = await import('/src/lib/db.ts')
    const { TABS } = await import('/src/lib/schema.ts')
    const projectId = db.getCurrentProjectId()
    const tab = TABS.find(row => row.group === '角色管理')
    await db.saveCardRecord({ id: 'nav-back-card', name: card, data: { '基础信息::姓名': card }, tabId: tab.id, projectId, order: 800 })
    const chapters = await db.getAllChapters()
    const target = chapters[0]
    // 命中放在**正文中段**：偏移不为 0，才能验证「真的落到那一段」而不是碰巧在第一行
    const head = '开篇雨声未歇，守门人仍站在原地。\n\n'
    const content = `${head}${marker}${card}。\n\n${target.content ?? ''}`
    await db.patchChapter(target.id, { content })
    return { chapterId: target.id, chapterTitle: target.title ?? '',
      expectedOffset: head.length + marker.length, expectedLength: card.length, contentLength: content.length }
  }, { card: CARD, marker: MARKER })
  if (!seeded.chapterId) throw new Error('示例项目没有章节，无法验证跳章返回')

  const nav = navRole
  // 🔴 分组可能是默认展开的：无条件点「角色管理」反而会**收起**它，导致「主要角色」消失
  if (!(await nav.getByRole('button', { name: '主要角色', exact: true }).isVisible().catch(() => false))) {
    await nav.getByRole('button', { name: '角色管理', exact: true }).click()
  }
  await nav.getByRole('button', { name: '主要角色', exact: true }).click()
  const cardButton = page.getByRole('button', { name: '选择角色：' + CARD, exact: true })
  await cardButton.click()
  await page.getByRole('button', { name: '修改名称：' + CARD, exact: true }).waitFor()

  // ---------- ① 提及 → 跳正文章节，出现「返回」入口 ----------
  await page.getByTitle(`查看「${CARD}」在正文中的提及`).click()
  // 用标记文本定位那一行（只有我们改过的那一章含它），不靠章节标题猜
  const row = page.getByRole('button').filter({ hasText: MARKER }).first()
  await row.click()
  // 点完先抓 2 秒时间线：有没有 toast、面板是否关闭、正文有没有出现（判断是"被拦"还是"没触发"）
  const timeline = []
  for (let i = 0; i < 10; i += 1) {
    timeline.push(await page.evaluate(() => ({
      t: Date.now() % 100000,
      alerts: [...document.querySelectorAll('[role="alert"],[role="status"]')].map(n => (n.textContent || '').trim()).filter(Boolean).slice(0, 3),
      panel: !!document.querySelector('[role="dialog"]'),
      textarea: !!document.querySelector('textarea.novel-textarea'),
    })))
    await page.waitForTimeout(200)
  }
  report.timeline = timeline
  const editor = page.locator('textarea.novel-textarea')
  try {
    await editor.waitFor({ timeout: 15000 })
  } catch (error) {
    const diag = await page.evaluate(() => ({
      hasTextarea: !!document.querySelector('textarea.novel-textarea'),
      activeNav: [...document.querySelectorAll('nav button')].filter(b => b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-current')).map(b => (b.textContent || '').trim()).slice(0, 6),
      messages: [...document.querySelectorAll('[role="alert"],[role="status"]')].map(n => (n.textContent || '').trim()).filter(Boolean).slice(0, 4),
      head: (document.body.innerText || '').slice(0, 160),
    }))
    throw new Error('点提及后没进正文：' + JSON.stringify({ diag, timeline }))
  }
  const chip = page.getByRole('button', { name: new RegExp(`返回：${CARD}`) })
  await chip.waitFor({ timeout: 15000 })
  check('🔴 ① 从「提及」跳章后出现明确的返回入口', await chip.isVisible())
  check('🔴 ① 跳过去的正文确实是那一章（内容含标记）', (await editor.inputValue()).includes(MARKER))
  // 段落级定位：光标应落在命中处，且把命中词选中
  const caret = await editor.evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd, top: el.scrollTop, len: el.value.length }))
  check('🔴 ① 落在命中那一段（光标 ＝ 正文内偏移）', caret.start === seeded.expectedOffset, { caret, seeded })
  check('🔴 ① 命中词被选中（一眼看到落在哪）', caret.end === seeded.expectedOffset + seeded.expectedLength, { caret, seeded })
  check('① 定位后滚动位置是有限值（不越界）', Number.isFinite(caret.top) && caret.top >= 0, caret)
  check('① 返回入口带来源标签（不是笼统的「返回」）', (await chip.innerText()).includes(CARD))

  // ---------- ② 点返回：回到同一张卡 ----------
  await chip.click()
  await page.getByRole('button', { name: '修改名称：' + CARD, exact: true }).waitFor({ timeout: 15000 })
  const pressed = await cardButton.getAttribute('aria-pressed')
  check('🔴 ② 返回后回到角色页并选中同一张卡', pressed === 'true', { pressed })
  check('🔴 ② 返回入口用过即消失（不留悬空入口）', (await chip.count()) === 0)

  // ---------- ③ 普通侧栏切换不产生返回入口 ----------
  await nav.getByRole('button', { name: '写作面板', exact: true }).click()
  await page.waitForTimeout(400)
  await nav.getByRole('button', { name: '正文编辑', exact: true }).click()
  await editor.waitFor()
  await page.waitForTimeout(600)
  check('🔴 ③ 普通侧栏导航不产生返回入口（不进历史栈）', (await chip.count()) === 0)

  await page.screenshot({ path: path.join(run, 'navigation-back.png'), animations: 'disabled' })
  check('全程没有模型请求', report.modelRequests.length === 0, report.modelRequests)
  check('全程没有浏览器运行错误', report.errors.length === 0, report.errors)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failure = String(error.stack || error)
  if (page) await page.screenshot({ path: path.join(run, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {})
} finally {
  report.stale = snapshot(root).fingerprint !== fingerprint
  if (report.stale) report.status = 'failed'
  report.passed = report.checks.filter(item => item.passed).length
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  await server?.close()
  console.log(JSON.stringify({ run, status: report.status, passed: report.passed, total: report.checks.length, stale: report.stale, failure: report.failure }))
  if (report.status !== 'passed') process.exitCode = 1
}
