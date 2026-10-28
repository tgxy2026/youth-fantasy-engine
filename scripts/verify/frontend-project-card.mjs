// Real project hub with a temporary browser profile and sample project only.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-project-card-')), fingerprint = snapshot(root).fingerprint
const report = { run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
let server, browser, page
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw Error(name + ': ' + JSON.stringify(details))
}
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', optimizeDeps: { entries: ['index.html'] },
    server: { host: 'localhost', port: 0, watch: { ignored: ['**/.workbuddy/**', '**/release/**', '**/dist/**'] } } })
  await server.listen(); const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => {
    const url = route.request().url()
    if (/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) { report.modelRequests.push('blocked'); return route.abort() }
    return url.startsWith(origin + '/') ? route.continue() : route.abort()
  })
  page = await context.newPage(); page.setDefaultTimeout(120000); page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(origin, { waitUntil: 'commit' }); await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click(); await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  const nav = page.getByRole('navigation')
  for (let attempt = 0; attempt < 100; attempt++) {
    const later = page.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.isVisible()) await later.click()
    if (await nav.isVisible()) break
    await page.waitForTimeout(100)
  }
  await nav.waitFor(); await page.getByRole('button', { name: '切换项目', exact: true }).click()
  const card = page.locator('[data-project-card]').first()
  await card.waitFor(); page.setDefaultTimeout(20000)
  const controls = ['打开项目', '导出 JSON 备份', '导出设定集', '备份与恢复', '编辑项目', '删除项目']
  const group = page.getByRole('group', { name: '界面密度', exact: true })
  for (const density of ['舒适', '紧凑']) {
    await group.getByRole('button', { name: density, exact: true }).click()
    for (const [width, height] of [[1280, 800], [1000, 640], [768, 640], [640, 640], [480, 640], [1536, 900]]) {
      await page.setViewportSize({ width, height })
      for (const zoom of [100, 125, 160]) {
        await page.evaluate(async value => (await import('/src/lib/settings/theme.ts')).applyZoom(value, { manual: true }), zoom)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const result = await card.evaluate((el, labels) => {
          const box = el.getBoundingClientRect(), buttons = labels.map(label => el.querySelector(`button[aria-label="${label}"]`))
          const bounds = buttons.map(button => button?.getBoundingClientRect().toJSON() ?? null)
          const within = bounds.every(rect => rect && rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 && rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5)
          const overlap = bounds.some((a, i) => bounds.some((b, j) => i < j && a && b && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1))
          const sameRow = bounds.every(rect => rect && bounds[0] && Math.abs(rect.top - bounds[0].top) < 1 && Math.abs(rect.bottom - bounds[0].bottom) < 1)
          return { box: box.toJSON(), bounds, within, overlap, sameRow }
        }, controls)
        check(`${density} ${width}x${height} zoom ${zoom}: six project actions stay in one row inside the card`, result.within && !result.overlap && result.sameRow, result)
      }
    }
  }
  check('no actual model requests or browser errors', !report.modelRequests.length && !report.errors.length, { models: report.modelRequests, errors: report.errors })
  await page.screenshot({ path: path.join(run, 'project-card.png'), animations: 'disabled' }); report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); await page?.screenshot({ path: path.join(run, 'failure.png'), animations: 'disabled' }).catch(() => {}) }
finally {
  report.stale = fingerprint !== snapshot(root).fingerprint; if (report.stale) report.status = 'failed'
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close()
  console.log(JSON.stringify({ run, status: report.status, passed: report.checks.filter(c => c.passed).length, total: report.checks.length, stale: report.stale, failure: report.failure })); if (report.status !== 'passed') process.exitCode = 1
}
