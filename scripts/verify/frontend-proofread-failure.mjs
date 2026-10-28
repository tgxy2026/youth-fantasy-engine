// UX09 · 校对（第二个生成宿主）失败不许装成「未发现问题」（假模型驱动）。
//
// 守的两个点：
//   ① 全部段都没拿到结果（401）⇒ 面板必须明说「本次未完成校对」，**绝不**亮绿色「未发现…」；
//   ② 切页签再回来重开面板，失败状态仍归属本章、仍可见（不因为换了宿主就变绿或消失）；
//   ③ 模型返回读不懂（非 JSON）⇒ 只能给「无法解析」的琥珀提示，同样不许绿。
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-proofread-failure-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-proofread-failure', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], modes: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const APP_PORT = 8806
const MOCK_PORT = 8801
const BASE = `http://127.0.0.1:${APP_PORT}`
const MOCK = `http://127.0.0.1:${MOCK_PORT}`
const setMode = async mode => {
  report.modes.push(mode)
  const response = await fetch(MOCK + '/_mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) })
  if (!response.ok) throw new Error('设置假模型模式失败：' + mode)
}

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
  if (/我的作品/.test(await page.evaluate(() => document.documentElement.textContent))) {
    await page.getByRole('button', { name: '打开项目' }).first().click().catch(() => {})
    await sleep(2500)
  }
  const openEditor = async () => {
    for (const label of ['稍后再说', '知道了']) {
      const button = page.getByRole('button', { name: label, exact: true })
      if (await button.isVisible().catch(() => false)) await button.click()
    }
    await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
    await page.locator('textarea.novel-textarea').first().waitFor({ timeout: 30000 })
  }
  const openProofread = async () => {
    // 🔴 触发键的可访问名是 HelpPopover 的 triggerTitle（"编辑工具"），不是按钮上的「工具」二字；
    //    旁边还有一个「工具栏按钮速查」帮助入口，用 /^工具/ 会先点到它。
    await page.keyboard.press('Escape').catch(() => {})
    await page.getByRole('button', { name: '编辑工具', exact: true }).click()
    await page.getByRole('button', { name: '校对（本章）', exact: true }).click()
    await page.getByText('AI 校对', { exact: false }).first().waitFor({ timeout: 15000 })
  }
  await openEditor()

  // ---------- ① 全部 401：必须说「未完成校对」，不许绿 ----------
  await setMode('http401')
  await openProofread()
  await page.getByRole('button', { name: /查错别字与语病/ }).first().click()
  // 🔴 判据只看**结构锚点**：401 走的是任务失败（error 框），全段解析失败走的是 unchecked 框；
  //    按文案搜会漏掉其中一种（本轮实测：整页文本里也搜不到，弹窗文本不受 body.innerText 管）
  const failureBox = page.locator('[data-proofread-failure]').first()
  await failureBox.waitFor({ timeout: 150000 })
  const failText = (await failureBox.innerText()).replace(/\s+/g, ' ')
  check('🔴 ① 全段失败 ⇒ 出红色「未完成校对」框，并说明原因',
    /未完成校对|都没能校对成功|所有分段都没能拿到结果/.test(failText), failText)
  check('🔴 ① 全段失败时**不出现**绿色「未发现…✓」',
    !(await page.getByText('未发现错别字 / 语病 / 标点问题 ✓', { exact: false }).count()))

  // ---------- ② 切页签再回来：失败仍归属本章、仍可见 ----------
  await page.keyboard.press('Escape')
  await page.getByRole('navigation').getByRole('button', { name: '写作面板', exact: true }).click()
  await page.getByRole('navigation').waitFor()
  await openEditor()
  await openProofread()
  const returnedBox = page.locator('[data-proofread-failure]').first()
  await returnedBox.waitFor({ timeout: 40000 })
  const returnText = (await returnedBox.innerText()).replace(/\s+/g, ' ')
  check('🔴 ② 换宿主回来仍看到同一失败（不是变绿或消失）',
    /未完成校对|都没能校对成功|所有分段都没能拿到结果/.test(returnText)
    && !(await page.getByText('未发现错别字 / 语病 / 标点问题 ✓', { exact: false }).count()), returnText)

  // ---------- ③ 模型返回读不懂：只许琥珀「无法解析」，同样不许绿 ----------
  await setMode('normal')
  await page.getByRole('button', { name: /查错别字与语病/ }).first().click()
  const unparsedBox = page.locator('[data-proofread-unparsed]').first()
  await unparsedBox.waitFor({ timeout: 150000 })
  const unparsedText = (await unparsedBox.innerText()).replace(/\s+/g, ' ')
  check('🔴 ③ 解析不了 ⇒ 明说「无法解析」，不当「没有问题」',
    /无法解析/.test(unparsedText) && !(await page.getByText('未发现错别字 / 语病 / 标点问题 ✓', { exact: false }).count()), unparsedText)

  await page.screenshot({ path: path.join(run, 'proofread-failure.png'), animations: 'disabled' })
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
  appSrv?.kill(); mockSrv?.kill()
  console.log(JSON.stringify({ run, status: report.status, passed: report.passed, total: report.checks.length, stale: report.stale, failure: report.failure }))
  if (report.status !== 'passed') process.exitCode = 1
}
