// 大表热点取证：在**存储边界**上数「打开了多少次、读回多少行」，而不是靠猜。
//
// 为什么单独一支：P0 报告里 `TableRefSelect` 每行都调 `getTableRows(refTabId)` 只是**代码确认的
// 重复读取路径**，还没有调用计数与字节量证据；而 large（1000×74）180 秒等不到首屏，必须先知道
// 「一次打开到底触发多少次整表读取」才谈得上修。
//
// 🔴 纪律：
//   · **不改** `table-performance.mjs` / `table-metrics.mjs` / 夹具模块 —— 它们的指纹被基线冻结，
//     动一个字节就让 compare 判为「测量实现不兼容」。本脚本只读它们导出的东西。
//   · 计数挂在 `IDBObjectStore.prototype`（getAll / getAllFromIndex / get / count / openCursor），
//     只统计**应用自己**发出的请求，不改应用行为、不注入假延迟。
//   · 正式样本只用生产构建 + 真实游客后端 + 真实 IndexedDB；结果写独立 run 目录。
//
// 用法：
//   node scripts/verify/table-hotpath.mjs --fixture medium
//   node scripts/verify/table-hotpath.mjs --fixture large --timeout 300000
//   node scripts/verify/table-hotpath.mjs --fixture medium --build-dir <已构建目录>   # 复用构建，省 1~2 分钟
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { captureInputs, hashPaths } from './evidence.mjs'
import { runProcess } from './process.mjs'
import { generateTableFixture, hash } from './fixtures/table-fixtures.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2))
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); if (i < 0) return fallback; const v = process.argv[i + 1]; if (!v || v.startsWith('--')) throw new Error('--' + name + ' requires a value'); return v }
function bounded(promise, label, ms) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timeout')), ms) })])
    .finally(() => clearTimeout(timer))
}
async function freePort() {
  const s = net.createServer()
  await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve) })
  const p = s.address().port
  await new Promise(resolve => s.close(resolve))
  return p
}

/** 只统计应用发出的 IDB 请求；命中一次就记一次「调用 / 返回行数 / 耗时」 */
function instrument() {
  const stats = { calls: 0, rows: 0, ms: 0, byKey: {}, tableRows: { calls: 0, rows: 0, ms: 0 }, biggest: [], samples: 0, stacks: {}, selfTest: null }
  window.__idbStats = stats
  /**
   * 每次调用都归一次签名（同步取栈）：同一读取键可能有很多调用方（模板缓存未命中、迁移、逐行组件…），
   * 只留前 3 条样本会看到「碰巧第一个」并据此下错结论。
   * 注：开栈有开销 —— 归因跑次的耗时**不能**当性能基线（正式基线仍走 table-performance.mjs）。
   */
  const capture = key => {
    // 只留能区分的帧：跳过 capture / 补丁自身两层
    const frames = String(new Error('idb-read').stack || '').split('\n').slice(3, 9)
      .map(line => line.trim().replace(/https?:\/\/[^/]+\/assets\//, '').replace(/\(<anonymous>.*\)$/, '').slice(0, 90))
      .join(' | ')
    const bucket = stats.stacks[key] ?? (stats.stacks[key] = {})
    bucket[frames] = (bucket[frames] || 0) + 1
  }
  window.__resetIdbStats = () => {
    stats.calls = 0; stats.rows = 0; stats.ms = 0; stats.byKey = {}; stats.tableRows = { calls: 0, rows: 0, ms: 0 }; stats.biggest = []; stats.samples = 0; stats.stacks = {}
  }
  /** 自检：探针自己发一次 getAllFromIndex，确认补丁真的在链路上（不确认就可能把「没数到」当成「没发生」） */
  window.__idbSelfTest = async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('youth-fantasy-engine'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    try {
      const before = stats.calls
      const tx = db.transaction('tableRows', 'readonly')
      await new Promise((resolve, reject) => { const req = tx.objectStore('tableRows').index('tabId').getAll('races'); req.onsuccess = resolve; req.onerror = () => reject(req.error) })
      stats.selfTest = { delta: stats.calls - before }
    } finally { db.close() }
  }
  /**
   * 🔴 只挂 IDBObjectStore 会漏掉大表最关键的一条读取路径：
   *    IndexedDB 标准里 `IDBObjectStore.getAllFromIndex` 已经**移除**，应用（经 idb 封装）走的是
   *    `store.index('tabId').getAll(value)` —— 请求对象是 **IDBIndex**，不是 IDBObjectStore。
   *    第一轮就因此把 tableRows 数成 0（看起来像「根本没读」，其实全在 IDBIndex 那一侧）。
   */
  const patchStore = (method) => {
    const native = IDBObjectStore.prototype[method]
    if (typeof native !== 'function') return
    IDBObjectStore.prototype[method] = function (...args) {
      const store = this.name, started = performance.now()
      // 🔴 栈必须在**调用的那一刻**同步取：放到 success 回调里取到的只是事件派发的栈（上一版就是这么白跑的）
      capture('store.' + method + '@' + store)
      const request = native.apply(this, args)
      request.addEventListener('success', () => {
        const elapsed = performance.now() - started
        const result = request.result
        const rows = Array.isArray(result) ? result.length : (result == null ? 0 : 1)
        stats.calls += 1; stats.rows += rows; stats.ms += elapsed; stats.samples += 1
        const key = method + '@' + store
        const row = stats.byKey[key] ?? (stats.byKey[key] = { calls: 0, rows: 0, ms: 0 })
        row.calls += 1; row.rows += rows; row.ms += elapsed
        if (store === 'tableRows') { stats.tableRows.calls += 1; stats.tableRows.rows += rows; stats.tableRows.ms += elapsed }
        if (rows > 1 && stats.biggest.length < 400) stats.biggest.push({ key, rows, ms: Math.round(elapsed) })
        // 调用栈只取前若干次：够定位「谁在读」，又不会把内存吃光
      })
      return request
    }
  }
  for (const method of ['getAll', 'get', 'count', 'openCursor', 'getAllKeys']) patchStore(method)
  /** 索引侧：`index(name).getAll(q)` 才是应用真正读整表的通道 */
  for (const method of ['getAll', 'get', 'getKey', 'count', 'openCursor', 'getAllKeys']) {
    const native = IDBIndex.prototype[method]
    if (typeof native !== 'function') continue
    IDBIndex.prototype[method] = function (...args) {
      const store = this.objectStore?.name ?? '?', index = this.name
      const started = performance.now()
      capture('index.' + method + '@' + store + '.' + index)
      const request = native.apply(this, args)
      request.addEventListener('success', () => {
        const elapsed = performance.now() - started
        const result = request.result
        const rows = Array.isArray(result) ? result.length : (result == null ? 0 : 1)
        stats.calls += 1; stats.rows += rows; stats.ms += elapsed; stats.samples += 1
        const key = 'index.' + method + '@' + store + '.' + index
        const row = stats.byKey[key] ?? (stats.byKey[key] = { calls: 0, rows: 0, ms: 0 })
        row.calls += 1; row.rows += rows; row.ms += elapsed
        if (store === 'tableRows') { stats.tableRows.calls += 1; stats.tableRows.rows += rows; stats.tableRows.ms += elapsed }
        if (rows > 1 && stats.biggest.length < 400) stats.biggest.push({ key, rows, ms: Math.round(elapsed) })
      })
      return request
    }
  }
}

async function main() {
  const fixtureName = arg('fixture', 'medium')
  const reuseBuild = arg('build-dir', '')
  const output = arg('result-file', '')
  const openTimeout = Number(arg('timeout', '240000'))
  const parent = path.join(ROOT, '.workbuddy/tmp')
  await fs.mkdir(parent, { recursive: true })
  const runRoot = await fs.mkdtemp(path.join(parent, 'table-hotpath-'))
  const inputs = await captureInputs(ROOT)
  const report = { schemaVersion: 1, kind: 'table-hotpath', fixture: fixtureName, backend: 'web-guest', runRoot,
    startedAt: new Date().toISOString(), inputHash: inputs.combined, scope: 'Storage-boundary call/rows counting for one table open; not a timing baseline',
    status: 'failed' }
  let server = null, browser = null, context = null, page = null

  try {
    // 夹具：与 P0 同一份生成器、同一份 schema 门面（不另造数据）
    const bundle = await build({ stdin: { contents: "export { TABS } from './src/lib/schema'; export { atlasColumnsOf } from './src/lib/atlas/columns'", resolveDir: ROOT, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, alias: { '@': path.join(ROOT, 'src') },
      plugins: [{ name: 'fixture-schema-no-storage', setup(b) {
        b.onResolve({ filter: /^@\/lib\/db$/ }, args => args.importer.endsWith('schemaShared.ts') ? { path: 'no-storage', namespace: 'fixture-schema' } : undefined)
        b.onLoad({ filter: /.*/, namespace: 'fixture-schema' }, () => ({ contents: "export async function getAllVolumes() { throw new Error('Fixture schema cannot access storage') }" }))
      } }] })
    const schemaFile = path.join(runRoot, 'fixture-schema.mjs')
    await fs.writeFile(schemaFile, bundle.outputFiles[0].contents)
    const schema = await import(pathToFileURL(schemaFile).href)
    const fixture = generateTableFixture({ tab: schema.TABS.find(t => t.id === 'races'), columnsOf: schema.atlasColumnsOf }, fixtureName)
    await write(path.join(runRoot, 'fixture-manifest.json'), fixture.manifest)
    report.fixtureHash = fixture.manifest.sha256
    report.fixtureRows = fixture.manifest.rows
    report.fixtureColumns = fixture.manifest.columns

    let buildDir
    if (reuseBuild) {
      buildDir = await fs.realpath(path.resolve(reuseBuild))
      await fs.access(path.join(buildDir, 'index.html'))
      report.buildReused = true
    } else {
      buildDir = path.join(runRoot, 'build')
      const built = await runProcess(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', buildDir], { cwd: ROOT, timeoutMs: 180000 })
      await fs.writeFile(path.join(runRoot, 'build.log'), built.out)
      if (!built.ok) throw new Error('Production build failed')
    }
    report.build = await hashPaths(buildDir, ['.'])

    // 真实游客后端：应用自己起服务、自己连 /guest（与 P0 同一套）
    const p = await freePort(), origin = `http://127.0.0.1:${p}`
    const env = { ...process.env, HOST: '127.0.0.1', PORT: String(p), YFE_DATA: path.join(runRoot, 'server-data'), YFE_WWW: buildDir, YFE_REGISTER: 'closed', YFE_BOOTSTRAP_INVITE: '' }
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[key]
    let log = ''
    server = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    server.stdout.on('data', b => { log += b }); server.stderr.on('data', b => { log += b })
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(origin + '/api/ping', { signal: AbortSignal.timeout(500) })).ok) break } catch { /* bounded */ }
      await sleep(100)
    }
    await fs.writeFile(path.join(runRoot, 'server.log'), log)

    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server', '--enable-precise-memory-info'] })
    context = await browser.newContext({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1 })
    await context.addInitScript(() => {
      localStorage.setItem('yfe-ui-zoom', '100')
      localStorage.setItem('yfe-ui-zoom-manual', '1')
      localStorage.setItem('yfe-theme', 'eye-care')
    })
    await context.addInitScript(instrument)
    page = await context.newPage()
    page.setDefaultTimeout(openTimeout)
    const pageErrors = []; report.pageErrors = pageErrors
    page.on('pageerror', e => pageErrors.push(e.message))
    await page.goto(origin + '/guest', { waitUntil: 'load', timeout: 120000 })
    await page.waitForFunction(async () => (await indexedDB.databases()).some(d => d.name === 'youth-fantasy-engine'))
    await bounded(page.evaluate(async stores => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('youth-fantasy-engine'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(Object.keys(stores), 'readwrite')
          tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error)
          for (const [key, rows] of Object.entries(stores)) { const st = tx.objectStore(key); st.clear(); for (const row of rows) st.put(row) }
        })
      } finally { db.close() }
    }, fixture.stores), 'fixture seed', 120000)
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: '打开项目', exact: true }).first().click()
    await page.getByRole('navigation').waitFor()
    for (const label of ['稍后再说', '知道了', '我知道了']) {
      const b = page.getByRole('button', { name: label, exact: true }).first()
      if (await b.isVisible()) await b.click()
    }

    const nav = page.getByRole('navigation')
    const tableButton = nav.getByRole('button', { name: fixture.tab.name, exact: true })
    if (!await tableButton.isVisible()) await nav.getByRole('button', { name: fixture.tab.group, exact: true }).click()
    const column = name => fixture.columns.findIndex(c => c.key === name) + 2
    const cell = name => page.locator('table tbody tr').first().locator('td').nth(column(name)).locator('textarea,input').first()

    // 先自检补丁在链路上，再清零计数：一次「进入表格」= 用户点页签那一下
    report.selfTest = await page.evaluate(async () => { await window.__idbSelfTest(); return window.__idbStats.selfTest })
    await page.evaluate(() => window.__resetIdbStats())
    const startedAt = Date.now()
    await tableButton.click()
    await cell('别称').waitFor({ state: 'visible' })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const openMs = Date.now() - startedAt
    // 效果链（每行 ref 控件的 useEffect）可能比首屏晚一拍，再给 3 秒稳定期
    await sleep(3000)
    report.openMs = openMs
    report.idb = await page.evaluate(() => {
      const s = window.__idbStats
      const stacks = Object.fromEntries(Object.entries(s.stacks).map(([key, value]) => [key,
        Object.entries(value).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([sig, count]) => ({ count, sig }))]))
      const byKey = Object.entries(s.byKey).sort((a, b) => b[1].rows - a[1].rows).map(([key, v]) => ({ key, calls: v.calls, rows: v.rows, ms: Math.round(v.ms) }))
      return { calls: s.calls, rows: s.rows, ms: Math.round(s.ms), tableRows: { calls: s.tableRows.calls, rows: s.tableRows.rows, ms: Math.round(s.tableRows.ms) }, byKey: byKey.slice(0, 12), biggest: s.biggest.slice(0, 40), stacks }
    })
    report.resources = await page.evaluate(() => ({ domNodes: document.querySelectorAll('*').length,
      mountedRows: document.querySelectorAll('table tbody tr').length,
      refSelects: document.querySelectorAll('table tbody tr button').length,
      heapBytes: performance.memory?.usedJSHeapSize ?? null }))
    report.amplification = { rowsReadPerLogicalRow: report.fixtureRows ? Number((report.idb.tableRows.rows / report.fixtureRows).toFixed(1)) : null,
      tableRowCallsPerRow: report.fixtureRows ? Number((report.idb.tableRows.calls / report.fixtureRows).toFixed(2)) : null }
    await page.screenshot({ path: path.join(runRoot, 'table.png') })
    report.status = pageErrors.length === 0 ? 'measured' : 'measured-with-page-errors'
  } catch (e) {
    report.error = String(e.stack ?? e)
    if (page) await page.screenshot({ path: path.join(runRoot, 'failure.png'), timeout: 5000 }).catch(() => {})
  } finally {
    await context?.close().catch(e => { report.cleanupError = String(e) })
    if (server && server.exitCode === null) { const done = new Promise(resolve => server.once('close', resolve)); server.kill(); await Promise.race([done, sleep(5000)]) }
    await browser?.close().catch(e => { report.cleanupError = String(e) })
    report.inputUnchanged = (await captureInputs(ROOT)).combined === inputs.combined
    report.finishedAt = new Date().toISOString()
    await write(path.join(runRoot, 'hotpath.json'), report)
    if (output) await write(path.resolve(output), report)
  }
  console.log('TABLE_HOTPATH ' + JSON.stringify({ status: report.status, fixture: report.fixture, openMs: report.openMs,
    tableRowCalls: report.idb?.tableRows.calls, tableRowRowsRead: report.idb?.tableRows.rows, amplification: report.amplification,
    runRoot: report.runRoot, error: report.error ? report.error.split('\n')[0] : undefined }))
  if (report.status !== 'measured') process.exitCode = 1
}
main().catch(e => { console.error(e); process.exitCode = 1 })
