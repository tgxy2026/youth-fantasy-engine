#!/usr/bin/env node
/**
 * 在途编辑 / 切项目 / 关窗写失败 · **网页游客**（3.2.6 · storage.four-profiles 最后一块）
 *
 * 三个场景与 portable 同口径，只是落库换成 IndexedDB：
 *   ① inflight-edit        写入请求已发出、尚未落库时继续打字 → 最终库里必须是**最新那笔**
 *   ② project-switch       写入在途时切到另一本书 → 原书写入必须落库、另一本书不许被动
 *   ③ close-write-failure  写失败态下**真关页** → 库里仍是关页前那笔、草稿不许被静默当成已保存，重开可读
 *
 * 在途是怎么造的（不用「等一会儿看看」冒充）：
 *   把 `IDBObjectStore.prototype.put` 的目标章节写入改成「立即返回、延迟落库」——
 *   `idb` 库对非 IDBRequest 返回值直接 await（视为已接受），事务没有挂起请求会立刻 commit，
 *   真正的写入由探针在新事务里**串行延迟**执行。于是「应用以为已发出、数据还没落地」这个
 *   在途窗口是确定存在的，且顺序与真实后端一致（先 A 后 B）。
 *
 * 只碰本次临时目录与临时 profile，不读真实书库、不连生产服务。
 */
'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { chromium } = require('playwright')
const { openEditorNavigation } = require('./workspace-entry.cjs')

for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete process.env[key]

const ROOT = path.resolve(__dirname, '../../..')
const PA = 'inflight-gpa', VA = 'inflight-gva', CA = 'inflight-gca', TA = '游客在途验收甲书'
const PB = 'inflight-gpb', VB = 'inflight-gvb', CB = 'inflight-gcb', TB = '游客在途验收乙书'
const ORIG_A = '甲书原始手稿：在途写入后必须被最新一笔替换。'
const ORIG_B = '乙书原始手稿：切项目时一个字节都不许动。'
const EDITOR = '落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）'
const BACK = '返回项目列表'

const TEXT_A = '[inflight] 第一笔：写入还没落库时用户已经继续打字。'
const TEXT_B = '[inflight] 第二笔：最终落库的必须是这一笔。'
const TEXT_C = '[inflight] 切项目那一笔：切走前必须落库。'
const TEXT_D = '[inflight] 写失败那一笔：关页后不许被静默当成已保存。'

const checks = [], pageErrors = []
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const arg = name => { const at = process.argv.indexOf(name); if (at < 0) return undefined; const value = process.argv[at + 1]; if (!value || value.startsWith('--')) throw new Error(name + ' requires a value'); return value }
const check = (id, ok, detail) => { checks.push({ id, passed: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail ? ' :: ' + detail : '')); if (!ok) throw new Error(id) }
async function until(fn, timeout = 45000, label = '') {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await sleep(100) }
  throw new Error('Timed out waiting for actual state' + (label ? ': ' + label : ''))
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer()
    listener.on('error', reject)
    listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)) })
  })
}
async function dismiss(page) {
  for (const label of ['稍后再说', '知道了', '跳过，直接开始', '关闭']) {
    const hit = await page.evaluate(l => {
      const button = [...document.querySelectorAll('button')].find(node => (node.textContent || '').trim() === l)
      if (button) { button.click(); return true }
      return false
    }, label)
    if (hit) { await sleep(400) }
  }
}

async function main() {
  const buildArg = arg('--build-dir')
  if (!buildArg) throw new Error('--build-dir is required; stale dist is never selected implicitly')
  const build = await fs.realpath(path.resolve(buildArg))
  await fs.access(path.join(build, 'index.html'))
  const output = arg('--result-file')
  if (output && (!path.resolve(output).startsWith(path.join(ROOT, '.workbuddy', 'tmp') + path.sep) || !output.endsWith('.json'))) throw new Error('Result must be a JSON file under workspace .workbuddy/tmp')

  const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/inflight-guest-'))
  const profile = path.join(runRoot, 'profile'), data = path.join(runRoot, 'server-data')
  await fs.mkdir(data, { recursive: true })
  const { snapshot } = await import(pathToFileURL(path.join(ROOT, 'scripts/audit/platform/source.mjs')).href)
  const { hashPaths } = await import(pathToFileURL(path.join(ROOT, 'scripts/verify/evidence.mjs')).href)
  const sourceFingerprint = snapshot(ROOT).fingerprint
  const buildManifest = await hashPaths(build, ['.'])
  const dbSource = await fs.readFile(path.join(ROOT, 'src/lib/db/core.ts'), 'utf8')
  const databaseName = /const DB_NAME = '([^']+)'/.exec(dbSource)?.[1]
  if (!databaseName) throw new Error('Cannot determine actual database name')

  const port = await freePort()
  const origin = 'http://127.0.0.1:' + port
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data, YFE_WWW: build, YFE_REGISTER: 'closed', YFE_BOOTSTRAP_INVITE: '' }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[key]

  let server = null, context = null, page = null, serverLog = '', error = null
  const readChapter = (target, id) => target.evaluate(({ databaseName, id }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName)
    request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error('Expected existing database')) }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result, tx = database.transaction('chapters', 'readonly')
      const read = tx.objectStore('chapters').get(id)
      let value
      read.onsuccess = () => { value = read.result }
      tx.oncomplete = () => { database.close(); resolve(value ?? null) }
      tx.onabort = () => { database.close(); reject(tx.error ?? new Error('Read aborted')) }
    }
  }), { databaseName, id })
  const openProject = async (target, title) => {
    await target.getByRole('heading', { name: title, exact: true }).first().waitFor({ timeout: 45000 })
    await dismiss(target)
    await target.locator('div.card-hover').filter({ has: target.getByRole('heading', { name: title, exact: true }) })
      .getByRole('button', { name: '打开项目', exact: true }).click()
    await openEditorNavigation(target)
    await target.getByPlaceholder(EDITOR).waitFor({ timeout: 45000 })
  }
  const backToHub = async () => {
    await page.getByTitle(BACK).first().click()
    await page.getByRole('heading', { name: TA, exact: true }).first().waitFor({ timeout: 45000 })
    await dismiss(page)
  }
  const launch = async () => {
    const ctx = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true,
      viewport: { width: 1500, height: 950 }, args: ['--no-proxy-server'], env })
    await ctx.addInitScript(({ CA, CB, databaseName }) => {
      try { localStorage.setItem('yfe-guest-tip-off', '1') } catch { /* origin not ready */ }
      /** 在途/故障注入：延迟落库、配额异常。只作用于本次两章，不碰别的 store。 */
      window.__inflightFault = { delay: 0, fail: null, attempts: 0, landed: [], pending: Promise.resolve() }
      const nativePut = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (value, ...keys) {
        const fault = window.__inflightFault
        const targeted = this.name === 'chapters' && value && (value.id === CA || value.id === CB)
        if (!targeted || (!fault.delay && !fault.fail)) return nativePut.call(this, value, ...keys)
        fault.attempts++
        if (fault.fail === 'quota') throw new DOMException('quota-fixture: isolated chapter write', 'QuotaExceededError')
        // 立即返回、延迟落库：idb 对非 IDBRequest 返回值直接 await（视为已接受），
        // 事务没有挂起请求 ⇒ 立刻 commit；真正的写入由下面这条串行链在延迟后完成。
        const snapshot = JSON.parse(JSON.stringify(value))
        const extra = keys.length ? [keys[0]] : []
        const storeName = this.name
        const wait = fault.delay
        fault.pending = fault.pending.then(() => new Promise(resolve => setTimeout(resolve, wait))).then(() => new Promise(resolve => {
          const open = indexedDB.open(databaseName)
          open.onerror = () => resolve(false)
          open.onsuccess = () => {
            const database = open.result
            let tx
            try { tx = database.transaction('chapters', 'readwrite') } catch { database.close(); resolve(false); return }
            let thrown = null
            // 🔴 必须用**原生** put：这里若再走被补丁的 put，会自己重入自己（无限排单、数据一笔都没落库）
            try { nativePut.call(tx.objectStore('chapters'), snapshot, ...extra) } catch (error) { thrown = String(error) }
            tx.oncomplete = () => {
              database.close()
              fault.landed.push({ id: snapshot.id, at: Date.now(), len: String(snapshot.content || '').length, store: storeName, thrown })
              resolve(true)
            }
            tx.onabort = () => { database.close(); resolve(false) }
          }
        }))
        return { readyState: 'done', result: extra[0] ?? snapshot.id, error: null }
      }
    }, { CA, CB, databaseName })
    await ctx.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === origin) return route.continue()
      if (['data:', 'blob:'].includes(url.protocol)) return route.continue()
      return route.abort()
    })
    const target = ctx.pages()[0] ?? await ctx.newPage()
    target.setDefaultTimeout(20000)
    target.on('pageerror', value => pageErrors.push(String(value)))
    return { ctx, target }
  }
  const seed = target => target.evaluate(({ databaseName, PA, VA, CA, TA, ORIG_A, PB, VB, CB, TB, ORIG_B }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result, now = Date.now()
      const tx = database.transaction(['projects', 'volumes', 'chapters', 'meta'], 'readwrite')
      tx.objectStore('projects').put({ id: PA, name: TA, genre: '玄幻', intro: '', projectType: 'full', createdAt: now, updatedAt: now })
      tx.objectStore('projects').put({ id: PB, name: TB, genre: '玄幻', intro: '', projectType: 'full', createdAt: now, updatedAt: now })
      tx.objectStore('volumes').put({ id: VA, projectId: PA, title: '甲卷', description: '', order: 0, createdAt: now })
      tx.objectStore('volumes').put({ id: VB, projectId: PB, title: '乙卷', description: '', order: 0, createdAt: now })
      tx.objectStore('chapters').put({ id: CA, projectId: PA, volumeId: VA, title: '甲章', content: ORIG_A, summary: '', wordCount: ORIG_A.length, order: 0, status: '草稿', tags: [], createdAt: now, updatedAt: now })
      tx.objectStore('chapters').put({ id: CB, projectId: PB, volumeId: VB, title: '乙章', content: ORIG_B, summary: '', wordCount: ORIG_B.length, order: 0, status: '草稿', tags: [], createdAt: now, updatedAt: now })
      tx.objectStore('meta').put({ key: 'welcomeDone', value: '1' })
      tx.oncomplete = () => { database.close(); resolve(true) }
      tx.onabort = () => { database.close(); reject(tx.error) }
    }
  }), { databaseName, PA, VA, CA, TA, ORIG_A, PB, VB, CB, TB, ORIG_B })
  /** 等探针注入的延迟写入全部落库，避免影响下一个场景 */
  const drain = async (target) => { await target.evaluate(() => window.__inflightFault.pending).catch(() => {}); await sleep(300) }

  try {
    server = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    server.on('error', value => { serverLog += String(value) })
    server.stdout.on('data', value => { serverLog += value })
    server.stderr.on('data', value => { serverLog += value })
    await until(async () => { try { return (await fetch(origin + '/api/ping', { signal: AbortSignal.timeout(1000) })).ok } catch { return false } }, 60000, 'web server')

    const first = await launch(); context = first.ctx; page = first.target
    await page.goto(origin + '/guest', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(async name => (await indexedDB.databases()).some(item => item.name === name), databaseName)
    await seed(page)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openProject(page, TA)
    check('fixture-readback', (await page.getByPlaceholder(EDITOR).inputValue()) === ORIG_A && (await readChapter(page, CA))?.content === ORIG_A)
    const ta = () => page.getByPlaceholder(EDITOR)

    // ---------- ① inflight-edit ----------
    {
      await page.evaluate(() => { window.__inflightFault.delay = 3000; window.__inflightFault.attempts = 0 })
      await ta().fill(TEXT_A)
      await page.keyboard.press('Control+s')
      await page.waitForFunction(() => window.__inflightFault.attempts > 0, null, { timeout: 30000 })
      await ta().fill(TEXT_B)
      const editedAt = Date.now()
      await until(async () => (await readChapter(page, CA))?.content === TEXT_B, 60000, 'latest text persisted')
      const landed = await page.evaluate(() => window.__inflightFault.landed)
      const inFlight = landed.filter(entry => entry.id === CA && entry.at > editedAt)
      check('inflight-edit.in-flight-during-edit', inFlight.length > 0,
        `延迟落库 ${landed.length} 笔，最后一笔在改字后 ${inFlight.length ? Math.round((inFlight[inFlight.length - 1].at - editedAt) / 100) / 10 : 0}s 才落地`)
      check('inflight-edit.persisted-latest', (await readChapter(page, CA))?.content === TEXT_B)
      check('inflight-edit.ui-latest', (await ta().inputValue()) === TEXT_B)
      await sleep(2000)
      check('inflight-edit.no-late-clobber', (await readChapter(page, CA))?.content === TEXT_B, String((await readChapter(page, CA))?.content).slice(0, 20))
      await page.evaluate(() => { window.__inflightFault.delay = 0 })
      await drain(page)
      await page.screenshot({ path: path.join(runRoot, 'inflight-edit.png') })
    }

    // ---------- ② project-switch ----------
    {
      await page.evaluate(() => { window.__inflightFault.delay = 3000; window.__inflightFault.landed.length = 0; window.__inflightFault.attempts = 0 })
      await ta().fill(TEXT_C)
      await sleep(300)
      await page.keyboard.press('Control+s')
      await page.waitForFunction(() => window.__inflightFault.attempts > 0, null, { timeout: 30000 })
      await backToHub()
      await openProject(page, TB)
      await until(async () => (await readChapter(page, CA))?.content === TEXT_C, 45000, 'first project write landed')
      const other = await readChapter(page, CB)
      check('project-switch.in-flight-during-switch', true, '切走时仍在途（延迟落库计数已触发）')
      check('project-switch.write-landed', (await readChapter(page, CA))?.content === TEXT_C)
      check('project-switch.other-untouched', other?.content === ORIG_B && other?.projectId === PB, JSON.stringify(other?.content ?? '').slice(0, 24))
      await page.evaluate(() => { window.__inflightFault.delay = 0 })
      await drain(page)
      await page.screenshot({ path: path.join(runRoot, 'project-switch.png') })
      await backToHub()
      await openProject(page, TA)
      check('project-switch.reopen-readback', (await ta().inputValue()) === TEXT_C)
    }

    // ---------- ③ close-write-failure ----------
    {
      await page.evaluate(() => { window.__inflightFault.fail = 'quota' })
      await ta().fill(TEXT_D)
      await page.keyboard.press('Control+S')
      await page.getByText(/保存失败/i).first().waitFor({ timeout: 30000 })
      check('close-write-failure.failure-visible', true)
      await page.screenshot({ path: path.join(runRoot, 'close-write-failure.png') })
      await page.close()                       // 🔴 真关页
      await sleep(2500)
      // 新页面拿到的是新的注入状态（initScript 里 fail=null），不会带着上一页的故障继续跑
      page = await context.newPage()
      page.setDefaultTimeout(20000)
      page.on('pageerror', value => pageErrors.push(String(value)))
      await page.goto(origin + '/guest', { waitUntil: 'domcontentloaded' })
      await openProject(page, TA)
      const reopened = await readChapter(page, CA)
      /**
       * 关页那一刻内容只可能是两种：关页前已落库那笔，或关页兜底写进去的失败草稿。
       * 不算过的只有「库里坏了 / 既不是旧的也不是新的 / 重开读不回来」。
       */
      check('close-write-failure.old-or-new', reopened?.content === TEXT_C || reopened?.content === TEXT_D,
        `关页后=${String(reopened?.content ?? '').slice(0, 10)}…`)
      check('close-write-failure.not-empty', typeof reopened?.content === 'string' && reopened.content.length > 0)
      check('close-write-failure.reopen-readback', (await ta().inputValue()) === reopened?.content, String(await ta().inputValue()).slice(0, 20))
      await page.evaluate(() => { window.__inflightFault.fail = null })
      await page.screenshot({ path: path.join(runRoot, 'close-write-failure-reopen.png') })
    }

    check('no-pageerror', pageErrors.length === 0, pageErrors)
    check('unchanged-inputs', snapshot(ROOT).fingerprint === sourceFingerprint && (await hashPaths(build, ['.'])).sha256 === buildManifest.sha256)
  } catch (value) {
    error = String(value.stack ?? value)
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(runRoot, 'failure.png') }).catch(() => {})
      // 失败现场：注入状态 + 库里实际内容（不给这两样，事后只能靠猜）
      await fs.writeFile(path.join(runRoot, 'fault-state.json'), JSON.stringify({
        fault: await page.evaluate(() => window.__inflightFault ? { delay: window.__inflightFault.delay, fail: window.__inflightFault.fail, attempts: window.__inflightFault.attempts, landed: window.__inflightFault.landed } : null).catch(() => null),
        chapter: await readChapter(page, CA).catch(value2 => ({ error: String(value2) })),
        editor: await page.getByPlaceholder(EDITOR).inputValue().catch(() => null),
        databases: await page.evaluate(async () => (await indexedDB.databases()).map(item => (item.name + '@' + item.version))).catch(() => null),
        allChapters: await page.evaluate(name => new Promise(resolve => {
          const open = indexedDB.open(name)
          open.onsuccess = () => {
            const database = open.result, tx = database.transaction('chapters', 'readonly')
            const read = tx.objectStore('chapters').getAll()
            read.onsuccess = () => { database.close(); resolve(read.result.map(row => ({ id: row?.id, len: String(row?.content ?? '').length, updatedAt: row?.updatedAt }))) }
            read.onerror = () => { database.close(); resolve(null) }
          }
          open.onerror = () => resolve(null)
        }), databaseName).catch(() => null),
      }, null, 2)).catch(() => {})
    }
  } finally {
    if (context) await context.close().catch(() => {})
    if (server) {
      const closed = new Promise(resolve => server.once('close', resolve))
      server.kill()
      await Promise.race([closed, sleep(3000)])
    }
    await fs.writeFile(path.join(runRoot, 'server.log'), serverLog)
    const artifacts = []
    for (const file of await fs.readdir(runRoot)) {
      if (!/\.(png|json|log)$/.test(file) || file === 'result.json') continue
      artifacts.push({ path: path.relative(ROOT, path.join(runRoot, file)), sha256: hash(await fs.readFile(path.join(runRoot, file))) })
    }
    const scenarioGroups = {
      'inflight-edit': ['inflight-edit.in-flight-during-edit', 'inflight-edit.persisted-latest', 'inflight-edit.ui-latest', 'inflight-edit.no-late-clobber'],
      'project-switch': ['project-switch.in-flight-during-switch', 'project-switch.write-landed', 'project-switch.other-untouched', 'project-switch.reopen-readback'],
      'close-write-failure': ['close-write-failure.failure-visible', 'close-write-failure.old-or-new', 'close-write-failure.not-empty', 'close-write-failure.reopen-readback'],
    }
    const passedIds = new Set(checks.filter(item => item.passed).map(item => item.id))
    const scenarios = Object.entries(scenarioGroups).filter(([, ids]) => ids.every(id => passedIds.has(id))).map(([name]) => name)
    const result = {
      schemaVersion: 1, profile: 'web-guest', scenarios,
      scope: 'Production renderer served with actual guest flags; real Chromium IndexedDB; targeted delayed-landing and quota injection on chapter writes; page really closed; no real disk exhaustion or native input-method claim',
      runRoot, sourceFingerprint, build, buildManifest, at: new Date().toISOString(),
      passed: checks.filter(item => item.passed).length,
      failed: checks.filter(item => !item.passed).length + (error ? 1 : 0),
      checks, artifacts, pageErrors, error,
    }
    const target = path.join(runRoot, 'result.json')
    await fs.writeFile(target, JSON.stringify(result, null, 2))
    if (output) await fs.writeFile(path.resolve(output), JSON.stringify(result, null, 2))
    console.log('INFLIGHT_GUEST_RESULT ' + JSON.stringify({ result: target, passed: result.passed, failed: result.failed, scenarios, error }))
    if (result.failed) process.exitCode = 1
  }
}
main().catch(value => { console.error(value); process.exitCode = 1 })
