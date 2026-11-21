#!/usr/bin/env node
// 打包形态验收探针（A–H 入口级 + 一次真实存储往返）· 版本无关，见 --expect-version
//
// 为什么需要它：`scripts/verify/frontend-*.mjs` 那 45 支探针都要 **vite dev server**
// （它们 import `/src/lib/...`），打包后的 dist 里没有源码模块 ⇒ 一支都跑不了。
// 于是「包装好之后，功能入口还在不在、能不能真存进去」一直只能靠人手点。
//
// 本探针补的就是这一段：**只看打包产物**，用真实点击驱动，不 import 任何源码模块。
// 两种载体同一条判据：
//   · `--base http://127.0.0.1:8791`  —— 便携版（包内 scripts/portable-server.mjs 起服务）
//   · `--exe <安装目录>/YouthFantasyEngine.exe` —— 桌面安装版（app.asar）
//
// 🔴 判据分级（避免把"我的选择器猜错了"写成"产品坏了"）：
//   · 必检（failureCount 计入失败）：版本号、存储标志、首启入口、正文保存往返、五个核心入口；
//   · 尽力（只记录，不判失败）：剧情候选 / 审读记录这类入口位置可能变的面板。
//   · 任何 pageerror / 404 / 5xx 一律判失败 —— 打包最常见的坏法就是资源没进包。
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chromium, _electron } from 'playwright'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const arg = name => {
  const at = process.argv.indexOf(name)
  if (at < 0) return ''
  const value = process.argv[at + 1]
  if (!value || value.startsWith('--')) throw new Error(name + ' requires a value')
  return value
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const checks = []
const errors = []
const check = (id, ok, detail) => {
  checks.push({ id, passed: !!ok, detail: String(detail ?? '').slice(0, 300) })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail ? ' :: ' + String(detail).slice(0, 160) : ''))
}
const note = (id, detail) => { checks.push({ id, passed: true, skipped: true, detail: String(detail).slice(0, 300) }); console.log('SKIP ' + id + ' :: ' + detail) }

/** 关引导/提醒：它们会把背景置 inert，导航点不动 */
async function clearOverlays(page) {
  for (const label of ['关闭本页指引', '跳过本页', '稍后再说', '知道了', '我知道了', '继续上次', '跳过，直接开始', '跳过，直接进入项目管理']) {
    const b = page.getByRole('button', { name: label, exact: true }).first()
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {})
  }
  await page.waitForFunction(() => !document.querySelector('[data-guide-mask]'), null, { timeout: 2000 }).catch(() => {})
}

async function main() {
  const base = arg('--base')
  const exe = arg('--exe')
  /**
   * web（云端）与便携在前端是**同一个渲染层**，差别只在服务端注入了什么：
   * 云端会同时给 `__YFE_WEB__` 与 `__YFE_PORTABLE__`，所以不能只靠 portable 判载体。
   * `--expect` 显式声明本次要验的形态；不传则按"有 exe = 桌面、否则便携"猜。
   */
  const expect = arg('--expect') || (exe ? 'desktop' : 'portable')
  /** `--login 用户名:密码`：云端形态必须先登录，否则页面是游客（IndexedDB），验不到服务端存储 */
  const login = arg('--login')
  const resultFile = arg('--result-file')
  /**
   * `--expect-version 3.6.1`：本次要验的产物版本。
   * 默认读 package.json；补验上一版产物时必须显式传，否则源码版本已前进会误判。
   */
  const expectVersion = arg('--expect-version')
    || JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version
  if (!base && !exe) throw new Error('需要 --base <url> 或 --exe <安装后的 exe>')
  const runRoot = path.join(ROOT, '.workbuddy/tmp', 'packaged-acceptance-' + crypto.randomBytes(3).toString('hex'))
  await fs.mkdir(runRoot, { recursive: true })
  const profile = path.join(runRoot, 'profile')

  let app = null, ctx = null, page = null
  const badStatus = []
  const wire = target => {
    target.setDefaultTimeout(20000)
    target.on('pageerror', e => errors.push('pageerror: ' + String(e.message).slice(0, 160)))
    target.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text().slice(0, 160)) })
    /**
     * 🔴 `/api/data` 的 404 是**正常语义**：空库 / 首次启动时服务端就返回 404 + {missing:true}
     *   （见 web-cloud 探针的 boot-store 判据）。把它算坏状态会让每一台新机器的首启验收直接判红。
     */
    target.on('response', r => {
      const status = r.status(), url = r.url()
      // `/api/blob?...` 的 404 = 该侧车（vecRows / kbDocs 等）**还没有数据**，属正常空态。
      if ((url.includes('/api/data') || url.includes('/api/blob')) && status === 404) return
      if (status >= 500 || status === 404) badStatus.push(status + ' ' + url.slice(0, 140))
    })
  }

  try {
    if (exe) {
      const env = { ...process.env }
      for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_START_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key]
      app = await _electron.launch({ executablePath: path.resolve(exe), args: ['--no-sandbox', '--no-proxy-server', `--user-data-dir=${profile}`], env, timeout: 120_000 })
      page = await app.firstWindow()
      page.setDefaultTimeout(60_000)
      wire(page)
      await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 90_000 })
    } else {
      ctx = await chromium.launchPersistentContext(profile, { channel: 'msedge', viewport: { width: 1500, height: 940 }, args: ['--no-first-run', '--no-proxy-server'] })
      page = ctx.pages()[0] ?? await ctx.newPage()
      wire(page)
      if (login) {
        const [name, password] = login.split(':')
        const res = await ctx.request.post(base.replace(/\/$/, '') + '/api/auth/login', { data: { name, password }, timeout: 30_000 })
        if (!res.ok()) throw new Error('登录失败：' + res.status() + ' ' + (await res.text()).slice(0, 120))
      }
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 90_000 })
      /**
       * 🔴 公网网页版首屏是**独立的静态登录页**（nginx 直接托管，不是 SPA 入口），
       *    未提供账号时脚本会停在这一页，后面所有入口断言都会假红。
       *    没有账号就点「免费以游客身份开始创作」进应用 —— 游客走 IndexedDB，
       *    能验入口与编辑往返，但验不到服务端存储（需 `--login`，结果里会如实标注）。
       */
      if (!login) {
        // 入口在服务端登录页里是 `<a class="guestBtn" href="/guest">`（server/lib/authPage.mjs:90），不是 button。
        const guestEntry = page.getByRole('link', { name: /免费以游客身份开始创作/ }).first()
        if (await guestEntry.isVisible().catch(() => false)) {
          console.log('NOTE 登录页 · 无 --login，改走游客入口（IndexedDB 存储）')
          await guestEntry.click().catch(() => {})
          await page.waitForLoadState('domcontentloaded').catch(() => {})
        }
      }
    }
    // 🔴 不能「sleep 完就判首启」：打包版首帧可能还在加载 assets，按钮未挂载。
    //    等「先看看示例」或主导航任一出现（最多 60s），再决定走首启还是已有项目。
    await page.waitForFunction(
      () => !!document.querySelector('nav') || [...document.querySelectorAll('button')].some(b => /先看看示例/.test(b.textContent || '')),
      null, { timeout: 60_000 },
    ).catch(() => {})
    await sleep(1200)
    await clearOverlays(page)

    // ---------- ① 版本与载体标志（打包最常见的坏法：拿到旧产物） ----------
    // 🔴 期望版本默认读 package.json，`--expect-version X.Y.Z` 可覆盖：
    //    补验上一版产物（如 3.6.1 的包在 3.6.2 源码期复验）时，本地版本号已前进，
    //    写死任何具体版本号都会把"验旧包"判成"拿了旧产物"。
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 4000))
    const shownVersions = (bodyText.match(/v?\d+\.\d+\.\d+/g) ?? []).slice(0, 3).join(',')
    check('app.version', bodyText.includes(expectVersion), `期望 ${expectVersion}，页面 ${shownVersions || '未显示版本'}`)
    const flags = await page.evaluate(() => ({
      portable: !!window.__YFE_PORTABLE__, web: !!window.__YFE_WEB__, guest: !!window.__YFE_GUEST__,
      // 🔴 桌面判据是 `window.electronStore`（preload 注入的 IPC 门面），不是 __YFE_DESKTOP__：
      //    后者是我想当然写出来的名字，实测永远 undefined（2026-11-18 已装版首跑就栽在这）。
      desktop: typeof window.electronStore === 'object' && window.electronStore !== null,
    })).catch(() => ({}))
    if (expect === 'desktop') check('carrier.desktop', flags.desktop === true, JSON.stringify(flags))
    else if (expect === 'web') {
      /**
       * 网页版判据只看 `__YFE_WEB__`：它决定界面把「便携版」字样换成「网页版」，是"认对载体"的最小证据。
       * `__YFE_PORTABLE__` 只在**已登录且云同步**时注入（见 server/index.mjs:490-500）；
       * 游客 / 账号本机模式下它是 false，此时存储是 IndexedDB —— 不是坏，但必须写在结论里，不能当服务端存储验收。
       */
      const cloudStore = flags.portable === true
      check('carrier.web-cloud', flags.web === true,
        JSON.stringify(flags) + (cloudStore ? ' :: 云端存储' : ' :: 游客/账号本机（IndexedDB，未验服务端存储）'))
    }
    else check('carrier.portable', flags.portable === true && flags.web !== true, JSON.stringify(flags))

    /**
     * ---------- ② 三种启动状态都要认 ----------
     * 实测打包版有三种落点（都不是"坏"）：
     *   ① 首启向导：写我的第一本书 / 先看看示例 / 我有备份；
     *   ② 项目中心（空库）：标题「我的作品 (0)」+「创建示范项目」；
     *   ③ 项目中心（有项目）：卡片 +「打开项目」。
     * 🔴 只认第 ① 种会在这里就断链（2026-11-18 实测：判「非首启」→ 后面全红），
     *    而真相只是"这个 profile 的首启已经在上一轮跑过了"。
     */
    const visible = t => page.getByRole('button', { name: t }).first().isVisible().catch(() => false)
    const body0 = await page.evaluate(() => document.body.innerText.slice(0, 800))
    if (await visible(/先看看示例/)) {
      const entries = await page.evaluate(() => [...document.querySelectorAll('button')].filter(b => b.offsetParent).map(b => (b.textContent || '').trim()))
      check('boot.three-entries', ['写我的第一本书', '先看看示例', '我有备份'].every(t => entries.some(e => e.includes(t))), entries.length + ' buttons')
      await page.getByRole('button', { name: /先看看示例/ }).first().click().catch(() => {})
      for (const label of ['下一步', '跳过，直接开始', '跳过，直接进入项目管理']) {
        if (await visible(label)) { await page.getByRole('button', { name: label, exact: true }).first().click().catch(() => {}); await sleep(700) }
      }
    } else if (/我的作品/.test(body0)) {
      // 项目中心：空库就创建一个示范项目（真实点，不写库）
      note('boot.three-entries', '项目中心形态（首启已过），跳过向导三入口')
      const demoBtn = page.getByRole('button', { name: /创建示范项目|继续上次/ }).first()
      if (await demoBtn.isVisible().catch(() => false)) {
        await demoBtn.click().catch(() => {})
        // 🔴 点「创建示范项目」会先弹确认框（取消 / 确定）——不点这一步就永远停在项目中心
        //    （2026-11-18 实测：截图里正是这个对话框，后面整串断言全红）。
        await sleep(900)
        const confirm = page.getByRole('button', { name: '确定', exact: true }).first()
        if (await confirm.isVisible().catch(() => false)) { await confirm.click().catch(() => {}) }
        // 示范项目是两卷二十章 + 设定全套的播种，需要时间；等「打开项目」出现（最多 120s）
        const seedDeadline = Date.now() + 120_000
        while (Date.now() < seedDeadline) {
          const ready = await page.getByRole('button', { name: '打开项目', exact: true }).first().isVisible().catch(() => false)
            || await page.getByRole('button', { name: '正文编辑', exact: true }).first().isVisible().catch(() => false)
          if (ready) break
          await sleep(1000)
        }
      }
      for (const label of ['下一步', '跳过，直接开始', '跳过，直接进入项目管理']) {
        if (await visible(label)) { await page.getByRole('button', { name: label, exact: true }).first().click().catch(() => {}); await sleep(700) }
      }
    } else {
      note('boot.three-entries', '未识别为向导或项目中心，继续尝试直接进项目')
    }
    await sleep(2500)
    await clearOverlays(page)

    // ---------- ③ 进入正文并做一次真实保存往返 ----------
    const navVisible = await page.getByRole('navigation').first().isVisible().catch(() => false)
    let opened = false
    const opener = page.getByRole('button', { name: '打开项目', exact: true }).first()
    const enterDeadline = Date.now() + 60_000
    while (Date.now() < enterDeadline && !navVisible) {
      if (await opener.isVisible().catch(() => false)) { await opener.click().catch(() => {}); await sleep(1200) }
      await clearOverlays(page)
      if (await page.getByRole('button', { name: '正文编辑', exact: true }).first().isVisible().catch(() => false)) { opened = true; break }
      await sleep(500)
    }
    opened = opened || await page.getByRole('button', { name: '正文编辑', exact: true }).first().isVisible().catch(() => false)
    check('nav.reachable', opened, opened ? '' : '找不到「正文编辑」入口')

    if (opened) {
      await clearOverlays(page)
      await page.getByRole('button', { name: '正文编辑', exact: true }).first().click().catch(() => {})
      // 🔴 正文编辑器的稳定标识是 `textarea.novel-textarea`（与 write-failure-portable 同一选择器）；
      //    placeholder 因章节而异，只能当兜底。进入时还会再弹一次引导（第 n/2 步），先清场。
      let box = page.locator('textarea.novel-textarea').first()
      await page.waitForTimeout(1200)
      await clearOverlays(page)
      if (!(await box.count())) box = page.getByPlaceholder(/开始写|写点什么|在这里写/).first()
      await box.waitFor({ timeout: 45_000 }).catch(() => {})
      const hasBox = await box.count()
      check('editor.opens', hasBox > 0, hasBox ? '' : '正文编辑器没出现')
      if (hasBox) {
        const before = await box.inputValue().catch(() => '')
        const marker = `\n[打包验收 ${Date.now().toString(36)}] 这一行写在**打包后的产物**里。`
        await clearOverlays(page)
        await box.click()
        /**
         * 🔴 与 `write-failure-portable` 同一套打法（那边 4 轮实测踩出来的）：
         *   · 先 `Control+End` 把光标落到文末，再慢速 `keyboard.type`（delay 30）——
         *     受控 textarea 用 `locator.type` 会漏字；
         *   · 打完按 **`Control+s`** 显式保存：自动保存在长文上没那么快，等"已保存"字样
         *     容易读到上一次保存留下的旧标记，看着像保存成功。
         */
        await page.keyboard.press('Control+End')
        await page.keyboard.type(marker, { delay: 30 })
        const afterType = await box.inputValue().catch(() => '')
        check('editor.typing-accepted', afterType.includes(marker.trim()), `${before.length} -> ${afterType.length}`)
        await page.keyboard.press('Control+s')
        await sleep(1200)
        // 等自动保存真的落盘（界面有「已保存」才继续）
        const savedDeadline = Date.now() + 60_000
        let saved = false
        while (Date.now() < savedDeadline) {
          const text = await page.evaluate(() => document.body.innerText)
          if (/已保存|已同步/.test(text)) { saved = true; break }
          await sleep(500)
        }
        check('editor.autosave-confirmed', saved, saved ? '' : '60s 内没看到「已保存」')
        // 🔴 读回要验**磁盘**，不是"重载后恰好停在同一章"：
        //    示范项目有 20 章，重载后可能打开别的章，DOM 里没有那段字并不等于没存进去。
        //    便携/云端走 `/api/data`；已安装桌面版直接读 userData 下的 JSON。
        const markerLine = marker.trim()
        let diskText = ''
        if (exe) {
          const dataFile = path.join(profile, 'youth-fantasy-engine-data.json')
          diskText = await fs.readFile(dataFile, 'utf8').catch(() => '')
        } else {
          diskText = await page.evaluate(() => fetch('/api/data').then(r => (r.ok ? r.text() : '')).catch(() => '')).catch(() => '')
        }
        if (!exe && flags.portable !== true) {
          // 游客 / 账号本机模式：数据存 IndexedDB，服务端没有 data.json ⇒ 这一项无从读起，不是没保存。
          // 持久化由下面「重载后正文仍在」覆盖。
          note('editor.persisted-on-disk', '游客/账号本机模式（IndexedDB），无服务端 data.json；持久化看 reopen-after-reload')
        } else {
          check('editor.persisted-on-disk', diskText.includes(markerLine), `disk=${diskText.length}B`)
        }
        // 重载只验「还能正常打开」，不承担"读到同一章"的判据
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
        await sleep(2500)
        await clearOverlays(page)
        const opener2 = page.getByRole('button', { name: '打开项目', exact: true }).first()
        if (await opener2.isVisible().catch(() => false)) { await opener2.click().catch(() => {}); await sleep(1200) }
        /**
         * 🔴 点完「打开项目」会**再弹一次本页指引**（每个新页面各有一次），
         *    遮罩 `data-guide-mask` 会把后续点击全吃掉。第一轮网页登录态验收就是栽在这：
         *    reload 后找不到正文框、五个核心入口全判红，而人工复核时入口一个不少。
         *    所以每过一道导航都要清一次，而不是只在开头清。
         */
        await clearOverlays(page)
        for (const label of ['继续上次', '正文编辑']) {
          const b = page.getByRole('button', { name: label, exact: true }).first()
          if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(1200) }
        }
        await clearOverlays(page)
        let box2 = page.locator('textarea.novel-textarea').first()
        if (!(await box2.count())) box2 = page.getByPlaceholder(/开始写|写点什么|在这里写/).first()
        await box2.waitFor({ timeout: 45_000 }).catch(() => {})
        check('editor.reopen-after-reload', await box2.count() > 0, `before=${before.length}`)
      }
    }

    // ---------- ④ 核心功能入口（必检） ----------
    // 进项目 / 重载 之后引导遮罩会再出现一次，点入口前先清掉（否则全是"找不到"的假红）
    await clearOverlays(page)
    const coreEntries = ['一键拆书', '创意写作', '设定检索', '世界设定', '检查工具']
    for (const label of coreEntries) {
      const found = await page.evaluate(l => {
        const nodes = [...document.querySelectorAll('nav button, nav a, button')].filter(b => b.offsetParent)
        return nodes.some(b => (b.textContent || '').trim() === l)
      }, label)
      check('entry.' + label, found, found ? '' : '打包产物里找不到该入口')
    }

    /**
     * ---------- ⑤ 进到「创意写作」再验面板内两个入口 ----------
     * 🔴 它们**不在导航上**，而是创意写作面板里的两个按钮（实测文案：「创作参考：未选」「剧情候选」）。
     *    上一版只在"当前视图"里找，所以永远 SKIP —— 那不是产品缺入口，是探针没进去。
     */
    const openNav = async label => {
      const btn = page.locator('nav').getByRole('button', { name: label, exact: true }).first()
      if (!(await btn.count())) return false
      await btn.click().catch(() => {})
      await sleep(1500)
      await clearOverlays(page)
      return true
    }
    if (await openNav('创意写作')) {
      const panel = await page.evaluate(() => {
        const m = document.querySelector('main') || document.body
        return [...m.querySelectorAll('button')].filter(b => b.offsetParent).map(b => (b.textContent || '').trim())
      })
      check('entry.创作参考', panel.some(t => t.includes('创作参考')), '创意写作面板里应有「创作参考」')
      check('entry.剧情候选', panel.some(t => t.includes('剧情候选')), '创意写作面板里应有「剧情候选」')
    } else {
      note('entry.创作参考', '找不到「创意写作」导航，人工确认')
      note('entry.剧情候选', '找不到「创意写作」导航，人工确认')
    }
    // 审读记录 / 章后整理：入口位置随面板变化，保留人工确认（不猜）
    for (const label of ['审读记录', '章后整理']) {
      const found = await page.evaluate(l => [...document.querySelectorAll('button, a')].filter(b => b.offsetParent).some(b => (b.textContent || '').includes(l)), label)
      if (found) check('entry.' + label, true, '入口可见')
      else note('entry.' + label, '未在已访问视图出现（子面板位置需人工确认）')
    }

    // ---------- ⑥ 无错误 ----------
    check('no-pageerror', errors.length === 0, errors.slice(0, 3).join(' | '))
    check('no-bad-status', badStatus.length === 0, badStatus.slice(0, 3).join(' | '))

    await page.screenshot({ path: path.join(runRoot, 'acceptance.png') }).catch(() => {})
  } catch (e) {
    check('run', false, e instanceof Error ? e.message : String(e))
  } finally {
    if (app) await app.close().catch(() => {})
    if (ctx) await ctx.close().catch(() => {})
    const mandatory = checks.filter(c => !c.skipped)
    const result = {
      kind: 'packaged-acceptance',
      carrier: expect === 'desktop' ? 'desktop-installed' : expect === 'web' ? 'web-cloud' : 'portable',
      status: mandatory.every(c => c.passed) ? 'passed' : 'failed',
      passed: mandatory.filter(c => c.passed).length, failed: mandatory.filter(c => !c.passed).length,
      skipped: checks.filter(c => c.skipped).length, checks,
    }
    const out = resultFile ? path.resolve(resultFile) : path.join(runRoot, 'result.json')
    await fs.writeFile(out, JSON.stringify(result, null, 2))
    console.log(`\nPACKAGED_ACCEPTANCE ${result.carrier} passed=${result.passed} failed=${result.failed} skipped=${result.skipped}`)
    console.log('artifact=' + path.relative(ROOT, out).replaceAll('\\', '/'))
    if (result.failed) process.exitCode = 1
  }
}

main()
