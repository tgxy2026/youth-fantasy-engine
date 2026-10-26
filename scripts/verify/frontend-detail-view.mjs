// UX06 详情页工作现场：真实浏览器取证（真实 IDB、真实角色页）。
// 覆盖：分组展开记忆、滚动位置复原、切卡不串、记录里不含字段正文、0 模型请求。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-detail-view-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-detail-view', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}
const MARKER = '详情现场取证标记：这段文字绝不能进视图记录'
const CARD_A = '现场甲'
const CARD_B = '现场乙'

let server, browser, page
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, reducedMotion: 'reduce' })
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
  await page.getByRole('button', { name: '稍后再说', exact: true }).click()
  await page.getByRole('navigation').waitFor()
  page.setDefaultTimeout(15000)

  // 两张卡：字段填上标记文本，用来证明「记录里没有正文」
  await page.evaluate(async ({ a, b, marker }) => {
    const db = await import('/src/lib/db.ts')
    const { TABS } = await import('/src/lib/schema.ts')
    const projectId = db.getCurrentProjectId()
    const target = TABS.find(row => row.group === '角色管理')
    const data = { '基础信息::姓名': a, '基础信息::身份定位': marker }
    await db.saveCardRecord({ id: 'detail-probe-a', name: a, data, tabId: target.id, projectId, order: 900 })
    await db.saveCardRecord({ id: 'detail-probe-b', name: b, data: { ...data, '基础信息::姓名': b }, tabId: target.id, projectId, order: 901 })
  }, { a: CARD_A, b: CARD_B, marker: MARKER })

  const nav = page.getByRole('navigation')
  const openCharacterTab = async () => {
    if (!(await nav.getByRole('button', { name: '主要角色', exact: true }).isVisible().catch(() => false))) {
      await nav.getByRole('button', { name: '角色管理', exact: true }).click()
    }
    await nav.getByRole('button', { name: '主要角色', exact: true }).click()
    await page.locator('[data-character-detail]').waitFor()
  }
  const choose = async name => {
    await page.getByRole('button', { name: '选择角色：' + name, exact: true }).click()
    await page.locator('[data-character-detail]').waitFor()
  }
  const detail = page.locator('[data-character-detail]')
  const groups = page.locator('[data-card-group]')
  const groupState = () => groups.evaluateAll(nodes => nodes.map(node => ({
    id: node.getAttribute('data-card-group'), open: node.hasAttribute('open'),
  })))
  const readScroll = () => detail.evaluate(el => ({ top: el.scrollTop, max: Math.max(0, el.scrollHeight - el.clientHeight) }))

  await openCharacterTab()
  await choose(CARD_A)

  // ---------- ① 默认：基础组开、其余收 ----------
  const initial = await groupState()
  check('① 首次进入：基础组展开、其余收起', initial.length >= 3 && initial[0].open && initial.slice(1).every(row => !row.open), initial)

  // ---------- ② 展开第三个组 + 滚到中部，离开再回来 ----------
  const third = initial[2].id
  await groups.nth(2).locator('summary').click()
  await page.waitForTimeout(200)
  const opened = await groupState()
  check('🔴 ② 点击分组标题后该组展开', opened.find(row => row.id === third)?.open === true, opened)
  const wantScroll = await detail.evaluate(el => {
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    el.scrollTop = Math.round(max * 0.5)
    return { top: el.scrollTop, max }
  })
  await page.waitForTimeout(400) // 让「滚动停下就记」跑一遍
  await nav.getByRole('button', { name: '写作面板', exact: true }).click()
  await page.waitForTimeout(300)
  await openCharacterTab()
  await choose(CARD_A)
  await page.waitForTimeout(700)
  const backGroups = await groupState()
  const backScroll = await readScroll()
  check('🔴 ② 回到该卡时展开状态复原（含手动展开的第三组）',
    backGroups.find(row => row.id === third)?.open === true, { third, backGroups })
  check('🔴 ② 回到该卡时滚动位置复原（比例恢复，容差 60px）',
    wantScroll.max === 0 ? true : Math.abs(backScroll.top - wantScroll.top) <= 60, { wantScroll, backScroll })

  // ---------- ③ 切到另一张卡：不继承上一张的展开集 ----------
  await choose(CARD_B)
  await page.waitForTimeout(500)
  const otherGroups = await groupState()
  check('🔴 ③ 切到另一张卡时用它自己的展开集（不继承上一张）',
    otherGroups.find(row => row.id === third)?.open !== true, { third, otherGroups })

  // ---------- ④ 切回第一张：仍是刚才的展开集 ----------
  await choose(CARD_A)
  await page.waitForTimeout(700)
  const againGroups = await groupState()
  check('🔴 ④ 切回原卡时展开集仍是离开时的样子', againGroups.find(row => row.id === third)?.open === true, { third, againGroups })

  // ---------- ⑤ 记录卫生：不含字段正文，且带版本 ----------
  const store = await page.evaluate(async ({ id }) => {
    const db = await import('/src/lib/db.ts')
    const runtime = await import('/src/lib/settings/workspaceRuntime.ts')
    const { workspaceViews } = await import('/src/lib/settings/workspaceViewState.ts')
    const { TABS } = await import('/src/lib/schema.ts')
    await runtime.resolveWorkspaceIdentity()
    const target = TABS.find(row => row.group === '角色管理')
    const scope = runtime.currentWorkspaceScope(db.getCurrentProjectId(), `character:${target.id}`)
    const record = workspaceViews.get(scope, id)
    return { json: JSON.stringify(record), record }
  }, { id: 'detail-probe-a' })
  check('🔴 ⑤ 视图记录里不含字段正文', !store.json.includes(MARKER), { record: store.record })
  check('⑤ 记录是 detail 类型且带分组与滚动', store.record?.kind === 'detail' && Array.isArray(store.record?.groups) && !!store.record?.scroll, { record: store.record })

  await page.screenshot({ path: path.join(run, 'detail-view.png'), animations: 'disabled' })
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
