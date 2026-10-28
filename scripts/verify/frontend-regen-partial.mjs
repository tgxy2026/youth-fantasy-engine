// UX09 · 批量重生成摘要**部分失败**必须可见（假模型驱动，不碰真实模型/真实书库）。
//
// 原实现：单章失败 `catch {}` 静默跳过、结果只报 {done,total}，完成提示写「全书…完成（共 N 章）」
// ⇒ 失败章节被说成成功。本探针用**假模型 + 真实便携后端 + 真实前端**验证：
//   ① 让第 2 次模型请求返回 500，其余正常 ⇒ 真的只失败一章；
//   ② 页面出现失败清单（`data-regen-failures`），点明「哪几章仍是旧摘要」；
//   ③ 提示文案不再出现「全书摘要重生成完成」；
//   ④ 数据侧核对：失败的章摘要**没变**，其余章**确实更新**（不是整批没跑）；
//   ⑤ 0 页面异常。
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-regen-partial-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-regen-partial', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const APP_PORT = 8804
const MOCK_PORT = 8799
const BASE = `http://127.0.0.1:${APP_PORT}`
const MOCK = `http://127.0.0.1:${MOCK_PORT}`
/** 第几次模型请求要被打成 500（从 1 开始） */
const FAIL_AT = 2
let completionCount = 0

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
  // 🔴 Playwright 的路由是「**后注册的先跑**」：必须先把兜底挂上，再挂假模型那条，
  //    否则兜底的 `continue` 会抢在前面，注入的 500 永远不会生效（本轮实测踩到）。
  await context.route('**/*', route => {
    const url = route.request().url()
    if (url.startsWith(MOCK) || url.startsWith(BASE)) return route.continue()
    return route.abort()
  })
  // 第 2 次补全请求打 500：模拟「模型偶发失败」，其余照常通过
  await context.route(`${MOCK}/**`, route => {
    const url = route.request().url()
    if (!/\/chat\/completions/.test(url)) return route.continue()
    completionCount += 1
    report.modelRequests.push({ n: completionCount, failed: completionCount === FAIL_AT })
    console.log('model request', completionCount, completionCount === FAIL_AT ? '→ 500' : '→ pass')
    if (completionCount === FAIL_AT) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: '上游繁忙（假模型注入）' } }) })
    }
    return route.continue()
  })
  page = await context.newPage()
  page.setDefaultTimeout(120000)
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

  // 注入假模型（走整库 meta，带条件写版本）
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
    return { status: response.status, hasRevision: !!revision }
  }, MOCK)
  check('假模型注入成功（整库 meta，带版本）', injected.status === 200 && injected.hasRevision === true, injected)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(3500)
  if (/我的作品/.test(await page.evaluate(() => document.body.innerText))) {
    await page.getByRole('button', { name: '打开项目' }).first().click().catch(() => {})
    await sleep(3000)
  }
  for (const label of ['稍后再说', '知道了']) {
    const button = page.getByRole('button', { name: label, exact: true })
    if (await button.isVisible().catch(() => false)) await button.click()
  }
  await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
  await page.locator('textarea.novel-textarea').first().waitFor({ timeout: 30000 })

  /** 数据侧快照：有正文的章 id → 摘要 */
  const readSummaries = () => page.evaluate(async () => {
    const raw = await (await fetch('/api/data')).json()
    const doc = JSON.parse(raw.text || '{}')
    // 🔴 便携整库的 chapters 是「id → 记录」的对象，不是数组
    const chapters = Object.values(doc.stores?.chapters ?? {})
    return chapters.filter(c => ((c && c.content) ?? '').trim()).map(c => ({ id: c.id, title: c.title, summary: (c && c.summary) ?? '' }))
  })
  // 只留 3 章有正文：3 次请求里让第 2 次失败 ⇒ 「部分失败」明确且跑得快（临时副本，不碰真实书库）
  const trimmed = await page.evaluate(async () => {
    const current = await fetch('/api/data')
    const raw = await current.json()
    const revision = raw.revision || current.headers.get('etag')
    const doc = JSON.parse(raw.text || '{}')
    const chapters = doc.stores?.chapters ?? {}
    const keep = Object.keys(chapters).slice(0, 3)
    for (const id of Object.keys(chapters)) if (!keep.includes(id)) delete chapters[id]
    const response = await fetch('/api/data', { method: 'PUT', headers: { 'content-type': 'application/json', ...(revision ? { 'If-Match': revision } : {}) }, body: JSON.stringify(doc) })
    return { status: response.status, kept: keep.length }
  })
  check('测试数据裁剪为 3 章（临时副本）', trimmed.status === 200 && trimmed.kept === 3, trimmed)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(3000)
  if (/我的作品/.test(await page.evaluate(() => document.body.innerText))) {
    await page.getByRole('button', { name: '打开项目' }).first().click().catch(() => {})
    await sleep(2500)
  }
  await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
  await page.locator('textarea.novel-textarea').first().waitFor({ timeout: 30000 })

  const before = await readSummaries()
  check('示例项目里有足够多的有正文章节（≥3）', before.length >= 3, { chapters: before.length })

  // 触发批量重生成
  const regen = page.getByTitle('批量重生成全书各章压缩摘要（约原文 1/10，覆盖现有摘要）', { exact: true })
  await regen.click()
  await page.getByRole('button', { name: '确定', exact: true }).click()

  // 失败清单一出现就说明批跑完并如实报了失败
  const strip = page.locator('[data-regen-failures]')
  await strip.waitFor({ timeout: 180000 })
  const stripText = (await strip.textContent() ?? '').replace(/\s+/g, ' ').trim()
  report.stripText = stripText

  // 🔴 落盘是**空闲批处理**（不是每次写都立刻落文件）：直接读 /api/data 会是旧快照。
  //    这里按「等到有章真的变了」轮询，拿不到再判红 —— 不用固定 sleep 猜时机。
  let after = await readSummaries()
  let changedIds = []
  for (let i = 0; i < 50; i++) {
    after = await readSummaries()
    changedIds = after.filter(row => before.find(b => b.id === row.id)?.summary !== row.summary).map(row => row.id)
    if (changedIds.length >= 2) break
    await sleep(400)
  }
  const changed = after.filter(row => changedIds.includes(row.id))
  const failedRows = after.filter(row => !changedIds.includes(row.id))

  check('🔴 ① 部分失败：确实有章被处理、也确有章保持旧摘要',
    changed.length >= 1 && failedRows.length === 1, { changed: changed.length, unchanged: failedRows.map(r => r.title) })
  check('🔴 ② 页面出现失败清单，并点明「仍是旧摘要」',
    stripText.includes('仍是旧摘要') && stripText.includes(failedRows[0]?.title ?? '###'), stripText)
  check('🔴 ② 失败清单说的章数＝数据侧未更新的章数', stripText.includes(`有 ${failedRows.length} 章`), stripText)
  check('🔴 ③ 提示文案不再谎称「全书摘要重生成完成」',
    !(await page.evaluate(() => document.body.innerText)).includes('全书摘要重生成完成'))
  check('④ 失败章之外确实真的写了新摘要（不是整批没跑）', changed.length >= 2, { changed: changed.length })
  check('④ 模型请求次数＝处理章节数（含失败那一章）',
    completionCount >= failedRows.length + changed.length, { completionCount, processed: failedRows.length + changed.length })
  check('⑤ 全程没有浏览器运行错误', report.errors.length === 0, report.errors)

  await page.screenshot({ path: path.join(run, 'regen-partial.png'), animations: 'disabled' })
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
