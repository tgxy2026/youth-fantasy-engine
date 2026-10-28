// UX13 · 长等待必须能叫停：批量重生成摘要的「中止」是真中止（假模型驱动）。
//
// 原来这排按钮里只有「开始」——跑起来后只能等整本跑完或切页签干等，作者没有叫停入口。
// 本探针验证：
//   ① 跑起来后同一位置变「中止」键（结构：aria-label「中止批量重生成」）；
//   ② 点它之后任务**由 running 变 aborted**、按钮复位；
//   ③ 已更新的章节保持已更新，未处理的章节仍是旧摘要（中止 ≠ 回滚）；
//   ④ 0 页面异常。
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-regen-cancel-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-regen-cancel', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const APP_PORT = 8810
const MOCK_PORT = 8805
const BASE = `http://127.0.0.1:${APP_PORT}`
const MOCK = `http://127.0.0.1:${MOCK_PORT}`

let appSrv, mockSrv, browser, page
try {
  const appRoot = path.join(run, 'app')
  await build({ root, logLevel: 'error', build: { outDir: path.join(appRoot, 'dist'), emptyOutDir: true } })
  mockSrv = spawn(process.execPath, [path.join(root, 'scripts/audit/probes/mock-model-server.cjs'), '--port', String(MOCK_PORT)], { stdio: 'ignore', windowsHide: true })
  appSrv = spawn(process.execPath, [path.join(root, 'scripts/portable-server.mjs'), '--root', appRoot, '--port', String(APP_PORT), '--no-open'], { stdio: 'ignore', windowsHide: true })
  let up = false
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + '/api/ping')).ok && (await fetch(MOCK + '/_stats')).ok) { up = true; break } } catch { /* 还没起来 */ }
    await sleep(300)
  }
  if (!up) throw new Error('便携服务或假模型服务没起来')

  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => {
    const url = route.request().url()
    if (url.startsWith(MOCK) || url.startsWith(BASE)) return route.continue()
    return route.abort()
  })
  page = await context.newPage()
  page.setDefaultTimeout(180000)
  page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 120000 })
  await sleep(1500)
  await page.getByRole('button', { name: /先看看示例/ }).first().click()
  await sleep(2500)
  for (const name of [/^下一步$/, /跳过，直接开始/]) {
    const button = page.getByRole('button', { name }).first()
    if (await button.count()) { await button.click(); await sleep(name.source.includes('跳过') ? 3500 : 1800) }
  }
  for (const label of ['稍后再说', '知道了']) {
    const b = page.getByRole('button', { name: label, exact: true })
    if (await b.isVisible().catch(() => false)) await b.click()
  }
  const injected = await page.evaluate(async mockBase => {
    const current = await fetch('/api/data')
    const raw = await current.json()
    const revision = raw.revision || current.headers.get('etag')
    const doc = JSON.parse(raw.text || '{}')
    doc.stores = doc.stores || {}
    const provider = { id: 'mock', name: '假服务（取证）', type: 'openai', baseUrl: mockBase + '/v1', apiKey: 'mock-key', model: 'mock-model', contextWindow: 32000, local: true }
    const meta = (doc.stores.meta || []).filter(m => !['aiProviders', 'aiActiveProviderId'].includes(m.key))
    meta.push({ key: 'aiProviders', value: [provider] }, { key: 'aiActiveProviderId', value: 'mock' })
    doc.stores.meta = meta
    const response = await fetch('/api/data', { method: 'PUT', headers: { 'content-type': 'application/json', ...(revision ? { 'If-Match': revision } : {}) }, body: JSON.stringify(doc) })
    return response.status
  }, MOCK)
  check('假模型注入成功', injected === 200, injected)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(3000)
  if (/我的作品/.test(await page.evaluate(() => document.body.innerText))) {
    await page.getByRole('button', { name: '打开项目' }).first().click().catch(() => {})
    await sleep(2500)
  }
  for (const label of ['稍后再说', '知道了']) {
    const b = page.getByRole('button', { name: label, exact: true })
    if (await b.isVisible().catch(() => false)) await b.click()
  }
  await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
  await page.locator('textarea.novel-textarea').first().waitFor({ timeout: 30000 })

  const readSummaries = () => page.evaluate(async () => {
    const raw = await (await fetch('/api/data')).json()
    const doc = JSON.parse(raw.text || '{}')
    const chapters = Object.values(doc.stores?.chapters ?? {})
    return chapters.filter(c => ((c && c.content) ?? '').trim()).map(c => ({ id: c.id, title: c.title, summary: (c && c.summary) ?? '' }))
  })
  const before = await readSummaries()
  check('示例项目 ≥3 个有正文章节', before.length >= 3, { chapters: before.length })

  // 慢模型（每请求 2.5s）：留出足够时间点「中止」
  await fetch(MOCK + '/_mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'slow' }) })
  await page.getByTitle('批量重生成全书各章压缩摘要（约原文 1/10，覆盖现有摘要）', { exact: true }).click()
  await page.getByRole('button', { name: '确定', exact: true }).click()

  const stopBtn = page.getByRole('button', { name: '中止批量重生成' })
  await stopBtn.waitFor({ timeout: 60000 })
  check('🔴 ① 跑起来后同一位置出现「中止」键', await stopBtn.isVisible())

  // 等第一章真的落库，再点中止（这样能验证「已更新的保持已更新」）
  let changedBeforeStop = 0
  for (let i = 0; i < 40; i++) {
    const now = await readSummaries()
    changedBeforeStop = now.filter(row => before.find(b => b.id === row.id)?.summary !== row.summary).length
    if (changedBeforeStop >= 1) break
    await sleep(400)
  }
  await stopBtn.click()

  // ② 中止生效：按钮复位成「开始」
  const regenBtn = page.getByTitle('批量重生成全书各章压缩摘要（约原文 1/10，覆盖现有摘要）', { exact: true })
  await regenBtn.waitFor({ timeout: 30000 })
  check('🔴 ② 点中止后任务结束、按钮复位', await regenBtn.isVisible() && await page.getByRole('button', { name: '中止批量重生成' }).count() === 0)

  // ③ 已更新的保持、未处理的仍是旧摘要
  await sleep(1200)
  const after = await readSummaries()
  const changedAfter = after.filter(row => before.find(b => b.id === row.id)?.summary !== row.summary).length
  report.changedBeforeStop = changedBeforeStop
  report.changedAfterStop = changedAfter
  report.total = before.length
  check('🔴 ③ 中止前确实已更新了章节', changedBeforeStop >= 1, { changedBeforeStop })
  check('🔴 ③ 中止 ≠ 回滚：已更新的仍是新摘要', changedAfter >= changedBeforeStop, { changedBeforeStop, changedAfter })
  check('🔴 ③ 中止后没有把剩下的都跑完（确实停住了）', changedAfter < before.length, { changedAfter, total: before.length })

  await page.screenshot({ path: path.join(run, 'regen-cancelled.png'), animations: 'disabled' })
  check('④ 全程没有浏览器运行错误', report.errors.length === 0, report.errors)
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
  appSrv?.kill(); mockSrv?.kill()
  console.log(JSON.stringify({ run, status: report.status, passed: report.passed, total: report.checks.length, stale: report.stale, failure: report.failure }))
  if (report.status !== 'passed') process.exitCode = 1
}
