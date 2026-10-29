// UX13 · 懒加载页面的分包失败与**真重试**：真实浏览器取证。
//
// 不碰作者书库（临时上下文里的示例项目）、不发任何模型请求。
// 🔴 用**生产构建**取证（`vite build` 到临时目录 + `vite preview`）：真机上出问题的是
//    带哈希的分包文件（更新后旧文件被替换 ⇒ 404），开发态的模块地址与反应都不一样。
//
// 守的是这条体验缺口：「切到一个页面，代码文件没拿到 ⇒ 只能整页刷新」。
// 裸 `lazy()` 会把失败永久缓存，重挂载也只会重抛；这里要证的是：
//   ① 失败只落在**这一页**，导航与其它页面照常；
//   ② 失败有明确、可读的界面（结构锚点 `data-module-failure`），不是空白也不是无限转圈；
//   ③ 故障仍在时再进来仍如实报错（不假装成功、不堆叠多份）；
//   ④ 恢复后点「重新加载这个页面」**真的重新发请求**并挂载出真页面；
//   ⑤ 技术摘要不外泄分包文件名 / 主机 / 查询串；
//   ⑥ 全程没有未捕获异常（生产构建下 React 不会再把边界接住的错误抛回 window）。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, preview } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-lazy-chunk-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-lazy-chunk', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], modelRequests: [], chunkRequests: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}

/** 被拦截的分包：拆书面板（页签「一键拆书」） */
const CHUNK = 'BookBreakPanel'
let blockChunk = true

let server, browser, page
try {
  // 生产构建到临时目录：**不碰仓内 dist**，也不清任何已有产物
  await build({ root, logLevel: 'error', build: { outDir: path.join(run, 'dist'), emptyOutDir: true } })
  const built = await fs.readdir(path.join(run, 'dist', 'assets'))
  report.chunks = built.filter(name => name.includes(CHUNK))
  if (!report.chunks.length) throw new Error('生产构建里没有找到拆书面板的分包，无法验证分包失败')
  server = await preview({ root, logLevel: 'error', build: { outDir: path.join(run, 'dist') }, preview: { host: 'localhost', port: 0 } })
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => {
    const url = route.request().url()
    if (/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) report.modelRequests.push({ method: route.request().method(), origin: new URL(url).origin })
    if (!url.startsWith(origin + '/')) return route.abort()
    if (url.includes(CHUNK)) {
      report.chunkRequests.push({ url: url.slice(origin.length), blocked: blockChunk })
      // 只断这一个文件：模拟「网络中断 / 更新后旧分包已被替换」
      return blockChunk ? route.abort('failed') : route.continue()
    }
    return route.continue()
  })
  page = await context.newPage()
  page.setDefaultTimeout(180000)
  page.on('pageerror', error => report.errors.push(error.message))
  // 诊断用：把真正没被接住的拒绝 / 异常原文留在证据里（只进本机证据，不进界面）
  await page.addInitScript(() => {
    window.__rejections = []
    window.addEventListener('unhandledrejection', event => {
      window.__rejections.push(String((event.reason && event.reason.stack) || event.reason))
    })
    window.addEventListener('error', event => {
      window.__rejections.push('error: ' + String((event.error && event.error.stack) || event.message))
    })
  })
  await page.goto(origin, { waitUntil: 'commit' })
  await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 180000 })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByRole('button', { name: '稍后再说', exact: true }).click()
  await page.getByRole('navigation').waitFor()
  page.setDefaultTimeout(20000)

  const nav = name => page.getByRole('navigation').getByRole('button', { name, exact: true })
  const notice = page.locator('[data-module-failure]')
  const openBookBreak = async () => {
    for (const name of ['稍后再说', '知道了', '跳过，直接开始']) {
      await page.getByRole('button', { name, exact: true }).click({ timeout: 1500 }).catch(() => {})
    }
    await nav('一键拆书').click()
  }

  // ---------- ① 分包失败：只这一页报错，界面可读 ----------
  await openBookBreak()
  await notice.waitFor({ timeout: 30000 })
  const heading = page.getByRole('heading', { name: '「一键拆书」没能加载出来', exact: true })
  check('🔴 ① 分包失败有明确标题，并自动获得焦点', await heading.isVisible()
    && await heading.evaluate(el => el === document.activeElement), { text: await notice.textContent() })
  check('① 说明不虚构保存结果、不复述原始报错',
    !(await page.getByText('未造成数据丢失', { exact: false }).count())
    && await page.getByText('工作台其它页面不受影响', { exact: false }).isVisible()
    && !(await notice.textContent()).includes('Failed to fetch'))
  check('① 失败只落在本页：主导航仍在、页面区域没有整屏错误页',
    await page.getByRole('navigation').isVisible()
    && !(await page.getByRole('heading', { name: '当前页面暂时无法打开', exact: true }).count()))
  check('① 技术摘要默认折叠，且不含分包文件名 / 主机 / 查询串', await (async () => {
    if (await page.locator('details pre').isVisible()) return false
    await page.getByText('查看技术摘要', { exact: true }).first().click()
    const summary = await page.locator('details pre').first().textContent()
    report.summary = summary
    return !new RegExp([CHUNK, 'assets', 'localhost', 'https?://', '\\?'].join('|')).test(summary)
  })())

  // ---------- ② 故障未解除时再进来：仍然如实报错（不假装成功） ----------
  await nav('写作面板').click()
  await page.getByRole('navigation').waitFor()
  check('🔴 ② 失败页之外导航照常（写作面板可进入）',
    await page.getByRole('navigation').getByRole('button', { name: '写作面板', exact: true }).isVisible())
  const blockedBefore = report.chunkRequests.filter(item => item.blocked).length
  await openBookBreak()
  await notice.waitFor({ timeout: 30000 })
  check('🔴 ② 故障仍在时再次进入仍报错，不会静默空白', await page.getByRole('heading', { name: '「一键拆书」没能加载出来', exact: true }).isVisible()
    && report.chunkRequests.filter(item => item.blocked).length > blockedBefore)
  check('② 界面没有重复堆叠多个失败面板', await notice.count() === 1, { count: await notice.count() })

  // ---------- ③ 恢复后重试：真的重新发请求并挂载出真页面 ----------
  blockChunk = false
  const attemptsBefore = report.chunkRequests.length
  await page.getByRole('button', { name: '重新加载这个页面', exact: true }).click()
  const realPage = page.getByRole('heading', { name: '一键拆书', exact: true, level: 1 })
  await realPage.waitFor({ timeout: 30000 })
  const afterRetry = report.chunkRequests.slice(attemptsBefore)
  check('🔴 ③ 重试真的重新请求了分包（不是复用已缓存的失败）', afterRetry.length >= 1 && afterRetry.every(item => !item.blocked), { attemptsBefore, afterRetry })
  check('🔴 ③ 重试后挂载出真页面，失败面板消失', await realPage.isVisible() && await notice.count() === 0)
  check('③ 真页面可以继续正常操作（原文入口与开始抽取按钮在）',
    await page.getByRole('button', { name: /开始抽取/ }).isVisible()
    && await page.getByPlaceholder(/把小说原文粘贴到这里/).isVisible())

  // ---------- ④ 换页再回来：已加载的页面不再重复请求 ----------
  const loadedOnce = report.chunkRequests.length
  await nav('写作面板').click(); await page.getByRole('navigation').waitFor()
  await openBookBreak()
  await page.getByRole('heading', { name: '一键拆书', exact: true, level: 1 }).waitFor({ timeout: 30000 })
  check('④ 切走再回来直接用已加载的包（不重复请求、不再报错）',
    report.chunkRequests.length === loadedOnce && await notice.count() === 0,
    { before: loadedOnce, after: report.chunkRequests.length })

  await page.screenshot({ path: path.join(run, 'lazy-chunk.png'), animations: 'disabled' })
  report.rejections = await page.evaluate(() => window.__rejections || [])
  check('全程没有模型请求', report.modelRequests.length === 0, report.modelRequests)
  check('🔴 全程没有未捕获的页面错误', report.errors.length === 0 && report.rejections.length === 0, { errors: report.errors, rejections: report.rejections })
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failure = String(error.stack || error)
  if (page) await page.screenshot({ path: path.join(run, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {})
} finally {
  if (page) report.rejections = await page.evaluate(() => window.__rejections || []).catch(() => report.rejections)
  report.stale = snapshot(root).fingerprint !== fingerprint
  if (report.stale) report.status = 'failed'
  report.passed = report.checks.filter(item => item.passed).length
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  await server?.close()
  console.log(JSON.stringify({ run, status: report.status, passed: report.passed, total: report.checks.length, stale: report.stale, failure: report.failure }))
  if (report.status !== 'passed') process.exitCode = 1
}
