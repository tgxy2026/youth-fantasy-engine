// Real NovelEditor volume/chapter CRUD via PromptModal, isolated native IDB and a replaced storage owner. No live author data or model.
// P1-A missing scenario: the name-prompt CRUD dispatch (submitNamePrompt → doAddVolume/doRenameChapter/…) is newly owned.
// Under the mounted owner a rename persists and updates the tree, and a new volume persists. After setStoreOps replaces the
// store (bumping the storage epoch) a late rename/add is blocked from BOTH owners, surfaces a failure prompt, and — crucially —
// leaves the tree title unchanged (write-first: no UI/DB divergence) and adds no volume. A remounted editor owns the restored
// store and can rename again. Guards the submitNamePrompt try/catch (PromptModal ignores the returned promise) and the
// doRenameChapter write-first reorder.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-editor-crud-owner-'))
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'frontend-editor-crud-owner', at: new Date().toISOString(), run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
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
    await db.saveChapter({ id: 'crud-owned', projectId: pid, volumeId: vol?.id ?? '', order: 9999, title: '原仓章名甲', content: '原仓 CRUD 正文', summary: '', status: '构思', wordCount: 7, createdAt: Date.now(), updatedAt: Date.now() })
    writeStringPref(`editor-last-chapter:${pid}`, 'crud-owned')
    window.__crudOwner = { originalOps, pid, volId: vol?.id ?? '' }
  })

  const editor = page.locator('textarea.novel-textarea')
  const titleSpan = page.locator('[data-chapter-id="crud-owned"] span[title^="双击改章名"]')
  const openEditor = async () => { await nav.getByRole('button', { name: '正文编辑', exact: true }).click(); await editor.waitFor() }
  const readOriginalTitle = () => page.evaluate(async () => (await window.__crudOwner.originalOps.get('chapters', 'crud-owned'))?.title)
  const expandAll = async () => {
    for (let i = 0; i < 12; i++) {
      const t = page.getByRole('button', { name: '展开本卷章节', exact: true }).first()
      if (!await t.isVisible().catch(() => false)) break
      await t.click()
    }
  }
  const promptSubmit = async (dialogName, value) => {
    const dlg = page.getByRole('dialog', { name: dialogName })
    await dlg.waitFor()
    await dlg.getByRole('textbox').fill(value)
    await dlg.getByRole('button', { name: '确定', exact: true }).click()
    await dlg.waitFor({ state: 'detached' }).catch(() => {})
  }
  const renameChapter = async (value) => { await expandAll(); await titleSpan.waitFor({ state: 'visible' }); await titleSpan.dblclick(); await promptSubmit('修改章名', value) }
  const addVolume = async (value) => { await page.locator('button[title="新建卷"]').click(); await promptSubmit('新建卷', value) }
  const waitToast = async () => { await page.locator('[data-toast]').waitFor(); await page.waitForTimeout(500); return page.locator('[data-toast]').innerText().catch(() => '') }

  await openEditor()
  await page.waitForFunction(() => document.querySelector('textarea.novel-textarea')?.value === '原仓 CRUD 正文')
  check('the editor opens the seeded chapter under its mounted owner', await editor.inputValue() === '原仓 CRUD 正文')

  // ---- Positive control: rename persists and updates the tree; a new volume persists ----
  await renameChapter('改名后章名乙')
  await page.waitForFunction(async () => (await window.__crudOwner.originalOps.get('chapters', 'crud-owned'))?.title === '改名后章名乙')
  await expandAll(); await page.waitForFunction(() => document.querySelector('[data-chapter-id="crud-owned"] span[title^="双击改章名"]')?.textContent === '改名后章名乙')
  check('a chapter rename persists into the current owner and updates the tree', await readOriginalTitle() === '改名后章名乙' && (await titleSpan.innerText()) === '改名后章名乙')
  await addVolume('新增卷丙')
  await page.waitForFunction(async () => (await window.__crudOwner.originalOps.getAll('volumes')).some(v => v.title === '新增卷丙'))
  check('a new volume persists into the current owner', await page.evaluate(async () => (await window.__crudOwner.originalOps.getAll('volumes')).some(v => v.title === '新增卷丙')))

  // ---- Owner switch: replace the store (bumps the epoch ⇒ the mount-captured owner goes stale) ----
  await page.evaluate(async () => {
    const owner = window.__crudOwner
    const replacement = await new Promise((resolve, reject) => {
      const open = indexedDB.open('crud-owner-replacement', 1)
      open.onupgradeneeded = () => { open.result.createObjectStore('chapters', { keyPath: 'id' }); open.result.createObjectStore('volumes', { keyPath: 'id' }) }
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error)
    })
    const request = (store, mode, action) => new Promise((resolve, reject) => {
      const tx = replacement.transaction(store, mode), req = action(tx.objectStore(store)); let value
      req.onsuccess = () => { value = req.result }; tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
    })
    const original = await owner.originalOps.get('chapters', 'crud-owned')
    await request('chapters', 'readwrite', s => s.put({ ...original, title: '替换仓章名' }))
    await request('volumes', 'readwrite', s => s.put({ id: 'crud-replacement-vol', projectId: owner.pid, order: 0, title: '替换仓卷', description: '', createdAt: Date.now() }))
    const both = { chapters: true, volumes: true }
    owner.replacement = { ...owner.originalOps,
      get: (store, key) => both[store] ? request(store, 'readonly', s => s.get(key)) : owner.originalOps.get(store, key),
      getAll: store => both[store] ? request(store, 'readonly', s => s.getAll()) : owner.originalOps.getAll(store),
      getAllByIndex: async (store, index, key) => both[store] ? (await request(store, 'readonly', s => s.getAll())).filter(row => row[index] === key) : owner.originalOps.getAllByIndex(store, index, key),
      put: (store, value) => both[store] ? request(store, 'readwrite', s => s.put(value)) : owner.originalOps.put(store, value),
    }
    const db = await import('/src/lib/db.ts'); db.setStoreOps(owner.replacement)
  })

  // ---- Negative: a late rename must not write into either owner, must prompt, and must NOT change the tree title ----
  await renameChapter('旧仓私密章名')
  const renameToast = await waitToast()
  const titles = await page.evaluate(async () => ({
    oldSame: (await window.__crudOwner.originalOps.get('chapters', 'crud-owned'))?.title,
    replacement: (await window.__crudOwner.replacement.get('chapters', 'crud-owned'))?.title,
  }))
  check('a late chapter rename cannot write the private title into either owner', titles.oldSame === '改名后章名乙' && titles.replacement === '替换仓章名', titles)
  check('the blocked chapter rename surfaces a failure prompt', renameToast.includes('保存失败'), { renameToast })
  await expandAll()
  check('the rejected chapter rename leaves the tree title unchanged (no UI/DB divergence)', (await titleSpan.innerText()) === '改名后章名乙', { treeTitle: await titleSpan.innerText() })

  // ---- Negative: a late add-volume must not create a volume in either owner, and must prompt ----
  const volCountBefore = await page.evaluate(async () => (await window.__crudOwner.originalOps.getAll('volumes')).length)
  await addVolume('私密新增卷')
  const addToast = await waitToast()
  const vols = await page.evaluate(async () => ({
    oldHas: (await window.__crudOwner.originalOps.getAll('volumes')).some(v => v.title === '私密新增卷'),
    replHas: (await window.__crudOwner.replacement.getAll('volumes')).some(v => v.title === '私密新增卷'),
    oldCount: (await window.__crudOwner.originalOps.getAll('volumes')).length,
  }))
  check('a late add-volume cannot create the private volume in either owner', !vols.oldHas && !vols.replHas && vols.oldCount === volCountBefore, vols)
  check('the blocked add-volume surfaces a failure prompt', addToast.includes('保存失败'), { addToast })

  // ---- Recovery: a freshly remounted editor owns the restored store and can rename again ----
  await page.evaluate(async () => { const db = await import('/src/lib/db.ts'); db.setStoreOps(window.__crudOwner.originalOps) })
  await nav.getByRole('button', { name: '写作面板', exact: true }).click(); await editor.waitFor({ state: 'hidden' })
  await openEditor(); await page.waitForFunction(() => document.querySelector('textarea.novel-textarea')?.value === '原仓 CRUD 正文')
  await renameChapter('新仓章名丁')
  await page.waitForFunction(async () => (await window.__crudOwner.originalOps.get('chapters', 'crud-owned'))?.title === '新仓章名丁')
  check('a remounted editor chapter rename persists into the restored owner', await readOriginalTitle() === '新仓章名丁')

  check('no model requests or unexpected browser errors', !report.modelRequests.length && !report.errors.length, { errors: report.errors, models: report.modelRequests })
  await page.screenshot({ path: path.join(run, 'crud-owner-result.png'), animations: 'disabled' }); report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); await page?.screenshot({ path: path.join(run, 'failure.png'), animations: 'disabled' }).catch(() => {}) }
finally {
  report.stale = fingerprint !== snapshot(root).fingerprint; if (report.stale) report.status = 'failed'
  report.passed = report.checks.filter(c => c.passed).length
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close()
  console.log(JSON.stringify({ run, status: report.status, passed: report.passed, total: report.checks.length, stale: report.stale, failure: report.failure })); if (report.status !== 'passed') process.exitCode = 1
}