// AC27 / UX09 · 模型输出含 HTML 与脚本时**不执行**：真实浏览器取证（真实编辑器 + 真高亮叠层）。
//
// 高亮叠层是**全仓唯一** `dangerouslySetInnerHTML`。模型输出被粘进正文后，若这里漏转义，
// `<img onerror>` / `<script>` 会在编辑器里真的跑起来。要证的是：
//   ① 叠层里**没有**任何注入的标签（img/script/b 元素数为 0）；
//   ② 注入串里的脚本没执行（哨兵变量保持 undefined）；
//   ③ 正文原样保留（textarea 值与叠层文本都等于原文，不偷偷改写作者稿子）；
//   ④ 引用名高亮仍然只有 `<mark class="ref-mark">` 这一种真标签；
//   ⑤ 全程 0 页面异常、0 模型请求。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-editor-html-safety-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-editor-html-safety', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}

const PAYLOAD = [
  '陈渊推门进来，肩上还沾着雨。',
  '<img src=x onerror="window.__pwned=1">',
  '<script>window.__pwned=2</script>',
  '<b>这不是粗体，只是文本</b>',
  '陈渊抬头，屋里的灯晃了一下。',
].join('\n')

let server, browser, page
try {
  server = await createServer({ optimizeDeps: { entries: ['index.html', 'tests/browser/*.html'] }, root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' })
  // 引用名高亮默认关闭：这里显式打开，才走得到那段 dangerouslySetInnerHTML
  await context.addInitScript(() => { try { localStorage.setItem('yfe-ui:editor-reference-highlight', '1') } catch { /* 隐私模式 */ } })
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

  for (const name of ['稍后再说', '知道了', '跳过，直接开始']) {
    await page.getByRole('button', { name, exact: true }).click({ timeout: 1500 }).catch(() => {})
  }
  await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
  const editor = page.locator('textarea.novel-textarea')
  await editor.waitFor()
  await editor.fill(PAYLOAD)
  // 等叠层真的按新内容重算（叠层是 120ms 防抖后的镜像）
  await page.waitForFunction(expected => {
    const layers = [...document.querySelectorAll('div.novel-textarea')]
    return layers.some(el => el.innerHTML.includes('&lt;img'))
  }, PAYLOAD, { timeout: 15000 }).catch(() => {})

  const overlay = await page.evaluate(() => {
    const layers = [...document.querySelectorAll('div.novel-textarea')]
    const el = layers.find(node => node.innerHTML.includes('&lt;img')) ?? null
    if (!el) return null
    return {
      injectedElements: el.querySelectorAll('img, script, b, iframe, object, embed').length,
      marks: el.querySelectorAll('mark.ref-mark').length,
      markClasses: [...el.querySelectorAll('mark')].map(m => m.className),
      text: el.textContent,
      htmlSample: el.innerHTML.slice(0, 220),
      pwned: window.__pwned ?? null,
    }
  })

  check('🔴 ① 高亮叠层里没有被注入的元素（img/script/b 全为 0）', !!overlay && overlay.injectedElements === 0, overlay)
  check('🔴 ② 注入串里的脚本没有执行（哨兵仍为空）', !!overlay && overlay.pwned === null, overlay && overlay.pwned)
  check('🔴 ③ 正文原样保留：textarea 值与叠层文本都等于原文',
    await editor.inputValue() === PAYLOAD && !!overlay && overlay.text === PAYLOAD, { overlayText: overlay && overlay.text })
  check('④ 唯一的真标签是引用名 mark（且 class 白名单只有 ref-mark）',
    !!overlay && overlay.markClasses.every(name => name === 'ref-mark') && overlay.marks > 0, overlay && overlay.markClasses)
  check('④ 注入串在叠层里是转义文本，不是标签', !!overlay && overlay.htmlSample.includes('&lt;img') && !overlay.htmlSample.includes('<img'), overlay && overlay.htmlSample)

  await page.screenshot({ path: path.join(run, 'editor-html-safety.png'), animations: 'disabled' })
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
