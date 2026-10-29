// Actual App + revision payloads in a fresh browser profile. No model calls or author library.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-revision-review-')), fingerprint = snapshot(root).fingerprint
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
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' })
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
  await nav.waitFor()
  const seed = await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts'), store = await import('/src/lib/revision/candidateStore.ts')
    ;(await import('/src/lib/settings/theme.ts')).applyZoom(100, { manual: true })
    const pid = db.getCurrentProjectId(), chapterId = 'review-chapter', before = '作者原文\n'.repeat(20)
    const after = '<img src=x onerror="window.reviewExecuted=true">\n' + '长候选段落\n'.repeat(2000) + 'Z'.repeat(3000) + '\n完整结尾'
    await db.saveChapter({ id: chapterId, projectId: pid, title: '审阅回归章节', content: before, summary: '', wordCount: before.length, createdAt: 1000, updatedAt: 1000, tags: [], status: 'draft', order: 999, volumeId: '' })
    for (const [id, status] of [['review-long', 'pending'], ['review-stale', 'stale'], ['review-reconcile', 'needs-reconcile'], ['review-applied', 'applied'], ['review-discarded', 'discarded']]) {
      const saved = await store.saveCandidate({ id, jobId: id + '-job', projectId: pid, chapterId, status, text: after, beforeText: before, summary: id, bytes: 0, createdAt: Date.now(), updatedAt: Date.now(), generation: 1, ...(status === 'stale' ? { staleReasons: ['正文已由作者修改'] } : {}) })
      if (!saved.ok) throw Error(JSON.stringify(saved))
    }
    const reports = await (await import('/src/lib/revision/checkReports.ts')).persistCheckReports({ projectId: pid, jobId: 'report-job', chapterId, chapterTitle: '落档时章节名', reports: [{ checkId: 'fixture', source: 'local', run: { state: 'completed', result: { data: [{ level: '严重', title: '长报告样本', detail: after, where: '作者原文' }] } } }] })
    if (reports.saved !== 1) throw Error(JSON.stringify(reports))
    return { pid, chapterId, before, after }
  })
  if (!await nav.getByRole('button', { name: '创作轨迹', exact: true }).isVisible()) await nav.getByRole('button', { name: '创作管理', exact: true }).click()
  await nav.getByRole('button', { name: '创作轨迹', exact: true }).click()
  const openCandidates = page.getByRole('button', { name: '候选审阅', exact: true })
  await openCandidates.click(); page.setDefaultTimeout(20000)
  const candidates = page.getByRole('dialog', { name: '候选审阅', exact: true }), row = page.locator('[data-candidate-id="review-long"]')
  await row.waitFor()
  await row.locator('summary').click()
  const original = row.getByRole('region', { name: '生成时原文', exact: true }), full = row.getByRole('region', { name: '候选全文', exact: true })
  check('candidate review exposes the full original and long generated text without executing HTML', await original.textContent() === seed.before && await full.textContent() === seed.after && await full.locator('img,script').count() === 0 && await page.evaluate(() => !window.reviewExecuted))
  await full.evaluate(el => { el.scrollTop = el.scrollHeight })
  check('long text has bounded vertical scrolling and no horizontal clipping', await full.evaluate(el => el.scrollTop > 0 && el.clientHeight <= 260 && el.scrollWidth <= el.clientWidth + 1))
  await page.screenshot({ path: path.join(run, 'candidate-long-review.png'), animations: 'disabled' })
  const bodyRead = () => page.evaluate(async id => (await (await import('/src/lib/db.ts')).getAllChapters()).find(ch => ch.id === id)?.content, seed.chapterId)
  check('expanding and scrolling a candidate never changes the chapter', await bodyRead() === seed.before)
  await candidates.getByRole('button', { name: '全部留档', exact: true }).click()
  await page.locator('[data-candidate-id="review-stale"]').waitFor()
  const stale = page.locator('[data-candidate-id="review-stale"]'), reconcile = page.locator('[data-candidate-id="review-reconcile"]')
  check('stale and uncertain outcomes expose causes and full-text review without an invalid apply button', (await stale.innerText()).includes('正文已由作者修改') && await stale.locator('summary').count() === 1 && await reconcile.getByRole('button', { name: '应用到正文', exact: true }).count() === 0 && (await reconcile.innerText()).includes('请先核对当前正文'))
  check('applied and discarded candidates remain readable in the archive', await page.locator('[data-candidate-status="applied"] summary').count() === 1 && await page.locator('[data-candidate-status="discarded"] summary').count() === 1)
  await candidates.getByRole('button', { name: '待处理候选', exact: true }).click()
  await stale.waitFor({ state: 'hidden' }); await row.waitFor()
  await row.getByRole('button', { name: '放弃', exact: true }).click()
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'revisionPayloads') throw new DOMException('C:\\private-author\\secret?token=private', 'QuotaExceededError'); return put.apply(this, args) }
    window.restoreRevisionPut = () => { IDBObjectStore.prototype.put = put }
  })
  await row.getByRole('button', { name: '确认放弃', exact: true }).click()
  await candidates.locator('[data-candidate-feedback="error"]').waitFor()
  await page.waitForTimeout(3000)
  const unchanged = await page.evaluate(async () => (await (await import('/src/lib/revision/candidateStore.ts')).loadCandidate('review-long')).status)
  check('failed discard stays pending, preserves the candidate and reports a persistent safe failure', unchanged === 'pending' && await row.isVisible() && !(await candidates.locator('[data-candidate-feedback="error"]').innerText()).includes('private') && await bodyRead() === seed.before)
  await page.evaluate(() => window.restoreRevisionPut()); await row.getByRole('button', { name: '确认放弃', exact: true }).click()
  await candidates.locator('[data-candidate-feedback="success"]').waitFor(); await row.waitFor({ state: 'hidden' })
  check('explicit discard retry persists the real status without rewriting body', await page.evaluate(async () => (await (await import('/src/lib/revision/candidateStore.ts')).loadCandidate('review-long')).status) === 'discarded' && await bodyRead() === seed.before)
  const shown = await candidates.locator('[data-candidate-id]').count()
  await page.evaluate(() => {
    const getAll = IDBObjectStore.prototype.getAll
    IDBObjectStore.prototype.getAll = function (...args) { if (this.name === 'revisionPayloads') throw Error('private-read-failure'); return getAll.apply(this, args) }
    window.restoreRevisionRead = () => { IDBObjectStore.prototype.getAll = getAll }
  })
  await candidates.getByRole('button', { name: '重试读取', exact: true }).click(); await candidates.getByRole('alert').last().waitFor()
  check('failed refresh preserves the readable snapshot and disables uncertain write actions', await candidates.locator('[data-candidate-id]').count() === shown && await candidates.getByRole('button', { name: '放弃', exact: true }).isDisabled())
  await page.evaluate(() => window.restoreRevisionRead()); await candidates.getByRole('button', { name: '重试读取', exact: true }).click()
  await candidates.getByRole('alert').waitFor({ state: 'hidden' })
  await page.keyboard.press('Escape'); await candidates.waitFor({ state: 'hidden' })
  check('candidate dialog Escape restores focus to its real App trigger', await openCandidates.evaluate(el => el === document.activeElement))
  const openReports = page.getByRole('button', { name: '检查报告', exact: true })
  await openReports.click()
  const reports = page.getByRole('dialog', { name: '检查报告', exact: true })
  await reports.locator('[data-report-id]').waitFor()
  check('long archived findings start with a compact summary and expand on demand', await reports.locator('[data-report-id] details').evaluate(el => !el.open))
  await reports.locator('[data-report-id] summary').click()
  check('real archived reports retain full long findings, inert HTML and the original chapter title', (await reports.innerText()).includes(seed.after) && (await reports.innerText()).includes('落档时章节名') && !await reports.locator('img,script').count() && await page.evaluate(() => !window.reviewExecuted))
  for (const zoom of [100, 160]) {
    await page.setViewportSize({ width: 1000, height: 640 })
    await page.evaluate(async value => (await import('/src/lib/settings/theme.ts')).applyZoom(value, { manual: true }), zoom)
    const bounds = await reports.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, rect: el.getBoundingClientRect().toJSON() }))
    check(`long report and actions stay inside the viewport at ${zoom}%`, bounds.scroll <= bounds.width + 1 && bounds.rect.left >= 0 && bounds.rect.right <= 1001 && bounds.rect.bottom <= 641, bounds)
  }
  await page.keyboard.press('Escape'); await reports.waitFor({ state: 'hidden' })
  check('report dialog Escape restores trigger focus', await openReports.evaluate(el => el === document.activeElement))
  await page.setViewportSize({ width: 1366, height: 900 })
  await page.evaluate(async () => {
    ;(await import('/src/lib/settings/theme.ts')).applyZoom(100, { manual: true })
    const db = await import('/src/lib/db.ts'), core = await import('/src/lib/db/core.ts')
    const original = core.ops; let release
    const wait = new Promise(resolve => { release = resolve })
    window.reviewOwner = { original, release, started: false }
    db.setStoreOps({ ...original, getAll: async store => {
      const rows = await original.getAll(store)
      if (store === 'revisionPayloads') { window.reviewOwner.started = true; await wait }
      return rows
    } })
  })
  await openCandidates.click(); await page.waitForFunction(() => window.reviewOwner.started)
  await page.evaluate(async () => {
    const owner = window.reviewOwner
    ;(await import('/src/lib/db.ts')).setStoreOps({ ...owner.original, getAll: async store => store === 'revisionPayloads' ? [] : owner.original.getAll(store) })
  })
  await page.waitForFunction(() => document.querySelector('[data-revision-candidates]')?.textContent.includes('还没有待审阅的候选'))
  await page.evaluate(() => window.reviewOwner.release())
  await page.waitForTimeout(100)
  check('late reads cannot reintroduce the previous backend candidate list after a mounted owner change', await candidates.locator('[data-candidate-id]').count() === 0 && (await candidates.innerText()).includes('还没有待审阅的候选'))
  await page.evaluate(async () => (await import('/src/lib/db.ts')).setStoreOps(window.reviewOwner.original))
  await row.waitFor({ state: 'hidden' })
  await page.locator('[data-candidate-id="review-reconcile"]').waitFor()
  check('restored owner reads its own archive after rejecting stale receipts', await candidates.locator('[data-candidate-id="review-reconcile"]').count() === 1)
  // Exercise actual candidate application on two isolated IndexedDB backends with identical IDs.
  await page.evaluate(async seed => {
    const store = await import('/src/lib/revision/candidateStore.ts')
    for (const id of ['review-switch', 'review-success', 'review-sibling']) {
      const result = await store.saveCandidate({ id, jobId: id === 'review-sibling' ? 'review-success-job' : id + '-job', projectId: seed.pid, chapterId: seed.chapterId,
        status: 'pending', text: seed.after, beforeText: seed.before, summary: id, bytes: 0,
        createdAt: Date.now(), updatedAt: Date.now(), generation: 1 })
      if (!result.ok) throw Error(JSON.stringify(result))
    }
  }, seed)
  await candidates.getByRole('button', { name: '重试读取', exact: true }).click()
  await page.locator('[data-candidate-id="review-switch"]').waitFor()
  await page.evaluate(async seed => {
    const db = await import('/src/lib/db.ts'), core = await import('/src/lib/db/core.ts'), original = core.ops
    const oldCandidate = await original.get('revisionPayloads', 'review-switch'), oldChapter = await original.get('chapters', seed.chapterId)
    const replacement = await new Promise((resolve, reject) => {
      const request = indexedDB.open('revision-owner-isolated', 1)
      request.onupgradeneeded = () => { request.result.createObjectStore('chapters', { keyPath: 'id' }); request.result.createObjectStore('revisionPayloads', { keyPath: 'id' }) }
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    const request = (store, mode, action) => new Promise((resolve, reject) => {
      const tx = replacement.transaction(store, mode), req = action(tx.objectStore(store)); let result
      req.onsuccess = () => { result = req.result }; tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
    })
    await request('chapters', 'readwrite', s => s.put(oldChapter)); await request('revisionPayloads', 'readwrite', s => s.put(oldCandidate))
    let release; const held = new Promise(resolve => { release = resolve })
    const test = window.revisionSwitch = { original, oldCandidate, oldChapter, replacement, release, enabled: false, waiting: false, resumed: false, writes: 0, reads: 0 }
    const local = store => store === 'chapters' || store === 'revisionPayloads'
    test.alternate = { ...original, putStrict: undefined,
      getAll: store => local(store) ? request(store, 'readonly', s => s.getAll()) : original.getAll(store),
      get: (store, key) => local(store) ? request(store, 'readonly', s => s.get(key)) : original.get(store, key),
      getAllByIndex: async (store, index, key) => local(store) ? (await request(store, 'readonly', s => s.getAll())).filter(row => row[index] === key) : original.getAllByIndex(store, index, key),
      put: (store, value) => { test.writes++; return local(store) ? request(store, 'readwrite', s => s.put(value)) : original.put(store, value) },
      del: (store, key) => { test.writes++; return local(store) ? request(store, 'readwrite', s => s.delete(key)) : original.del(store, key) },
      bulkPut: (...args) => { test.writes++; return original.bulkPut(...args) },
      bulkDel: (...args) => { test.writes++; return original.bulkDel(...args) },
    }
    db.setStoreOps({ ...original, getAll: async store => {
      const rows = await original.getAll(store)
      if (store === 'revisionPayloads') {
        test.reads++
        if (test.enabled) { test.waiting = true; await held; test.resumed = true }
      }
      return rows
    } })
  }, seed)
  await page.waitForFunction(() => window.revisionSwitch.reads > 0)
  await page.locator('[data-candidate-id="review-switch"]').getByRole('button', { name: '应用到正文', exact: true }).waitFor()
  await page.waitForTimeout(100)
  await page.evaluate(() => { window.revisionSwitch.enabled = true })
  await page.locator('[data-candidate-id="review-switch"]').getByRole('button', { name: '应用到正文', exact: true }).click()
  await page.waitForFunction(() => window.revisionSwitch.waiting)
  await page.evaluate(async () => (await import('/src/lib/db.ts')).setStoreOps(window.revisionSwitch.alternate))
  await page.locator('[data-candidate-id="review-switch"]').waitFor()
  await page.evaluate(() => window.revisionSwitch.release())
  await page.waitForFunction(() => window.revisionSwitch.resumed)
  await page.waitForTimeout(300)
  const result = await page.evaluate(async seed => {
    const t = window.revisionSwitch
    return { writes: t.writes, oldChapter: JSON.stringify(await t.original.get('chapters', seed.chapterId)) === JSON.stringify(t.oldChapter),
      oldCandidate: JSON.stringify(await t.original.get('revisionPayloads', 'review-switch')) === JSON.stringify(t.oldCandidate),
      newChapter: JSON.stringify(await t.alternate.get('chapters', seed.chapterId)) === JSON.stringify(t.oldChapter),
      newCandidate: JSON.stringify(await t.alternate.get('revisionPayloads', 'review-switch')) === JSON.stringify(t.oldCandidate) }
  }, seed)
  check('an actual delayed candidate application cannot write the original or same-ID replacement database after a backend switch', result.writes === 0 && result.oldChapter && result.oldCandidate && result.newChapter && result.newCandidate, result)
  await page.evaluate(async () => (await import('/src/lib/db.ts')).setStoreOps(window.revisionSwitch.original))
  const success = page.locator('[data-candidate-id="review-success"]'); await success.waitFor()
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'revisionPayloads' && args[0]?.id === 'review-sibling' && args[0]?.report?.status === 'stale') throw new DOMException('fixture quota', 'QuotaExceededError')
      return put.apply(this, args)
    }
    window.restorePartialFailure = () => { IDBObjectStore.prototype.put = put }
  })
  await success.getByRole('button', { name: '应用到正文', exact: true }).click()
  await candidates.locator('[data-candidate-feedback="partial"]').waitFor()
  const applied = await page.evaluate(async seed => {
    const db = await import('/src/lib/db.ts'), c = await (await import('/src/lib/revision/candidateStore.ts')).loadCandidate('review-success')
    return { status: c?.status, text: (await db.getAllChapters()).find(ch => ch.id === seed.chapterId)?.content,
      snapshots: (await db.getSnapshots(seed.chapterId)).length }
  }, seed)
  check('normal candidate application still writes the original chapter, records a snapshot and confirms the receipt', applied.status === 'applied' && applied.text === seed.after && applied.snapshots > 0, { status: applied.status, snapshots: applied.snapshots, textMatches: applied.text === seed.after })
  const partial = await candidates.locator('[data-candidate-feedback="partial"]').innerText()
  check('a failed sibling update is reported as partial instead of hiding behind applied success', partial.includes('1 份同批候选未能确认标记过期') && partial.includes('正文已应用') && await page.evaluate(async () => (await (await import('/src/lib/revision/candidateStore.ts')).loadCandidate('review-sibling')).status) === 'pending', partial)
  await page.screenshot({ path: path.join(run, 'partial-warning.png'), animations: 'disabled' })
  await page.evaluate(() => window.restorePartialFailure())
  const sibling = page.locator('[data-candidate-id="review-sibling"]')
  await sibling.getByRole('button', { name: '应用到正文', exact: true }).click()
  await candidates.locator('[data-candidate-feedback="error"]').waitFor()
  check('a sibling whose stale marker failed still cannot overwrite the updated chapter', await bodyRead() === seed.after && await page.evaluate(async () => (await (await import('/src/lib/revision/candidateStore.ts')).loadCandidate('review-sibling')).status) === 'pending')
  check('no model requests or unexpected page errors', !report.modelRequests.length && !report.errors.length, { models: report.modelRequests, errors: report.errors })
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); await page?.screenshot({ path: path.join(run, 'failure.png'), animations: 'disabled' }).catch(() => {}) }
finally {
  report.stale = fingerprint !== snapshot(root).fingerprint; if (report.stale) report.status = 'failed'
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close()
  console.log(JSON.stringify({ run, status: report.status, passed: report.checks.filter(c => c.passed).length, total: report.checks.length, stale: report.stale, failure: report.failure })); if (report.status !== 'passed') process.exitCode = 1
}
