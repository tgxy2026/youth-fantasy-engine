// 3.4.0 · 整页纵切（深度版）：A/B/C 核心往返 + 刷新 / 切项目 / 删章回来（含回收站恢复）
//
// 用法：
//   node scripts/verify/app-slice-340-deep.mjs                      # 网页形态（Chromium + Vite 开发服务器）
//   node scripts/verify/app-slice-340-deep.mjs --surface=desktop    # 桌面壳（Electron 开发态 + 文件后端）
//   node scripts/verify/app-slice-340-deep.mjs --surface=portable   # 便携服务形态（dist + portable-server，先 npm run build）
//
// 🔴 只覆盖「真实应用页面 + 真实存储」；
//    桌面壳用开发服务器加载、便携用 dist + 本地服务，都不等于安装包 / 便携 exe 验收。
import { createServer } from 'vite'
import { chromium, _electron } from 'playwright'
import { mkdtemp, mkdir, writeFile, cp } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const ROOT = process.cwd()
const argSurface = process.argv.find(a => a.startsWith('--surface='))?.slice('--surface='.length)
const surface = argSurface === 'desktop' || argSurface === 'portable' ? argSurface : 'web'
const run = await mkdtemp(path.join(ROOT, '.workbuddy/tmp/app-slice-deep-340-'))
let server
let portable
let browser
let app
let page
const checks = []
const check = (id, ok, detail = '') => {
  checks.push({ id, ok: !!ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok || !detail ? '' : ` :: ${detail}`))
  if (!ok) throw new Error(`${id}${detail ? ' :: ' + detail : ''}`)
}

/** 关掉可能出现的「稍后再说」引导提示 */
const dismissLater = async () => {
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
}

/** 从项目列表打开示例项目 */
const openSampleFromHub = async () => {
  const card = page.locator('[data-project-card]').filter({ hasText: '吞天神脉' })
  await card.waitFor({ timeout: 60000 })
  await card.getByLabel('打开项目').click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  await dismissLater()
}

/** 首启向导进入示例项目 */
const enterSampleViaWizard = async () => {
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  await dismissLater()
}

/** 打开写作面板 */
const openWriting = async () => {
  await page.getByRole('navigation').getByRole('button', { name: '写作面板', exact: true }).click()
  await page.getByRole('button', { name: /章节规划板/ }).waitFor({ timeout: 30000 })
}

try {
  let url
  if (surface === 'portable') {
    // 便携服务形态：dist + scripts/portable-server.mjs（先 `npm run build`）。
    // 🔴 这不是打包后的便携 exe：只验证「构建产物 + 便携本地服务 + 文件落盘」这一层。
    const appRoot = path.join(run, 'app')
    await mkdir(appRoot)
    await cp(path.join(ROOT, 'dist'), path.join(appRoot, 'dist'), { recursive: true })
    const port = 8899
    portable = spawn(process.execPath, [path.join(ROOT, 'scripts/portable-server.mjs'), '--root', appRoot, '--no-open', '--port', String(port)], { stdio: 'ignore' })
    url = `http://127.0.0.1:${port}`
    let ready = false
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (r.ok) { ready = true; break } } catch { /* 还没起来 */ }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!ready) throw new Error('便携服务没有在 30s 内就绪')
  } else {
    server = await createServer({
      cacheDir: path.join(run, 'vite'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    url = `http://127.0.0.1:${server.httpServer.address().port}`
  }

  if (surface === 'desktop') {
    const profile = path.join(run, 'profile')
    const appData = path.join(run, 'appdata')
    await mkdir(profile)
    await mkdir(appData)
    await writeFile(path.join(run, 'package.json'), JSON.stringify({ name: 'yfe-app-slice', version: '3.4.0', main: 'bootstrap.cjs' }))
    await writeFile(
      path.join(run, 'bootstrap.cjs'),
      `const {app}=require('electron');app.setPath('appData',${JSON.stringify(appData)});require(${JSON.stringify(path.join(ROOT, 'electron/main.cjs'))});`,
    )
    app = await _electron.launch({
      executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
      args: [run, '--no-sandbox', '--no-proxy-server', '--user-data-dir=' + profile],
      env: { ...process.env, ELECTRON_START_URL: url },
      timeout: 90000,
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(20000)
  } else {
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  }

  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => localStorage.setItem('yfe-ui:guide-auto', '0'))
  await page.goto(url, { waitUntil: 'domcontentloaded' })

  // ---- 进入示例项目 ----
  await enterSampleViaWizard()
  const nav = page.getByRole('navigation')

  // ---- A：规划板筛选 ----
  const board = page.getByRole('button', { name: /章节规划板/ })
  await board.waitFor({ timeout: 30000 })
  await board.click()
  const search = page.getByLabel('搜索章节标题或摘要')
  await search.waitFor()
  const volumeSelect = page.getByLabel('筛选分卷')
  const volumeOptions = await volumeSelect.locator('option').evaluateAll(opts => opts.map(o => ({ value: o.value, label: o.textContent || '' })))
  check('规划板有分卷筛选选项', volumeOptions.length > 1, JSON.stringify(volumeOptions))

  const cards = page.locator('[data-board-card]')
  const firstTitle = (await cards.first().innerText()).split('\n')[0].trim()
  if (!firstTitle) throw new Error('规划板没有可点章节')
  const keyword = firstTitle.slice(0, Math.min(2, firstTitle.length))
  await search.fill(keyword)
  const pickedVolume = volumeOptions[1]
  await volumeSelect.selectOption(pickedVolume.value)
  const filteredCount = await cards.count()
  if (filteredCount === 0) await volumeSelect.selectOption('all')
  const expectedVolume = filteredCount === 0 ? 'all' : pickedVolume.value
  const beforeCount = await cards.count()
  check('筛选后仍有章节可进入', beforeCount > 0, `count=${beforeCount}`)

  // ---- A：进章 ----
  const openedId = await cards.first().getAttribute('data-board-card')
  const openedTitle = (await cards.first().innerText()).split('\n')[0].trim()
  await cards.first().click()
  await page.getByPlaceholder(/自动保存已开启/).waitFor({ timeout: 30000 })

  // ---- A：返回写作面板，筛选与展开必须还在 ----
  await openWriting()
  await search.waitFor({ timeout: 30000 })
  check('返回后规划板仍是展开的', await search.isVisible())
  check('返回后关键词筛选被恢复', (await search.inputValue()) === keyword, `value=${await search.inputValue()}`)
  check('返回后分卷筛选被恢复', (await volumeSelect.inputValue()) === expectedVolume, `value=${await volumeSelect.inputValue()}`)
  const restoredIds = await cards.evaluateAll(els => els.map(el => el.getAttribute('data-board-card')))
  check('返回后仍按同一条件筛出章节', restoredIds.length > 0 && restoredIds.includes(openedId), `ids=${restoredIds.length}`)

  // ---- B：本章资料抽屉（Esc 收起 + 焦点回入口） ----
  await nav.getByRole('button', { name: '正文编辑', exact: true }).click()
  await page.getByPlaceholder(/自动保存已开启/).waitFor({ timeout: 30000 })
  await page.getByTitle(/^本章资料/).click()
  const drawer = page.getByRole('region', { name: '本章资料' })
  await drawer.waitFor({ timeout: 15000 })
  check('本章资料抽屉可打开', await drawer.isVisible())
  await page.keyboard.press('Escape')
  await drawer.waitFor({ state: 'hidden', timeout: 10000 })
  check('Esc 能收起本章资料', await drawer.isHidden())
  check('收起后焦点回到「本章资料」入口', await page.evaluate(() => document.activeElement?.hasAttribute('data-refs-trigger')))

  // ---- C：时光机命名快照（真实写入） ----
  await page.getByRole('button', { name: '编辑工具', exact: true }).click()
  await page.getByRole('button', { name: /时光机 · 版本历史/ }).click()
  await page.getByLabel('快照名称').fill('纵切测试快照')
  await page.getByLabel('快照备注').fill('app-slice-340-deep 自动写入')
  await page.getByRole('button', { name: '保存命名快照' }).click()
  await page.getByText('命名快照已保存。').waitFor({ timeout: 15000 })
  await page.getByText('纵切测试快照').first().waitFor({ timeout: 10000 })
  check('命名快照保存后出现在列表里', true)
  await page.keyboard.press('Escape')
  await page.getByText('纵切测试快照').first().waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {})

  // ================= 深度项 1：刷新后规划板状态仍在 =================
  // 先回写作面板，等防抖把状态落一次本机偏好，再整页刷新。
  await openWriting()
  await search.waitFor()
  await page.waitForTimeout(700)
  await page.reload({ waitUntil: 'domcontentloaded' })
  // 启动默认停在项目列表（2.4.0 起不自动打开上次项目）
  await page.locator('[data-project-hub]').waitFor({ timeout: 60000 })
  check('刷新后回到项目列表（不自动打开上次项目）', true)
  await openSampleFromHub()
  await openWriting()
  await search.waitFor({ timeout: 30000 })
  check('刷新重进后规划板仍是展开的', await search.isVisible())
  check('刷新重进后关键词筛选被恢复', (await search.inputValue()) === keyword, `value=${await search.inputValue()}`)
  check('刷新重进后分卷筛选被恢复', (await volumeSelect.inputValue()) === expectedVolume, `value=${await volumeSelect.inputValue()}`)

  // ================= 深度项 2：切项目不串筛选 =================
  await page.getByTitle('返回项目列表').click()
  await page.locator('[data-project-hub]').waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: /新建小说项目/ }).click()
  await page.locator('#create-project-name').fill('纵切第二项目')
  await page.getByRole('button', { name: '创建并进入项目' }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  await dismissLater()
  await openWriting()
  const board2 = page.getByRole('button', { name: /章节规划板/ })
  await board2.click()
  const search2 = page.getByLabel('搜索章节标题或摘要')
  await search2.waitFor()
  const volumeSelect2 = page.getByLabel('筛选分卷')
  check('新项目规划板展开后没有继承旧关键词', (await search2.inputValue()) === '', `value=${await search2.inputValue()}`)
  check('新项目规划板没有继承旧分卷', (await volumeSelect2.inputValue()) === 'all', `value=${await volumeSelect2.inputValue()}`)

  // 回示例项目：原筛选必须还在
  await page.getByTitle('返回项目列表').click()
  await page.locator('[data-project-hub]').waitFor({ timeout: 30000 })
  await openSampleFromHub()
  await openWriting()
  await search.waitFor({ timeout: 30000 })
  check('切回示例项目后关键词筛选仍在', (await search.inputValue()) === keyword, `value=${await search.inputValue()}`)
  check('切回示例项目后分卷筛选仍在', (await volumeSelect.inputValue()) === expectedVolume, `value=${await volumeSelect.inputValue()}`)

  // ================= 深度项 3：删章回来 / 回收站恢复 =================
  const victimTitle = openedTitle
  const targetCard = page.locator(`[data-board-card="${openedId}"]`)
  await targetCard.waitFor({ timeout: 15000 })
  await targetCard.click()
  await page.getByPlaceholder(/自动保存已开启/).waitFor({ timeout: 30000 })
  const rowTitle = page.locator('span[title^="双击改章名"]').filter({ hasText: victimTitle }).first()
  await rowTitle.waitFor({ timeout: 15000 })
  await rowTitle.locator('..').hover()
  await rowTitle.locator('..').getByLabel('删除该章节').click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await rowTitle.waitFor({ state: 'detached', timeout: 20000 })
  check('删除后章节树里该章已消失', true)
  await openWriting()
  const notice = page.getByText(/已不在项目中/)
  await notice.waitFor({ timeout: 20000 }).catch(async () => {
    console.log('DEBUG 删章回来页面文本:', (await page.locator('body').innerText()).slice(0, 1200))
    throw new Error('删章回来没有出现锚点失效提示')
  })
  check('删章后回规划板会明确提示目标已不在', true)
  check('删章后筛选条件仍保留', (await search.inputValue()) === keyword, `value=${await search.inputValue()}`)
  const goneCount = await cards.count()
  check('被删章节不再出现在规划板卡片里', goneCount < beforeCount, `before=${beforeCount} after=${goneCount}`)

  // 回收站恢复，确认章节回到规划板
  await nav.getByRole('button', { name: '正文编辑', exact: true }).click()
  await page.getByPlaceholder(/自动保存已开启/).waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: '编辑工具', exact: true }).click()
  await page.getByRole('button', { name: /回收站/ }).click()
  const trashRow = page.getByText(victimTitle, { exact: true }).first()
  await trashRow.waitFor({ timeout: 15000 })
  // 结构：外层行 → 左侧信息块 → 标题文本；恢复按钮在外层行里，往上两层。
  await trashRow.locator('xpath=../..').getByRole('button', { name: '恢复', exact: true }).click()
  await page.keyboard.press('Escape')
  await openWriting()
  await search.waitFor({ timeout: 30000 })
  const backIds = await cards.evaluateAll(els => els.map(el => el.getAttribute('data-board-card')))
  check('回收站恢复后被删章节重新出现在规划板', backIds.includes(openedId), `ids=${backIds.length}`)
  check('回收站恢复后筛选仍未被改动', (await search.inputValue()) === keyword, `value=${await search.inputValue()}`)

  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`\nPASS ${checks.length} checks · app-slice-340-deep (${surface})`)
} finally {
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  portable?.kill()
  await server?.close().catch(() => {})
}