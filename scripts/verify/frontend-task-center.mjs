// Real React task hooks/indicator + isolated deferred jobs. No author data or model endpoints.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-task-center-'))
const fingerprint = snapshot(root).fingerprint
const fixtureHash = async () => {
  const hash = createHash('sha256')
  for (const file of ['task-center.html', 'task-center.tsx']) hash.update(await fs.readFile(path.join(root, 'tests/browser', file)))
  return hash.digest('hex')
}
const fixtureFingerprint = await fixtureHash()
const report = { run, fingerprint, fixtureFingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
let server, browser, page
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw Error(name + ': ' + JSON.stringify(details))
}
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error',
    optimizeDeps: { entries: ['tests/browser/task-center.html'] },
    server: { host: 'localhost', port: 0, watch: { ignored: ['**/.workbuddy/**', '**/release/**', '**/dist/**'] } } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => {
    const url = route.request().url()
    if (/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) { report.modelRequests.push('blocked'); return route.abort() }
    return url.startsWith(origin + '/') ? route.continue() : route.abort()
  })
  page = await context.newPage(); page.setDefaultTimeout(120000)
  page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(origin + '/tests/browser/task-center.html', { waitUntil: 'commit' })
  await page.getByRole('button', { name: '启动隔离任务', exact: true }).waitFor()
  page.setDefaultTimeout(15000)
  // Record actual toast DOM, independent of how often React renders an effect.
  await page.evaluate(() => {
    window.taskToasts = []
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        const items = [...(node.matches('.pointer-events-auto.border.shadow-2xl') ? [node] : []), ...node.querySelectorAll('.pointer-events-auto.border.shadow-2xl')]
        for (const item of items) window.taskToasts.push(item.textContent)
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  // Hide the consumer, finish simultaneous jobs, then remount under StrictMode.
  await page.getByRole('button', { name: '开关任务指示器', exact: true }).click()
  await page.evaluate(async () => {
    const tasks = await import('/src/lib/ai/aiTaskCenter.ts')
    tasks.startTask({ ownerTab: 'a', kind: 'one', title: '并发失败甲', run: async () => { throw Error('失败甲原因') } })
    tasks.startTask({ ownerTab: 'b', kind: 'two', title: '并发失败乙', run: async () => { throw Error('失败乙原因') } })
    tasks.startTask({ ownerTab: 'c', kind: 'quiet', title: '成功不提示', run: async () => 'ok', notify: () => null })
  })
  await page.getByRole('button', { name: '开关任务指示器', exact: true }).click()
  await page.waitForFunction(() => window.taskToasts.length > 0)
  await page.waitForTimeout(150)
  const notices = await page.evaluate(() => window.taskToasts)
  check('simultaneous failures each notify once after a StrictMode consumer remount', notices.filter(text => text.includes('失败甲原因')).length === 1 && notices.filter(text => text.includes('失败乙原因')).length === 1 && notices.length === 2, notices)
  check('custom silent success emits no fallback toast', !notices.some(text => text.includes('成功不提示')), notices)
  await page.evaluate(async () => { (await import('/src/lib/ai/aiTaskCenter.ts')).resetTaskCenter(); window.taskToasts = [] })
  await page.getByRole('button', { name: '启动隔离任务', exact: true }).click()
  const id = await page.evaluate(async () => (await import('/src/lib/ai/aiTaskCenter.ts')).tasksSnapshot()[0].id)
  for (let round = 0; round < 50; round++) {
    await page.getByRole('button', { name: '开关任务面板', exact: true }).click()
    await page.locator('[data-task-view]').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '开关任务面板', exact: true }).click()
    await page.locator('[data-task-view][data-status="running"]').waitFor()
  }
  const lifecycle = await page.evaluate(async () => ({ runs: window.taskRuns, aborted: window.taskSignal.aborted, tasks: (await import('/src/lib/ai/aiTaskCenter.ts')).tasksSnapshot().map(t => ({ id: t.id, status: t.status })) }))
  check('50 actual panel close/reopen cycles retain one running job without aborting or rerunning', lifecycle.runs === 1 && !lifecycle.aborted && lifecycle.tasks.length === 1 && lifecycle.tasks[0].id === id && lifecycle.tasks[0].status === 'running', lifecycle)
  await page.getByRole('button', { name: '切换页签', exact: true }).click()
  await page.locator('[data-task-view]').waitFor({ state: 'hidden' })
  const payload = '<script>window.taskExecuted=true</script>\n' + '长结果完整原文\n'.repeat(2000) + '末尾完整保留'
  await page.evaluate(text => window.finishTask(text), payload)
  await page.waitForFunction(() => window.taskToasts.length === 1)
  check('completion while its panel is unmounted still emits exactly one actual toast', (await page.evaluate(() => window.taskToasts)).length === 1)
  await page.getByRole('button', { name: '查看', exact: true }).click()
  await page.locator('[data-task-result]').waitFor()
  check('view action returns to the original page and hook recovers the full long text as inert text', await page.locator('[data-task-result]').textContent() === payload && await page.evaluate(() => !window.taskExecuted) && await page.locator('[data-task-result] script').count() === 0)
  await page.getByRole('button', { name: '开关任务面板', exact: true }).click()
  await page.getByRole('button', { name: '开关任务面板', exact: true }).click()
  check('reopening completed results never regenerates or repeats the notification', await page.locator('[data-task-result]').textContent() === payload && await page.evaluate(() => window.taskRuns === 1 && window.taskToasts.length === 1))
  await page.evaluate(async () => (await import('/src/lib/ai/aiTaskCenter.ts')).resetTaskCenter())
  await page.getByRole('button', { name: '启动隔离任务', exact: true }).click()
  await page.getByRole('button', { name: '中止', exact: true }).click()
  check('explicit stop sends abort while ordinary panel closing did not', await page.evaluate(() => window.taskSignal.aborted))
  await page.evaluate(() => window.finishTask('中止后的晚结果'))
  await page.locator('[data-task-view][data-status="aborted"]').waitFor()
  check('aborted jobs never display a successful late result', !await page.locator('[data-task-result]').count() && await page.evaluate(() => window.taskToasts.length === 1))
  await page.evaluate(async () => (await import('/src/lib/ai/aiTaskCenter.ts')).resetTaskCenter())
  await page.getByRole('button', { name: '启动隔离任务', exact: true }).click()
  await page.evaluate(async () => { (await import('/src/lib/ai/aiTaskCenter.ts')).resetTaskCenter(); window.finishTask('上一本书晚结果') })
  await page.locator('[data-task-view][data-status="idle"]').waitFor()
  await page.waitForTimeout(100)
  check('project reset discards old late results and notices', await page.evaluate(async () => !(await import('/src/lib/ai/aiTaskCenter.ts')).tasksSnapshot().length && window.taskToasts.length === 1))
  // Repeat the delivery boundary in the real App/Sidebar, including collapsed tools.
  await page.goto(origin, { waitUntil: 'commit' }); page.setDefaultTimeout(120000)
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  const nav = page.getByRole('navigation')
  for (let attempt = 0; attempt < 100; attempt++) {
    const later = page.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.isVisible()) await later.click()
    if (await nav.isVisible()) break
    await page.waitForTimeout(100)
  }
  await nav.waitFor(); page.setDefaultTimeout(20000)
  await page.getByRole('button', { name: '收起左下角工具栏', exact: true }).click()
  await page.evaluate(async () => {
    window.appToasts = []
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        const items = [...(node.matches('.pointer-events-auto.border.shadow-2xl') ? [node] : []), ...node.querySelectorAll('.pointer-events-auto.border.shadow-2xl')]
        for (const item of items) if (item.textContent.includes('应用后台回归')) window.appToasts.push(item.textContent)
      }
    }).observe(document.body, { childList: true, subtree: true })
    const center = await import('/src/lib/ai/aiTaskCenter.ts')
    const ids = []
    for (const label of ['甲', '乙']) ids.push(center.startTask({ ownerTab: 'dashboard', kind: 'app-' + label, title: '应用后台回归' + label,
      run: () => new Promise((_, reject) => { (window.appFail ??= []).push(() => reject(Error('隔离失败' + label))) }) }))
    window.appTaskIds = ids
  })
  await nav.getByRole('button', { name: '模型设置', exact: true }).click()
  await page.evaluate(() => window.appFail.forEach(fail => fail()))
  await page.waitForFunction(() => window.appToasts.length === 2)
  check('real App keeps the collapsed Sidebar subscriber alive and delivers both background failures once', await page.evaluate(() => window.appToasts.length === 2 && window.appToasts.some(text => text.includes('隔离失败甲')) && window.appToasts.some(text => text.includes('隔离失败乙'))))
  await page.getByRole('button', { name: '展开左下角工具栏', exact: true }).click()
  await page.locator('[data-task-status="failed"]').first().waitFor()
  check('expanding tools exposes both failed records and a return action for each', await page.locator('[data-sidebar-tools] [data-task-status="failed"]').count() === 2 && await page.locator('[data-sidebar-tools]').getByRole('button', { name: '查看', exact: true }).count() === 2)
  await page.locator('[data-sidebar-tools]').getByRole('button', { name: '查看', exact: true }).first().click()
  check('real Sidebar view action navigates back without rerunning or repeating notices', await nav.getByRole('button', { name: '写作面板', exact: true }).getAttribute('aria-current') === 'page' && await page.evaluate(() => window.appToasts.length === 2))
  check('no actual model requests or browser errors', !report.modelRequests.length && !report.errors.length, { models: report.modelRequests, errors: report.errors })
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.failure = error.stack || String(error)
  await page?.screenshot({ path: path.join(run, 'failure.png'), animations: 'disabled' }).catch(() => {})
} finally {
  report.stale = fingerprint !== snapshot(root).fingerprint || fixtureFingerprint !== await fixtureHash()
  if (report.stale) report.status = 'failed'
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close(); await server?.close()
  console.log(JSON.stringify({ run, status: report.status, passed: report.checks.filter(c => c.passed).length, total: report.checks.length, stale: report.stale, failure: report.failure }))
  if (report.status !== 'passed') process.exitCode = 1
}
