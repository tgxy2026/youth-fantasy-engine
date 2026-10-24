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

// ---------- write-failure 段落用的固定件 ----------
const PROJECT_ID = 'cloud-save-project', VOLUME_ID = 'cloud-save-volume', CHAPTER_ID = 'cloud-save-chapter'
const PROJECT_TITLE = '云端保存故障临时作品'
const ORIGINAL = '隔离云端模式的原始手稿。'
const DRAFT = '云端配额超限时仍保留这份草稿。'
const DRAFT2 = '服务端写盘失败时同样保留这份草稿。'
const EDITOR = '落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）'

/**
 * 富整库：带真实项目/卷/章，才能在页面上真的打开编辑器敲字。
 * 🔴 行形态必须是**键化对象**（与桌面/云端导出一致）；数组形态是游客那份，
 *    两者都是合法 portable-data，但只有键化能被这三端按主键读回。
 */
const mkRichData = () => {
  const now = Date.now()
  return JSON.stringify({
    app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: now,
    stores: {
      projects: { [PROJECT_ID]: { id: PROJECT_ID, name: PROJECT_TITLE, genre: '玄幻', intro: '', projectType: 'full', createdAt: now, updatedAt: now } },
      volumes: { [VOLUME_ID]: { id: VOLUME_ID, projectId: PROJECT_ID, title: '验收卷', description: '', order: 0, createdAt: now } },
      chapters: { [CHAPTER_ID]: { id: CHAPTER_ID, projectId: PROJECT_ID, volumeId: VOLUME_ID, title: '云端验收章', content: ORIGINAL, summary: '', wordCount: ORIGINAL.length, order: 0, status: '草稿', tags: [], createdAt: now, updatedAt: now } },
      meta: { welcomeDone: { key: 'welcomeDone', value: '1' } },
    },
  })
}

/**
 * 从整库文本里取本章（🔴 行形态两种都要认）。
 * 实测：**云端/便携写盘时 store 是数组**，桌面写的是主键→记录对象；
 * 只按 `stores.chapters[ID]` 取会在云端永远读到 undefined —— 那不是"没落盘"，是取错了形状。
 */
const chapterOf = text => {
  const rows = JSON.parse(text)?.stores?.chapters
  const list = Array.isArray(rows) ? rows : Object.values(rows ?? {})
  return list.find(row => row && row.id === CHAPTER_ID)
}
const chapterContent = text => chapterOf(text)?.content

/** 打开这本临时作品并切到「正文编辑」——与桌面探针同一套真实交互 */
async function openProjectEditor(page) {
  await page.getByRole('heading', { name: PROJECT_TITLE, exact: true }).waitFor({ timeout: 45000 })
  for (const name of ['稍后再说', '知道了', '跳过，直接开始']) {
    const button = page.getByRole('button', { name, exact: true })
    if (await button.isVisible().catch(() => false)) await button.click()
  }
  await page.locator('div.card-hover').filter({ has: page.getByRole('heading', { name: PROJECT_TITLE, exact: true }) })
    .getByRole('button', { name: '打开项目', exact: true }).click()
  await page.getByRole('navigation').waitFor()
  await page.getByRole('button', { name: '稍后再说', exact: true }).click({ timeout: 5000 }).catch(() => {})
  await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
  await page.getByPlaceholder(EDITOR).waitFor()
}

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
  /** 写失败段落注入的「空目录挡在数据文件位置」是否仍在生效（清理要幂等，见 restoreBlocker） */
  let blocked = false
  let activeDataFile = ''
  let keptDataFile = ''
  /**
   * 解除「用空目录挡住 data.json」的注入（幂等）。
   * · 目标仍是空目录 ⇒ 先移除它，**然后等服务端自己写回来**；
   * · 已被服务端写回 ⇒ 保留那一份，删掉暂存；
   * · 服务端 15s 内确实没写 ⇒ 才把旧字节补回去兜底。
   * 🔴 不能"撤掉目录就立刻补旧字节"：与桌面探针同一坑 —— rmdir 与服务端的 write→rename 撞车时，
   *    会把刚写成功的那份覆盖掉，后面的 retry-readback 读到旧正文、误判成没落盘。
   * 任何情况下都不许抛错：清理阶段一旦中断，服务端就下不了线，整步会被判超时。
   */
  const restoreBlocker = async () => {
    try {
      if (!blocked || !activeDataFile) return
      let isDir = false
      try { isDir = (await fs.stat(activeDataFile)).isDirectory() } catch (e) { if (e.code !== 'ENOENT') throw e }
      if (isDir) await fs.rmdir(activeDataFile)
      blocked = false
      const end = Date.now() + 15000
      let written = false
      while (Date.now() < end) {
        written = await fs.stat(activeDataFile).then(s => s.isFile(), () => false)
        if (written) break
        await new Promise(r => setTimeout(r, 150))
      }
      if (written) await fs.rm(keptDataFile).catch(() => {})
      else if (await fs.stat(keptDataFile).then(() => true, () => false)) await fs.rename(keptDataFile, activeDataFile)
    } catch (e) {
      serverLog += '[probe] 恢复空目录挡板失败（已记录，不影响结论）: ' + (e instanceof Error ? e.message : String(e)) + '\n'
    } finally {
      blocked = false
    }
  }
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

    // ---------- ⑧ write-failure：服务端真实配额拒绝（413）与真实写盘失败（500） ----------
    // 🔴 两种故障都不给产品加开关：
    //   · 413 走服务端**真实配额校验**，只是把本次临时账号的 quotaBytes 调小（隔离环境里的数据，不是产品逻辑）；
    //   · 500 把真实 data.json 换成空目录，让原子写的 rename 真的失败 —— 与桌面探针同一手法。
    // 断言口径同方案 §6.1：不误报已保存、草稿不丢、旧数据不被覆盖、恢复后能重试落盘。
    {
      const usersFile = path.join(data, 'users.json')
      const readUsersDb = async () => JSON.parse(await fs.readFile(usersFile, 'utf8'))
      const db0 = await readUsersDb()
      const self = Object.values(db0.users).find(u => u.name === USER_A)
      if (!self) throw new Error('Cannot locate the throwaway account record')
      const uid = self.id
      const originalQuota = self.quotaBytes
      activeDataFile = path.join(data, 'users', uid, 'data.json')
      keptDataFile = activeDataFile + '.probe-kept'

      /** 服务端此刻真正落盘的整库文本（挡板生效期间旧字节在 .probe-kept） */
      const persistedText = async () => {
        try { return await fs.readFile(activeDataFile, 'utf8') } catch { return await fs.readFile(keptDataFile, 'utf8') }
      }
      /** 编辑器底栏真实渲染出来的落盘错误（来源 getPortableState().lastError） */
      const diskErrorTitle = async () => {
        const span = A.page.locator('span[title*="尚未写入磁盘"]')
        if (!(await span.count())) return ''
        return (await span.first().getAttribute('title')) ?? ''
      }
      const setQuota = async bytes => {
        const db = await readUsersDb()
        db.users[uid].quotaBytes = bytes
        await fs.writeFile(usersFile, JSON.stringify(db, null, 2))
        // 服务端按 mtime 热读用户表；留一点间隔，避免同毫秒内两次写被缓存吞掉
        await new Promise(r => setTimeout(r, 150))
      }

      // 🔴 上一段（restart-readback）用另一个上下文登录了同一个账号，单会话机制已把 A 的会话顶掉。
      //    这里必须重新登录，否则下面的 PUT 全是 401 —— 那不是"写失败取证"，是会话过期。
      await login(A.ctx, USER_A)
      const seed = await A.ctx.request.put(origin + '/api/data', {
        headers: { 'Content-Type': 'application/json' }, data: mkRichData(),
      })
      check('write-failure-seed', seed.ok(), String(seed.status()))
      await A.page.goto(origin + '/', { waitUntil: 'domcontentloaded' })
      await waitUser(A.page)
      await openProjectEditor(A.page)
      const editor = A.page.getByPlaceholder(EDITOR)
      check('write-failure-fixture', (await editor.inputValue()) === ORIGINAL, await editor.inputValue())
      // 等启动期那次自动保存落完：否则挡板一上来就被它吃掉，后面看到的错会变成"假故障"
      await until(async () => !(await A.page.getByText('正在写入', { exact: true }).count())
        && !(await A.page.getByText('保存中…', { exact: true }).count()), 30000)
      await new Promise(r => setTimeout(r, 400))

      // ---- ① 配额 413：服务端自己拒绝，不是前端假报 ----
      await setQuota(512)
      await editor.fill(DRAFT)
      await A.page.keyboard.press('Control+s')
      await until(async () => /HTTP 413/.test(await diskErrorTitle()), 30000)
      check('quota-rejected-visible', /HTTP 413/.test(await diskErrorTitle()), await diskErrorTitle())
      check('quota-preserves-draft', (await editor.inputValue()) === DRAFT)
      const afterQuota = chapterContent(await persistedText())
      check('quota-not-persisted', afterQuota === ORIGINAL, afterQuota)
      await A.page.screenshot({ path: path.join(runRoot, 'quota-rejected.png') })

      // ---- ② 写盘 500：先上挡板再恢复配额，保证重试不会抢先落盘 ----
      await fs.rename(activeDataFile, keptDataFile)
      await fs.mkdir(activeDataFile)
      blocked = true
      const keptBytes = await fs.readFile(keptDataFile)
      await setQuota(originalQuota)
      await editor.fill(DRAFT2)
      await A.page.keyboard.press('Control+s')
      await until(async () => /HTTP 500/.test(await diskErrorTitle()), 40000)
      check('server-error-visible', /HTTP 500/.test(await diskErrorTitle()), await diskErrorTitle())
      check('failure-preserves-draft', (await editor.inputValue()) === DRAFT2)
      const stillDir = (await fs.stat(activeDataFile)).isDirectory()
      check('accepted-vs-persisted',
        stillDir && hash(await fs.readFile(keptDataFile)) === hash(keptBytes)
        && chapterContent(keptBytes) === ORIGINAL,
        JSON.stringify({ stillDir }))
      await A.page.screenshot({ path: path.join(runRoot, 'write-failure.png') })

      // ---- ③ 恢复后重试：草稿自动落盘，无需重新输入 ----
      await restoreBlocker()
      await until(async () => {
        try { return chapterContent(await fs.readFile(activeDataFile, 'utf8')) === DRAFT2 } catch { return false }
      }, 30000)
      check('retry-readback', true, DRAFT2)
      await until(async () => (await diskErrorTitle()) === '', 20000)
      check('recovery-visible', (await diskErrorTitle()) === '' && !(await A.page.getByText('未写入磁盘', { exact: true }).count()))
      await A.page.screenshot({ path: path.join(runRoot, 'recovery.png') })
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
    // 挡板必须先撤（幂等），否则服务端数据目录会留着空目录，下一次运行读到 500
    if (blocked) await restoreBlocker()
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
