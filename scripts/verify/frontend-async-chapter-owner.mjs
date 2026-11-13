// Real NovelEditor, isolated native IDB and a replaced storage owner. No live author data or model.
// The pause wrapper is installed BEFORE the editor mounts so its mount-captured owner is valid;
// switching to a replacement IDB then invalidates that owner (setStoreOps bumps the storage epoch).
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-async-chapter-owner-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-async-chapter-owner', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
const check = (name, passed, details) => { report.checks.push({ name, passed: !!passed, details }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`); if (!passed) throw Error(name + ': ' + JSON.stringify(details)) }
let server, browser, page
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', server: { host: 'localhost', port: 0, watch: { ignored: ['**/.workbuddy/**', '**/release/**', '**/dist/**'] } } })
  await server.listen(); const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => { const url = route.request().url(); if (/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) report.modelRequests.push('blocked'); return url.startsWith(origin + '/') ? route.continue() : route.abort() })
  page = await context.newPage(); page.setDefaultTimeout(120000); page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(origin, { waitUntil: 'commit' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click(); await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  const backupLaterBtn = page.getByRole('button', { name: '稍后再说', exact: true }); if (await backupLaterBtn.isVisible().catch(() => false)) await backupLaterBtn.click()
  const nav = page.getByRole('navigation'); await nav.waitFor()
  const guide = page.locator('[data-guide-card]').first()
  if (await guide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) { await page.getByRole('button', { name: '跳过本页' }).click(); await guide.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {}) }
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })
  page.setDefaultTimeout(20000)

  // Seed a dedicated chapter and install the pause wrapper BEFORE the editor mounts (owner captures this epoch).
  const seed = await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts'), core = await import('/src/lib/db/core.ts')
    const { writeStringPref } = await import('/src/lib/settings/uiPrefs.ts')
    ;(await import('/src/lib/settings/theme.ts')).applyZoom(100, { manual: true })
    const pid = db.getCurrentProjectId(), originalOps = core.ops
    const vol = (await db.getAllVolumes())[0]
    await db.saveChapter({ id: 'owned-chapter', projectId: pid, volumeId: vol?.id ?? '', order: 9999, title: '归属探针章', content: '原仓章节正文', summary: '', status: '构思', wordCount: 6, createdAt: Date.now(), updatedAt: Date.now() })
    writeStringPref(`editor-last-chapter:${pid}`, 'owned-chapter')
    let release; const wait = new Promise(yes => { release = yes })
    const pause = { enabled: false, started: false, release }
    window.__chapterOwner = { originalOps, pause, pid }
    db.setStoreOps({ ...originalOps, get: async (store, key) => {
      if (store === 'chapters' && pause.enabled) { pause.started = true; await wait }
      return originalOps.get(store, key)
    } })
    return { pid }
  })

  const editor = page.locator('textarea.novel-textarea')
  const openEditor = async () => { await nav.getByRole('button', { name: '正文编辑', exact: true }).click(); await editor.waitFor() }
  const readOriginal = () => page.evaluate(async () => (await window.__chapterOwner.originalOps.get('chapters', 'owned-chapter'))?.content)
  await openEditor()
  await page.waitForFunction(() => document.querySelector('textarea.novel-textarea')?.value === '原仓章节正文')
  check('the editor opens the seeded chapter under its mounted owner', await editor.inputValue() === '原仓章节正文')

  // ---- Same-owner serialization: a held receipt must not drop the newer edit ----
  await page.evaluate(() => {
    const add = IDBRequest.prototype.addEventListener, put = IDBObjectStore.prototype.put, queue = []; let hold = true
    window.__chapterHeld = 0; window.__chapterWrites = 0
    IDBObjectStore.prototype.put = function (...args) { const request = put.apply(this, args); if (this.name === 'chapters' && args[0]?.id === 'owned-chapter') { window.__chapterWrites++; request.__chapterHold = hold } return request }
    IDBRequest.prototype.addEventListener = function (type, callback, options) {
      if (type === 'success' && this.__chapterHold) return add.call(this, type, event => { window.__chapterHeld++; queue.push(() => typeof callback === 'function' ? callback.call(this, event) : callback.handleEvent(event)) }, options)
      return add.call(this, type, callback, options)
    }
    window.__releaseChapterReceipt = () => { hold = false; IDBRequest.prototype.addEventListener = add; for (const release of queue.splice(0)) release() }
    window.__restoreChapterReceipt = () => { IDBObjectStore.prototype.put = put; IDBRequest.prototype.addEventListener = add }
  })
  await editor.click(); await editor.fill('已发出章节修改'); await editor.press('Control+s'); await page.waitForFunction(() => window.__chapterHeld > 0)
  await editor.fill('慢回执期间更新的章节草稿'); await editor.press('Control+s')
  check('busy chapter shortcuts issue only one native write while its receipt is pending', await page.evaluate(() => window.__chapterWrites) === 1)
  await page.evaluate(() => window.__releaseChapterReceipt())
  await page.waitForFunction(() => window.__chapterWrites >= 2)
  await page.waitForFunction(async () => (await window.__chapterOwner.originalOps.get('chapters', 'owned-chapter'))?.content === '慢回执期间更新的章节草稿')
  check('serialized chapter receipts persist the newest edit in order without a lost update', await editor.inputValue() === '慢回执期间更新的章节草稿' && await readOriginal() === '慢回执期间更新的章节草稿')
  await page.evaluate(() => window.__restoreChapterReceipt())

  // ---- Owner switch: a delayed submission must not write into either owner ----
  const originalValue = await readOriginal()
  await page.evaluate(() => { window.__chapterOwner.pause.enabled = true })
  await editor.fill('旧仓章节私密输入'); await editor.press('Control+s'); await page.waitForFunction(() => window.__chapterOwner.pause.started)
  await page.evaluate(async () => {
    const owner = window.__chapterOwner
    const replacement = await new Promise((resolve, reject) => {
      const open = indexedDB.open('chapter-owner-replacement', 1); open.onupgradeneeded = () => open.result.createObjectStore('chapters', { keyPath: 'id' }); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error)
    })
    const request = (mode, action) => new Promise((resolve, reject) => {
      const tx = replacement.transaction('chapters', mode), req = action(tx.objectStore('chapters')); let value
      req.onsuccess = () => { value = req.result }; tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
    })
    const original = await owner.originalOps.get('chapters', 'owned-chapter')
    await request('readwrite', store => store.put({ ...original, content: '替换仓章节内容' }))
    owner.replacement = { ...owner.originalOps,
      get: (store, key) => store === 'chapters' ? request('readonly', s => s.get(key)) : owner.originalOps.get(store, key),
      getAll: store => store === 'chapters' ? request('readonly', s => s.getAll()) : owner.originalOps.getAll(store),
      getAllByIndex: async (store, index, key) => store === 'chapters' ? (await request('readonly', s => s.getAll())).filter(row => row[index] === key) : owner.originalOps.getAllByIndex(store, index, key),
      put: (store, value) => store === 'chapters' ? request('readwrite', s => s.put(value)) : owner.originalOps.put(store, value),
    }
    const db = await import('/src/lib/db.ts'); db.setStoreOps(owner.replacement)
  })
  await page.evaluate(() => { window.__chapterOwner.pause.enabled = false; window.__chapterOwner.pause.release() })
  await page.waitForTimeout(600)
  const owners = await page.evaluate(async () => ({
    oldSame: (await window.__chapterOwner.originalOps.get('chapters', 'owned-chapter'))?.content,
    replacement: (await window.__chapterOwner.replacement.get('chapters', 'owned-chapter'))?.content,
  }))
  check('a delayed chapter submission cannot write the private draft into either replacement owner', owners.oldSame === originalValue && owners.replacement === '替换仓章节内容', { ...owners, originalValue })
  check('the rejected chapter draft stays visible in the editor', await editor.inputValue() === '旧仓章节私密输入')

  // ---- pagehide flush fallback must also be blocked by the stale owner ----
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await page.waitForTimeout(600)
  const afterHide = await page.evaluate(async () => ({
    oldSame: (await window.__chapterOwner.originalOps.get('chapters', 'owned-chapter'))?.content,
    replacement: (await window.__chapterOwner.replacement.get('chapters', 'owned-chapter'))?.content,
  }))
  check('the pagehide chapter flush cannot write into either replacement owner', afterHide.oldSame === originalValue && afterHide.replacement === '替换仓章节内容', afterHide)

  // ---- Recovery: a freshly remounted editor owns the restored store and can save ----
  await page.evaluate(async () => { const db = await import('/src/lib/db.ts'); db.setStoreOps(window.__chapterOwner.originalOps) })
  await editor.fill(originalValue) // clean the draft so the leave barrier has nothing to flush
  await page.waitForTimeout(300)
  await nav.getByRole('button', { name: '写作面板', exact: true }).click(); await editor.waitFor({ state: 'hidden' })
  await openEditor(); await page.waitForFunction(v => document.querySelector('textarea.novel-textarea')?.value === v, originalValue)
  await editor.fill('新仓当前章节提交'); await editor.press('Control+s')
  await page.waitForFunction(async () => (await window.__chapterOwner.originalOps.get('chapters', 'owned-chapter'))?.content === '新仓当前章节提交')
  check('a remounted editor remains editable and saves into the restored owner', await readOriginal() === '新仓当前章节提交')

  check('no model requests or unexpected browser errors', !report.modelRequests.length && !report.errors.length, { errors: report.errors, models: report.modelRequests })
  await page.screenshot({ path: path.join(run, 'chapter-owner-result.png'), animations: 'disabled' }); report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); await page?.screenshot({ path: path.join(run, 'failure.png'), animations: 'disabled' }).catch(() => {}) }
finally {
  report.stale = fingerprint !== snapshot(root).fingerprint; if (report.stale) report.status = 'failed'
  report.passed = report.checks.filter(c => c.passed).length
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close()
  console.log(JSON.stringify({ run, status: report.status, passed: report.passed, total: report.checks.length, stale: report.stale, failure: report.failure })); if (report.status !== 'passed') process.exitCode = 1
}