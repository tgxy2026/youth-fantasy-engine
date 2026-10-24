#!/usr/bin/env node
// 3.2.3 · R4：web-cloud（真实本地服务 + 临时账号）账号隔离与写失败取证
//
// 方案 §7 对 web-cloud 的要求：两个独立浏览器上下文模拟两设备会话、共享 Cookie 的两个标签、
// 会话过期用本地测试服务签发（不等待 30 天）。这里全部用**本机临时账号 + 隔离数据目录**，
// 不接触生产服务、不使用真实账号，也不写产品故障开关。
//
// 覆盖 account-isolation 的四个必需子场景：two-accounts / guest-to-account /
// same-browser-account-switch / expired-session；外加账号库的 boot 与写读。
'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { chromium } = require('playwright')

const ROOT = path.resolve(__dirname, '../../..')
const checks = []
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const arg = name => {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(name + ' requires a value')
  return value
}
const check = (id, ok, detail) => {
  checks.push({ id, passed: !!ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id)
  if (!ok) throw new Error(id)
}
const until = async (fn, timeout = 30000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 120)) }
  throw new Error('Timed out waiting for actual state')
}

const PASSWORD = 'probe-pass-2026'
const stamp = Date.now().toString(36)
const USER_A = 'probe-a-' + stamp
const USER_B = 'probe-b-' + stamp
const USER_C = 'probe-c-' + stamp

/** 一份合法的整库载荷（服务端会校验 kind 与 stores） */
const mkData = marker => JSON.stringify({
  app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: Date.now(),
  stores: { chapters: [{ id: 'ch-' + marker, projectId: 'p1', volumeId: 'v1', title: '账号验收章', content: '账号正文-' + marker }] },
})

async function main() {
  const buildArg = arg('--build-dir')
  if (!buildArg) throw new Error('--build-dir is required; old builds are not selected implicitly')
  const build = await fs.realpath(path.resolve(buildArg))
  await fs.access(path.join(build, 'index.html'))
  const output = arg('--result-file')
  if (output && (!path.resolve(output).startsWith(path.join(ROOT, '.workbuddy', 'tmp') + path.sep) || !output.endsWith('.json'))) throw new Error('Result must be a JSON file under workspace .workbuddy/tmp')

  const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/web-cloud-save-'))
  const data = path.join(runRoot, 'server-data')
  await fs.mkdir(data)
  const { snapshot } = await import(pathToFileURL(path.join(ROOT, 'scripts/audit/platform/source.mjs')).href)
  const { hashPaths } = await import(pathToFileURL(path.join(ROOT, 'scripts/verify/evidence.mjs')).href)
  const sourceFingerprint = snapshot(ROOT).fingerprint
  const buildManifest = await hashPaths(build, ['.'])
  const dbSource = await fs.readFile(path.join(ROOT, 'src/lib/db/core.ts'), 'utf8')
  const databaseName = /const DB_NAME = '([^']+)'/.exec(dbSource)?.[1]
  if (!databaseName) throw new Error('Cannot determine actual database name')

  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer()
    listener.on('error', reject)
    listener.listen(0, '127.0.0.1', () => { const p = listener.address().port; listener.close(() => resolve(p)) })
  })
  const origin = 'http://127.0.0.1:' + port
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data, YFE_WWW: build, YFE_REGISTER: 'open', YFE_BOOTSTRAP_INVITE: '' }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[key]

  let server, serverLog = '', error = null
  const pageErrors = []
  const contexts = []
  const openContext = async (name, reuseDir) => {
    const dir = reuseDir ?? await fs.mkdtemp(path.join(runRoot, 'profile-' + name + '-'))
    const ctx = await chromium.launchPersistentContext(dir, { channel: 'msedge', headless: true,
      viewport: { width: 1440, height: 1000 }, args: ['--no-proxy-server'], env })
    /** 页面发出的实际请求（用于证明"数据来自服务端"而不是浏览器本地库） */
    const requests = []
    await ctx.route('**/*', route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin === origin) { requests.push({ method: request.method(), pathname: url.pathname }); return route.continue() }
      if (['data:', 'blob:'].includes(url.protocol)) return route.continue()
      return route.abort()
    })
    const page = ctx.pages()[0] ?? await ctx.newPage()
    page.setDefaultTimeout(15000)
    page.on('pageerror', value => pageErrors.push(String(value)))
    contexts.push({ ctx, dir })
    return { ctx, page, dir, requests }
  }
  const register = async (ctx, name) => {
    const res = await ctx.request.post(origin + '/api/auth/register', { data: { name, password: PASSWORD } })
    if (!res.ok()) throw new Error('register failed ' + name + ': ' + res.status() + ' ' + (await res.text()))
  }
  const login = async (ctx, name) => {
    const res = await ctx.request.post(origin + '/api/auth/login', { data: { name, password: PASSWORD } })
    if (!res.ok()) throw new Error('login failed ' + name + ': ' + res.status() + ' ' + (await res.text()))
  }
  const dataStatus = async ctx => {
    const res = await ctx.request.get(origin + '/api/data')
    return { status: res.status(), body: await res.text() }
  }
  const putData = async (ctx, marker) => {
    const res = await ctx.request.put(origin + '/api/data', {
      headers: { 'Content-Type': 'application/json' }, data: mkData(marker),
    })
    return { status: res.status(), body: await res.text() }
  }
  /** 页面启动后等前端拿到账号标记（项目中心没有 <nav>，不能用它当就绪信号） */
  const waitUser = async (page, timeout = 30000) => {
    await page.waitForFunction(() => {
      const u = window.__YFE_USER__
      return !!u && typeof u.name === 'string' && u.name.length > 0
    }, null, { timeout }).catch(() => {})
    return page.evaluate(() => window.__YFE_USER__?.name ?? null)
  }

  try {
    server = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    server.on('error', v => { serverLog += String(v) })
    server.stdout.on('data', v => { serverLog += v })
    server.stderr.on('data', v => { serverLog += v })
    await until(async () => { try { return (await fetch(origin + '/api/ping', { signal: AbortSignal.timeout(1000) })).ok } catch { return false } })

    // ---------- ① 账号 A：注册 → 真实页面启动标记 ----------
    const A = await openContext('a')
    await register(A.ctx, USER_A)
    await A.page.goto(origin + '/', { waitUntil: 'domcontentloaded' })
    const nameOnBoot = await waitUser(A.page)
    check('page-renders-account', nameOnBoot === USER_A, String(nameOnBoot) + ' @ ' + A.page.url())
    const flags = await A.page.evaluate(() => ({
      web: window.__YFE_WEB__, guest: window.__YFE_GUEST__, portable: window.__YFE_PORTABLE__,
      user: window.__YFE_USER__?.name ?? null,
    }))
    // 平台矩阵对 web-cloud 的期望：WEB=true、PORTABLE=true（复用 HTTP StoreOps）、GUEST=false、有账号
    check('initial-flags',
      flags.web === 1 && !flags.guest && !!flags.portable && flags.user === USER_A,
      JSON.stringify(flags))

    // ---------- ② 账号库：空库启动 → 写入 → 回读 ----------
    const emptyA = await dataStatus(A.ctx)
    check('boot-store', emptyA.status === 404 && JSON.parse(emptyA.body).missing === true, emptyA.status + ' ' + emptyA.body.slice(0, 120))
    const putA = await putData(A.ctx, 'a-1')
    check('write-readback', putA.status === 200, putA.status + ' ' + putA.body.slice(0, 120))
    const readA = await dataStatus(A.ctx)
    check('data-scoped-to-account', readA.status === 200 && JSON.parse(readA.body).text.includes('账号正文-a-1'), readA.status)

    // ---------- ②-b backend-selection：主库来自服务端，不是浏览器本地 IndexedDB ----------
    {
      const fetchedFromServer = A.requests.some(r => r.method === 'GET' && r.pathname === '/api/data')
      const localDb = await A.page.evaluate(name => indexedDB.databases().then(list => list.some(d => d.name === name)), databaseName)
      check('backend-selection', fetchedFromServer && !localDb, JSON.stringify({ fetchedFromServer, localDb, databaseName }))
    }

    // ---------- ③ two-accounts：另一设备/另一账号看不到 A 的数据 ----------
    const B = await openContext('b')
    await register(B.ctx, USER_B)
    const emptyB = await dataStatus(B.ctx)
    check('two-accounts', emptyB.status === 404 && JSON.parse(emptyB.body).missing === true, emptyB.status + ' ' + emptyB.body.slice(0, 120))

    // ---------- ④ same-browser-account-switch：同浏览器换账号不串库 ----------
    await login(A.ctx, USER_B)
    await A.page.goto(origin + '/', { waitUntil: 'domcontentloaded' })
    const asB = await waitUser(A.page)
    const bViewFromA = await dataStatus(A.ctx)
    check('same-browser-account-switch',
      asB === USER_B && bViewFromA.status === 404 && JSON.parse(bViewFromA.body).missing === true,
      asB + ' ' + bViewFromA.status)
    await login(A.ctx, USER_A)
    const backA = await dataStatus(A.ctx)
    check('switch-back-restores-own-data', backA.status === 200 && JSON.parse(backA.body).text.includes('账号正文-a-1'), backA.status)

    // ---------- ⑤ expired-session：同账号在别处登录 ⇒ 旧会话写盘被拒且如实返回原因 ----------
    const A2 = await openContext('a2')
    await login(A2.ctx, USER_A)
    const replaced = await putData(A.ctx, 'a-stale')
    const replacedBody = JSON.parse(replaced.body)
    check('expired-session', replaced.status === 401 && replacedBody.code === 'SESSION_REPLACED',
      replaced.status + ' ' + replaced.body.slice(0, 160))
    const afterReplace = await dataStatus(A2.ctx)
    check('stale-write-did-not-land', afterReplace.status === 200 && !JSON.parse(afterReplace.body).text.includes('a-stale'))

    // ---------- ⑥ guest-to-account：游客数据留在浏览器，不会被带进新账号 ----------
    const C = await openContext('c')
    await C.page.goto(origin + '/guest', { waitUntil: 'domcontentloaded' })
    await C.page.waitForFunction(async () => (await indexedDB.databases()).length > 0)
    await C.page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('youth-fantasy-engine')
      open.onerror = () => reject(open.error)
      open.onupgradeneeded = () => { /* 空库由应用自己建表；此处只等它存在 */ }
      open.onsuccess = () => {
        const db = open.result
        const names = [...db.objectStoreNames]
        if (!names.includes('chapters')) { db.close(); resolve('no-store'); return }
        const tx = db.transaction('chapters', 'readwrite')
        tx.objectStore('chapters').put({ id: 'guest-ch', projectId: 'gp', volumeId: 'gv', title: '游客章', content: '游客草稿-不许进账号' })
        tx.oncomplete = () => { db.close(); resolve('ok') }
        tx.onabort = () => { db.close(); reject(tx.error) }
      }
    }))
    const guestData = await dataStatus(C.ctx)
    check('guest-never-writes-server', guestData.status === 401, guestData.status + ' ' + guestData.body.slice(0, 120))
    await register(C.ctx, USER_C)
    const accountAfterRegister = await dataStatus(C.ctx)
    check('guest-to-account', accountAfterRegister.status === 404 && JSON.parse(accountAfterRegister.body).missing === true,
      accountAfterRegister.status + ' ' + accountAfterRegister.body.slice(0, 120))
    const guestStillOwn = await C.page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('youth-fantasy-engine')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const req = db.transaction('chapters', 'readonly').objectStore('chapters').get('guest-ch')
        req.onsuccess = () => { const v = req.result; db.close(); resolve(v?.content ?? null) }
        req.onerror = () => { db.close(); reject(req.error) }
      }
    }))
    check('guest-local-data-intact', guestStillOwn === '游客草稿-不许进账号', String(guestStillOwn))

    // ---------- ⑦ restart-readback：关掉浏览器再开，账号库仍从服务端读回同一份 ----------
    {
      const D = await openContext('d')
      await login(D.ctx, USER_A)
      const restartWrite = await putData(D.ctx, 'restart-1')
      check('restart-readback-write', restartWrite.status === 200, String(restartWrite.status))
      await D.ctx.close()
      const reopened = await openContext('d', D.dir)
      await reopened.page.goto(origin + '/', { waitUntil: 'domcontentloaded' })
      const nameAfterRestart = await waitUser(reopened.page)
      const afterRestart = await dataStatus(reopened.ctx)
      const fetchedAgain = reopened.requests.some(r => r.method === 'GET' && r.pathname === '/api/data')
      check('restart-readback',
        nameAfterRestart === USER_A && afterRestart.status === 200
        && JSON.parse(afterRestart.body).text.includes('账号正文-restart-1') && fetchedAgain,
        JSON.stringify({ nameAfterRestart, status: afterRestart.status, fetchedAgain }))
      await reopened.page.screenshot({ path: path.join(runRoot, 'restart-readback.png') })
    }

    check('no-pageerror', pageErrors.length === 0, pageErrors)
    check('unchanged-inputs', snapshot(ROOT).fingerprint === sourceFingerprint)
  } catch (value) {
    error = String(value.stack ?? value)
    for (const c of contexts) {
      const page = c.ctx.pages()[0]
      if (page) await page.screenshot({ path: path.join(runRoot, 'failure.png') }).catch(() => {})
    }
  } finally {
    for (const c of contexts) await c.ctx.close().catch(() => {})
    if (server) {
      const closed = new Promise(resolve => server.once('close', resolve))
      server.kill()
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))])
    }
    await fs.writeFile(path.join(runRoot, 'server.log'), serverLog)
    const artifacts = []
    for (const file of await fs.readdir(runRoot)) {
      if (!/\.(png|json|log)$/.test(file) || file === 'result.json') continue
      artifacts.push({ path: path.relative(ROOT, path.join(runRoot, file)), sha256: hash(await fs.readFile(path.join(runRoot, file))) })
    }
    const result = {
      schemaVersion: 1, profile: 'web-cloud',
      scope: 'Production renderer; actual local server with isolated data dir and throwaway accounts; real sessions/cookies; two independent browser contexts; no production account or service touched',
      runRoot, sourceFingerprint, build, buildManifest, at: new Date().toISOString(),
      passed: checks.filter(item => item.passed).length,
      failed: checks.filter(item => !item.passed).length + (error ? 1 : 0),
      checks, artifacts, pageErrors, error,
    }
    const target = path.join(runRoot, 'result.json')
    await fs.writeFile(target, JSON.stringify(result, null, 2))
    if (output) await fs.writeFile(path.resolve(output), JSON.stringify(result, null, 2))
    console.log('WEB_CLOUD_SAVE_RESULT ' + JSON.stringify({ result: target, passed: result.passed, failed: result.failed, error }))
    if (result.failed) process.exitCode = 1
  }
}

main().catch(e => { console.error(e); process.exitCode = 1 })
