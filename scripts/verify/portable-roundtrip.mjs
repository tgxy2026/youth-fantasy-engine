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
/** 矩阵要的运行时证据落点（统一验收传；不传则只写到本次 runRoot） */
const resultFile = (() => { const i = process.argv.indexOf('--result-file'); return i >= 0 ? process.argv[i + 1] : '' })()
const MARKER = '便携往返注入的改动，导入后应当消失。'
/** 密钥剥离场景用的假密钥（只为证明它不会出现在导出文件里） */
const SECRET = 'sk-probe-portable-secret-do-not-export'
/** 侧车场景用的向量行（便携把 vecRows 存成 /api/blob 的整表文件，导出时必须内联回单文件） */
const VEC_ID = 'vec-probe-1'
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
   *
   * 🔴 不能写成 `if (await opener.isVisible())` —— **isVisible() 不等待渲染**：
   *    重启浏览器后 goto 刚回来时项目卡还没画出来，它立刻返回 false，于是跳过点击、
   *    直接去等一个只有进项目后才会出现的 navigation，白等 40 秒判超时。
   *    单跑时机器空闲、渲染快，看不出来；完整验收里同时跑别的探针时就会红（实测
   *    `reliability-6YIUYD`：6 项里 5 项 PASS，只在这条上超时）。
   *    改成「先等『打开项目』或导航任一个出现」，再决定要不要点。
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

  try {
    const buildDir = buildArg ? path.resolve(buildArg) : path.join(ROOT, 'dist')
    await fs.access(path.join(buildDir, 'index.html'))
    await copyDir(buildDir, path.join(appRoot, 'dist'))
    server = spawn(process.execPath, [path.join(ROOT, 'scripts/portable-server.mjs'), '--root', appRoot, '--port', String(PORT), '--no-open'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    server.stdout.on('data', (v) => { serverLog += v })
    server.stderr.on('data', (v) => { serverLog += v })
    await waitServer()

    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 }, acceptDownloads: true })
    /**
     * 🔴 必须在**每次导航前**都装（addInitScript），不能只在首屏 evaluate 一次：
     *    本用例中间会 reload（播种后、导入后），一次性安装的补丁会随页面消失，
     *    于后面读 __apiLog 永远是 0 —— 看起来像"没走后端"，其实是记录器没了。
     */
    await ctx.addInitScript(() => {
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
    const page = await ctx.newPage()
    page.setDefaultTimeout(25000)
    page.on('pageerror', (e) => pageErrors.push(String(e.message)))
    page.on('response', async (res) => {
      const url = res.url()
      if (!url.includes('/api/data')) return
      const req = res.request()
      dataCalls.push({ method: req.method(), status: res.status(), ifMatch: (req.headers()['if-match'] || '').slice(0, 18), etag: (res.headers()['etag'] || '').slice(0, 18) })
    })

    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // boot-store/initial-flags：便携服务真的注入了 PORTABLE（不是网页版 / 游客 / 桌面）
    const flags = await page.evaluate(() => ({
      web: !!window.__YFE_WEB__,
      portable: !!window.__YFE_PORTABLE__,
      guest: !!window.__YFE_GUEST__,
      electron: !!window.electronStore,
    }))
    check('initial-flags', flags.portable && !flags.web && !flags.guest && !flags.electron, JSON.stringify(flags))

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

    // ---------- ① 播种：密钥 + 侧车（都走真实 HTTP，不碰产品开关）----------
    //
    // 为什么必须播种再导出：
    //   · 不先放一枚密钥，「导出里没有密钥」是句空话（本来就没有）；
    //   · 不先放一行向量，`sidecars` 场景无从判断"外置数据有没有被内联回单文件"。
    // 两者都只改**本次临时数据根**里的内容：数据文件用服务端自己的条件写 PUT，
    // 侧车用服务端自己的 /api/blob —— 与产品走同一条路。
    const apiText = async () => {
      const r = await fetch(BASE + '/api/data', { cache: 'no-store' })
      if (!r.ok) throw new Error('读取服务端数据文件失败 HTTP ' + r.status)
      const j = await r.json()
      return { text: j.text, etag: r.headers.get('etag') || '' }
    }
    async function seedSecretAndSidecar() {
      const cur = await apiText()
      const file = JSON.parse(cur.text)
      file.stores = file.stores || {}
      // 行形态两可：对象（主键→记录）或数组（历史遗留）—— 统一成对象再塞一行
      const metaRows = file.stores.meta
      const asMap = Array.isArray(metaRows)
        ? Object.fromEntries(metaRows.filter((r) => r && r.key).map((r) => [r.key, r]))
        : { ...(metaRows || {}) }
      asMap.aiProviders = { key: 'aiProviders', value: { activeId: 'probe', providers: [{ id: 'probe', apiKey: SECRET }] } }
      file.stores.meta = asMap
      const put = await fetch(BASE + '/api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': cur.etag },
        body: JSON.stringify(file),
      })
      if (!put.ok) throw new Error('播种密钥失败 HTTP ' + put.status)
      const blob = await fetch(BASE + '/api/blob?store=vecRows&id=__all__', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ id: VEC_ID, projectId: 'probe', dim: 3, vector: [0.1, 0.2, 0.3], updatedAt: 1 }]),
      })
      if (!blob.ok) throw new Error('播种侧车失败 HTTP ' + blob.status)
    }
    await seedSecretAndSidecar()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismiss(page)
    await openEditor(page)

    // ---------- ② 导出：浏览器真实下载 ----------
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

    // 密钥剥离：先证明"服务端确实存着这枚密钥"，再证明"导出文件里没有它"
    const serverHasSecret = (await apiText()).text.includes(SECRET)
    check('secret-stripping.secret-present-before', serverHasSecret, serverHasSecret ? undefined : '服务端数据文件里没有播种的密钥，本场景无效')
    const exportedMeta = exportedJson?.stores?.meta
    const exportedMetaKeys = Array.isArray(exportedMeta)
      ? exportedMeta.map((r) => String(r?.key ?? ''))
      : Object.keys(exportedMeta ?? {})
    check('secret-stripping.absent-after-export',
      !exportedText.includes(SECRET) && !exportedMetaKeys.includes('aiProviders'),
      `文件里含密钥=${exportedText.includes(SECRET)} / meta 含 aiProviders=${exportedMetaKeys.includes('aiProviders')}`)

    // 侧车：便携把 vecRows 存成 /api/blob 的整表文件，导出必须**内联回单文件**
    const exportedVec = exportedJson?.stores?.vecRows
    const exportedVecList = Array.isArray(exportedVec) ? exportedVec : Object.values(exportedVec ?? {})
    check('sidecars.inlined-on-export',
      exportedVecList.some((row) => row && row.id === VEC_ID),
      `导出 ${exportedVecList.length} 行向量${exportedVecList.some((r) => r && r.id === VEC_ID) ? '（含探针行）' : '（缺探针行）'}`)

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

    // boot-store/backend-selection：数据确实走便携服务的 HTTP 通道（不是本地 IDB 冒充）
    // 🔴 必须在这里读：导入会 location.reload()，页面里包的 fetch 记录会随页面一起没掉（末尾读永远是 0）。
    {
      const apiLog = await page.evaluate(() => window.__apiLog || []).catch(() => [])
      const puts = apiLog.filter((item) => item.method === 'PUT' && item.status === 200)
      check('backend-selection', puts.length > 0 && !flags.electron, `PUT /api/data 200 次数=${puts.length}`)
    }
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

    // 导入时侧车内联在单文件里 ⇒ 导入后必须**再拆回** blob，否则等于每次导入都把外置数据搬回主文件
    let vecRestored = false
    for (let i = 0; i < 80; i++) {
      const r = await fetch(BASE + '/api/blob?store=vecRows&id=__all__', { cache: 'no-store' })
      if (r.ok) {
        const j = await r.json().catch(() => ({}))
        const rows = Array.isArray(j.value) ? j.value : []
        if (rows.some((row) => row && row.id === VEC_ID)) { vecRestored = true; break }
      }
      await sleep(250)
    }
    check('sidecars.restored-after-import', vecRestored, '导入后侧车 blob 里应有探针向量行')

    // ---------- ⑤ 两个必须被拒的导入：版本闸与损坏文件 ----------
    const beforeReject = await diskText()
    async function importExpectRefusal(file, pattern, label) {
      await page.getByTitle(IMPORT_TITLE, { exact: true }).click()
      const ch = page.waitForEvent('filechooser', { timeout: 30000 })
      await page.getByRole('button', { name: '继续导入', exact: true }).click()
      await (await ch).setFiles(file)
      const toast = page.getByText(pattern).first()
      await toast.waitFor({ timeout: 25000 })
      const text = (await toast.textContent()) || ''
      check(label, true, text.trim().slice(0, 120))
      return text
    }
    // 版本闸：把导出文件的 fileVersion 改成本版本 + 1（模拟"新版本软件写的数据文件"）
    const newerVersionFile = path.join(runRoot, 'newer-version.json')
    {
      const f = JSON.parse(exportedText)
      f.fileVersion = 999
      await fs.writeFile(newerVersionFile, JSON.stringify(f))
    }
    await importExpectRefusal(newerVersionFile, /更新版本的软件导出/, 'schema-version.reject-newer')
    const afterVersionReject = await diskText()
    check('schema-version.data-unchanged', beforeReject === afterVersionReject,
      beforeReject === afterVersionReject ? undefined : '被拒的导入居然改动了数据文件')

    // 恢复失败：结构损坏的 JSON
    const corruptFile = path.join(runRoot, 'corrupt.json')
    await fs.writeFile(corruptFile, '{"kind":"portable-data","stores":{')
    await importExpectRefusal(corruptFile, /数据文件已损坏/, 'restore-failure.corrupt-rejected')
    const afterCorruptReject = await diskText()
    check('restore-failure.data-unchanged', afterVersionReject === afterCorruptReject,
      afterVersionReject === afterCorruptReject ? undefined : '损坏文件被拒后数据文件却变了')
    await page.screenshot({ path: path.join(runRoot, 'rejected-imports.png') })

    // ---------- ⑥ 重启浏览器：确认导入真的落盘，不只是内存 ----------
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
    // 🔴 场景是**算出来的**，不是写死的：某个场景只要有一条检查没走完/没过，就不出现在这份清单里。
    //    矩阵那边的 `auditRuntime` 会拿它跟 policy.json 要求的四个场景比对，缺一个就不点亮。
    /**
     * 场景名必须与 `scripts/audit/platform/policy.json` 里写的一模一样 —— 执行器是拿它逐项比对的。
     * 🔴 别用"我自己的分组名"（例如 boot-store）去填：那一格里 policy 要的是 initial-flags /
     *    backend-selection / restart-readback 三条**场景名**，填组名会被判成"缺场景"（踩过）。
     */
    const scenarioGroups = {
      // boot-store 的三条（restart-readback 由 import-restart-readback 这条检查证明）
      'initial-flags': ['initial-flags'],
      'backend-selection': ['backend-selection'],
      'restart-readback': ['import-restart-readback'],
      // roundtrip 的四条：每条由 2~3 个检查共同证明
      'schema-version': ['schema-version.reject-newer', 'schema-version.data-unchanged'],
      sidecars: ['sidecars.inlined-on-export', 'sidecars.restored-after-import'],
      'secret-stripping': ['secret-stripping.secret-present-before', 'secret-stripping.absent-after-export'],
      'restore-failure': ['restore-failure.corrupt-rejected', 'restore-failure.data-unchanged'],
    }
    const passedIds = new Set(checks.filter((c) => c.ok).map((c) => c.id))
    const scenarios = Object.entries(scenarioGroups)
      .filter(([, ids]) => ids.every((id) => passedIds.has(id)))
      .map(([name]) => name)
    const payload = {
      schemaVersion: 1, contract: 'storage.portable-roundtrip', profile: 'portable', scenarios,
      at: new Date().toISOString(), samples: checks.length, passed, failed: checks.length - passed,
      environment: `Windows · Playwright headless(msedge) · portable-server :${PORT} · 隔离数据根`,
      buildDir: buildArg ? path.relative(ROOT, path.resolve(buildArg)).replaceAll('\\', '/') : 'dist',
      note: '导出＝浏览器真实下载；导入＝真实 filechooser；改库后 Ctrl+S 落盘再导入；导入后重启浏览器复核',
      checks, pageErrors, dataCalls: dataCalls.slice(-40), toastTexts: toastTexts || [], serverLogTail: serverLog.slice(-1200),
    }
    const artifact = path.join(runRoot, 'result.json')
    await fs.writeFile(artifact, JSON.stringify(payload, null, 2)).catch(() => {})
    if (resultFile) {
      await fs.mkdir(path.dirname(path.resolve(resultFile)), { recursive: true })
      await fs.writeFile(path.resolve(resultFile), JSON.stringify(payload, null, 2))
    }
    console.log(`PORTABLE_ROUNDTRIP samples=${checks.length} passed=${passed} failed=${payload.failed}`)
    console.log('artifact=' + path.relative(ROOT, artifact).replaceAll('\\', '/'))
    console.log('sha256=' + createHash('sha256').update(JSON.stringify(payload)).digest('hex'))
    if (payload.failed) process.exitCode = 1
  }
}

main().catch((e) => { console.error('PORTABLE_ROUNDTRIP failed: ' + (e instanceof Error ? e.stack : e)); process.exitCode = 1 })
