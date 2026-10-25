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
const AFTER = '导入之前先改成这样，看导入能不能把它换回导出那一刻。'
/** 密钥剥离场景用的假密钥（只为证明它不会出现在导出文件里） */
const SECRET = 'sk-probe-cloud-secret-do-not-export'
/** 侧车场景的向量行（云端与便携一样把 vecRows 外置到 /api/blob） */
const VEC_ID = 'vec-probe-1'
const EDITOR = '落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）'
const EXPORT_TITLE = '导出全部数据：下载一个 JSON 文件（与桌面版格式一致，可直接导入桌面版）'
const IMPORT_TITLE = '导入数据文件：选择之前导出的 JSON，替换云端账号的全部数据'

/**
 * 富整库：带真实项目/卷/章，才能在页面上真的打开编辑器敲字。
 * 两种行形态都合法；本夹具用桌面键化格式，读取时统一兼容云端保存的数组格式。
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
  let activeUserId = '', controlId = 0
  const control = (operation, uid) => new Promise((resolve, reject) => {
    const id = ++controlId
    const timer = setTimeout(() => { server.off('message', listener); reject(new Error('Server barrier timeout: ' + operation)) }, 15000)
    const listener = message => { if (message.id === id) { clearTimeout(timer); server.off('message', listener); message.error ? reject(new Error(message.error)) : resolve() } }
    server.on('message', listener); server.send({ id, operation, uid })
  })
  const mutateDataFile = async action => {
    await control('pause', activeUserId)
    try { return await action() } finally { await control('resume', activeUserId) }
  }
  /**
   * Restore the probe's exact baseline under a browser request barrier. Active writes are drained,
   * new writes parked, and the directory blocks every actual commit. Thus no successful user write
   * can be overwritten; only this artificial fault is removed, keeping the real CAS baseline stable.
   */
  const restoreBlocker = async () => {
    try {
      if (!blocked || !activeDataFile) return
      let isDir = false
      try { isDir = (await fs.stat(activeDataFile)).isDirectory() } catch (e) { if (e.code !== 'ENOENT') throw e }
      await mutateDataFile(async () => {
        if (isDir) await fs.rmdir(activeDataFile)
        // Restore the exact immutable baseline while all browser PUTs are parked and drained.
        // CAS must not interpret our temporary missing file as a real external revision change.
        await fs.rename(keptDataFile, activeDataFile)
      })
    } catch (e) {
      error = [error, '[probe] 恢复隔离基线失败: ' + String(e)].filter(Boolean).join('\n')
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
    await ctx.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin === origin) {
        requests.push({ method: request.method(), pathname: url.pathname })
        return route.continue()
      }
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
    const current = await ctx.request.get(origin + '/api/data')
    const res = await ctx.request.put(origin + '/api/data', {
      headers: { 'Content-Type': 'application/json', 'If-Match': current.headers().etag ?? '' }, data: mkData(marker),
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
    const bootstrap = path.join(runRoot, 'server-bootstrap.mjs')
    await fs.writeFile(bootstrap, `
import {withUserDataLock} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'server/lib/userdata.mjs')).href)};
await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'server/index.mjs')).href)});
let release,held;
process.on('message',async message=>{
 try{
  if(message.operation==='pause'){
   held=withUserDataLock(message.uid,async()=>{process.send({id:message.id});await new Promise(resolve=>{release=resolve});});
   held.catch(error=>process.send({id:message.id,error:String(error)}));
  }else{release();await held;process.send({id:message.id});}
 }catch(error){process.send({id:message.id,error:String(error)});}
});`)
    server = spawn(process.execPath, [bootstrap], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    server.on('error', v => { serverLog += String(v) })
    const log = v => { serverLog += v; fs.appendFile(path.join(runRoot, 'server-live.log'), v).catch(() => {}) }
    server.stdout.on('data', log)
    server.stderr.on('data', log)
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
      activeUserId = uid
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
      const baseline = await A.ctx.request.get(origin + '/api/data')
      const seed = await A.ctx.request.put(origin + '/api/data', {
        headers: { 'Content-Type': 'application/json', 'If-Match': baseline.headers().etag }, data: mkRichData(),
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
      await mutateDataFile(async () => {
        await fs.rename(activeDataFile, keptDataFile)
        await fs.mkdir(activeDataFile)
      })
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
      // 撤挡板后按一次 Ctrl+S：作者在「排除问题后按 Ctrl+S 重试」之后会做的动作。
      // 「没有新输入也会自己重试」由 ② 的连续失败计数单独证明，这里证的是「故障排除后能存进去」。
      await A.page.keyboard.press('Control+s')
      await until(async () => {
        try { return chapterContent(await fs.readFile(activeDataFile, 'utf8')) === DRAFT2 } catch { return false }
      }, 30000)
      check('retry-readback', true, DRAFT2)
      await until(async () => (await diskErrorTitle()) === '', 20000)
      check('recovery-visible', (await diskErrorTitle()) === '' && !(await A.page.getByText('未写入磁盘', { exact: true }).count()))
      await A.page.screenshot({ path: path.join(runRoot, 'recovery.png') })
    }

    // ---------- ⑨ 端到端往返：浏览器真实下载 → 改库 → 真实选文件导入 → reload ----------
    // 与桌面同一套口径：全程真实 UI + 真实文件，只让浏览器把下载落到本次临时目录。
    // 不改库就直接导入的话，"导入回到导出那一刻"什么都证明不了，所以中间先改成别的样子并落盘。
    {
      const roundtripFile = path.join(runRoot, 'roundtrip-export.json')
      const editor = A.page.getByPlaceholder(EDITOR)

      // ---------- 播种：密钥 + 侧车（走页面自己的登录会话，与产品同一条接口）----------
      // 不先放一枚密钥 / 一行向量，「导出里没有密钥」「侧车有没有内联」都是空话。
      const seeded = await A.page.evaluate(async ({ SECRET, VEC_ID }) => {
        const get = await fetch('/api/data', { cache: 'no-store' })
        const etag = get.headers.get('etag') || ''
        const j = await get.json()
        const file = JSON.parse(j.text)
        file.stores = file.stores || {}
        const metaRows = file.stores.meta
        const asMap = Array.isArray(metaRows)
          ? Object.fromEntries(metaRows.filter(r => r && r.key).map(r => [r.key, r]))
          : { ...(metaRows || {}) }
        asMap.aiProviders = { key: 'aiProviders', value: { activeId: 'probe', providers: [{ id: 'probe', apiKey: SECRET }] } }
        file.stores.meta = asMap
        const put = await fetch('/api/data', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'If-Match': etag },
          body: JSON.stringify(file),
        })
        const blob = await fetch('/api/blob?store=vecRows&id=__all__', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([{ id: VEC_ID, projectId: 'probe', dim: 3, vector: [0.1, 0.2, 0.3], updatedAt: 1 }]),
        })
        return { put: put.status, blob: blob.status, secretInFile: JSON.stringify(file).includes(SECRET) }
      }, { SECRET, VEC_ID })
      check('sidecars.seeded', seeded.put === 200 && seeded.blob === 200, JSON.stringify(seeded))

      // 重新载入，让应用读到的就是这份带密钥的库
      await A.page.reload({ waitUntil: 'domcontentloaded' }); await openProjectEditor(A.page)
      check('secret-stripping.secret-present-before', (await fs.readFile(activeDataFile, 'utf8')).includes(SECRET), '服务端数据文件里应能看到播种的密钥')

      const downloadPromise = A.page.waitForEvent('download', { timeout: 30000 })
      await A.page.getByTitle(EXPORT_TITLE, { exact: true }).click()
      await (await downloadPromise).saveAs(roundtripFile)
      const exported = chapterContent(await fs.readFile(roundtripFile, 'utf8'))
      check('roundtrip-export', exported === DRAFT2, String(exported))

      const exportedText = await fs.readFile(roundtripFile, 'utf8')
      const exportedJson = JSON.parse(exportedText)
      const exportedVec = exportedJson?.stores?.vecRows
      const exportedVecList = Array.isArray(exportedVec) ? exportedVec : Object.values(exportedVec ?? {})
      check('sidecars.inlined-on-export', exportedVecList.some(row => row && row.id === VEC_ID),
        `导出 ${exportedVecList.length} 行向量${exportedVecList.some(r => r && r.id === VEC_ID) ? '（含探针行）' : '（缺探针行）'}`)
      const exportedMeta = exportedJson?.stores?.meta
      const exportedMetaKeys = Array.isArray(exportedMeta) ? exportedMeta.map(r => String(r?.key ?? '')) : Object.keys(exportedMeta ?? {})
      check('secret-stripping.absent-after-export',
        !exportedText.includes(SECRET) && !exportedMetaKeys.includes('aiProviders'),
        `文件里含密钥=${exportedText.includes(SECRET)} / meta 含 aiProviders=${exportedMetaKeys.includes('aiProviders')}`)

      await editor.fill(AFTER)
      await A.page.keyboard.press('Control+s')
      await until(async () => chapterContent(await fs.readFile(activeDataFile, 'utf8')) === AFTER, 25000)
      check('roundtrip-changed', true, 'server library now differs from the export')

      // 先注册 chooser/load 的等待再点确认：确认之后才会弹文件选择，导入成功才会 reload
      const chooser = A.page.waitForEvent('filechooser', { timeout: 30000 })
      const reloaded = A.page.waitForEvent('load', { timeout: 45000 })
      await A.page.getByTitle(IMPORT_TITLE, { exact: true }).click()
      await A.page.getByRole('button', { name: '继续导入', exact: true }).click()
      await (await chooser).setFiles(roundtripFile)
      await reloaded
      await waitUser(A.page)
      await openProjectEditor(A.page)
      await until(async () => chapterContent(await fs.readFile(activeDataFile, 'utf8')) === DRAFT2, 30000)
      const shown = await A.page.getByPlaceholder(EDITOR).inputValue()
      check('roundtrip-import-readback',
        shown === DRAFT2 && chapterContent(await fs.readFile(activeDataFile, 'utf8')) === DRAFT2, shown)
      await A.page.screenshot({ path: path.join(runRoot, 'roundtrip-import.png') })

      // 导入时侧车内联在单文件里 ⇒ 导入后必须再拆回 blob
      let vecRestored = false
      for (let i = 0; i < 80; i++) {
        const rows = await A.page.evaluate(async ({ VEC_ID }) => {
          const r = await fetch('/api/blob?store=vecRows&id=__all__', { cache: 'no-store' })
          if (!r.ok) return []
          const j = await r.json().catch(() => ({}))
          return Array.isArray(j.value) ? j.value.map(row => row && row.id) : []
        }, { VEC_ID })
        if (rows.includes(VEC_ID)) { vecRestored = true; break }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      check('sidecars.restored-after-import', vecRestored, '导入后侧车 blob 里应有探针向量行')

      // ---------- 两个必须被拒的导入（版本闸 / 损坏文件）----------
      const beforeReject = await fs.readFile(activeDataFile, 'utf8')
      const importExpectRefusal = async (file, pattern, label) => {
        await A.page.getByTitle(IMPORT_TITLE, { exact: true }).click()
        const chooserInner = A.page.waitForEvent('filechooser', { timeout: 30000 })
        await A.page.getByRole('button', { name: '继续导入', exact: true }).click()
        await (await chooserInner).setFiles(file)
        const toast = A.page.getByText(pattern).first()
        await toast.waitFor({ timeout: 25000 })
        check(label, true, ((await toast.textContent()) || '').trim().slice(0, 120))
      }
      const newerVersionFile = path.join(runRoot, 'newer-version.json')
      await fs.writeFile(newerVersionFile, JSON.stringify({ ...exportedJson, fileVersion: 999 }))
      await importExpectRefusal(newerVersionFile, /更新版本的软件导出/, 'schema-version.reject-newer')
      const afterVersionReject = await fs.readFile(activeDataFile, 'utf8')
      check('schema-version.data-unchanged', beforeReject === afterVersionReject, '被拒的导入居然改动了云端数据文件')

      const corruptFile = path.join(runRoot, 'corrupt.json')
      await fs.writeFile(corruptFile, '{"kind":"portable-data","stores":{')
      await importExpectRefusal(corruptFile, /已损坏/, 'restore-failure.corrupt-rejected')
      const afterCorruptReject = await fs.readFile(activeDataFile, 'utf8')
      check('restore-failure.data-unchanged', afterVersionReject === afterCorruptReject, '损坏文件被拒后云端数据文件却变了')
      await A.page.screenshot({ path: path.join(runRoot, 'rejected-imports.png') })
    }

    // Real UI writes from two tabs sharing a session; no direct API PUT stands in for editing.
    {
      const stale = await A.ctx.newPage()
      stale.on('pageerror', value => pageErrors.push(String(value)))
      await stale.goto(origin + '/', { waitUntil: 'domcontentloaded' }); await openProjectEditor(stale)
      await A.page.reload({ waitUntil: 'domcontentloaded' }); await openProjectEditor(A.page)
      const winner = DRAFT2 + '第一窗口成功提交。', loser = DRAFT2 + '第二窗口的冲突草稿。'
      await A.page.getByPlaceholder(EDITOR).fill(winner); await A.page.keyboard.press('Control+s')
      await until(async () => chapterContent(await fs.readFile(activeDataFile, 'utf8')) === winner)
      check('two-tabs-conditional-write', true)
      let puts = 0
      stale.on('request', request => { if (new URL(request.url()).pathname === '/api/data' && request.method() === 'PUT') puts++ })
      const rejected = stale.waitForResponse(reply => new URL(reply.url()).pathname === '/api/data' && reply.request().method() === 'PUT' && reply.status() === 409)
      await stale.getByPlaceholder(EDITOR).fill(loser); await stale.keyboard.press('Control+s')
      await rejected
      await stale.getByRole('alert').filter({ hasText: '已停止本窗口保存' }).waitFor()
      check('stale-save-rejected', true)
      check('conflict-keeps-draft', (await stale.getByPlaceholder(EDITOR).inputValue()) === loser)
      check('conflict-preserves-server', chapterContent(await fs.readFile(activeDataFile, 'utf8')) === winner)
      const downloaded = stale.waitForEvent('download')
      await stale.getByTitle(EXPORT_TITLE, { exact: true }).click()
      const target = path.join(runRoot, 'conflict-export.json')
      await (await downloaded).saveAs(target)
      check('conflict-export', chapterContent(await fs.readFile(target, 'utf8')) === loser)
      const before = puts
      await stale.waitForTimeout(1200)
      check('conflict-stops-retry', puts === before)
      check('conflict-leave-blocked', await stale.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented
      }))
      await stale.screenshot({ path: path.join(runRoot, 'conflict.png') })
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
    await fs.writeFile(path.join(runRoot, 'server.log'), serverLog)
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
    // 场景清单**算出来**：某场景只要有一条检查没过/没走完，就不出现在清单里（矩阵据此比对 policy）
    const scenarioGroups = {
      'schema-version': ['schema-version.reject-newer', 'schema-version.data-unchanged'],
      sidecars: ['sidecars.seeded', 'sidecars.inlined-on-export', 'sidecars.restored-after-import'],
      'secret-stripping': ['secret-stripping.secret-present-before', 'secret-stripping.absent-after-export'],
      'restore-failure': ['restore-failure.corrupt-rejected', 'restore-failure.data-unchanged'],
    }
    const passedIds = new Set(checks.filter(item => item.passed).map(item => item.id))
    const scenarios = Object.entries(scenarioGroups).filter(([, ids]) => ids.every(id => passedIds.has(id))).map(([name]) => name)
    const result = {
      schemaVersion: 1, profile: 'web-cloud', scenarios,
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
