// Real template manager/personal-library UI in an isolated app and native IndexedDB.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), started = Date.now()
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-template-library-save-')), fingerprint = snapshot(root).fingerprint
const report = { run, fingerprint, checks: [], errors: [], modelRequests: [], status: 'running' }
const check = (name, passed, details) => { report.checks.push({ name, passed: !!passed, details }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`); if (!passed) throw Error(name + ': ' + JSON.stringify(details)) }
let server, browser, page
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen(); const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => { const url = route.request().url(); if (/chat\/completions|\/api\/ai(?:\/|$)/.test(url)) report.modelRequests.push('blocked'); return url.startsWith(origin + '/') ? route.continue() : route.abort() })
  page = await context.newPage(); page.setDefaultTimeout(120000); page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(origin, { waitUntil: 'commit' }); await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click(); await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click(); await page.getByRole('button', { name: '稍后再说', exact: true }).click()
  const seed = await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts'), { TABS } = await import('/src/lib/schema.ts'), { snapshotOfBuiltin } = await import('/src/lib/templates/snapshot.ts')
    const store = await import('/src/lib/templates/store.ts'), library = await import('/src/lib/templates/library.ts')
    ;(await import('/src/lib/settings/theme.ts')).applyZoom(100, { manual: true })
    const pid = db.getCurrentProjectId(), def = snapshotOfBuiltin(TABS.find(t => t.id === 'char-main'), { name: '模板库保存回归' })
    def.templateId = 'tpl_active_fixture'; await store.saveTemplateDef(pid, def)
    await library.publishTemplateDef({ ...def, templateId: 'tpl_seed_fixture', name: '库中已有模板' })
    return { pid, indexKey: library.LIBRARY_INDEX_KEY }
  })
  const nav = page.getByRole('navigation')
  if (!await nav.getByRole('button', { name: '主要角色', exact: true }).isVisible()) await nav.getByRole('button', { name: '角色管理', exact: true }).click()
  await nav.getByRole('button', { name: '主要角色', exact: true }).click(); await page.locator('[data-character-workspace]').waitFor(); page.setDefaultTimeout(20000)
  const modal = page.getByRole('dialog', { name: '模板 · 主要角色', exact: true }), panel = modal.locator('[data-template-library]')
  const open = async () => { await page.getByRole('button', { name: '档案工具', exact: true }).click(); await page.getByRole('group', { name: '档案工具选项', exact: true }).getByRole('button', { name: '模板管理', exact: true }).click(); await panel.waitFor() }
  const close = async () => { await modal.locator('button[aria-label="关闭"]').click(); await modal.waitFor({ state: 'hidden' }) }
  const failNative = (operation, needle, prefix = false) => page.evaluate(({ operation, needle, prefix }) => {
    const native = IDBObjectStore.prototype[operation]
    IDBObjectStore.prototype[operation] = function (...args) { const key = operation === 'put' ? args[0]?.key : args[0]; if (this.name === 'meta' && typeof key === 'string' && (prefix ? key.startsWith(needle) : key === needle)) throw new DOMException('C:\\private-library\\secret?token=private', 'QuotaExceededError'); return native.apply(this, args) }
    window.__restoreLibraryNative = () => { IDBObjectStore.prototype[operation] = native }
  }, { operation, needle, prefix })
  const settled = () => page.waitForFunction(() => {
    const button = [...document.querySelectorAll('[data-template-library] button')].find(b => b.textContent === '重新读取个人库')
    return button && !button.disabled
  })
  const readIndex = () => page.evaluate(async () => (await import('/src/lib/templates/library.ts')).loadLibraryIndex())
  await failNative('get', seed.indexKey); await open(); await panel.getByRole('alert').filter({ hasText: '读取失败' }).waitFor(); await settled()
  check('a real library read failure is not rendered as an empty library', await panel.getByText('这一页还没有存入个人库的模板。', { exact: false }).count() === 0 && await panel.getByRole('button', { name: '存为个人模板', exact: true }).isDisabled())
  await page.evaluate(() => window.__restoreLibraryNative()); await panel.getByRole('button', { name: '重新读取个人库', exact: true }).click(); await panel.getByText('库中已有模板', { exact: true }).waitFor(); await settled()
  check('explicit library read retry recovers the actual existing entry', (await readIndex()).entries.length === 1)
  await failNative('put', 'templateLibrary32:', true); await panel.getByRole('button', { name: '存为个人模板', exact: true }).click(); await panel.locator('[data-library-feedback="error"]').waitFor(); await settled(); await page.waitForTimeout(4100)
  check('publication failure stays visible and does not echo private error payloads', !(await panel.locator('[data-library-feedback="error"]').innerText()).includes('private') && (await readIndex()).entries.length === 1)
  await page.evaluate(() => window.__restoreLibraryNative()); await panel.getByRole('button', { name: '存为个人模板', exact: true }).click(); await panel.locator('[data-library-feedback="success"]').waitFor(); await settled()
  const adopted = await page.evaluate(async pid => (await import('/src/lib/templates/store.ts')).loadTemplateDef(pid, 'char-main'), seed.pid)
  check('explicit publication retry submits library definition and original-project provenance', adopted.origin.kind === 'library' && adopted.templateId === adopted.origin.templateId && (await readIndex()).entries.length === 2)
  await close()
  await page.evaluate(async pid => {
    const store = await import('/src/lib/templates/store.ts'), def = await store.loadTemplateDef(pid, 'char-main')
    await store.saveTemplateDef(pid, { ...def, templateId: 'tpl_legacy_snapshot', name: '模板库保存回归第二版' })
  }, seed.pid)
  await open(); await modal.getByText('模板库保存回归第二版', { exact: true }).waitFor(); await settled(); const originalVersion = await page.evaluate(async id => (await import('/src/lib/templates/library.ts')).loadLibraryVersion(id, 1), adopted.origin.templateId)
  await failNative('put', seed.indexKey); await panel.getByRole('button', { name: '发布新版本', exact: true }).click(); await panel.locator('[data-library-feedback="error"]').waitFor(); await settled()
  const partialVersion = await page.evaluate(async id => (await import('/src/lib/templates/library.ts')).loadLibraryVersion(id, 2), adopted.origin.templateId)
  const partialEntry = (await readIndex()).entries.find(e => e.templateId === adopted.origin.templateId)
  check('an actual index-write failure leaves an accepted version without claiming completion', partialVersion?.def.name === '模板库保存回归第二版' && partialEntry.latestVersion === 1, { name: partialVersion?.def.name, entry: partialEntry, error: await panel.locator('[data-library-feedback="error"]').innerText() })
  check('a legacy snapshot with mismatched IDs continues the provenance version line', !await page.evaluate(async () => (await import('/src/lib/templates/library.ts')).loadLibraryVersion('tpl_legacy_snapshot', 1)))
  await page.evaluate(() => window.__restoreLibraryNative()); await panel.getByRole('button', { name: '发布新版本', exact: true }).click(); await panel.locator('[data-library-feedback="success"]').waitFor(); await settled()
  const versions = await page.evaluate(async id => {
    const lib = await import('/src/lib/templates/library.ts'); return { first: await lib.loadLibraryVersion(id, 1), second: await lib.loadLibraryVersion(id, 2), third: await lib.loadLibraryVersion(id, 3), index: await lib.loadLibraryIndex() }
  }, adopted.origin.templateId)
  check('retry repairs the real index and preserves accepted immutable versions', JSON.stringify(versions.first) === JSON.stringify(originalVersion) && JSON.stringify(versions.second) === JSON.stringify(partialVersion) && !versions.third && versions.index.entries.find(e => e.templateId === adopted.origin.templateId).latestVersion === 2)
  await panel.locator('input[type="file"]').setInputFiles({ name: 'bad-template.json', mimeType: 'application/json', buffer: Buffer.from('{bad-json') }); await panel.locator('[data-library-feedback="error"]').waitFor(); await settled()
  check('invalid template imports have persistent failure feedback and preserve the library', (await readIndex()).entries.length === 2)
  const pack = await page.evaluate(async id => {
    const lib = await import('/src/lib/templates/library.ts'), io = await import('/src/lib/templates/packIO.ts'), { libraryKeyOf } = await import('/src/lib/templates/definition.ts'), source = (await lib.loadLibraryVersion(id, 2)).def
    const defs = ['tpl_import_first', 'tpl_import_second'].map((templateId, i) => ({ ...source, templateId, name: '批量导入模板' + i, origin: { kind: 'library', templateId, version: 1, fromName: '导入样板' } }))
    const pack = io.exportTemplatePack(defs); if (!pack.ok) throw Error(pack.detail)
    return { text: pack.text, secondKey: libraryKeyOf('tpl_import_second', 1) }
  }, adopted.origin.templateId)
  const upload = () => panel.locator('input[type="file"]').setInputFiles({ name: 'two-templates.json', mimeType: 'application/json', buffer: Buffer.from(pack.text) })
  await failNative('put', pack.secondKey); await upload(); await panel.locator('[data-library-feedback="error"]').filter({ hasText: '已确认处理 1 份' }).waitFor(); await settled()
  const partialIndex = await readIndex()
  check('partially accepted imports state the confirmed count and stop without false success', partialIndex.entries.some(e => e.templateId === 'tpl_import_first') && !partialIndex.entries.some(e => e.templateId === 'tpl_import_second'))
  await page.evaluate(() => window.__restoreLibraryNative()); await upload(); await panel.locator('[data-library-feedback="success"]').waitFor(); await settled()
  const imported = (await readIndex()).entries.filter(e => e.templateId.startsWith('tpl_import_'))
  check('explicit import retry is idempotent for previously accepted versions', imported.length === 2 && imported.every(e => e.versions.length === 1 && e.latestVersion === 1))
  check('no model requests or unexpected browser errors', !report.modelRequests.length && !report.errors.length, { errors: report.errors, models: report.modelRequests })
  await page.screenshot({ path: path.join(run, 'template-library-save.png'), animations: 'disabled' }); report.status = 'passed'
} catch (error) { report.status = 'failed'; report.failure = error.stack || String(error); await page?.screenshot({ path: path.join(run, 'failure.png'), animations: 'disabled' }).catch(() => {}) }
finally {
  report.stale = fingerprint !== snapshot(root).fingerprint; if (report.stale) report.status = 'failed'
  report.elapsedMs = Date.now() - started; await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close()
  console.log(JSON.stringify({ run, status: report.status, passed: report.checks.filter(c => c.passed).length, total: report.checks.length, stale: report.stale, elapsedMs: report.elapsedMs, failure: report.failure })); if (report.status !== 'passed') process.exitCode = 1
}
