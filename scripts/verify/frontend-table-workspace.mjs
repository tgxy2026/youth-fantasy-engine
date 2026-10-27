// Real virtualized table + Atlas flags. Fresh demo and isolated IDB; no model/backend success mocked.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-table-workspace-')), fingerprint = snapshot(root).fingerprint
const report = { run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
const check = (name, ok, details) => { report.checks.push({ name, passed: !!ok, details }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) throw Error(name + ': ' + JSON.stringify(details)) }
let server, browser, page
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', optimizeDeps: { entries: ['index.html'] },
    server: { host: 'localhost', port: 0, watch: { ignored: ['**/.workbuddy/**', '**/dist/**', '**/release/**'] } } })
  await server.listen(); const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1560, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => {
    const url = route.request().url(); if (/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) report.modelRequests.push('blocked')
    return url.startsWith(origin + '/') ? route.continue() : route.abort()
  })
  page = await context.newPage(); page.setDefaultTimeout(120000); page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(origin, { waitUntil: 'commit' }); await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click(); await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByRole('button', { name: '稍后再说', exact: true }).click(); page.setDefaultTimeout(20000)
  await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts'), pid = db.getCurrentProjectId()
    ;(await import('/src/lib/settings/theme.ts')).applyZoom(100, { manual: true })
    for (let i = 0; i < 150; i++) await db.saveTableRow({ id: 'table-view-' + i, projectId: pid, tabId: 'races', order: i,
      data: { 名称: '滚动现场' + String(i).padStart(3, '0'), 编号: String(i).padStart(4, '0'), 备注: '不能进入视图的记录正文\n'.repeat(i % 3 + 1) } })
  })
  const nav = page.getByRole('navigation'), table = () => page.locator('[data-table-scroll]')
  const enter = async () => {
    if (!await nav.getByRole('button', { name: '种族生物', exact: true }).isVisible()) await nav.getByRole('button', { name: '世界构建', exact: true }).click()
    await nav.getByRole('button', { name: '种族生物', exact: true }).click()
  }
  const mode = name => page.locator('main header').getByRole('button', { name, exact: true }).click()
  const dashboard = () => nav.getByRole('button', { name: '写作面板', exact: true }).click()
  const settle = () => table().evaluate(async el => {
    let last = '', stable = 0
    for (let i = 0; i < 100; i++) { await new Promise(resolve => requestAnimationFrame(resolve)); const key = [el.scrollTop, el.scrollLeft, el.scrollHeight, el.clientHeight].join(':')
      stable = last === key && !el.dataset.workspaceRestoring ? stable + 1 : 0; last = key; if (stable >= 5) return }
    throw Error('table geometry did not settle')
  })
  const anchor = wanted => table().evaluate((el, wanted) => {
    const box = el.getBoundingClientRect(), header = el.querySelector('thead tr').getBoundingClientRect(), z = box.height / el.offsetHeight
    const row = [...el.querySelectorAll('tbody [data-workspace-record]')].find(node => wanted ? node.dataset.workspaceRecord === wanted.row.id : node.getBoundingClientRect().bottom > header.bottom && node.getBoundingClientRect().top < box.bottom)
    const col = [...el.querySelectorAll('[data-workspace-column]')].find(node => wanted ? node.dataset.workspaceColumn === wanted.column.id : node.getBoundingClientRect().right > box.left)
    return { top: el.scrollTop, left: el.scrollLeft, count: el.querySelectorAll('tbody [data-workspace-record]').length,
      row: row && { id: row.dataset.workspaceRecord, offset: (row.getBoundingClientRect().top - header.bottom) / z },
      column: col && { id: col.dataset.workspaceColumn, offset: (col.getBoundingClientRect().left - box.left) / z } }
  }, wanted)
  await enter(); await table().waitFor(); await settle()
  check('large ordinary table remains virtualized', (await anchor()).count < 80)
  await table().evaluate(el => { el.scrollTop = el.scrollHeight * .64; el.scrollLeft = 1100 }); await settle(); const initial = await anchor()
  check('fixture genuinely scrolls both axes beyond the initial virtual window', initial.top > 1000 && initial.left > 500 && Number(initial.row.id.split('-').at(-1)) > 60 && Math.abs(initial.row.offset) < 200, initial)
  await dashboard(); await enter(); await table().waitFor(); await settle(); const back = await anchor(initial)
  check('ordinary table round trip restores the same row and column anchors', back.row?.id === initial.row.id && Math.abs(back.row.offset - initial.row.offset) < 8 && Math.abs(back.column.offset - initial.column.offset) < 8, { initial, back })
  await mode('图鉴'); await page.locator('[data-atlas-list]').waitFor(); await mode('表格'); await settle(); const switched = await anchor(initial)
  check('virtual row listeners reconnect after switching from Atlas back to the table', switched.row?.id === initial.row.id && Math.abs(switched.row.offset - initial.row.offset) < 8, switched)
  await dashboard(); await page.evaluate(async () => { (await import('/src/lib/settings/density.ts')).applyDensity('comfortable'); (await import('/src/lib/settings/theme.ts')).applyZoom(110, { manual: true }) })
  await enter(); await table().waitFor(); await settle(); const reflow = await anchor(initial)
  check('density and CSS zoom reflow preserve logical anchors rather than stale pixels', reflow.row?.id === initial.row.id && Math.abs(reflow.row.offset - initial.row.offset) < 9 && Math.abs(reflow.column.offset - initial.column.offset) < 9, reflow)
  // Current interaction always beats an in-flight restoration; invalidation never replaces a live cell.
  // Edit the name, not the sortable code column (changing a code legitimately moves its row).
  const cell = table().locator(`[data-workspace-record="${initial.row.id}"] textarea`).nth(1)
  await cell.fill('视图清理不能丢掉这个草稿'); await cell.evaluate(el => { el.dataset.keepWorkspaceDom = 'same' })
  const beforeClear = await table().evaluate(el => el.scrollTop)
  await page.evaluate(async () => (await import('/src/lib/settings/workspaceViewState.ts')).workspaceViews.clear())
  await settle()
  check('clearing optional views preserves the actual virtualized draft input and viewport', await cell.inputValue() === '视图清理不能丢掉这个草稿' && await cell.getAttribute('data-keep-workspace-dom') === 'same' && Math.abs(await table().evaluate(el => el.scrollTop) - beforeClear) < 2)
  await page.locator('main header').getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(async () => (await (await import('/src/lib/db.ts')).getTableRows('races')).some(row => Object.values(row.data).includes('视图清理不能丢掉这个草稿')))
  const targetId = 'table-view-8'
  await page.evaluate(targetId => window.dispatchEvent(new CustomEvent('yfe:navigate', { detail: { tabId: 'races', rowId: targetId } })), targetId)
  await table().locator(`[data-workspace-record="${targetId}"]`).waitFor(); await settle()
  check('explicit navigation to an unmounted row beats the remembered viewport', await table().locator(`[data-workspace-record="${targetId}"]`).evaluate(el => { const scroller = el.closest('[data-table-scroll]'), r = el.getBoundingClientRect(), b = scroller.getBoundingClientRect(); return r.bottom > b.top && r.top < b.bottom }))
  await table().evaluate(el => { el.scrollTop = el.scrollHeight * .55; el.scrollLeft = 700 }); await settle(); const gone = await anchor()
  await dashboard(); await page.evaluate(async id => (await import('/src/lib/db.ts')).deleteTableRow(id), gone.row.id)
  await enter(); await table().waitFor(); await settle()
  check('deleted row anchors fall back to the top without resurrecting a record', await table().evaluate(el => el.scrollTop) < 2 && await table().locator(`[data-workspace-record="${gone.row.id}"]`).count() === 0)
  await mode('图鉴'); await page.locator('[data-workspace-record="table-view-20"]').click(); const empty = () => page.getByRole('checkbox', { name: '显示未填写字段', exact: true })
  check('new Atlas records retain the default hidden-empty state', !await empty().isChecked())
  await empty().check(); await page.locator('main aside').getByRole('button', { name: /返回|关闭/ }).first().click()
  await page.locator('[data-workspace-record="table-view-21"]').click(); check('Atlas display flags are isolated per record', !await empty().isChecked())
  await page.locator('main aside').getByRole('button', { name: /返回|关闭/ }).first().click(); await page.locator('[data-workspace-record="table-view-20"]').click()
  check('reopening the original Atlas record restores its empty-field flag', await empty().isChecked())
  await mode('表格'); await mode('图鉴'); check('display flags survive a real mode round trip', await empty().isChecked())
  await dashboard(); await enter(); check('display flags survive a real page round trip', await empty().isChecked())
  await page.evaluate(async () => (await import('/src/lib/settings/workspaceViewState.ts')).workspaceViews.clear())
  check('view reset clears the display flag without entering or leaving edit mode', !await empty().isChecked())
  const metadata = await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts'), { workspaceViews } = await import('/src/lib/settings/workspaceViewState.ts'), { currentWorkspaceScope } = await import('/src/lib/settings/workspaceRuntime.ts')
    return JSON.stringify(workspaceViews.get(currentWorkspaceScope(db.getCurrentProjectId(), 'table-scroll:races'), 'viewport'))
  })
  check('table metadata contains no business record text or draft bodies', !metadata.includes('视图清理') && !metadata.includes('不能进入视图'))
  check('no real model requests or browser errors', !report.errors.length && !report.modelRequests.length, { errors: report.errors, modelRequests: report.modelRequests })
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = error.stack || String(error)
  await page?.screenshot({ path: path.join(run, 'failure.png'), animations: 'disabled' }).catch(() => {}) }
finally {
  report.stale = fingerprint !== snapshot(root).fingerprint; if (report.stale) report.status = 'failed'
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close()
  console.log(JSON.stringify({ run, status: report.status, passed: report.checks.filter(c => c.passed).length, total: report.checks.length, stale: report.stale, failure: report.failure })); if (report.status !== 'passed') process.exitCode = 1
}
