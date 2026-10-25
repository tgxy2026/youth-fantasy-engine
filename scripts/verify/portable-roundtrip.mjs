#!/usr/bin/env node
// 3.2.3 · R4：**便携配置**的端到端导出→导入取证（真实便携服务 + 真实浏览器 + 真实文件）。
//
// 为什么单独一个脚本：`storage.four-profiles` 一直 block 的最后一块就是「portable / web-guest 端到端往返」。
// 桌面与云端已有同口径证据（desktop-save-probe / web-cloud-save-probe 的 roundtrip 段），
// 便携版必须自己走一遍：导出是**浏览器下载**、导入是**浏览器选文件**，与云端同形但服务和数据根不同。
//
// 🔴 三条纪律：
//   ① 用真实便携服务（scripts/portable-server.mjs --root 临时目录），dist 复制过去，不碰主人真实书库；
//   ② 导出后**先改库并落盘**再导入 —— 不改的话「导回导出那一刻」什么都证明不了；
//   ③ 断言同时看**页面**与**磁盘**，且导入后要重启一次浏览器确认落盘（不是只信内存）。
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const PORT = Number(process.env.YFE_PROBE_PORT || 8781)
/**
 * 🔴 必须用**本次源码构建**的前端，不能用仓库根的旧 dist：
 *    服务端已经要求 If-Match，旧页面不带就被 428 拒写 —— 那是"新旧不配套"，不是产品缺陷。
 *    第一轮正是拿旧 dist 跑出「保存出错」，白查了半天。
 */
const buildArg = (() => { const i = process.argv.indexOf('--build-dir'); return i >= 0 ? process.argv[i + 1] : '' })()
const BASE = `http://127.0.0.1:${PORT}`
const MARKER = '便携往返注入的改动，导入后应当消失。'
const EDITOR = '落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）'
const EXPORT_TITLE = '导出数据文件：把全部数据导出为一个 JSON 文件（浏览器下载），用于留档或搬到别的电脑'
const IMPORT_TITLE = '导入数据文件：选择之前导出的数据文件，替换本机全部数据'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 🔴 自写递归复制：本机 cpSync 会杀进程（历史踩过） */
async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true })
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name), to = path.join(dst, entry.name)
    if (entry.isDirectory()) await copyDir(from, to)
    else await fs.copyFile(from, to)
  }
}

async function main() {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[key]
  const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/portable-roundtrip-'))
  const appRoot = path.join(runRoot, 'app')
  const dataFile = path.join(appRoot, 'data', 'youth-fantasy-engine-data.json')
  const exported = path.join(runRoot, 'portable-export.json')
  const checks = []
  const pageErrors = []
  /** 每次 /api/data 的状态码与 If-Match（保存出错时判断是 428 还是 409） */
  const dataCalls = []
  let toastTexts = []
  let server = null, browser = null, serverLog = ''
  const check = (id, ok, detail) => { checks.push({ id, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail ? ' :: ' + detail : '')) }
  const diskText = async () => { try { return await fs.readFile(dataFile, 'utf8') } catch { return null } }

  /** 章正文：云端/便携写出的 store 是**数组**形态，桌面才是键化对象 —— 两种都要认 */
  const chapterOf = (text) => {
    const rows = JSON.parse(text)?.stores?.chapters
    const list = Array.isArray(rows) ? rows : Object.values(rows ?? {})
    return list.find((row) => row && typeof row.content === 'string')
  }

  async function waitServer() {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + '/api/ping', { signal: AbortSignal.timeout(700) }); if (r.ok) return } catch { /* 还没起来 */ }
      await sleep(250)
    }
    throw new Error('便携服务未就绪：' + serverLog.slice(-400))
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
   * 进正文编辑器（与云端探针同一路径）：示范项目可能停在项目中心，也可能已经进项目。
   * 有「打开项目」就先开，再点导航里的「正文编辑」。
   */
  const openEditor = async (page) => {
    const opener = page.getByRole('button', { name: '打开项目', exact: true }).first()
    if (await opener.isVisible().catch(() => false)) {
      await opener.click()
      await page.getByRole('navigation').waitFor({ timeout: 40000 })
    }
    await page.getByRole('navigation').waitFor({ timeout: 40000 })
    await dismiss(page)
    await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
    await page.getByPlaceholder(EDITOR).waitFor({ timeout: 40000 })
  }

  try {
    const buildDir = buildArg ? path.resolve(buildArg) : path.join(ROOT, 'dist')
    await fs.access(path.join(buildDir, 'index.html'))
    await copyDir(buildDir, path.join(appRoot, 'dist'))
    server = spawn(process.execPath, [path.join(ROOT, 'scripts/portable-server.mjs'), '--root', appRoot, '--port', String(PORT), '--no-open'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    server.stdout.on('data', (v) => { serverLog += v })
    server.stderr.on('data', (v) => { serverLog += v })
    await waitServer()

    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, acceptDownloads: true })
    page.setDefaultTimeout(25000)
    page.on('pageerror', (e) => pageErrors.push(String(e.message)))
    page.on('response', async (res) => {
      const url = res.url()
      if (!url.includes('/api/data')) return
      const req = res.request()
      dataCalls.push({ method: req.method(), status: res.status(), ifMatch: (req.headers()['if-match'] || '').slice(0, 18), etag: (res.headers()['etag'] || '').slice(0, 18) })
    })

    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // 🔴 在页面里包一层 fetch 记录 /api/data（Playwright 的 response 事件在这里没抓到，别依赖它）
    await page.evaluate(() => {
      window.__apiLog = []
      const original = window.fetch
      window.fetch = function patched(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        if (!url.includes('/api/data')) return original.apply(this, arguments)
        const method = (init && init.method) || 'GET'
        const headers = (init && init.headers) || {}
        const ifMatch = headers['If-Match'] || headers['if-match'] || ''
        return original.apply(this, arguments).then((res) => {
          window.__apiLog.push({ method, status: res.status, ifMatch: String(ifMatch).slice(0, 16), etag: String(res.headers.get('etag') || '').slice(0, 16) })
          return res
        })
      }
    })
    // 示范项目：真实入口
    await page.getByRole('button', { name: /先看看示例/ }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
    await page.getByRole('navigation').waitFor()
    await dismiss(page)
    await openEditor(page)
    const editorBox = page.getByPlaceholder(EDITOR)
    await editorBox.waitFor()
    const original = await editorBox.inputValue()
    if (!original.trim()) throw new Error('示范项目正文为空，无法验证往返')

    // ---------- ① 导出：浏览器真实下载 ----------
    const downloadPromise = page.waitForEvent('download', { timeout: 40000 })
    await page.getByTitle(EXPORT_TITLE, { exact: true }).click()
    await (await downloadPromise).saveAs(exported)
    const exportedText = await fs.readFile(exported, 'utf8')
    // 🔴 两个坑：① 不能按"第一条章节"取（当前编辑的可能是第 N 章）；
    //           ② 不能拿原始 JSON 文本做 includes —— 正文里的换行在 JSON 里是 `\n` 两个字符，永远比不中。
    const exportedJson = JSON.parse(exportedText)
    const exportedRows = exportedJson?.stores?.chapters
    const exportedList = Array.isArray(exportedRows) ? exportedRows : Object.values(exportedRows ?? {})
    check('export-file', exportedList.some((row) => row && row.content === original), `导出文件里是否有与页面一致的那一章（页面 ${original.length} 字 / 导出 ${exportedList.length} 章）`)
    check('export-is-portable-data', JSON.parse(exportedText).kind === 'portable-data')

    // ---------- ② 改库并落盘：不然后面的"导回"证明不了任何事 ----------
    const changed = original + MARKER
    await editorBox.fill(changed)
    await page.keyboard.press('Control+s')
    let diskChanged = false
    let lastState = ''
    for (let i = 0; i < 80; i++) {
      const text = await diskText()
      if (text && text.includes(MARKER)) { diskChanged = true; break }
      // 顺带把界面上的保存状态记下来，失败时能看出是"没触发保存"还是"保存失败"
      lastState = await page.evaluate(() => {
        const leaf = [...document.querySelectorAll('span,div')].filter((e) => !e.children.length)
        return leaf.map((e) => (e.textContent || '').trim()).filter((t) => /保存|落盘|失败|出错/.test(t)).slice(0, 3).join(' / ')
      })
      await sleep(250)
    }
    check('changed-on-disk', diskChanged, diskChanged ? undefined : '磁盘仍没有改动内容；界面状态：' + lastState)
    // 🔴 **故意不等待**：落盘后立刻导入，正是「导入撞上在途保存」的场景。
    //    flushPortable 现在会排队等上一笔写完（3.2.6），这里就是要证明它不再随机失败；
    //    若产品退回"在途即 return false"，本用例会红。
    // ---------- ③ 导入：确认框 → 真实 filechooser → 应用 reload ----------
    await page.getByTitle(IMPORT_TITLE, { exact: true }).click()
    const chooser = page.waitForEvent('filechooser', { timeout: 30000 })
    const reloaded = page.waitForEvent('load', { timeout: 60000 })
    await page.getByRole('button', { name: '继续导入', exact: true }).click()
    await (await chooser).setFiles(exported)
    await sleep(1500)
    // 现场留证：导入点了没反应时，先看画面上到底弹了什么
    await page.screenshot({ path: path.join(runRoot, 'after-import-click.png') })
    toastTexts = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('div,p,span')].map((d) => (d.textContent || '').trim())
      return [...new Set(nodes.filter((t) => /导入|冲突|保存|请先|稍等/.test(t) && t.length < 160))].slice(-6)
    })
    dataCalls.push(...(await page.evaluate(() => window.__apiLog || [])))

    let sawLoad = false
    const loadProbe = reloaded.then(() => { sawLoad = true }).catch(() => {})
    await Promise.race([loadProbe, sleep(4000)])
    if (!sawLoad) {
      // 没 reload：把界面上所有跟「导入」有关的提示抓出来（toast 消失也还能看到冲突横幅等）
      const hints = await page.evaluate(() => {
        const texts = [...document.querySelectorAll('div,p,span')].map((d) => (d.textContent || '').trim())
        return [...new Set(texts.filter((t) => /导入|冲突|校验失败|请先/.test(t) && t.length < 200))].slice(0, 5)
      })
      await Promise.race([loadProbe, sleep(20000)])
      if (!sawLoad) throw new Error('导入后没有触发 reload ⇒ 界面提示：' + JSON.stringify(hints))
    }
    await page.getByRole('navigation').waitFor({ timeout: 40000 }).catch(() => {})
    await dismiss(page)
    await openEditor(page)
    let restored = ''
    for (let i = 0; i < 40; i++) {
      const box = page.getByPlaceholder(EDITOR)
      restored = (await box.count()) ? await box.inputValue() : ''
      if (restored.includes(original.slice(0, 12)) && !restored.includes(MARKER)) break
      await sleep(300)
    }
    check('import-page-readback', restored === original, `页面正文长度 ${restored.length} / 导出时 ${original.length}${restored.includes(MARKER) ? '（注入的改动还在）' : ''}`)
    // reload 之后前端可能还有一次落盘在途，别用一次性读取判死
    // 🔴 同样不能只看"第一条章节"：当前编辑的是第 N 章，要判"库里**有一章**等于导出时那段"
    const anyChapterIsOriginal = (text) => {
      const rows = JSON.parse(text || '{}')?.stores?.chapters
      const list = Array.isArray(rows) ? rows : Object.values(rows ?? {})
      return list.some((row) => row && row.content === original)
    }
    let diskRestored = false
    for (let i = 0; i < 60; i++) {
      if (anyChapterIsOriginal(await diskText())) { diskRestored = true; break }
      await sleep(250)
    }
    check('import-disk-readback', diskRestored, '磁盘里应有与导出时一致的那一章')

    // ---------- ④ 重启浏览器：确认导入真的落盘，不只是内存 ----------
    await browser.close()
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
    const page2 = await browser.newPage({ viewport: { width: 1440, height: 940 } })
    page2.setDefaultTimeout(25000)
    page2.on('pageerror', (e) => pageErrors.push(String(e.message)))
    await page2.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // 🔴 导入后 reload 会回到项目中心（没有 navigation），所以直接走 openEditor，
    //    它会先点「打开项目」再进「正文编辑」——不要在这里先等 navigation。
    await dismiss(page2)
    await openEditor(page2)
    const box2 = page2.getByPlaceholder(EDITOR)
    const afterRestart = (await box2.count()) ? await box2.inputValue() : ''
    check('import-restart-readback', afterRestart === original, `重启后长度 ${afterRestart.length}`)
    check('no-pageerror', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

    await page2.screenshot({ path: path.join(runRoot, 'portable-roundtrip.png') })
  } catch (e) {
    check('run', false, e instanceof Error ? e.message : String(e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (server) { const c = server; server = null; const closed = new Promise((r) => c.once('close', r)); c.kill(); await Promise.race([closed, sleep(3000)]) }
    const passed = checks.filter((c) => c.ok).length
    const payload = {
      schemaVersion: 1, contract: 'storage.portable-roundtrip', profile: 'portable',
      at: new Date().toISOString(), samples: checks.length, passed, failed: checks.length - passed,
      environment: `Windows · Playwright headless(msedge) · portable-server :${PORT} · 隔离数据根`,
      buildDir: buildArg ? path.relative(ROOT, path.resolve(buildArg)).replaceAll('\\', '/') : 'dist',
      note: '导出＝浏览器真实下载；导入＝真实 filechooser；改库后 Ctrl+S 落盘再导入；导入后重启浏览器复核',
      checks, pageErrors, dataCalls: dataCalls.slice(-40), toastTexts: toastTexts || [], serverLogTail: serverLog.slice(-1200),
    }
    const artifact = path.join(runRoot, 'result.json')
    await fs.writeFile(artifact, JSON.stringify(payload, null, 2)).catch(() => {})
    console.log(`PORTABLE_ROUNDTRIP samples=${checks.length} passed=${passed} failed=${payload.failed}`)
    console.log('artifact=' + path.relative(ROOT, artifact).replaceAll('\\', '/'))
    console.log('sha256=' + createHash('sha256').update(JSON.stringify(payload)).digest('hex'))
    if (payload.failed) process.exitCode = 1
  }
}

main().catch((e) => { console.error('PORTABLE_ROUNDTRIP failed: ' + (e instanceof Error ? e.stack : e)); process.exitCode = 1 })
