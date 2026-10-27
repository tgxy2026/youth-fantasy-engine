// Actual SettingSearch hosted by the real editor, real isolated IDB, and controlled native failures/receipts.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-indexed-field-save-'))
const fingerprint = snapshot(root).fingerprint
const report = { run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
const check = (name, passed, details) => { report.checks.push({ name, passed: !!passed, details }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`); if (!passed) throw Error(name + ': ' + JSON.stringify(details)) }
let server, browser, page
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', optimizeDeps: { entries: ['index.html'] },
    server: { host: 'localhost', port: 0, watch: { ignored: ['**/.workbuddy/**', '**/release/**', '**/dist/**'] } } })
  await server.listen(); const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => {
    const url = route.request().url(); if (/\/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) report.modelRequests.push('blocked')
    return url.startsWith(origin + '/') ? route.continue() : route.abort()
  })
  page = await context.newPage(); page.setDefaultTimeout(120000); page.on('pageerror', e => report.errors.push(e.message))
  await page.goto(origin, { waitUntil: 'commit' }); await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click(); await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByRole('button', { name: '稍后再说', exact: true }).click()
  const seed = await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts'), { TABS } = await import('/src/lib/schema.ts')
    ;(await import('/src/lib/settings/theme.ts')).applyZoom(100, { manual: true })
    const pid = db.getCurrentProjectId(), tab = TABS.find(t => t.id === 'char-main')
    const group = tab.modules.find(m => m.fields.some(f => f.name === '出身背景')), key = group.name + '::出身背景'
    await db.saveTableRow({ id: 'indexed-save-table', projectId: pid, tabId: 'nations', order: 900, data: { 名称: '检索回归势力', 别称: '原有别称', 类别: '宗门', 备注: '不得改变的其他字段' } })
    await db.saveCardRecord({ id: 'indexed-save-card', projectId: pid, tabId: 'char-main', name: '检索回归角色', order: 900, data: { [key]: '原有背景', 'fixture::保留': '不应改变' } })
    return { pid, key }
  })
  const nav = page.getByRole('navigation')
  if (!await nav.getByRole('button', { name: '正文编辑', exact: true }).isVisible()) await nav.getByRole('button', { name: '正文写作', exact: true }).click()
  await nav.getByRole('button', { name: '正文编辑', exact: true }).click()
  const pane = page.locator('[data-setting-search]:visible')
  if (!await pane.count()) await page.getByRole('button', { name: '设定检索', exact: true }).click()
  await pane.waitFor(); page.setDefaultTimeout(20000)
  const doc = kind => pane.locator(`[data-setting-doc="${kind === 'table' ? 'table-indexed-save-table' : 'card-indexed-save-card'}"]`)
  const field = (kind, key = kind === 'table' ? '别称' : seed.key) => doc(kind).locator(`[data-setting-field=${JSON.stringify(key)}]`)
  const choose = async kind => {
    await pane.locator(`[data-setting-group="${kind === 'table' ? '世界构建' : '角色管理'}"]`).click()
    await pane.getByPlaceholder('搜角色名 / 伏笔 / 境界 / 地名…').fill(kind === 'table' ? '检索回归势力' : '检索回归角色')
    await doc(kind).waitFor(); if (!await doc(kind).locator('[data-setting-field]').count()) await doc(kind).getByRole('button').first().click()
  }
  const edit = async (kind, key) => { const f = field(kind, key); await f.getByRole('button', { name: /^编辑/ }).click(); await f.locator('textarea,button[aria-expanded]').first().waitFor(); return f }
  const stored = kind => page.evaluate(async ({ kind, seed }) => {
    const db = await import('/src/lib/db.ts')
    return kind === 'table' ? (await db.getTableRowsFor(seed.pid, 'nations')).find(r => r.id === 'indexed-save-table') : (await db.getCardRecordsFor(seed.pid, 'char-main')).find(r => r.id === 'indexed-save-card')
  }, { kind, seed })
  const failPut = store => page.evaluate(store => {
    const put = IDBObjectStore.prototype.put; window.__restoreIndexedPut = () => { IDBObjectStore.prototype.put = put }
    IDBObjectStore.prototype.put = function (...args) { if (this.name === store) throw new DOMException('C:\\private-library\\secret.json?token=private', 'QuotaExceededError'); return put.apply(this, args) }
  }, store)
  for (const kind of ['table', 'card']) {
    await choose(kind); const f = await edit(kind), text = `${kind}失败后保留的草稿`, original = await stored(kind)
    await f.locator('textarea').fill(text); await f.locator('textarea').evaluate(el => { el.dataset.indexedKeep = 'original' })
    await failPut(kind === 'table' ? 'tableRows' : 'cardRecords'); await f.getByRole('button', { name: '保存', exact: true }).click()
    await f.getByRole('status').filter({ hasText: '未确认保存' }).waitFor(); await page.waitForTimeout(4100)
    check(kind + ': real put failure preserves the actual draft DOM and a persistent safe error', await f.locator('textarea').inputValue() === text
      && await f.locator('textarea').getAttribute('data-indexed-keep') === 'original' && !(await f.getByRole('status').innerText()).includes('private') && JSON.stringify(await stored(kind)) === JSON.stringify(original))
    await page.evaluate(() => window.__restoreIndexedPut()); await f.getByRole('button', { name: '保存', exact: true }).click()
    await f.locator('textarea').waitFor({ state: 'detached' })
    const value = await stored(kind)
    check(kind + ': explicit retry persists only the intended field through the actual editor', value.data[kind === 'table' ? '别称' : seed.key] === text
      && value.data[kind === 'table' ? '备注' : 'fixture::保留'] === (kind === 'table' ? '不得改变的其他字段' : '不应改变'))
  }
  await choose('table'); let f = await edit('table')
  const failedSubmissionSettled = async () => {
    await f.getByRole('status').filter({ hasText: '未确认保存' }).waitFor()
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('[data-setting-field="别称"] button')].find(b => b.textContent === '保存')
      return button && !button.disabled
    })
  }
  await f.locator('textarea').fill('离页保护的设定草稿'); await failPut('tableRows')
  await f.locator('textarea').evaluate(el => { el.dataset.leaveKeep = 'same-dom' })
  await page.getByRole('button', { name: '设定检索', exact: true }).click()
  await failedSubmissionSettled()
  check('failed submission prevents hiding the pane and keeps the original draft DOM', await f.locator('textarea').getAttribute('data-leave-keep') === 'same-dom')
  await page.getByRole('button', { name: '专注', exact: true }).click()
  await failedSubmissionSettled()
  check('failed submission prevents focus mode from discarding the side-pane draft', await f.locator('textarea').inputValue() === '离页保护的设定草稿')
  await field('table', '备注').getByRole('button', { name: /^编辑/ }).click()
  await failedSubmissionSettled()
  check('switching inline fields first submits the old draft and stays on failure', await field('table', '备注').locator('textarea').count() === 0 && await f.locator('textarea').inputValue() === '离页保护的设定草稿')
  await nav.getByRole('button', { name: '写作面板', exact: true }).click()
  await failedSubmissionSettled()
  await page.getByText(/^已留在当前页面：/).waitFor()
  check('a side-pane failure participates in real App navigation without replacing the body guard', await f.locator('textarea').getAttribute('data-leave-keep') === 'same-dom')
  await page.evaluate(() => window.__restoreIndexedPut()); await f.locator('textarea').press('Control+s')
  await f.locator('textarea').waitFor({ state: 'detached' })
  check('focused Ctrl+S submits the field through the actual writer', (await stored('table')).data.别称 === '离页保护的设定草稿')
  f = await edit('table'); await f.locator('textarea').fill('缩小窗口不丢的草稿')
  await f.locator('textarea').evaluate(el => { el.dataset.resizeKeep = 'same-dom' })
  await page.setViewportSize({ width: 900, height: 900 })
  await page.getByRole('status').filter({ hasText: '暂时保留编辑面板' }).waitFor()
  check('responsive inline-to-drawer transition keeps the dirty editor and its actual DOM', await f.locator('textarea').inputValue() === '缩小窗口不丢的草稿' && await f.locator('textarea').getAttribute('data-resize-keep') === 'same-dom')
  await f.locator('textarea').press('Control+s'); await pane.waitFor({ state: 'hidden' })
  check('responsive layout resumes only after the retained inline draft is submitted', (await stored('table')).data.别称 === '缩小窗口不丢的草稿')
  await page.setViewportSize({ width: 1920, height: 1080 }); await pane.waitFor(); await choose('table')
  f = await edit('table'); await f.locator('textarea').fill('收起前自动提交')
  await page.getByRole('button', { name: '设定检索', exact: true }).click(); await pane.waitFor({ state: 'hidden' })
  check('successful side-pane submission finishes before hiding', (await stored('table')).data.别称 === '收起前自动提交')
  await page.getByRole('button', { name: '设定检索', exact: true }).click(); await choose('table')
  await page.setViewportSize({ width: 900, height: 900 }); await pane.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '设定检索', exact: true }).click(); await pane.waitFor(); await choose('table')
  f = await edit('table'); await f.locator('textarea').fill('抽屉关闭失败留稿'); await failPut('tableRows')
  const drawer = page.getByRole('dialog', { name: '设定检索', exact: true })
  await f.locator('textarea').evaluate(el => { el.dataset.drawerKeep = 'same-dom' })
  await page.setViewportSize({ width: 1920, height: 1080 })
  check('responsive drawer-to-inline transition retains the dirty dialog input', await drawer.isVisible() && await drawer.locator('textarea[data-drawer-keep="same-dom"]').inputValue() === '抽屉关闭失败留稿')
  await page.setViewportSize({ width: 900, height: 900 })
  await drawer.getByRole('button', { name: '关闭', exact: true }).click(); await f.getByRole('status').filter({ hasText: '未确认保存' }).waitFor()
  check('drawer close failure keeps the live input mounted', await drawer.isVisible() && await f.locator('textarea').inputValue() === '抽屉关闭失败留稿')
  await page.evaluate(() => window.__restoreIndexedPut()); await drawer.getByRole('button', { name: '关闭', exact: true }).click(); await drawer.waitFor({ state: 'hidden' })
  check('drawer close retries and waits for the actual submission', (await stored('table')).data.别称 === '抽屉关闭失败留稿')
  await page.setViewportSize({ width: 1920, height: 1080 }); await pane.waitFor(); await choose('table')
  f = await edit('table'); const original = await stored('table')
  await f.locator('textarea').fill('已删除目标不得复活'); await page.evaluate(async () => (await import('/src/lib/db.ts')).deleteTableRow('indexed-save-table'))
  await f.getByRole('button', { name: '保存', exact: true }).click(); await f.getByRole('status').filter({ hasText: '已经不在了' }).waitFor()
  check('a target removed after indexing stays missing and keeps the unsaved draft open', !(await stored('table')) && await f.locator('textarea').inputValue() === '已删除目标不得复活')
  await page.evaluate(async row => (await import('/src/lib/db.ts')).saveTableRow(row), original); await f.getByRole('button', { name: '取消', exact: true }).click()
  await field('table').getByRole('button', { name: /^编辑/ }).waitFor(); f = await edit('table')
  await page.evaluate(() => {
    const add = IDBRequest.prototype.addEventListener, put = IDBObjectStore.prototype.put, queue = []; let hold = true
    window.__indexedHeld = 0; window.__indexedWrites = 0
    IDBObjectStore.prototype.put = function (...args) { const request = put.apply(this, args); if (this.name === 'tableRows' && args[0]?.id === 'indexed-save-table') { window.__indexedWrites++; request.__indexedHold = hold } return request }
    IDBRequest.prototype.addEventListener = function (type, callback, options) {
      if (type === 'success' && this.__indexedHold) return add.call(this, type, event => { window.__indexedHeld++; queue.push(() => typeof callback === 'function' ? callback.call(this, event) : callback.handleEvent(event)) }, options)
      return add.call(this, type, callback, options)
    }
    window.__releaseIndexedReceipt = () => { hold = false; IDBRequest.prototype.addEventListener = add; for (const release of queue.splice(0)) release() }
    window.__uninstallIndexedReceipt = () => { IDBObjectStore.prototype.put = put; IDBRequest.prototype.addEventListener = add }
  })
  await f.locator('textarea').fill('慢回执已发出的值'); await f.getByRole('button', { name: '保存', exact: true }).evaluate(button => { button.click(); button.click() })
  await page.waitForFunction(() => window.__indexedHeld === 1); await f.locator('textarea').fill('慢回执期间更新的草稿'); await f.locator('textarea').evaluate(el => { el.dataset.latestIndexed = 'same-dom' })
  await page.evaluate(() => window.__releaseIndexedReceipt()); await f.getByRole('button', { name: '保存', exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-setting-field] button')].find(button => button.textContent === '保存')?.disabled)
  check('late submission receipts never close or overwrite a newer inline draft', await f.locator('textarea').inputValue() === '慢回执期间更新的草稿' && await f.locator('textarea').getAttribute('data-latest-indexed') === 'same-dom' && await page.evaluate(() => window.__indexedWrites) === 1)
  await f.getByRole('button', { name: '保存', exact: true }).click(); await f.locator('textarea').waitFor({ state: 'detached' })
  check('the newer draft requires and survives its own actual write exactly once', (await stored('table')).data.别称 === '慢回执期间更新的草稿' && await page.evaluate(() => window.__indexedWrites) === 2)
  await page.evaluate(() => window.__uninstallIndexedReceipt())
  f = await edit('table', '类别'); await failPut('tableRows'); await f.locator('button[aria-expanded]').click()
  await page.getByPlaceholder('搜索选项…').locator('..').locator('..').getByRole('button', { name: '商会', exact: true }).click()
  await f.getByRole('status').filter({ hasText: '未确认保存' }).waitFor()
  check('auto-submit controls retain the selected draft and expose an explicit retry', await f.getByRole('button', { name: '重试提交', exact: true }).isVisible() && await f.locator('button[aria-expanded]').innerText().then(text => text.includes('商会')))
  await page.evaluate(() => window.__restoreIndexedPut()); await f.getByRole('button', { name: '重试提交', exact: true }).click(); await f.getByRole('button', { name: /^编辑/ }).waitFor()
  check('auto-submit retry writes the selection through the original record interface', (await stored('table')).data.类别 === '商会')
  const beforeReadError = await stored('table')
  await page.evaluate(() => { const read = IDBObjectStore.prototype.getAll; window.__restoreIndexedRead = () => { IDBObjectStore.prototype.getAll = read }
    IDBObjectStore.prototype.getAll = function (...args) { if (this.name === 'cardRecords') throw new DOMException('isolated index read failure', 'UnknownError'); return read.apply(this, args) } })
  await pane.getByRole('button', { name: '重新加载设定数据', exact: true }).click(); await pane.getByRole('alert').waitFor()
  await page.evaluate(() => window.__restoreIndexedRead()); await pane.getByRole('button', { name: '重试读取设定', exact: true }).click(); await doc('table').waitFor()
  check('a real index read failure has a working explicit retry without changing records', JSON.stringify(await stored('table')) === JSON.stringify(beforeReadError))
  // Original index and replacement records are two actual IDBs. Metadata intentionally forwards the fixture's original Ops.
  await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts'), core = await import('/src/lib/db/core.ts'), originalOps = core.ops
    let release; const promise = new Promise(resolve => { release = resolve })
    const pause = { enabled: false, hits: 0, promise, release }
    const wrapped = { ...originalOps, getAllByIndex: async (store, index, key) => {
      if (store === 'tableRows' && index === 'tabId' && key === 'nations' && pause.enabled) { pause.hits++; await pause.promise }
      return originalOps.getAllByIndex(store, index, key)
    } }
    window.__indexOwner = { originalOps, pause }; db.setStoreOps(wrapped)
  })
  await field('table').getByRole('button', { name: /^编辑/ }).waitFor(); f = await edit('table')
  await page.evaluate(() => { window.__indexOwner.pause.enabled = true })
  await f.locator('textarea').fill('旧索引私密草稿'); await f.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => window.__indexOwner.pause.hits === 1)
  await page.evaluate(async ({ pid }) => {
    const db = await import('/src/lib/db.ts'), owner = window.__indexOwner
    const isolated = await new Promise((resolve, reject) => { const request = indexedDB.open('indexed-field-owner-replacement', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('tableRows', { keyPath: 'id' }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const request = (mode, act) => new Promise((resolve, reject) => { const tx = isolated.transaction('tableRows', mode), req = act(tx.objectStore('tableRows')); let value
      req.onsuccess = () => { value = req.result }; tx.oncomplete = () => resolve(value); tx.onabort = () => reject(tx.error) })
    await request('readwrite', store => store.put({ id: 'indexed-save-table', projectId: pid, tabId: 'nations', order: 900, data: { 名称: '检索回归势力', 别称: '替换仓同ID内容', 类别: '宗门' } }))
    const originalRows = await owner.originalOps.getAllByIndex('tableRows', 'tabId', 'nations')
    owner.originalValue = JSON.stringify(originalRows.find(row => row.id === 'indexed-save-table'))
    owner.replacement = { ...owner.originalOps,
      get: (store, key) => store === 'tableRows' ? request('readonly', s => s.get(key)) : owner.originalOps.get(store, key),
      getAll: store => store === 'tableRows' ? request('readonly', s => s.getAll()) : owner.originalOps.getAll(store),
      getAllByIndex: async (store, index, key) => store === 'tableRows' ? (await request('readonly', s => s.getAll())).filter(row => row[index] === key) : owner.originalOps.getAllByIndex(store, index, key),
      put: (store, value) => store === 'tableRows' ? request('readwrite', s => s.put(value)) : owner.originalOps.put(store, value),
    }
    db.setStoreOps(owner.replacement)
  }, seed)
  await field('table').getByText('替换仓同ID内容', { exact: true }).waitFor()
  await page.evaluate(() => { window.__indexOwner.pause.enabled = false; window.__indexOwner.pause.release() })
  const ownerResult = await page.evaluate(async () => {
    const o = window.__indexOwner, original = (await o.originalOps.getAllByIndex('tableRows', 'tabId', 'nations')).find(row => row.id === 'indexed-save-table')
    const replacement = await o.replacement.get('tableRows', 'indexed-save-table')
    return { originalSame: JSON.stringify(original) === o.originalValue, replacementValue: replacement.data.别称 }
  })
  check('a delayed old-index read cannot write either real same-ID storage owner', ownerResult.originalSame && ownerResult.replacementValue === '替换仓同ID内容', ownerResult)
  check('the replacement index drops the old editor and never displays its private draft', await field('table').locator('textarea').count() === 0 && !(await pane.innerText()).includes('旧索引私密草稿'))
  f = await edit('table'); await f.locator('textarea').fill('新仓当前提交'); await f.getByRole('button', { name: '保存', exact: true }).click(); await f.locator('textarea').waitFor({ state: 'detached' })
  check('the current owner remains editable after rejecting the stale submission', await page.evaluate(async () => (await window.__indexOwner.replacement.get('tableRows', 'indexed-save-table')).data.别称) === '新仓当前提交')
  await page.evaluate(async () => (await import('/src/lib/db.ts')).setStoreOps(window.__indexOwner.originalOps))
  await field('table').getByRole('button', { name: /^编辑/ }).waitFor()
  await page.screenshot({ path: path.join(run, 'actual-setting-search.png'), animations: 'disabled' })
  check('no model requests or unexpected browser errors', !report.modelRequests.length && !report.errors.length, { errors: report.errors, models: report.modelRequests })
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); await page?.screenshot({ path: path.join(run, 'failure.png'), animations: 'disabled' }).catch(() => {}) }
finally {
  report.stale = fingerprint !== snapshot(root).fingerprint; if (report.stale) report.status = 'failed'
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close()
  console.log(JSON.stringify({ run, status: report.status, passed: report.checks.filter(c => c.passed).length, total: report.checks.length, stale: report.stale, failure: report.failure })); if (report.status !== 'passed') process.exitCode = 1
}
