#!/usr/bin/env node
// Production renderer + actual web server guest injection + Chromium IndexedDB.
// Faults affect only chapter writes in this probe's isolated persistent profile.
'use strict'

/**
 * 🔴 首屏导航单独放宽（BOOT_TIMEOUT）：这台机器上「持久化 profile + 全量路由拦截 + 冷启动大包」
 *    实测同一导航要 41s（2026-10-28 实测；手工直连只要 112ms），15s 会稳定误判成产品故障。
 *    断言本身仍走各页 15s 默认超时 —— 放宽的只是「等页面起来」，不是「等结果对」。
 */
const BOOT_TIMEOUT = 60_000
const fs = require('node:fs/promises')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { chromium } = require('playwright')
const ROOT = path.resolve(__dirname, '../../..')
const PID = 'guest-save-project', VID = 'guest-save-volume', CH = 'guest-save-chapter'
const TITLE = '游客保存故障临时作品'
const EDITOR = '落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）'
const ORIGINAL = '隔离游客模式的原始手稿。'
const checks = []
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const arg = name => { const index = process.argv.indexOf(name); if (index < 0) return undefined; const value = process.argv[index + 1]; if (!value || value.startsWith('--')) throw new Error(name + ' requires a value'); return value }
const check = (id, ok, detail) => { checks.push({ id, passed: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id); if (!ok) throw new Error(id) }
async function until(fn, timeout = 45000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error('Timed out waiting for actual state')
}
async function readChapter(page, databaseName) {
  return page.evaluate(({ databaseName, CH }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName)
    request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error('Expected existing database')) }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result, tx = database.transaction('chapters', 'readonly')
      const read = tx.objectStore('chapters').get(CH)
      let value
      read.onsuccess = () => { value = read.result }
      tx.oncomplete = () => { database.close(); resolve(value) }
      tx.onabort = () => { database.close(); reject(tx.error ?? new Error('Read aborted')) }
    }
  }), { databaseName, CH })
}
async function dismiss(page) {
  for (const name of ['稍后再说', '知道了', '跳过，直接开始']) {
    const button = page.getByRole('button', { name, exact: true })
    if (await button.isVisible().catch(() => false)) await button.click()
  }
}
async function openEditor(page) {
  await page.getByRole('heading', { name: TITLE, exact: true }).waitFor({ timeout: 45000 })
  await dismiss(page)
  await page.locator('div.card-hover').filter({ has: page.getByRole('heading', { name: TITLE, exact: true }) }).getByRole('button', { name: '打开项目', exact: true }).click()
  // 🔴 备份提醒是「打开项目之后」才挂的，而它把背景节点置为 inert/aria-hidden ⇒ 背景里的
  //    `<nav>` **从可访问性树里消失**，`getByRole('navigation')` 连 `state:'attached'` 都等不到
  //    （2026-10-26 实测 storage.web-guest-save：等满 45s 超时，而 failure.png 里导航其实画着）。
  //    所以先用 CSS 定位等它进 DOM，再循环「关提醒 → 看角色定位是否可见」，最后仍要求
  //    role=导航真的可见 —— 只改准备流程，产品可用性断言不放宽。
  const navEl = page.locator('nav')
  await navEl.waitFor({ state: 'attached', timeout: 45000 })
  const nav = page.getByRole('navigation')
  const deadline = Date.now() + 45000
  while (Date.now() < deadline && !(await nav.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: '稍后再说', exact: true }).click({ timeout: 2000 }).catch(() => {})
    await dismiss(page)
    await page.waitForTimeout(200)
  }
  await nav.waitFor({ timeout: 5000 })
  await dismiss(page)
  // 🔴 提醒层可能在导航可见之后又盖上来（异步挂载）：改成「点一下 → 关提醒 → 再点」，
  //    直到真的进了正文编辑；进不去仍然报错。
  const enterDeadline = Date.now() + 45000
  let entered = false
  while (!entered && Date.now() < enterDeadline) {
    try {
      await nav.getByRole('button', { name: '正文编辑', exact: true }).click({ timeout: 4000 })
      await page.getByPlaceholder(EDITOR).waitFor({ timeout: 8000 })
      entered = true
    } catch {
      await dismiss(page)
      await page.waitForTimeout(200)
    }
  }
  if (!entered) throw new Error('无法进入正文编辑：导航不可用或仍有提醒遮挡')
}
async function main() {
  const buildArg = arg('--build-dir')
  if (!buildArg) throw new Error('--build-dir is required; old builds are not selected implicitly')
  const build = await fs.realpath(path.resolve(buildArg))
  await fs.access(path.join(build, 'index.html'))
  const output = arg('--result-file')
  if (output && (!path.resolve(output).startsWith(path.join(ROOT, '.workbuddy', 'tmp') + path.sep) || !output.endsWith('.json'))) throw new Error('Result must be a JSON file under workspace .workbuddy/tmp')
  const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/web-guest-save-'))
  const profile = path.join(runRoot, 'profile'), data = path.join(runRoot, 'server-data')
  await fs.mkdir(data)
  const { snapshot } = await import(pathToFileURL(path.join(ROOT, 'scripts/audit/platform/source.mjs')).href)
  const { hashPaths } = await import(pathToFileURL(path.join(ROOT, 'scripts/verify/evidence.mjs')).href)
  const sourceFingerprint = snapshot(ROOT).fingerprint
  const dbSource = await fs.readFile(path.join(ROOT, 'src/lib/db/core.ts'), 'utf8')
  const databaseName = /const DB_NAME = '([^']+)'/.exec(dbSource)?.[1]
  if (!databaseName) throw new Error('Cannot determine actual database name')
  const buildManifest = await hashPaths(build, ['.'])
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer(); listener.on('error', reject)
    listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)) })
  })
  const origin = 'http://127.0.0.1:' + port
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data, YFE_WWW: build, YFE_REGISTER: 'closed', YFE_BOOTSTRAP_INVITE: '' }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[key]
  let server, context, page, serverLog = '', error = null
  const requests = [], pageErrors = []
  const launch = async () => {
    const ctx = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true,
      viewport: { width: 1440, height: 1000 }, args: ['--no-proxy-server'], env })
    await ctx.addInitScript(({ CH }) => {
      window.__guestSaveFault = { mode: null, attempts: 0 }
      try { localStorage.setItem('yfe-guest-tip-off', '1') } catch { /* origin not ready */ }
      const original = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function(value, ...keys) {
        const fault = window.__guestSaveFault
        if (this.name === 'chapters' && value?.id === CH && fault.mode) {
          fault.attempts++
          if (fault.mode === 'quota') throw new DOMException('quota-fixture: isolated chapter write', 'QuotaExceededError')
          const request = original.call(this, value, ...keys)
          this.transaction.abort()
          return request
        }
        return original.call(this, value, ...keys)
      }
    }, { CH })
    await ctx.route('**/*', route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin === origin) { requests.push({ method: request.method(), pathname: url.pathname }); return route.continue() }
      if (['data:', 'blob:'].includes(url.protocol)) return route.continue()
      return route.abort()
    })
    const pg = ctx.pages()[0] ?? await ctx.newPage()

    pg.setDefaultTimeout(15000)
    pg.on('pageerror', value => pageErrors.push(String(value)))
    return { ctx, pg }
  }
  try {
    server = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    server.on('error', value => { serverLog += String(value) })
    server.stdout.on('data', value => { serverLog += value }); server.stderr.on('data', value => { serverLog += value })
    await until(async () => { try { return (await fetch(origin + '/api/ping', { signal: AbortSignal.timeout(1000) })).ok } catch { return false } })
    const first = await launch(); context = first.ctx; page = first.pg
    await page.goto(origin + '/guest', { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT })
    await page.waitForFunction(async name => (await indexedDB.databases()).some(item => item.name === name), databaseName)
    check('initial-flags', await page.evaluate(() => !!window.__YFE_WEB__ && !!window.__YFE_GUEST__ && !window.__YFE_PORTABLE__ && !window.electronStore))
    await page.evaluate(({ databaseName, PID, VID, CH, TITLE, ORIGINAL }) => new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result, tx = database.transaction(['projects', 'volumes', 'chapters', 'meta'], 'readwrite'), now = Date.now()
        tx.objectStore('projects').put({ id: PID, name: TITLE, genre: '玄幻', intro: '', projectType: 'full', createdAt: now, updatedAt: now })
        tx.objectStore('volumes').put({ id: VID, projectId: PID, title: '验收卷', description: '', order: 0, createdAt: now })
        tx.objectStore('chapters').put({ id: CH, projectId: PID, volumeId: VID, title: '游客验收章', content: ORIGINAL, summary: '', wordCount: ORIGINAL.length, order: 0, status: '草稿', tags: [], createdAt: now, updatedAt: now })
        tx.objectStore('meta').put({ key: 'welcomeDone', value: '1' })
        tx.oncomplete = () => { database.close(); resolve(true) }
        tx.onabort = () => { database.close(); reject(tx.error) }
      }
    }), { databaseName, PID, VID, CH, TITLE, ORIGINAL })
    await page.reload({ waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT }); await openEditor(page)
    check('fixture-readback', (await page.getByPlaceholder(EDITOR).inputValue()) === ORIGINAL && (await readChapter(page, databaseName)).content === ORIGINAL)
    let persisted = ORIGINAL
    for (const mode of ['quota', 'abort']) {
      const wanted = '游客草稿：' + mode + '失败后必须保留，恢复后无需重新输入。'
      await page.evaluate(mode => { window.__guestSaveFault.mode = mode; window.__guestSaveFault.attempts = 0 }, mode)
      await page.getByPlaceholder(EDITOR).fill(wanted)
      await page.keyboard.press('Control+s')
      await page.waitForFunction(() => window.__guestSaveFault.attempts > 0)
      await page.getByText(mode === 'quota' ? /保存失败.*quota-fixture/ : /保存失败.*abort/i).first().waitFor()
      check(mode + '.failure-visible', true)
      check(mode + '.failure-preserves-draft', (await page.getByPlaceholder(EDITOR).inputValue()) === wanted)
      check(mode + '.accepted-vs-persisted', (await readChapter(page, databaseName)).content === persisted)
      await page.screenshot({ path: path.join(runRoot, mode + '-failure.png') })
      await page.evaluate(() => { window.__guestSaveFault.mode = null })
      await page.keyboard.press('Control+s')
      await until(async () => (await readChapter(page, databaseName)).content === wanted)
      check(mode + '.retry-readback', true)
      persisted = wanted
    }
    check('backend-selection', requests.every(request => request.pathname !== '/api/data'))
    await context.close(); context = null
    const restarted = await launch(); context = restarted.ctx; page = restarted.pg
    await page.goto(origin + '/guest', { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT }); await openEditor(page)
    check('restart-readback', (await readChapter(page, databaseName)).content === persisted && (await page.getByPlaceholder(EDITOR).inputValue()) === persisted)
    check('no-pageerror', pageErrors.length === 0, pageErrors)
    await page.screenshot({ path: path.join(runRoot, 'restart-readback.png') })
    await fs.writeFile(path.join(runRoot, 'chapter-readback.json'), JSON.stringify(await readChapter(page, databaseName), null, 2))
    check('unchanged-inputs', snapshot(ROOT).fingerprint === sourceFingerprint)
  } catch (value) {
    error = String(value.stack ?? value)
    if (page) await page.screenshot({ path: path.join(runRoot, 'failure.png') }).catch(() => {})
  } finally {
    if (context) await context.close().catch(() => {})
    if (server) {
      const closed = new Promise(resolve => server.once('close', resolve))
      server.kill()
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))])
    }
    await fs.writeFile(path.join(runRoot, 'server.log'), serverLog)
    const artifacts = []
    for (const file of await fs.readdir(runRoot)) if (/\.(png|json|log)$/.test(file) && file !== 'result.json') artifacts.push({ path: path.relative(ROOT, path.join(runRoot, file)), sha256: hash(await fs.readFile(path.join(runRoot, file))) })
    const result = { schemaVersion: 1, profile: 'web-guest', scope: 'Production renderer; actual server guest flags and Chromium IndexedDB; targeted quota/abort injection; actual browser restart; no real disk exhaustion or native input-method claim', runRoot, sourceFingerprint, build, buildManifest, at: new Date().toISOString(),
      passed: checks.filter(item => item.passed).length, failed: checks.filter(item => !item.passed).length + (error ? 1 : 0), checks, artifacts, pageErrors, error }
    const target = path.join(runRoot, 'result.json')
    await fs.writeFile(target, JSON.stringify(result, null, 2))
    if (output) await fs.writeFile(path.resolve(output), JSON.stringify(result, null, 2))
    console.log('WEB_GUEST_SAVE_RESULT ' + JSON.stringify({ result: target, passed: result.passed, failed: result.failed, error }))
    if (result.failed) process.exitCode = 1
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
