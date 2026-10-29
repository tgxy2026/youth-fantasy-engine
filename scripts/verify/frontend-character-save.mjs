// Real CharacterSheet, isolated native IDB and controlled failures/receipts. No live author data or model.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-character-save-')), fingerprint = snapshot(root).fingerprint
const report = { run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
const check = (name, passed, details) => { report.checks.push({ name, passed: !!passed, details }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`); if (!passed) throw Error(name + ': ' + JSON.stringify(details)) }
let server, browser, page
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', optimizeDeps: { entries: ['index.html'] },
    server: { host: 'localhost', port: 0, watch: { ignored: ['**/.workbuddy/**', '**/release/**', '**/dist/**'] } } })
  await server.listen(); const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => { const url = route.request().url(); if (/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) report.modelRequests.push('blocked'); return url.startsWith(origin + '/') ? route.continue() : route.abort() })
  page = await context.newPage(); page.setDefaultTimeout(120000); page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(origin, { waitUntil: 'commit' }); await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click(); await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByRole('button', { name: '稍后再说', exact: true }).click()
  const seed = await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts'), { TABS } = await import('/src/lib/schema.ts')
    ;(await import('/src/lib/settings/theme.ts')).applyZoom(100, { manual: true })
    const tab = TABS.find(t => t.id === 'char-main'), pid = db.getCurrentProjectId()
    const identity = tab.modules.flatMap(group => group.fields.map(field => ({ key: group.name + '::' + field.name, name: field.name }))).find(field => field.name === '身份定位').key
    for (const [id, name, value] of [['card-save-a', '保存回归甲', '甲原内容'], ['card-save-b', '保存回归乙', '乙原内容']]) {
      await db.saveCardRecord({ id, name, tabId: tab.id, projectId: pid, order: 900, data: { [identity]: value, 'fixture::保留': '其它字段不变' } })
    }
    return { pid, identity }
  })
  const nav = page.getByRole('navigation'), view = page.locator('[data-character-workspace]')
  if (!await nav.getByRole('button', { name: '主要角色', exact: true }).isVisible()) await nav.getByRole('button', { name: '角色管理', exact: true }).click()
  await nav.getByRole('button', { name: '主要角色', exact: true }).click(); await view.waitFor(); page.setDefaultTimeout(20000)
  const pick = async (name, wait = true) => {
    await view.getByRole('button', { name: '选择角色：' + name, exact: true }).click()
    if (wait) await view.getByRole('button', { name: '修改名称：' + name, exact: true }).waitFor()
  }
  const input = () => view.locator(`[data-card-field=${JSON.stringify(seed.identity)}] textarea`)
  const read = (id = 'card-save-a') => page.evaluate(async ({ id, pid }) => (await (await import('/src/lib/db.ts')).getCardRecordsFor(pid, 'char-main')).find(row => row.id === id), { id, pid: seed.pid })
  const fail = () => page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'cardRecords') throw new DOMException('C:\\private-author-library\\secret?token=private', 'QuotaExceededError'); return put.apply(this, args) }
    window.__restoreCardPut = () => { IDBObjectStore.prototype.put = put }
  })
  const settleFailure = async () => { await view.locator('[data-draft-save-feedback="error"]').waitFor(); await view.getByRole('button', { name: '重试保存', exact: true }).waitFor(); await page.waitForFunction(() => !document.querySelector('[data-draft-save-feedback="error"] button')?.disabled) }
  await pick('保存回归甲'); await input().fill('角色失败后保留草稿'); await input().evaluate(el => { el.dataset.cardKeep = 'same-dom' }); const original = await read()
  await fail(); await view.getByRole('button', { name: '保存', exact: true }).click(); await settleFailure(); await page.waitForTimeout(4100)
  const retained = { value: await input().inputValue(), marker: await input().getAttribute('data-card-keep'), error: await view.locator('[data-draft-save-feedback="error"]').innerText(), unchanged: JSON.stringify(await read()) === JSON.stringify(original) }
  check('manual failure retains the original input DOM and a persistent safe error', retained.value === '角色失败后保留草稿' && retained.marker === 'same-dom' && !retained.error.includes('private') && retained.unchanged, retained)
  await pick('保存回归乙', false); await settleFailure()
  check('failed card switch retains the selected card and draft', await input().inputValue() === '角色失败后保留草稿' && await view.getByRole('button', { name: '选择角色：保存回归甲', exact: true }).getAttribute('aria-pressed') === 'true')
  await nav.getByRole('button', { name: '写作面板', exact: true }).click(); await settleFailure(); await page.getByText(/^已留在当前页面：/).waitFor()
  check('failed App navigation retains the character draft', await input().getAttribute('data-card-keep') === 'same-dom')
  await page.evaluate(() => window.__restoreCardPut()); await view.getByRole('button', { name: '重试保存', exact: true }).click()
  await view.locator('[data-draft-save-feedback="submitted"]').waitFor()
  check('explicit retry submits the actual record and distinguishes disk confirmation', (await read()).data[seed.identity] === '角色失败后保留草稿' && (await view.locator('[data-draft-save-feedback="submitted"]').innerText()).includes('最终写入状态') && (await read()).data['fixture::保留'] === '其它字段不变')
  await input().fill('切卡前实际提交'); await pick('保存回归乙'); await page.waitForFunction(() => document.querySelector('textarea[aria-label="身份定位"]')?.value === '乙原内容')
  check('successful card switch waits for the actual previous draft write', (await read()).data[seed.identity] === '切卡前实际提交')
  await pick('保存回归甲'); await page.waitForFunction(() => document.querySelector('textarea[aria-label="身份定位"]')?.value === '切卡前实际提交')
  await page.evaluate(() => {
    const add = IDBRequest.prototype.addEventListener, put = IDBObjectStore.prototype.put, queue = []; let hold = true
    window.__cardHeld = 0; window.__cardWrites = 0
    IDBObjectStore.prototype.put = function (...args) { const request = put.apply(this, args); if (this.name === 'cardRecords' && args[0]?.id === 'card-save-a') { window.__cardWrites++; request.__cardHold = hold } return request }
    IDBRequest.prototype.addEventListener = function (type, callback, options) {
      if (type === 'success' && this.__cardHold) return add.call(this, type, event => { window.__cardHeld++; queue.push(() => typeof callback === 'function' ? callback.call(this, event) : callback.handleEvent(event)) }, options)
      return add.call(this, type, callback, options)
    }
    window.__releaseCardReceipt = () => { hold = false; IDBRequest.prototype.addEventListener = add; for (const release of queue.splice(0)) release() }
    window.__restoreCardReceipt = () => { IDBObjectStore.prototype.put = put; IDBRequest.prototype.addEventListener = add }
  })
  await input().fill('已发出角色修改'); await input().press('Control+s'); await page.waitForFunction(() => window.__cardHeld > 0)
  await input().fill('慢回执期间更新的角色草稿'); await input().press('Control+s'); await input().press('Control+s')
  check('busy shortcuts share one actual immutable write', await page.evaluate(() => window.__cardWrites) === 1)
  await page.evaluate(() => window.__releaseCardReceipt()); await view.locator('[data-draft-save-feedback="pending"]').waitFor()
  check('a late receipt leaves newer card input dirty and visible', await input().inputValue() === '慢回执期间更新的角色草稿' && (await read()).data[seed.identity] === '已发出角色修改')
  await input().press('Control+s'); await view.locator('[data-draft-save-feedback="submitted"]').waitFor()
  check('the newest card draft gets its own explicit write exactly once', (await read()).data[seed.identity] === '慢回执期间更新的角色草稿' && await page.evaluate(() => window.__cardWrites) === 2)
  await page.evaluate(() => window.__restoreCardReceipt())
  const beforeDelete = await read(); await input().fill('已删除角色不可复活')
  await page.evaluate(async () => (await import('/src/lib/db.ts')).deleteCardRecord('card-save-a')); await input().press('Control+s'); await settleFailure()
  check('a deleted target is not recreated and its unsubmitted input stays visible', !(await read()) && await input().inputValue() === '已删除角色不可复活')
  await page.evaluate(async row => (await import('/src/lib/db.ts')).saveCardRecord(row), beforeDelete)
  await view.getByRole('button', { name: '重试保存', exact: true }).click(); await view.locator('[data-draft-save-feedback="submitted"]').waitFor()
  await input().fill('离页时实际提交'); await nav.getByRole('button', { name: '写作面板', exact: true }).click(); await view.waitFor({ state: 'hidden' })
  check('successful App navigation submits the character before unmount', (await read()).data[seed.identity] === '离页时实际提交')
  await nav.getByRole('button', { name: '主要角色', exact: true }).click(); await view.waitFor(); await pick('保存回归甲')
  await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts'), core = await import('/src/lib/db/core.ts'), originalOps = core.ops
    let release; const wait = new Promise(yes => { release = yes })
    const pause = { enabled: false, started: false, release }
    window.__cardOwner = { originalOps, pause, originalValue: JSON.stringify(await originalOps.get('cardRecords', 'card-save-a')) }
    db.setStoreOps({ ...originalOps, getAll: async store => {
      if (store === 'cardRecords' && pause.enabled) { pause.started = true; await wait }
      return originalOps.getAll(store)
    } })
  })
  await view.waitFor(); await pick('保存回归甲')
  await page.evaluate(() => { window.__cardOwner.pause.enabled = true })
  await input().fill('旧仓角色私密输入'); await input().press('Control+s'); await page.waitForFunction(() => window.__cardOwner.pause.started)
  await page.evaluate(async seed => {
    const owner = window.__cardOwner, db = await import('/src/lib/db.ts')
    const replacement = await new Promise((resolve, reject) => {
      const open = indexedDB.open('card-save-owner', 1); open.onupgradeneeded = () => open.result.createObjectStore('cardRecords', { keyPath: 'id' }); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error)
    })
    const request = (mode, action) => new Promise((resolve, reject) => {
      const tx = replacement.transaction('cardRecords', mode), req = action(tx.objectStore('cardRecords')); let value
      req.onsuccess = () => { value = req.result }; tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
    })
    const original = JSON.parse(owner.originalValue)
    await request('readwrite', store => store.put({ ...original, data: { ...original.data, [seed.identity]: '替换仓角色内容' } }))
    owner.replacement = { ...owner.originalOps,
      get: (store, key) => store === 'cardRecords' ? request('readonly', s => s.get(key)) : owner.originalOps.get(store, key),
      getAll: store => store === 'cardRecords' ? request('readonly', s => s.getAll()) : owner.originalOps.getAll(store),
      getAllByIndex: async (store, index, key) => store === 'cardRecords' ? (await request('readonly', s => s.getAll())).filter(row => row[index] === key) : owner.originalOps.getAllByIndex(store, index, key),
      put: (store, value) => store === 'cardRecords' ? request('readwrite', s => s.put(value)) : owner.originalOps.put(store, value),
    }
    db.setStoreOps(owner.replacement)
  }, seed)
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="身份定位"]')?.value === '替换仓角色内容')
  await page.evaluate(() => { window.__cardOwner.pause.enabled = false; window.__cardOwner.pause.release() })
  const owners = await page.evaluate(async key => {
    const owner = window.__cardOwner
    return { oldSame: JSON.stringify(await owner.originalOps.get('cardRecords', 'card-save-a')) === owner.originalValue, replacement: (await owner.replacement.get('cardRecords', 'card-save-a')).data[key] }
  }, seed.identity)
  check('a delayed character submission and unmount fallback cannot write either replacement owner', owners.oldSame && owners.replacement === '替换仓角色内容', owners)
  check('the replacement character workspace does not expose the previous private draft', !(await view.innerText()).includes('旧仓角色私密输入') && await input().inputValue() === '替换仓角色内容')
  await input().fill('新仓当前角色提交'); await input().press('Control+s'); await view.locator('[data-draft-save-feedback="submitted"]').waitFor()
  check('the new character owner remains editable after rejecting the old callback', await page.evaluate(async key => (await window.__cardOwner.replacement.get('cardRecords', 'card-save-a')).data[key], seed.identity) === '新仓当前角色提交')
  await page.evaluate(async () => (await import('/src/lib/db.ts')).setStoreOps(window.__cardOwner.originalOps))
  check('no model requests or unexpected browser errors', !report.modelRequests.length && !report.errors.length, { errors: report.errors, models: report.modelRequests })
  await page.screenshot({ path: path.join(run, 'character-save-result.png'), animations: 'disabled' }); report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); await page?.screenshot({ path: path.join(run, 'failure.png'), animations: 'disabled' }).catch(() => {}) }
finally {
  report.stale = fingerprint !== snapshot(root).fingerprint; if (report.stale) report.status = 'failed'
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close()
  console.log(JSON.stringify({ run, status: report.status, passed: report.checks.filter(c => c.passed).length, total: report.checks.length, stale: report.stale, failure: report.failure })); if (report.status !== 'passed') process.exitCode = 1
}
