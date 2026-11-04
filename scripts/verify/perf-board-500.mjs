// 3.4.0 · 规划板 500 章夹具性能测量
//
// 目的：按 `docs/3.4.0-开发规划-2026-11-04.md` §复核补充「可用性和性能」，
//       在同一台机器、同一份夹具上记录：打开规划板 / 筛选 / 进章 / 返回恢复、
//       JS 堆内存、长任务数量与总时长。
//
// 用法：
//   node scripts/verify/perf-board-500.mjs                              # 网页形态（Vite + Chromium + IndexedDB）
//   node scripts/verify/perf-board-500.mjs --surface=desktop            # Electron 开发态 + 文件后端
//   node scripts/verify/perf-board-500.mjs --surface=portable           # dist + portable-server（先 npm run build）
//   node scripts/verify/perf-board-500.mjs --label=f1d28a3              # 写入结果里的版本标签
//
// 🔴 各运行面结果**分别记录、不混在一起比较**：窗口尺寸、文件后端与浏览器内存口径不同。
import { createServer } from 'vite'
import { chromium, _electron } from 'playwright'
import { mkdtemp, mkdir, writeFile, cp } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const ROOT = process.cwd()
const argSurface = process.argv.find(a => a.startsWith('--surface='))?.slice('--surface='.length)
const surface = argSurface === 'desktop' || argSurface === 'portable' ? argSurface : 'web'
const label = process.argv.find(a => a.startsWith('--label='))?.slice('--label='.length) || `current-${surface}`
const run = await mkdtemp(path.join(ROOT, '.workbuddy/tmp/perf-board-500-'))
const VOLUMES = 10
const CHAPTERS_PER_VOLUME = 50
const TOTAL = VOLUMES * CHAPTERS_PER_VOLUME

let server
let portable
let browser
let app
let page
const report = { label, surface, totalChapters: TOTAL, startedAt: new Date().toISOString(), steps: {} }
const errors = []

try {
  let url
  if (surface === 'portable') {
    const appRoot = path.join(run, 'app')
    await mkdir(appRoot)
    await cp(path.join(ROOT, 'dist'), path.join(appRoot, 'dist'), { recursive: true })
    const port = 8905
    portable = spawn(process.execPath, [path.join(ROOT, 'scripts/portable-server.mjs'), '--root', appRoot, '--no-open', '--port', String(port)], { stdio: 'ignore' })
    url = `http://127.0.0.1:${port}`
    let ready = false
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (r.ok) { ready = true; break } } catch { /* 等待启动 */ }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!ready) throw new Error('便携服务没有在 30s 内就绪')
  } else {
    server = await createServer({ cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
    await server.listen()
    url = `http://127.0.0.1:${server.httpServer.address().port}`
  }

  if (surface === 'desktop') {
    const profile = path.join(run, 'profile')
    const appData = path.join(run, 'appdata')
    await mkdir(profile)
    await mkdir(appData)
    await writeFile(path.join(run, 'package.json'), JSON.stringify({ name: 'yfe-perf', version: '3.4.0', main: 'bootstrap.cjs' }))
    await writeFile(path.join(run, 'bootstrap.cjs'), `const {app}=require('electron');app.setPath('appData',${JSON.stringify(appData)});require(${JSON.stringify(path.join(ROOT, 'electron/main.cjs'))});`)
    app = await _electron.launch({
      executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
      args: [run, '--no-sandbox', '--no-proxy-server', '--user-data-dir=' + profile],
      env: { ...process.env, ELECTRON_START_URL: url },
      timeout: 90000,
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(30000)
  } else {
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  }
  page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => localStorage.setItem('yfe-ui:guide-auto', '0'))
  await page.goto(url, { waitUntil: 'domcontentloaded' })

  // ---- 建一个空项目（首启向导可整步跳过） ----
  const skipWizard = page.getByRole('button', { name: '跳过，直接进入项目管理' })
  await skipWizard.waitFor({ timeout: 60000 }).catch(() => {})
  if (await skipWizard.isVisible().catch(() => false)) await skipWizard.click()
  await page.locator('[data-project-hub]').waitFor({ timeout: 60000 }).catch(async () => {
    console.log('DEBUG 首启页面文本:', (await page.locator('body').innerText()).slice(0, 800))
    throw new Error('没有进入项目列表')
  })
  await page.getByRole('button', { name: /新建小说项目/ }).click()
  await page.locator('#create-project-name').fill('性能夹具500')
  await page.getByRole('button', { name: '创建并进入项目' }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()

  // ---- 批量写入 10 卷 × 50 章 ----
  const seedStart = Date.now()
  const seeded = await page.evaluate(async ({ volumes, perVolume }) => {
    const db = await import('/src/lib/db.ts')
    const pid = db.getCurrentProjectId()
    if (!pid) throw new Error('当前项目 id 为空')
    const now = Date.now()
    const ids = []
    for (let v = 1; v <= volumes; v++) {
      const vid = crypto.randomUUID()
      await db.saveVolume({
        id: vid, projectId: pid, order: v - 1, title: `第${v}卷 夹具卷`,
        description: `性能夹具第${v}卷`, createdAt: now,
      })
      for (let i = 1; i <= perVolume; i++) {
        const id = crypto.randomUUID()
        ids.push(id)
        const text = `第${v}卷第${i}章正文。`.repeat(20) // 约 240 字，避免夹具过大
        await db.saveChapter({
          id, projectId: pid, volumeId: vid, order: i - 1,
          title: `第${v}卷 第${i}章 夹具章节`,
          content: text,
          summary: `第${v}卷第${i}章摘要：用于规划板性能测量的隔离数据。`,
          status: ['构思', '细纲', '草稿', '修改', '完稿', '已发布'][(i + v) % 6],
          wordCount: text.length,
          createdAt: now, updatedAt: now,
        })
      }
    }
    return { pid, count: ids.length }
  }, { volumes: VOLUMES, perVolume: CHAPTERS_PER_VOLUME })
  report.seeded = { ...seeded, ms: Date.now() - seedStart }

  // ---- 重新加载，确保从库里读到 500 章 ----
  // 便携后端是整库 JSON 落盘，给防抖写入留出时间。
  if (surface === 'portable') await page.waitForTimeout(3000)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-project-hub]').waitFor({ timeout: 60000 })
  const card = page.locator('[data-project-card]').filter({ hasText: '性能夹具500' })
  await card.getByLabel('打开项目').click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  const later2 = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later2.isVisible().catch(() => false)) await later2.click()

  // ---- 准备长任务观察器 + 内存采集 ----
  await page.evaluate(() => {
    window.__longTasks = { count: 0, total: 0, max: 0 }
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        window.__longTasks.count++
        window.__longTasks.total += e.duration
        window.__longTasks.max = Math.max(window.__longTasks.max, e.duration)
      }
    }).observe({ type: 'longtask', buffered: false })
  })
  const cdp = await page.context().newCDPSession(page)
  const heapMB = async () => {
    try { await cdp.send('HeapProfiler.collectGarbage') } catch { /* 不支持时按当前值 */ }
    const { usedJSHeapSize } = await page.evaluate(() => ({ usedJSHeapSize: performance.memory?.usedJSHeapSize ?? 0 }))
    return Math.round((usedJSHeapSize / 1048576) * 10) / 10
  }
  const resetLong = () => page.evaluate(() => { window.__longTasks = { count: 0, total: 0, max: 0 } })
  const readLong = () => page.evaluate(() => ({ ...window.__longTasks, total: Math.round(window.__longTasks.total) }))

  const now = () => page.evaluate(() => performance.now())
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))

  report.steps.heapAfterLoad = await heapMB()

  // 进入写作面板（Dashboard 读 500 章）
  const nav = page.getByRole('navigation')
  let t0 = await now()
  await nav.getByRole('button', { name: '写作面板', exact: true }).click()
  await page.getByRole('button', { name: /章节规划板/ }).waitFor({ timeout: 60000 })
  await settle()
  report.steps.openWritingPanelMs = Math.round((await now()) - t0)

  // 打开规划板：首批 60 张卡渲染完成
  const cards = page.locator('[data-board-card]')
  await resetLong()
  t0 = await now()
  await page.getByRole('button', { name: /章节规划板/ }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-board-card]').length === 60, undefined, { timeout: 60000 })
  await settle()
  report.steps.openBoardMs = Math.round((await now()) - t0)
  report.steps.openBoardLongTasks = await readLong()
  report.steps.heapBoardOpen = await heapMB()

  // 筛选：关键词包含 50 章
  const search = page.getByLabel('搜索章节标题或摘要')
  await resetLong()
  t0 = await now()
  await search.fill('第3卷')
  await page.waitForFunction(() => document.querySelectorAll('[data-board-card]').length === 50, undefined, { timeout: 60000 })
  await settle()
  report.steps.filterMs = Math.round((await now()) - t0)
  report.steps.filterLongTasks = await readLong()

  // 进章：首张卡 → 编辑器可输入
  await resetLong()
  t0 = await now()
  await cards.first().click()
  await page.getByPlaceholder(/自动保存已开启/).waitFor({ timeout: 60000 })
  report.steps.openChapterMs = Math.round((await now()) - t0)
  report.steps.openChapterLongTasks = await readLong()

  // 返回规划板：筛选与首批渲染恢复
  await resetLong()
  t0 = await now()
  await nav.getByRole('button', { name: '写作面板', exact: true }).click()
  await page.getByLabel('搜索章节标题或摘要').waitFor({ timeout: 60000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-board-card]').length === 50, undefined, { timeout: 60000 })
  await settle()
  report.steps.returnToBoardMs = Math.round((await now()) - t0)
  report.steps.returnLongTasks = await readLong()
  report.steps.heapAfterReturn = await heapMB()

  // 继续显示：从 50 抬到全部 500？这里只验一次步长（60 → 120）
  await page.getByLabel('搜索章节标题或摘要').fill('')
  await page.waitForFunction(() => document.querySelectorAll('[data-board-card]').length === 60, undefined, { timeout: 60000 })
  const showMore = page.getByRole('button', { name: /继续显示/ })
  if (await showMore.count()) {
    await resetLong()
    t0 = await now()
    await showMore.first().click()
    await page.waitForFunction(() => document.querySelectorAll('[data-board-card]').length === 120, undefined, { timeout: 60000 })
    await settle()
    report.steps.showMoreMs = Math.round((await now()) - t0)
    report.steps.showMoreLongTasks = await readLong()
  } else {
    report.steps.showMoreMs = null
  }

  report.pageErrors = errors
  report.finishedAt = new Date().toISOString()
  const out = path.join(ROOT, '.workbuddy/tmp', `perf-board-500-${label}.json`)
  await writeFile(out, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  console.log(`\n结果已写入 ${out}`)
} finally {
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  portable?.kill()
  await server?.close().catch(() => {})
}