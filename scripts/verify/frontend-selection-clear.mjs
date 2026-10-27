// Actual shared controls and the CharacterSheet save path, in a fresh isolated browser IDB.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-selection-clear-'))
const fingerprint = snapshot(root).fingerprint
const fixtureHash = async () => {
  const hash = createHash('sha256')
  for (const file of ['selection-clear.html', 'selection-clear.tsx']) hash.update(await fs.readFile(path.join(root, 'tests/browser', file)))
  return hash.digest('hex')
}
const fixtureFingerprint = await fixtureHash()
const report = { kind: 'frontend-selection-clear', at: new Date().toISOString(), run, fingerprint, fixtureFingerprint, checks: [], errors: [], modelRequests: [], assetFailures: [], status: 'running' }
const check = (name, passed, details) => { report.checks.push({ name, passed: !!passed, details }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`); if (!passed) throw Error(name + ': ' + JSON.stringify(details)) }
let server, browser, page
const pending = new Map()
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error',
    optimizeDeps: { entries: ['index.html', 'tests/browser/selection-clear.html'] },
    server: { host: 'localhost', port: 0, watch: { ignored: ['**/.workbuddy/**', '**/release/**', '**/dist/**'] } } })
  await server.listen(); const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => {
    const url = route.request().url()
    if (/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) report.modelRequests.push(route.request().method())
    return url.startsWith(origin + '/') ? route.continue() : route.abort()
  })
  page = await context.newPage(); page.setDefaultTimeout(120000); page.on('pageerror', error => report.errors.push(error.message))
  page.on('request', request => pending.set(request, new URL(request.url()).pathname))
  page.on('requestfinished', request => pending.delete(request))
  page.on('requestfailed', request => { report.assetFailures.push({ path: pending.get(request), error: request.failure()?.errorText }); pending.delete(request) })
  await page.goto(origin + '/tests/browser/selection-clear.html', { waitUntil: 'commit' })
  const section = name => page.getByRole('region', { name, exact: true })
  const value = name => section(name).locator('output').getAttribute('data-value')
  const waitValue = (name, value) => page.waitForFunction(({ name, value }) => [...document.querySelectorAll('section')]
    .find(el => el.getAttribute('aria-label') === name)?.querySelector('output')?.getAttribute('data-value') === value, { name, value })
  const open = name => section(name).locator('button[aria-expanded]').click()
  const popup = placeholder => page.getByPlaceholder(placeholder, { exact: true }).locator('..').locator('..')
  const refs = () => popup('搜索或手动输入…'), customs = () => popup('搜索选项…')
  const remove = (scope, name) => scope.getByRole('button', { name: '取消选择：' + name, exact: true }).click()
  await section('引用多选').waitFor(); page.setDefaultTimeout(20000)
  await open('引用多选'); await page.getByPlaceholder('搜索或手动输入…').fill('手动势力')
  await refs().getByRole('button', { name: '使用「手动势力」', exact: true }).click()
  check('manual multi entry appends without losing the existing choice', await value('引用多选') === '候选甲，手动势力')
  await open('引用多选'); await page.getByPlaceholder('搜索或手动输入…').fill('完全不匹配')
  await remove(refs(), '手动势力')
  check('manual value remains removable under an unrelated search', await value('引用多选') === '候选甲')
  check('multi removal returns keyboard focus to the live search', await page.getByPlaceholder('搜索或手动输入…').evaluate(el => el === document.activeElement))
  await page.getByPlaceholder('搜索或手动输入…').fill(''); await refs().getByRole('button', { name: '候选甲', exact: true }).click()
  check('existing multi option still toggles off', await value('引用多选') === '')
  await refs().getByRole('button', { name: '候选乙', exact: true }).click(); await refs().getByRole('button', { name: '候选甲', exact: true }).click()
  await refs().getByRole('button', { name: '清空当前选择', exact: true }).click()
  check('clear all empties the field and closes its popup', await value('引用多选') === '' && !await page.getByPlaceholder('搜索或手动输入…').count())
  await open('引用单选'); await remove(refs(), '旧的手动输入')
  check('legacy single value absent from the catalogue can be cleared', await value('引用单选') === '')
  await open('引用单选'); await refs().getByRole('button', { name: '候选乙', exact: true }).click()
  await open('引用单选'); await refs().getByRole('button', { name: '候选乙', exact: true }).click()
  check('single existing choice can be toggled off', await value('引用单选') === '')
  await open('空候选'); await page.getByPlaceholder('搜索或手动输入…').fill('孤立值'); await page.getByPlaceholder('搜索或手动输入…').press('Enter')
  await open('空候选'); const orphan = refs().getByRole('button', { name: '取消选择：孤立值', exact: true }); await orphan.focus(); await orphan.press('Space')
  check('an empty source does not strand manual input; removal supports the keyboard', await value('空候选') === '')
  await page.keyboard.press('Escape')
  await open('可扩展选项'); await remove(customs(), '已删除选项')
  check('CustomSelect can clear a legacy value missing from all options', await value('可扩展选项') === '')
  await open('可扩展选项'); await customs().getByRole('button', { name: '添加新值…', exact: true }).click()
  await page.getByPlaceholder('输入新选项').fill('本次新增'); await page.getByPlaceholder('输入新选项').press('Enter')
  await waitValue('可扩展选项', '本次新增')
  check('new custom option remains selectable through the original persistence path', await value('可扩展选项') === '本次新增')
  const catalogue = await page.evaluate(() => window.__selectionClear.catalogue())
  await open('可扩展选项'); await remove(customs(), '本次新增')
  check('clearing one value preserves the shared catalogue and the sibling selection', JSON.stringify(catalogue) === JSON.stringify(await page.evaluate(() => window.__selectionClear.catalogue())) && await value('同列其他字段') === '共享自定义')
  await open('可扩展选项'); await customs().getByRole('button', { name: /^候选甲$/ }).click()
  await open('可扩展选项'); await customs().getByRole('button', { name: /^候选甲$/ }).click()
  check('CustomSelect builtin selection also toggles off', await value('可扩展选项') === '')
  await open('固定档位'); await customs().getByRole('button', { name: 'S', exact: true }).click()
  check('fixed machine-readable enums keep their existing selection contract', await value('固定档位') === 'S')
  await open('角色引用'); const roles = popup('搜索角色…'); await remove(roles, '已删除角色')
  check('deleted-source character values can be removed while existing references survive', await value('角色引用') === '已有角色')
  await page.getByPlaceholder('搜索角色…').fill('任意未建角色')
  check('character reference does not gain arbitrary manual creation', !await roles.getByRole('button', { name: /使用「|添加新值/ }).count())
  await remove(roles, '已有角色'); await page.keyboard.press('Escape')
  await remove(section('图鉴多选'), '旧手动标签')
  check('Atlas JSON multi selection removes a legacy value and preserves order', await value('图鉴多选') === '["候选甲","候选乙"]')
  await section('图鉴多选').getByRole('button', { name: '清空当前选择', exact: true }).click()
  check('Atlas clear uses the canonical empty string', await value('图鉴多选') === '')
  await section('图鉴多选').locator('summary').click(); await section('图鉴多选').getByRole('checkbox', { name: '候选甲', exact: true }).check()
  check('Atlas configured checkbox behavior survives the fix', await value('图鉴多选') === '["候选甲"]')
  await section('图鉴补配候选').locator('textarea').fill('旧手工甲、旧手工乙')
  await section('图鉴补配候选').getByRole('button', { name: '加载候选', exact: true }).click(); await remove(section('图鉴补配候选'), '旧手工甲')
  check('adding a catalogue later does not lock previously typed Atlas values', await value('图鉴补配候选') === '["旧手工乙"]')
  check('selection controls never accidentally submit their containing form', await page.evaluate(() => window.__selectionClear.submits()) === 0)
  await page.setViewportSize({ width: 390, height: 844 })
  const long = '<script>window.__selectionScriptRan=true</script>' + 'LongManualValue'.repeat(24)
  await open('空候选'); await page.getByPlaceholder('搜索或手动输入…').fill(long); await page.getByPlaceholder('搜索或手动输入…').press('Enter')
  await open('空候选'); const longButton = refs().getByRole('button', { name: '取消选择：' + long, exact: true })
  const bounds = await longButton.boundingBox()
  check('long manual value is removable within a narrow viewport', bounds.x >= 0 && bounds.x + bounds.width <= 391, bounds)
  check('manual values are text and cannot execute markup', !await page.evaluate(() => window.__selectionScriptRan))
  await page.screenshot({ path: path.join(run, 'narrow-manual-value.png'), animations: 'disabled' }); await longButton.click()

  // Fresh normal SPA, real CharacterSheet editor, explicit DB verification after save and reload.
  await page.setViewportSize({ width: 1366, height: 900 }); await page.goto(origin, { waitUntil: 'commit' }); page.setDefaultTimeout(120000)
  await page.getByRole('button', { name: /先看看示例/ }).click(); await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click(); await page.getByRole('button', { name: '稍后再说', exact: true }).click()
  const seed = await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts'), { TABS } = await import('/src/lib/schema.ts')
    const tab = TABS.find(t => t.id === 'char-main'), pid = db.getCurrentProjectId()
    const group = tab.modules.find(m => m.fields.some(f => f.name === '所属势力')), key = group.name + '::所属势力'
    await db.saveTableRow({ id: 'clear-source-nation', projectId: pid, tabId: 'nations', data: { 名称: '保留势力', 类别: '手工分类', 地理位置: '手动地名' }, order: 900 })
    await db.saveCardRecord({ id: 'clear-real-card', projectId: pid, tabId: 'char-main', name: '清除回归角色', data: { [key]: '保留势力，手动旧势力', 'fixture::保留': '不应改变' }, order: 900 })
    return { key, pid }
  })
  const nav = page.getByRole('navigation')
  if (!await nav.getByRole('button', { name: '主要角色', exact: true }).isVisible()) await nav.getByRole('button', { name: '角色管理', exact: true }).click()
  await nav.getByRole('button', { name: '主要角色', exact: true }).click(); await page.getByRole('button', { name: '选择角色：清除回归角色', exact: true }).click(); page.setDefaultTimeout(20000)
  const trigger = page.locator('[data-card-field]').getByRole('button', { name: '保留势力，手动旧势力', exact: true, includeHidden: true })
  const group = trigger.locator('xpath=ancestor::details[1]'); await group.evaluate(el => { el.open = true })
  await trigger.click(); await remove(refs(), '手动旧势力'); await page.keyboard.press('Escape'); await page.keyboard.press('Control+s')
  await page.waitForFunction(async ({ key, pid }) => (await (await import('/src/lib/db.ts')).getCardRecordsFor(pid, 'char-main')).find(r => r.id === 'clear-real-card')?.data[key] === '保留势力', seed)
  const stored = await page.evaluate(async ({ pid }) => {
    const db = await import('/src/lib/db.ts'); return { row: (await db.getCardRecordsFor(pid, 'char-main')).find(r => r.id === 'clear-real-card'), source: (await db.getTableRowsFor(pid, 'nations')).find(r => r.id === 'clear-source-nation') }
  }, seed)
  check('real CharacterSheet save persists removal without changing source records or unrelated data', stored.row.data[seed.key] === '保留势力' && stored.row.data['fixture::保留'] === '不应改变' && stored.source.data.名称 === '保留势力')
  await page.reload({ waitUntil: 'commit' })
  await page.getByRole('button', { name: '打开项目', exact: true }).click(); await nav.waitFor()
  if (!await nav.getByRole('button', { name: '主要角色', exact: true }).isVisible()) await nav.getByRole('button', { name: '角色管理', exact: true }).click()
  await nav.getByRole('button', { name: '主要角色', exact: true }).click(); await page.getByRole('button', { name: '选择角色：清除回归角色', exact: true }).click()
  const reloaded = page.locator('[data-card-field]').getByRole('button', { name: '保留势力', exact: true, includeHidden: true }); await reloaded.locator('xpath=ancestor::details[1]').evaluate(el => { el.open = true })
  check('saved removal survives a real page reload', await reloaded.isVisible())
  if (!await nav.getByRole('button', { name: '国家势力', exact: true }).isVisible()) await nav.getByRole('button', { name: '世界构建', exact: true }).click()
  await nav.getByRole('button', { name: '国家势力', exact: true }).click()
  await page.locator('main header').getByRole('button', { name: '表格', exact: true }).click()
  await page.getByRole('button', { name: '手工分类', exact: true }).click(); await remove(customs(), '手工分类')
  await page.getByRole('button', { name: '手动地名', exact: true }).click(); await remove(refs(), '手动地名'); await page.keyboard.press('Control+s')
  await page.waitForFunction(async ({ pid }) => {
    const row = (await (await import('/src/lib/db.ts')).getTableRowsFor(pid, 'nations')).find(r => r.id === 'clear-source-nation')
    return row?.data.类别 === '' && row?.data.地理位置 === '' && row?.data.名称 === '保留势力'
  }, seed)
  check('real TableSheet persists clearing both a legacy custom option and a manual reference', true)
  check('no model requests', report.modelRequests.length === 0, report.modelRequests); check('no browser errors', report.errors.length === 0, report.errors); report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.failure = error.stack || String(error); report.pendingAssets = [...pending.values()]
  await page?.screenshot({ path: path.join(run, 'failure.png'), animations: 'disabled' }).catch(() => {})
} finally {
  report.stale = fingerprint !== snapshot(root).fingerprint || fixtureFingerprint !== await fixtureHash(); if (report.stale) report.status = 'failed'; report.passed = report.checks.filter(c => c.passed).length
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close()
  console.log(JSON.stringify({ run, status: report.status, passed: report.passed, total: report.checks.length, stale: report.stale, failure: report.failure })); if (report.status !== 'passed') process.exitCode = 1
}
