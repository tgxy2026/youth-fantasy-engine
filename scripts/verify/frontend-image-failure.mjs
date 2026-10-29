// UX13 · 图片加载失败的可见降级与**真重试**：真实浏览器取证（真实 `<img>`、真实网络失败）。
//
// 用隔离夹具 `tests/browser/images.html`：探针把同一张图前几次打成 404，之后放真图。
// 要证的是：
//   ① 失败时不画破图标，而是可读的占位（`data-image-failure` + 「图片没能加载」+ aria 说明）；
//   ② 占位沿用同一套 className ⇒ 有图无图盒子尺寸一致，列表不跳；
//   ③ 「重试」真的**重新发请求**并换成真图（换新节点重试，不是重挂壳子）；
//   ④ 小缩略图（`retry={false}`）只占位不给按钮；
//   ⑤ 全程 0 页面异常、0 模型请求。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-image-failure-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-image-failure', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], modelRequests: [], imageRequests: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}

/** 1×1 透明 PNG */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
/** 先放失败、后放真图：模拟「网断了一下 / 图刚被同步回来」 */
let serveImage = false

let server, browser, page
try {
  server = await createServer({ optimizeDeps: { entries: ['index.html', 'tests/browser/*.html'] }, root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1000, height: 640 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => {
    const url = route.request().url()
    if (/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) report.modelRequests.push({ method: route.request().method(), origin: new URL(url).origin })
    if (!url.startsWith(origin + '/')) return route.abort()
    if (new URL(url).pathname === '/tests/browser/probe-image.png') {
      report.imageRequests.push({ query: new URL(url).search, served: serveImage })
      return serveImage
        ? route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
        : route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' })
    }
    return route.continue()
  })
  page = await context.newPage()
  page.setDefaultTimeout(60000)
  page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(origin + '/tests/browser/images.html', { waitUntil: 'commit' })
  const retryable = page.locator('#retryable')
  const plain = page.locator('#plain')
  const placeholder = retryable.locator('[data-image-failure]')
  await placeholder.waitFor({ timeout: 30000 })

  // ---------- ① 失败 = 可读占位，不是破图 ----------
  check('🔴 ① 图坏了给可读占位，不画破图标', await placeholder.isVisible()
    && await placeholder.getByText('图片没能加载', { exact: true }).isVisible()
    && await retryable.locator('img').count() === 0)
  check('① 占位带无障碍说明（读屏知道这张图没出来）',
    /没能加载/.test(await placeholder.getAttribute('aria-label') ?? '') && await placeholder.getAttribute('role') === 'img')
  // 占位与 img 用的是同一套 `absolute inset-0 w-full h-full`：量出来应等于宿主的内容盒（clientWidth/Height），
  // 不是 getBoundingClientRect —— 宿主带 1px 边框时后者会多出边框宽度，比出来的差是假的。
  check('① 占位沿用同一套尺寸类 ⇒ 有图无图盒子一样大', await placeholder.evaluate((el, host) => {
    const box = el.getBoundingClientRect()
    return Math.abs(box.width - host.clientWidth) < 1.5 && Math.abs(box.height - host.clientHeight) < 1.5
  }, await retryable.elementHandle()))

  // ---------- ② 小缩略图只占位、不给按钮 ----------
  const plainPlaceholder = plain.locator('[data-image-failure]')
  await plainPlaceholder.waitFor({ timeout: 15000 })
  check('🔴 ② 小缩略图（retry=false）只占位、不塞按钮',
    await plainPlaceholder.isVisible() && await plainPlaceholder.getByRole('button', { name: '重试', exact: true }).count() === 0)
  check('② 大图占位给出重试入口', await placeholder.getByRole('button', { name: '重试', exact: true }).isVisible())

  await page.screenshot({ path: path.join(run, 'image-failure.png'), animations: 'disabled' })

  // ---------- ③ 重试 = 真重新请求 ----------
  const before = report.imageRequests.length
  serveImage = true
  await placeholder.getByRole('button', { name: '重试', exact: true }).click()
  await retryable.locator('img').waitFor({ timeout: 20000 })
  const after = report.imageRequests.slice(before)
  check('🔴 ③ 重试真的重新请求了图片（不是复用失败结果）', after.length >= 1 && after.every(item => item.served), { before, after })
  check('🔴 ③ 重试后显示真图，占位消失', await retryable.locator('img').evaluate(img => img.complete && img.naturalWidth > 0)
    && await retryable.locator('[data-image-failure]').count() === 0)
  check('③ 另一张没点重试的仍是占位（互不影响）', await plain.locator('[data-image-failure]').count() === 1)

  await page.screenshot({ path: path.join(run, 'image-retried.png'), animations: 'disabled' })
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
