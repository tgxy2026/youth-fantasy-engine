// UX09 · AI 整理（第三个生成宿主）：「模型没读懂」不许说成「文本里没东西」（假模型驱动）。
//
// 原实现把三种完全不同的「0 条」压成一句话：
//   「没有可新增的条目 —— 要么已经登记过，要么这段文本里没有可抽取的信息」，
//   其中「模型返回根本解析不出条目」被算进了「文本里没信息」，等于替模型背书。
// 本探针用假模型（返回叙事文本、不是 JSON 数组）验证：
//   ① 界面出 `data-organize-empty="parse-failed"`，文案明说「没能解析」并建议重试；
//   ② 不再出现那句「要么已经登记过，要么…没有可抽取的信息」；
//   ③ 0 页面异常。
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-organize-parse-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-organize-parse', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const APP_PORT = 8808
const MOCK_PORT = 8803
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
    const button = page.getByRole('button', { name: label, exact: true })
    if (await button.isVisible().catch(() => false)) await button.click()
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
    const button = page.getByRole('button', { name: label, exact: true })
    if (await button.isVisible().catch(() => false)) await button.click()
  }

  // 人物关系 = 「AI 整理」能力的表（aiCapabilityOf → organize）
  await page.getByRole('navigation').getByRole('button', { name: '人物关系', exact: true }).click()
  await page.getByRole('button', { name: 'AI 整理', exact: true }).click()
  await page.getByRole('dialog').waitFor({ timeout: 20000 })

  // 假模型返回叙事文本 ⇒ 解析不出条目（invalid），这正是旧文案会误报成「文本里没东西」的情形
  await fetch(MOCK + '/_mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'normal' }) })
  await page.getByRole('button', { name: '开始整理', exact: true }).click()

  const empty = page.locator('[data-organize-empty]').first()
  await empty.waitFor({ timeout: 150000 })
  const kind = await empty.getAttribute('data-organize-empty')
  const text = (await empty.innerText()).replace(/\s+/g, ' ')

  check('🔴 ① 解析不出条目 ⇒ 锚点为 parse-failed（不是 nothing-found）', kind === 'parse-failed', { kind, text })
  check('🔴 ① 文案明说「没能解析」并建议重试', /没能从模型返回里解析出条目/.test(text) && /重试/.test(text), text)
  check('🔴 ② 不再把「模型没读懂」说成「文本里没有可抽取的信息」', !/没有可抽取的信息/.test(text), text)
  check('② 也不再声称「已经全部登记过」', !/全部登记过/.test(text), text)
  check('② 面板仍给出可读的诊断（说明丢在哪）', /无法解析|元素|截断/.test(text), text)

  // 通知口径（toast 有结构锚点 data-toast）：解析失败时不许弹「已完成」
  const toast = await page.locator('[data-toast]').first().innerText().catch(() => '')
  report.toast = toast.replace(/\s+/g, ' ').trim()
  check('🔴 ③ 完成通知按真实结果说话，不谎称「已完成」',
    !/已完成 —— 结果保存在该页签/.test(report.toast)
    && (!report.toast || /没读到可用条目/.test(report.toast)), { toast: report.toast })
  check('③ 全程没有浏览器运行错误', report.errors.length === 0, report.errors)

  await page.screenshot({ path: path.join(run, 'organize-parse.png'), animations: 'disabled' })
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
