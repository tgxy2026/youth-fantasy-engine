#!/usr/bin/env node
// 3.2.3 · R4：**游客配置**的端到端导出→导入取证（真实服务 + 真实浏览器 + 真实文件 + 真实 IndexedDB）。
//
// 为什么单独一个脚本：`storage.four-profiles` 要「四种配置各自的端到端导出→导入」。
// 桌面（desktop-save-probe）、云端（web-cloud-save-probe）、便携（portable-roundtrip）都已取证，
// 只剩游客 —— 游客最特殊：**数据不在文件里，而在浏览器的 IndexedDB**，
// 所以「落盘」这一步必须直接读 IDB，不能看什么文件。
//
// 🔴 四条纪律：
//   ① 用真实 server/index.mjs 的 /guest 路由（不是自己拼 flag），数据根隔离，不碰主人真实书库；
//   ② 导出后**先改库**再导入 —— 不改的话「导回导出那一刻」什么都证明不了；
//   ③ 断言同时看**页面**与**IndexedDB**，且导入后要**重启浏览器**再确认（不是只信内存）；
//   ④ 必须用**本次源码构建**的 dist（--build-dir），旧产物不代表当前代码。
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const PID = 'guest-rt-project', VID = 'guest-rt-volume', CH = 'guest-rt-chapter'
const TITLE = '游客往返临时作品'
const ORIGINAL = '隔离游客模式的原始手稿。\n这一段在导出后会被改动，导入后必须原样回来。'
const MARKER = '游客往返注入的改动，导入后应当消失。'
const EDITOR = '落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）'
/** 密钥剥离场景用的假密钥（只为证明它不会出现在导出文件里） */
const SECRET = 'sk-probe-guest-secret-do-not-export'
/** 矩阵要的运行时证据落点 */
const resultFile = (() => { const i = process.argv.indexOf('--result-file'); return i >= 0 ? process.argv[i + 1] : '' })()
const EXPORT_TITLE = '导出全部数据：下载一个 JSON 文件，用于留档或换设备'
const IMPORT_TITLE = '导入数据文件：选择之前导出的 JSON，替换当前浏览器里的全部数据'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (name, detail) => console.log('[step] ' + name + (detail ? ' :: ' + detail : ''))
/**
 * 🔴 `page.evaluate` **没有超时**：里面的 Promise 若不 resolve（IDB 事务卡住 / 库被别处占着），
 *    整个脚本会静默挂死 —— 2026-10-25 实测挂到 7 分钟没有任何输出。所有碰 IDB 的 evaluate 都必须包这层。
 */
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  sleep(ms).then(() => { throw new Error(`${label} 超时（${ms}ms）：页面里的 IDB 操作没有返回`) }),
])
const argOf = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : '' }

async function main() {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[key]
  const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/web-guest-roundtrip-'))
  const profile = path.join(runRoot, 'profile')
  const data = path.join(runRoot, 'server-data')
  const exported = path.join(runRoot, 'guest-export.json')
  await fs.mkdir(data, { recursive: true })

  const checks = []
  const pageErrors = []
  const check = (id, ok, detail) => { checks.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail ? ' :: ' + detail : '')) }

  let server = null, context = null, serverLog = ''
  let databaseName = ''

  /** 直接读 IndexedDB 里目标章（游客的"磁盘"就是它） */
  const readChapter = async (ctx) => {
    const pages = ctx.pages().filter((p) => !p.isClosed())
    const page = pages[0] ?? await ctx.newPage()
    return withTimeout(page.evaluate(({ databaseName, CH }) => new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onerror = () => reject(request.error)
      request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error('expected existing database')) }
      request.onsuccess = () => {
        const database = request.result
        let tx
        try { tx = database.transaction('chapters', 'readonly') } catch (e) { database.close(); reject(e); return }
        const read = tx.objectStore('chapters').get(CH)
        let value
        read.onsuccess = () => { value = read.result }
        tx.oncomplete = () => { database.close(); resolve(value ?? null) }
        tx.onabort = () => { database.close(); reject(tx.error ?? new Error('read aborted')) }
      }
    }), { databaseName, CH }), 20000, 'readChapter')
  }

  /** 首启可能弹提醒框，会挡住点击 */
  async function dismiss(page) {
    for (const label of ['稍后再说', '知道了', '我知道了', '关闭']) {
      const hit = await page.evaluate((l) => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === l)
        if (b) { b.click(); return true }
        return false
      }, label)
      if (hit) { await sleep(600); return }
    }
  }

  /**
   * 进正文编辑器：先「打开项目」（若停在项目中心），再点导航「正文编辑」。
   *
   * 🔴 不能写成 `if (await opener.isVisible())` —— **isVisible() 不等待渲染**：
   *    reload 刚回来时项目卡还没画出来，它立刻返回 false，于是跳过点击、
   *    直接去等一个只有进项目后才会出现的 navigation，白等 40 秒判超时（第一轮就这么红的）。
   *    这里改成「先等『打开项目』或导航任一个出现」，再决定要不要点。
   */
  const openEditor = async (page) => {
    const opener = page.getByRole('button', { name: '打开项目', exact: true }).first()
    const nav = page.getByRole('navigation').first()
    // 备份提醒可能把导航移出可访问性树，DOM 入口用于等待首屏，实际操作仍走可见角色。
    await Promise.race([
      opener.waitFor({ state: 'visible', timeout: 45000 }).catch(() => {}),
      page.locator('nav').first().waitFor({ state: 'attached', timeout: 45000 }).catch(() => {}),
    ])
    if (await opener.isVisible().catch(() => false)) await opener.click()
    // 提醒在打开项目后异步挂载，循环关闭直到导航真的可见；不降低往返与存储断言。
    const navDeadline = Date.now() + 45000
    while (Date.now() < navDeadline && !(await nav.isVisible().catch(() => false))) {
      await dismiss(page)
      await page.waitForTimeout(200)
    }
    await nav.waitFor({ timeout: 10000 })
    await dismiss(page)
    await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
    await page.getByPlaceholder(EDITOR).waitFor({ timeout: 45000 })
  }

  const launch = async () => {
    const ctx = await chromium.launchPersistentContext(profile, {
      channel: 'msedge', headless: true, acceptDownloads: true,
      viewport: { width: 1440, height: 1000 }, args: ['--no-proxy-server'],
    })
    ctx.setDefaultTimeout(25000)
    await ctx.addInitScript(() => { try { localStorage.setItem('yfe-guest-tip-off', '1') } catch { /* origin 还没就绪 */ } })
    ctx.on('page', (p) => p.on('pageerror', (e) => pageErrors.push(String(e.message))))
    const page = ctx.pages()[0] ?? await ctx.newPage()
    page.on('pageerror', (e) => pageErrors.push(String(e.message)))
    return { ctx, page }
  }

  try {
    const buildArg = argOf('--build-dir')
    if (!buildArg) throw new Error('--build-dir 必填：不接受隐式使用旧产物')
    const buildDir = path.resolve(buildArg)
    await fs.access(path.join(buildDir, 'index.html'))

    // 🔴 库名从源码读，别写死（改名时会静默读错库）
    const dbSource = await fs.readFile(path.join(ROOT, 'src/lib/db/core.ts'), 'utf8')
    databaseName = /const DB_NAME = '([^']+)'/.exec(dbSource)?.[1]
    if (!databaseName) throw new Error('无法从 src/lib/db/core.ts 读出数据库名')

    const port = await new Promise((resolve, reject) => {
      const listener = net.createServer()
      listener.on('error', reject)
      listener.listen(0, '127.0.0.1', () => { const p = listener.address().port; listener.close(() => resolve(p)) })
    })
    const origin = 'http://127.0.0.1:' + port
    const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data, YFE_WWW: buildDir, YFE_REGISTER: 'closed', YFE_BOOTSTRAP_INVITE: '' }
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[key]

    server = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    server.stdout.on('data', (v) => { serverLog += v })
    server.stderr.on('data', (v) => { serverLog += v })
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(origin + '/api/ping', { signal: AbortSignal.timeout(800) })).ok) break } catch { /* 还没起来 */ }
      await sleep(250)
    }

    const first = await launch()
    context = first.ctx
    let page = first.page
    await page.goto(origin + '/guest', { waitUntil: 'domcontentloaded', timeout: 60000 })
    // 游客判定必须真的生效（不是靠 URL 猜）
    await page.waitForFunction(() => !!window.__YFE_GUEST__, null, { timeout: 30000 })
    await page.waitForFunction(async (name) => (await indexedDB.databases()).some((d) => d.name === name), databaseName, { timeout: 30000 })

    // 播种一个已知项目：WelcomeWizard 已跳过，进项目中心就能看到
    step('seed-start')
    await withTimeout(page.evaluate(({ databaseName, PID, VID, CH, TITLE, ORIGINAL, SECRET }) => new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const tx = database.transaction(['projects', 'volumes', 'chapters', 'meta'], 'readwrite')
        const now = Date.now()
        tx.objectStore('projects').put({ id: PID, name: TITLE, genre: '玄幻', intro: '', projectType: 'full', createdAt: now, updatedAt: now })
        tx.objectStore('volumes').put({ id: VID, projectId: PID, title: '验收卷', description: '', order: 0, createdAt: now })
        tx.objectStore('chapters').put({ id: CH, projectId: PID, volumeId: VID, title: '游客往返章', content: ORIGINAL, summary: '', wordCount: ORIGINAL.length, order: 0, status: '草稿', tags: [], createdAt: now, updatedAt: now })
        tx.objectStore('meta').put({ key: 'welcomeDone', value: '1' })
        // 密钥剥离场景的种子：全局 meta 里的 AI 配置（导出时必须被剥掉）
        tx.objectStore('meta').put({ key: 'aiProviders', value: { activeId: 'probe', providers: [{ id: 'probe', apiKey: SECRET }] } })
        tx.oncomplete = () => { database.close(); resolve(true) }
        tx.onabort = () => { database.close(); reject(tx.error) }
      }
    }), { databaseName, PID, VID, CH, TITLE, ORIGINAL, SECRET }), 20000, 'seed')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await openEditor(page)
    const editorBox = page.getByPlaceholder(EDITOR)
    const original = await editorBox.inputValue()
    if (original !== ORIGINAL) throw new Error('编辑框正文与播种内容不一致：' + JSON.stringify(original.slice(0, 40)))

    step('editor-open', `正文 ${original.length} 字`)

    // ---------- ① 导出：游客走浏览器真实下载 ----------
    const downloadPromise = page.waitForEvent('download', { timeout: 40000 })
    await page.getByTitle(EXPORT_TITLE, { exact: true }).click()
    await (await downloadPromise).saveAs(exported)
    const exportedText = await fs.readFile(exported, 'utf8')
    const exportedJson = JSON.parse(exportedText)
    // 🔴 不能拿原始 JSON 文本 includes（换行在 JSON 里是 `\n` 两字符），必须解析后比字段
    const exportedRows = exportedJson?.stores?.chapters
    const exportedList = Array.isArray(exportedRows) ? exportedRows : Object.values(exportedRows ?? {})
    check('export-file', exportedList.some((row) => row && row.content === original),
      `导出文件里是否有与页面一致的那一章（页面 ${original.length} 字 / 导出 ${exportedList.length} 章）`)
    check('export-is-portable-data', exportedJson?.kind === 'portable-data' && exportedJson?.app === 'youth-fantasy-engine',
      `kind=${String(exportedJson?.kind)} app=${String(exportedJson?.app)}`)

    // 密钥剥离：先确认"库里真的存着这枚密钥"，再确认"导出文件里没有它"
    step('export-done', `导出 ${original.length} 字`)
    const seededSecret = await withTimeout(page.evaluate(({ databaseName }) => new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('meta', 'readonly')
        const read = tx.objectStore('meta').get('aiProviders')
        let value
        read.onsuccess = () => { value = read.result }
        tx.oncomplete = () => { db.close(); resolve(JSON.stringify(value ?? null)) }
        tx.onabort = () => { db.close(); reject(tx.error) }
      }
    }), { databaseName }), 20000, 'seededSecret')
    check('secret-stripping.secret-present-before', seededSecret.includes(SECRET), seededSecret.slice(0, 120))
    const exportedMeta = exportedJson?.stores?.meta
    const exportedMetaKeys = Array.isArray(exportedMeta)
      ? exportedMeta.map((row) => String(row?.key ?? ''))
      : Object.keys(exportedMeta ?? {})
    check('secret-stripping.absent-after-export',
      !exportedText.includes(SECRET) && !exportedMetaKeys.includes('aiProviders'),
      `文件里含密钥=${exportedText.includes(SECRET)} / meta 含 aiProviders=${exportedMetaKeys.includes('aiProviders')}`)

    // 侧车：游客的语义向量与知识库在**两个独立 IDB**里，按设计不进整库 JSON ——
    // 但这属于"必须说清楚"的缺口，所以既要断言"文件里没有"，也要断言"界面说了没有"。
    const sidecarKeys = ['vecRows', 'kbDocs', 'kbBodies'].filter((k) => Object.prototype.hasOwnProperty.call(exportedJson?.stores ?? {}, k))
    const exportToast = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('div,p,span')].map((d) => (d.textContent || '').trim())
      return nodes.filter((t) => t.includes('已导出')).slice(-1)[0] || ''
    })
    check('sidecars.excluded-and-declared',
      sidecarKeys.length === 0 && /语义检索索引与知识库不在这份文件里/.test(exportToast),
      `文件里含侧车键=${JSON.stringify(sidecarKeys)} / 提示是否说明=${/语义检索索引/.test(exportToast)}`)

    step('export-checks-done')
    // ---------- ② 改库：不然后面的"导回"证明不了任何事 ----------
    const changed = original + MARKER
    await editorBox.fill(changed)
    await page.keyboard.press('Control+s')
    let idbChanged = false
    for (let i = 0; i < 80; i++) {
      const row = await readChapter(context)
      if (row && typeof row.content === 'string' && row.content.includes(MARKER)) { idbChanged = true; break }
      await sleep(250)
    }
    check('changed-in-indexeddb', idbChanged, idbChanged ? undefined : 'IndexedDB 里仍没有改动内容（游客的"落盘"就是它）')

    step('changed-in-idb')
    // ---------- ③ 导入：确认框 → 真实 filechooser → 应用 reload ----------
    await page.getByTitle(IMPORT_TITLE, { exact: true }).click()
    const chooser = page.waitForEvent('filechooser', { timeout: 30000 })
    const reloaded = page.waitForEvent('load', { timeout: 60000 })
    await page.getByRole('button', { name: '继续导入', exact: true }).click()
    await (await chooser).setFiles(exported)
    await sleep(1200)
    await page.screenshot({ path: path.join(runRoot, 'after-import-click.png') })

    let sawLoad = false
    const loadProbe = reloaded.then(() => { sawLoad = true }).catch(() => {})
    await Promise.race([loadProbe, sleep(4000)])
    if (!sawLoad) {
      const hints = await page.evaluate(() => {
        const texts = [...document.querySelectorAll('div,p,span')].map((d) => (d.textContent || '').trim())
        return [...new Set(texts.filter((t) => /导入|失败|冲突|请先/.test(t) && t.length < 200))].slice(0, 5)
      })
      await Promise.race([loadProbe, sleep(20000)])
      if (!sawLoad) throw new Error('导入后没有触发 reload ⇒ 界面提示：' + JSON.stringify(hints))
    }

    await dismiss(page)
    await openEditor(page)
    let restored = ''
    for (let i = 0; i < 40; i++) {
      const box = page.getByPlaceholder(EDITOR)
      restored = (await box.count()) ? await box.inputValue() : ''
      if (restored === original) break
      await sleep(300)
    }
    check('import-page-readback', restored === original,
      `页面正文长度 ${restored.length} / 导出时 ${original.length}${restored.includes(MARKER) ? '（注入的改动还在）' : ''}`)

    let idbRestored = false
    for (let i = 0; i < 60; i++) {
      const row = await readChapter(context)
      if (row && row.content === original) { idbRestored = true; break }
      await sleep(250)
    }
    check('import-indexeddb-readback', idbRestored, 'IndexedDB 里应有与导出时一致的那一章')

    step('import-restored')
    // ---------- ④ 两个必须被拒的导入：版本闸与损坏文件 ----------
    const idbFingerprint = async () => {
      const row = await readChapter(context)
      const projects = await withTimeout(page.evaluate(({ databaseName }) => new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const tx = db.transaction('projects', 'readonly')
          const read = tx.objectStore('projects').getAll()
          let rows = []
          read.onsuccess = () => { rows = read.result }
          tx.oncomplete = () => { db.close(); resolve(rows.map((r) => r.id).sort()) }
          tx.onabort = () => { db.close(); reject(tx.error) }
        }
      }), { databaseName }), 20000, 'idbFingerprint')
      return JSON.stringify({ chapter: row?.content ?? null, projects })
    }
    async function importExpectRefusal(file, pattern, label) {
      await page.getByTitle(IMPORT_TITLE, { exact: true }).click()
      const ch = page.waitForEvent('filechooser', { timeout: 30000 })
      await page.getByRole('button', { name: '继续导入', exact: true }).click()
      await (await ch).setFiles(file)
      const toast = page.getByText(pattern).first()
      await toast.waitFor({ timeout: 25000 })
      check(label, true, ((await toast.textContent()) || '').trim().slice(0, 120))
    }
    const beforeReject = await idbFingerprint()

    const newerVersionFile = path.join(runRoot, 'newer-version.json')
    {
      const f = JSON.parse(exportedText)
      f.fileVersion = 999
      await fs.writeFile(newerVersionFile, JSON.stringify(f))
    }
    await importExpectRefusal(newerVersionFile, /更新版本的软件导出/, 'schema-version.reject-newer')
    {
      const after = await idbFingerprint()
      check('schema-version.data-unchanged', after === beforeReject,
        after === beforeReject ? undefined : '被拒的导入居然改动了 IndexedDB')
    }

    const corruptFile = path.join(runRoot, 'corrupt.json')
    await fs.writeFile(corruptFile, '{"kind":"portable-data","stores":{')
    await importExpectRefusal(corruptFile, /已损坏/, 'restore-failure.corrupt-rejected')
    {
      const after = await idbFingerprint()
      check('restore-failure.data-unchanged', after === beforeReject,
        after === beforeReject ? undefined : '损坏文件被拒后 IndexedDB 却变了')
    }
    await page.screenshot({ path: path.join(runRoot, 'rejected-imports.png') })

    step('rejections-done')
    // ---------- ⑤ 重启浏览器：确认导入真的写进 IDB，不只是内存 ----------
    await context.close()
    context = null
    const second = await launch()
    context = second.ctx
    page = second.page
    await page.goto(origin + '/guest', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(() => !!window.__YFE_GUEST__, null, { timeout: 30000 })
    await dismiss(page)
    await openEditor(page)
    const box2 = page.getByPlaceholder(EDITOR)
    const afterRestart = (await box2.count()) ? await box2.inputValue() : ''
    check('import-restart-readback', afterRestart === original, `重启后长度 ${afterRestart.length}`)
    check('no-pageerror', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

    await page.screenshot({ path: path.join(runRoot, 'web-guest-roundtrip.png') })
  } catch (e) {
    check('run', false, e instanceof Error ? e.message : String(e))
  } finally {
    if (context) await context.close().catch(() => {})
    if (server) { const c = server; server = null; const closed = new Promise((r) => c.once('close', r)); c.kill(); await Promise.race([closed, sleep(3000)]) }
    const passed = checks.filter((c) => c.ok).length
    // 场景是**算出来的**：某场景只要有一条检查没过/没走完，就不出现在清单里（矩阵那边据此比对 policy）
    const scenarioGroups = {
      'schema-version': ['schema-version.reject-newer', 'schema-version.data-unchanged'],
      sidecars: ['sidecars.excluded-and-declared'],
      'secret-stripping': ['secret-stripping.secret-present-before', 'secret-stripping.absent-after-export'],
      'restore-failure': ['restore-failure.corrupt-rejected', 'restore-failure.data-unchanged'],
    }
    const passedIds = new Set(checks.filter((c) => c.ok).map((c) => c.id))
    const scenarios = Object.entries(scenarioGroups)
      .filter(([, ids]) => ids.every((id) => passedIds.has(id)))
      .map(([name]) => name)
    const payload = {
      schemaVersion: 1, contract: 'storage.web-guest-roundtrip', profile: 'web-guest', scenarios,
      at: new Date().toISOString(), samples: checks.length, passed, failed: checks.length - passed,
      environment: 'Windows · Playwright headless(msedge) · 真实 server/index.mjs /guest · 隔离数据根 · 持久化 profile（重启后仍读同一 IndexedDB）',
      note: '导出＝浏览器真实下载；导入＝真实 filechooser；改库直接读 IndexedDB 确认；导入后重启浏览器复核',
      checks, pageErrors, serverLogTail: serverLog.slice(-1200),
    }
    const artifact = path.join(runRoot, 'result.json')
    await fs.writeFile(artifact, JSON.stringify(payload, null, 2)).catch(() => {})
    if (resultFile) {
      await fs.mkdir(path.dirname(path.resolve(resultFile)), { recursive: true })
      await fs.writeFile(path.resolve(resultFile), JSON.stringify(payload, null, 2))
    }
    console.log(`WEB_GUEST_ROUNDTRIP samples=${checks.length} passed=${passed} failed=${payload.failed}`)
    console.log('artifact=' + path.relative(ROOT, artifact).replaceAll('\\', '/'))
    console.log('sha256=' + createHash('sha256').update(JSON.stringify(payload)).digest('hex'))
    if (payload.failed) process.exitCode = 1
  }
}

main().catch((e) => { console.error('WEB_GUEST_ROUNDTRIP failed: ' + (e instanceof Error ? e.stack : e)); process.exitCode = 1 })
