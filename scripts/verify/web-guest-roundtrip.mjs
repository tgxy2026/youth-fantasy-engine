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
const EXPORT_TITLE = '导出全部数据：下载一个 JSON 文件，用于留档或换设备'
const IMPORT_TITLE = '导入数据文件：选择之前导出的 JSON，替换当前浏览器里的全部数据'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
    return page.evaluate(({ databaseName, CH }) => new Promise((resolve, reject) => {
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
    }), { databaseName, CH })
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
    await Promise.race([
      opener.waitFor({ state: 'visible', timeout: 45000 }).catch(() => {}),
      nav.waitFor({ state: 'visible', timeout: 45000 }).catch(() => {}),
    ])
    if (await opener.isVisible().catch(() => false)) await opener.click()
    await nav.waitFor({ timeout: 45000 })
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
    await page.evaluate(({ databaseName, PID, VID, CH, TITLE, ORIGINAL }) => new Promise((resolve, reject) => {
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
        tx.oncomplete = () => { database.close(); resolve(true) }
        tx.onabort = () => { database.close(); reject(tx.error) }
      }
    }), { databaseName, PID, VID, CH, TITLE, ORIGINAL })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await openEditor(page)
    const editorBox = page.getByPlaceholder(EDITOR)
    const original = await editorBox.inputValue()
    if (original !== ORIGINAL) throw new Error('编辑框正文与播种内容不一致：' + JSON.stringify(original.slice(0, 40)))

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

    // ---------- ④ 重启浏览器：确认导入真的写进 IDB，不只是内存 ----------
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
    const payload = {
      schemaVersion: 1, contract: 'storage.web-guest-roundtrip', profile: 'web-guest',
      at: new Date().toISOString(), samples: checks.length, passed, failed: checks.length - passed,
      environment: 'Windows · Playwright headless(msedge) · 真实 server/index.mjs /guest · 隔离数据根 · 持久化 profile（重启后仍读同一 IndexedDB）',
      note: '导出＝浏览器真实下载；导入＝真实 filechooser；改库直接读 IndexedDB 确认；导入后重启浏览器复核',
      checks, pageErrors, serverLogTail: serverLog.slice(-1200),
    }
    const artifact = path.join(runRoot, 'result.json')
    await fs.writeFile(artifact, JSON.stringify(payload, null, 2)).catch(() => {})
    console.log(`WEB_GUEST_ROUNDTRIP samples=${checks.length} passed=${passed} failed=${payload.failed}`)
    console.log('artifact=' + path.relative(ROOT, artifact).replaceAll('\\', '/'))
    console.log('sha256=' + createHash('sha256').update(JSON.stringify(payload)).digest('hex'))
    if (payload.failed) process.exitCode = 1
  }
}

main().catch((e) => { console.error('WEB_GUEST_ROUNDTRIP failed: ' + (e instanceof Error ? e.stack : e)); process.exitCode = 1 })
