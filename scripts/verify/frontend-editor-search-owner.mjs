// Real NovelEditor GlobalSearch replace, isolated native IDB and a replaced storage owner. No live author data or model.
// P1-A missing scenario: the full-text replace path is newly owned (patchChapter carries the mount-captured owner).
// Under the mounted owner it persists and syncs the active draft; after setStoreOps replaces the store (bumping the
// storage epoch) a late replace is blocked from BOTH owners, surfaces a failure prompt, and leaves the draft intact —
// no unhandled rejection. A freshly remounted editor owns the restored store and can replace again.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-editor-search-owner-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-editor-search-owner', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
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

  // Seed a dedicated chapter BEFORE the editor mounts so its mount-captured owner is valid.
  await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts'), core = await import('/src/lib/db/core.ts')
    const { writeStringPref } = await import('/src/lib/settings/uiPrefs.ts')
    ;(await import('/src/lib/settings/theme.ts')).applyZoom(100, { manual: true })
    const pid = db.getCurrentProjectId(), originalOps = core.ops
    const vol = (await db.getAllVolumes())[0]
    await db.saveChapter({ id: 'search-owned', projectId: pid, volumeId: vol?.id ?? '', order: 9999, title: '搜索归属探针章', content: '原仓搜索正文甲', summary: '', status: '构思', wordCount: 7, createdAt: Date.now(), updatedAt: Date.now() })
    writeStringPref(`editor-last-chapter:${pid}`, 'search-owned')
    window.__searchOwner = { originalOps, pid }
  })

  const editor = page.locator('textarea.novel-textarea')
  const openEditor = async () => { await nav.getByRole('button', { name: '正文编辑', exact: true }).click(); await editor.waitFor() }
  const readOriginal = () => page.evaluate(async () => (await window.__searchOwner.originalOps.get('chapters', 'search-owned'))?.content)
  const openSearch = async () => {
    await page.getByRole('button', { name: '编辑工具', exact: true }).click()
    await page.getByRole('button', { name: '全书搜索替换', exact: true }).click()
    await page.getByPlaceholder('搜索全书正文与章名…').waitFor()
  }
  const runReplace = async (query, replacement) => {
    await page.getByPlaceholder('搜索全书正文与章名…').fill(query)
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await page.getByPlaceholder('替换为…（留空即删除）').fill(replacement)
    await page.getByRole('button', { name: '全部替换', exact: true }).click()
    await page.getByRole('button', { name: '确定', exact: true }).click()
  }
  const closeSearch = async () => { await page.keyboard.press('Escape'); await page.getByPlaceholder('搜索全书正文与章名…').waitFor({ state: 'detached' }).catch(() => {}) }

  await openEditor()
  await page.waitForFunction(() => document.querySelector('textarea.novel-textarea')?.value === '原仓搜索正文甲')
  check('the editor opens the seeded chapter under its mounted owner', await editor.inputValue() === '原仓搜索正文甲')

  // ---- Positive control: under the current owner the replace persists and syncs the active draft ----
  await openSearch(); await runReplace('原仓搜索正文甲', '替换后正文乙')
  await page.waitForFunction(async () => (await window.__searchOwner.originalOps.get('chapters', 'search-owned'))?.content === '替换后正文乙')
  await page.waitForFunction(() => document.querySelector('textarea.novel-textarea')?.value === '替换后正文乙')
  check('search-replace persists into the current owner and syncs the active draft', await readOriginal() === '替换后正文乙' && await editor.inputValue() === '替换后正文乙')
  await closeSearch()

  // ---- Owner switch: replace the store (bumps the epoch ⇒ the mount-captured owner goes stale) ----
  await page.evaluate(async () => {
    const owner = window.__searchOwner
    const replacement = await new Promise((resolve, reject) => {
      const open = indexedDB.open('search-owner-replacement', 1); open.onupgradeneeded = () => open.result.createObjectStore('chapters', { keyPath: 'id' }); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error)
    })
    const request = (mode, action) => new Promise((resolve, reject) => {
      const tx = replacement.transaction('chapters', mode), req = action(tx.objectStore('chapters')); let value
      req.onsuccess = () => { value = req.result }; tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
    })
    const original = await owner.originalOps.get('chapters', 'search-owned')
    await request('readwrite', store => store.put({ ...original, content: '替换仓搜索内容' }))
    owner.replacement = { ...owner.originalOps,
      get: (store, key) => store === 'chapters' ? request('readonly', s => s.get(key)) : owner.originalOps.get(store, key),
      getAll: store => store === 'chapters' ? request('readonly', s => s.getAll()) : owner.originalOps.getAll(store),
      getAllByIndex: async (store, index, key) => store === 'chapters' ? (await request('readonly', s => s.getAll())).filter(row => row[index] === key) : owner.originalOps.getAllByIndex(store, index, key),
      put: (store, value) => store === 'chapters' ? request('readwrite', s => s.put(value)) : owner.originalOps.put(store, value),
    }
    const db = await import('/src/lib/db.ts'); db.setStoreOps(owner.replacement)
  })

  // ---- Negative: a late replace must not write the private replacement into either owner ----
  await openSearch(); await runReplace('替换后正文乙', '旧仓私密替换')
  await page.locator('[data-toast]').waitFor()
  await page.waitForTimeout(600)
  const owners = await page.evaluate(async () => ({
    oldSame: (await window.__searchOwner.originalOps.get('chapters', 'search-owned'))?.content,
    replacement: (await window.__searchOwner.replacement.get('chapters', 'search-owned'))?.content,
  }))
  check('a late search-replace cannot write the private replacement into either owner', owners.oldSame === '替换后正文乙' && owners.replacement === '替换仓搜索内容', owners)
  const toastText = await page.locator('[data-toast]').innerText().catch(() => '')
  check('the blocked search-replace surfaces a failure prompt', toastText.includes('全书替换失败'), { toastText })
  check('the rejected search-replace leaves the draft intact', await editor.inputValue() === '替换后正文乙')
  await closeSearch()

  // ---- Recovery: a freshly remounted editor owns the restored store and can replace again ----
  await page.evaluate(async () => { const db = await import('/src/lib/db.ts'); db.setStoreOps(window.__searchOwner.originalOps) })
  await nav.getByRole('button', { name: '写作面板', exact: true }).click(); await editor.waitFor({ state: 'hidden' })
  await openEditor(); await page.waitForFunction(() => document.querySelector('textarea.novel-textarea')?.value === '替换后正文乙')
  await openSearch(); await runReplace('替换后正文乙', '新仓替换丙')
  await page.waitForFunction(async () => (await window.__searchOwner.originalOps.get('chapters', 'search-owned'))?.content === '新仓替换丙')
  check('a remounted editor search-replace persists into the restored owner', await readOriginal() === '新仓替换丙')

  check('no model requests or unexpected browser errors', !report.modelRequests.length && !report.errors.length, { errors: report.errors, models: report.modelRequests })
  await page.screenshot({ path: path.join(run, 'search-owner-result.png'), animations: 'disabled' }); report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); await page?.screenshot({ path: path.join(run, 'failure.png'), animations: 'disabled' }).catch(() => {}) }
finally {
  report.stale = fingerprint !== snapshot(root).fingerprint; if (report.stale) report.status = 'failed'
  report.passed = report.checks.filter(c => c.passed).length
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close()
  console.log(JSON.stringify({ run, status: report.status, passed: report.passed, total: report.checks.length, stale: report.stale, failure: report.failure })); if (report.status !== 'passed') process.exitCode = 1
}