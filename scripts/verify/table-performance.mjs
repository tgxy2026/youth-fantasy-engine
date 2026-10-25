// P0 production-build baseline. No development server, product test hooks or real libraries.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { captureInputs, hashPaths } from './evidence.mjs'
import { runProcess } from './process.mjs'
import { FIXTURE_NAMES, generateTableFixture, hash } from './fixtures/table-fixtures.mjs'
import { SAMPLE_PLAN, SCROLL_STEP_PX, MEASUREMENT_VERSION, thresholdsFor, REGRESSION_LIMITS, validateSamples, compareBaseline, comparisonKey } from './table-metrics.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2))
async function bounded(promise, label, ms = 180000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timeout')), ms) })]) }
  finally { clearTimeout(timer) }
}
function options(args) {
  const out = { mode: 'measure', backend: 'web-guest', fixture: 'medium,large', profile: 'local' }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2)
    if (!['mode', 'backend', 'fixture', 'profile', 'baseline'].includes(key) || !args[i].startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown/missing option: ' + args[i])
    out[key] = args[i + 1]
  }
  if (!['measure', 'smoke', 'compare'].includes(out.mode) || !['web-guest', 'portable'].includes(out.backend) || out.profile !== 'local') throw new Error('Invalid mode/backend/profile')
  out.fixtures = out.fixture.split(',')
  if (!out.fixtures.length || new Set(out.fixtures).size !== out.fixtures.length || out.fixtures.some(n => !['small', 'medium', 'large', 'tree', 'mixed'].includes(n))) throw new Error('Timing currently supports small/medium/large/tree/mixed; project-switch/longbook fixtures are generated only')
  if (out.mode === 'compare' && (!out.baseline || out.fixtures.length !== 1)) throw new Error('Compare requires one fixture and --baseline')
  return out
}
async function port() {
  const s = net.createServer()
  await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve) })
  const p = s.address().port
  await new Promise(resolve => s.close(resolve))
  return p
}
async function copy(from, to) {
  await fs.mkdir(to, { recursive: true })
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    if (e.isSymbolicLink()) throw new Error('Build symlink rejected')
    if (e.isDirectory()) await copy(path.join(from, e.name), path.join(to, e.name))
    else await fs.copyFile(path.join(from, e.name), path.join(to, e.name))
  }
}
async function startServer(backend, directory, buildDir, fixture) {
  const p = await port(), origin = `http://127.0.0.1:${p}`
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(p), YFE_DATA: path.join(directory, 'server-data'), YFE_WWW: buildDir, YFE_REGISTER: 'closed', YFE_BOOTSTRAP_INVITE: '' }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[key]
  const dataFile = path.join(directory, 'app/data/youth-fantasy-engine-data.json')
  let args = ['server/index.mjs']
  if (backend === 'portable') {
    await copy(buildDir, path.join(directory, 'app/dist'))
    await fs.mkdir(path.dirname(dataFile), { recursive: true })
    const stores = Object.fromEntries(Object.entries(fixture.stores).map(([k, rows]) => [k, Object.fromEntries(rows.map(r => [r.id ?? r.key, r]))]))
    await write(dataFile, { app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: 1792800000000, stores })
    args = ['scripts/portable-server.mjs', '--root', path.join(directory, 'app'), '--port', String(p), '--no-open']
  }
  let log = '', error = null
  const child = spawn(process.execPath, args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', b => { log += b }); child.stderr.on('data', b => { log += b }); child.on('error', e => { error = e })
  const close = async () => {
    if (child.exitCode === null) {
      const done = new Promise(resolve => child.once('close', resolve))
      child.kill()
      await bounded(done, 'owned server shutdown', 10000)
    }
    await fs.writeFile(path.join(directory, 'server.log'), log)
  }
  try {
    for (let i = 0; i < 100; i++) {
      if (error || child.exitCode !== null) throw error ?? new Error('Server exited: ' + child.exitCode)
      try { if ((await fetch(origin + '/api/ping', { signal: AbortSignal.timeout(500) })).ok) return { origin, dataFile, close } } catch { /* bounded startup */ }
      await sleep(100)
    }
    throw new Error('Server not ready')
  } catch (e) { await close(); throw e }
}
const frames = page => bounded(page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))), 'paint')
async function readStores(page, backend, dataFile) {
  if (backend === 'portable') {
    const file = JSON.parse(await fs.readFile(dataFile, 'utf8'))
    return Object.fromEntries(Object.entries(file.stores).map(([key, value]) => [key, Array.isArray(value) ? value : Object.values(value)]))
  }
  return bounded(page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('youth-fantasy-engine'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    try {
      const tx = db.transaction(['tableRows', 'projects'], 'readonly')
      const get = store => new Promise((resolve, reject) => { const r = tx.objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
      const [tableRows, projects] = await Promise.all([get('tableRows'), get('projects')])
      return { tableRows, projects }
    } finally { db.close() }
  }), 'independent IDB read')
}
async function measure(browser, fixture, opt, runRoot, buildDir, environment, inputHash, buildHash, measurementHash) {
  const directory = path.join(runRoot, opt.backend + '-' + fixture.name)
  await fs.mkdir(directory)
  const plan = opt.mode === 'smoke'
    ? { warmup: 1, open: 1, input: 2, save: 1, filter: 1, clear: 1, scroll: 8 }
    : SAMPLE_PLAN
  const result = { schemaVersion: 1, measurementVersion: MEASUREMENT_VERSION, mode: opt.mode, backend: opt.backend, fixture: fixture.name,
    inputHash, buildHash, measurementHash, fixtureHash: fixture.manifest.sha256, environmentHash: hash(environment), environment,
    samplePlan: plan, quantile: 'nearest-rank', thresholds: thresholdsFor(opt.backend, fixture.name),
    featureFlags: { production: true, productInstrumentation: false },
    metricsSamples: { open: [], input: [], save: [], filter: [], clear: [], scroll: [] }, operations: [], checks: [], status: 'failed',
    boundaries: ['project-switch and longbook timing pending', 'cold-project and remote-locate metrics pending', 'mounted-row budget is observational (window active above 80 rows)', 'real IME and device checks pending'] }
  let server, context, page
  const check = (name, ok) => { result.checks.push({ name, ok }); if (!ok) throw new Error('Functional prerequisite failed: ' + name) }
  const timed = async (name, action, record = true) => {
    console.log(`${opt.backend}/${fixture.name} begin ${name}${record ? '' : ' (unscored)'}`)
    const operation = { name, startedAt: new Date().toISOString(), status: 'running' }
    result.operations.push(operation)
    const start = performance.now()
    try {
      await action()
      operation.ms = performance.now() - start; operation.status = 'passed'
      if (record) result.metricsSamples[name].push(operation.ms)
      return operation.ms
    } catch (e) { operation.ms = performance.now() - start; operation.status = 'failed'; operation.error = String(e); throw e }
  }
  try {
    server = await startServer(opt.backend, directory, buildDir, fixture)
    context = await browser.newContext({ viewport: environment.viewport, deviceScaleFactor: 1 })
    await context.addInitScript(() => {
      localStorage.setItem('yfe-ui-zoom', '100')
      localStorage.setItem('yfe-ui-zoom-manual', '1')
      localStorage.setItem('yfe-theme', 'eye-care')
    })
    page = await context.newPage(); page.setDefaultTimeout(180000)
    const pageErrors = []; result.pageErrors = pageErrors
    page.on('pageerror', e => pageErrors.push(e.message))
    page.on('crash', () => { result.pageCrashed = true })
    await page.goto(server.origin + (opt.backend === 'web-guest' ? '/guest' : '/'), { waitUntil: 'load', timeout: 120000 })
    check('actual backend flags', await page.evaluate(backend => backend === 'web-guest' ? !!window.__YFE_GUEST__ && !window.__YFE_PORTABLE__ : !!window.__YFE_PORTABLE__ && !window.__YFE_WEB__, opt.backend))
    if (opt.backend === 'web-guest') {
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
      }, fixture.stores), 'fixture seed')
      await page.reload({ waitUntil: 'load' })
    }
    await page.getByRole('button', { name: '打开项目', exact: true }).first().click()
    await page.getByRole('navigation').waitFor()
    for (const label of ['稍后再说', '知道了', '我知道了']) {
      const b = page.getByRole('button', { name: label, exact: true }).first()
      if (await b.isVisible()) await b.click()
    }
    check('reference scale and theme', await page.evaluate(() => getComputedStyle(document.documentElement).zoom === '1' && document.documentElement.dataset.theme === 'eye-care'))
    const before = await readStores(page, opt.backend, server.dataFile)
    await write(path.join(directory, 'readback-before.json'), before)
    // Opening a fresh full project legitimately creates a default geomap. Table metrics scope to
    // this fixture's project+tab; retain ancillary records separately rather than weakening row checks.
    const scoped = rows => rows.filter(r => r.tabId === fixture.tab.id && fixture.stores.projects.some(p => p.id === r.projectId))
    result.ancillaryRows = before.tableRows.length - scoped(before.tableRows).length
    before.tableRows = scoped(before.tableRows)
    check('complete logical row count', before.tableRows.length === fixture.manifest.rows)
    const ordered = [...before.tableRows].sort((a, b) => a.order - b.order)
    check('seed bytes match independent stored records', hash(ordered) === fixture.expected.recordsHash)
    const nav = page.getByRole('navigation')
    const tableButton = nav.getByRole('button', { name: fixture.tab.name, exact: true })
    if (!await tableButton.isVisible()) await nav.getByRole('button', { name: fixture.tab.group, exact: true }).click()
    const first = fixture.stores.tableRows[0], last = fixture.stores.tableRows.at(-1)
    const column = name => fixture.columns.findIndex(c => c.key === name) + 2
    // 🔴 P2 行窗口化后 tbody 首尾各有一条「撑高占位行」（data-row-spacer），数据行必须排除它们
  const dataRow = nth => page.locator('table tbody tr:not([data-row-spacer])').nth(nth)
  const cell = name => dataRow(0).locator('td').nth(column(name)).locator('textarea,input').first()
    const ready = async () => {
      await cell('别称').waitFor({ state: 'visible' })
      check('first row identity', await cell('名称').inputValue() === first.data['名称'])
      await frames(page)
    }
    await timed('cold-table', async () => { await tableButton.click(); await ready() }, false)
    const reopen = async () => {
      await nav.getByRole('button', { name: '正文编辑', exact: true }).click()
      // Timing starts after leaving the table has actually unmounted it.
      await page.locator('[data-table-scroll]').waitFor({ state: 'detached' })
      return timed('open', async () => { await tableButton.click(); await ready() }, false)
    }
    await reopen() // exactly one warmup, retained in operations but excluded from samples
    for (let i = 0; i < plan.open; i++) {
      result.metricsSamples.open.push(await reopen())
      console.log(`${opt.backend}/${fixture.name} open ${i + 1}/${plan.open}`)
    }
    // First/last marks are verified by real scrolling; opening never waits for all logical rows in DOM.
    await page.locator('[data-table-scroll]').evaluate(e => { e.scrollTop = e.scrollHeight })
    await frames(page)
    const lastName = dataRow(-1).locator('td').nth(column('名称')).locator('textarea,input').first()
    check('last row identity after scroll', await lastName.inputValue() === last.data['名称'])
    await page.locator('[data-table-scroll]').evaluate(e => { e.scrollTop = 0 })
    await frames(page)
    const input = cell('别称')
    await input.click()
    let value = await input.inputValue()
    await timed('input-warmup', async () => { await input.press('w'); value += 'w'; check('input warmup value', await input.inputValue() === value); await frames(page) }, false)
    for (let i = 0; i < plan.input; i++) {
      await timed('input', async () => { await input.press('x'); value += 'x'; check('input value ' + i, await input.inputValue() === value); await frames(page) })
      if ((i + 1) % 10 === 0) console.log(`${opt.backend}/${fixture.name} input ${i + 1}/${plan.input}`)
    }
    for (let i = 0; i < plan.save + 1; i++) {
      await input.press('s'); value += 's'; await frames(page)
      const expected = value
      await timed('save', async () => {
        // Toolbar button, not an unrelated persistent "saved" message.
        await page.getByTitle('保存全部（Ctrl+S）', { exact: true }).click()
        const deadline = Date.now() + 180000
        for (;;) {
          /**
           * 🔴 计量 v5：轮询必须**便宜**。原来每轮 `readStores()` 要开库 + getAll(tableRows)
           *    + getAll(projects)，large 单次约 40ms —— 产品保存本身只要 13~45ms，
           *    却被探针自己的轮询量成 450ms。这里改成按主键读单条（约 2~5ms）。
           *    整表回读仍保留，但只做一次且不计时（见下方 `complete persisted records`）。
           */
          const stored = opt.backend === 'portable'
            ? JSON.parse(await fs.readFile(server.dataFile, 'utf8')).stores.tableRows
            : await page.evaluate(async ([id]) => {
              const db = await new Promise((resolve, reject) => { const r = indexedDB.open('youth-fantasy-engine'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
              try {
                const tx = db.transaction('tableRows', 'readonly')
                return await new Promise((resolve, reject) => { const rq = tx.objectStore('tableRows').get(id); rq.onsuccess = () => resolve(rq.result ?? null); rq.onerror = () => reject(rq.error) })
              } finally { db.close() }
            }, [first.id])
          const content = opt.backend === 'portable'
            ? Object.values(stored ?? {}).map(r => r).find(r => r.id === first.id)?.data?.['别称']
            : stored?.data?.['别称']
          if (content === expected) break
          if (Date.now() > deadline) throw new Error('Persisted save acknowledgement timeout')
          await sleep(15)
        }
        await frames(page)
      }, i > 0)
      check('save still shows current input ' + i, await input.inputValue() === expected)
      console.log(`${opt.backend}/${fixture.name} save ${i}/${plan.save}`)
    }
    // ---------- 筛选 / 清筛选 / 连续滚动（3.2.3 · P0 余项）----------
    // 判据口径：
    //   · 行数以界面自己的「共 N 行」为准（虚拟化之后挂载行数已不代表筛选结果）；
    //   · 期望值由夹具独立算出（不是读界面），并对首行身份做一次交叉核对。
    const shownRows = () => page.evaluate(() => {
      const el = [...document.querySelectorAll('span')].find(n => /^共 \d+ 行/.test((n.textContent || '').trim()))
      return el ? Number((el.textContent || '').match(/\d+/)?.[0] ?? -1) : -1
    })
    const filterInput = page.locator('thead th').nth(column('名称')).locator('input').first()
    /**
     * 🔴 查询词必须**从夹具数据里算**，不能写死。上一版写死 `-条目01`：
     *    small 只有 30 行（编号 0001~0030）⇒ 一条都不命中 ⇒ `filter fixture has matches` 直接判整轮失败。
     *    这里按候选词依次试，取第一个「命中数 > 0 且 < 总行数」的，顺便让这条检查变成真的前置断言。
     */
    const nameOf = r => String(r.data['名称'] ?? '')
    const picked = (() => {
      // 从第 2 行起取名称**末尾 2~4 字**当查询词：这是数据自带的编号后缀，天然是严格子集
      for (const len of [2, 3, 4]) {
        for (const row of fixture.stores.tableRows.slice(1, 20)) {
          const name = nameOf(row)
          if (name.length <= len) continue
          const q = name.slice(-len)
          const n = fixture.stores.tableRows.filter(r => nameOf(r).includes(q)).length
          if (n > 0 && n < fixture.manifest.rows) return { q, n }
        }
      }
      return null
    })()
    check('filter fixture has a strict subset to search', !!picked, JSON.stringify(picked))
    const query = picked.q
    const matching = fixture.stores.tableRows.filter(r => nameOf(r).includes(query)).sort((a, b) => a.order - b.order)
    /**
     * 首行身份不能直接拿 `matching[0]`：树形夹具（有「上级」列）渲染的是**层级序** ——
     * 先出「父级不在筛选结果里」的根，再递归子行。这里按同样的规则独立算出期望首行，
     * 而不是读界面对答案（读界面就等于没断言）。
     */
    const matchingNames = new Set(matching.map(nameOf))
    const isTree = fixture.stores.tableRows.some(r => String(r.data['上级'] ?? '').trim() !== '')
    const roots = isTree ? matching.filter(r => { const p = String(r.data['上级'] ?? '').trim(); return !p || !matchingNames.has(p) }) : matching
    const expectedFirst = (roots[0] ?? matching[0]) && nameOf(roots[0] ?? matching[0])
    check('filter fixture has matches', matching.length > 0 && matching.length < fixture.manifest.rows, `${picked.n}/${fixture.manifest.rows} by「${query}」`)
    const filterRounds = plan.filter
    for (let i = 0; i < filterRounds; i++) {
      await timed('filter', async () => {
        await filterInput.fill(query)
        const deadline = Date.now() + 60000
        for (;;) {
          if (await shownRows() === matching.length) break
          if (Date.now() > deadline) throw new Error('Filtered row count timeout')
          await sleep(20)
        }
        check('filtered first row identity ' + i, await cell('名称').inputValue() === expectedFirst, `${await cell('名称').inputValue()} vs ${expectedFirst}`)
        await frames(page)
      })
      await timed('clear', async () => {
        await filterInput.fill('')
        const deadline = Date.now() + 60000
        for (;;) {
          if (await shownRows() === fixture.manifest.rows) break
          if (Date.now() > deadline) throw new Error('Cleared row count timeout')
          await sleep(20)
        }
        check('cleared first row identity ' + i, await cell('名称').inputValue() === first.data['名称'])
        await frames(page)
      })
      console.log(`${opt.backend}/${fixture.name} filter+clear ${i + 1}/${filterRounds}`)
    }
    // 连续滚动（3.2.3 · 计量 v4）：**固定 120px/步、在页面内计时**。
    // 🔴 旧口径「每步推进 1/40 全表」在 large 一步就是 1000px（约 25 行），既不是真实滚轮步长，
    //    又把「新挂 20 行 vs 0 行」混成一个数字（诊断：800px/20 行=125ms，1px/0 行=19ms）。
    //    改成页内一次性跑完：省掉 Playwright 往返开销，量到的才是「滚一步并画出来」本身。
    const scrollBox = page.locator('[data-table-scroll]')
    // 🔴 Locator.evaluate 的第 1 个参数是**元素本身**，参数对象是第 2 个 —— 第一版写反了，
    //    结果 steps 是 undefined、一次都没滚，样本为空直接被样本校验拒掉。
    const scrollSeries = await scrollBox.evaluate(async (el, { steps, stepPx }) => {
      const out = []
      el.scrollTop = 0
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      for (let i = 0; i < steps; i++) {
        const t0 = performance.now()
        el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, (i + 1) * stepPx)
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
        out.push(performance.now() - t0)
      }
      return out
    }, { steps: plan.scroll, stepPx: SCROLL_STEP_PX })
    for (const ms of scrollSeries) result.metricsSamples.scroll.push(ms)
    console.log(`${opt.backend}/${fixture.name} scroll ${plan.scroll}×${SCROLL_STEP_PX}px done`)
    // 滚到底（若 60 步还没到底）：末行身份仍要能读到
    await scrollBox.evaluate(el => { el.scrollTop = el.scrollHeight })
    await frames(page)
    check('last row identity after continuous scroll', await lastName.inputValue() === last.data['名称'])
    await scrollBox.evaluate(el => { el.scrollTop = 0 })
    await frames(page)

    const after = await readStores(page, opt.backend, server.dataFile)
    await write(path.join(directory, 'readback-after.json'), after)
    const expectedRows = fixture.stores.tableRows.map(r => r.id === first.id ? { ...r, data: { ...r.data, 别称: value } } : r)
    // updatedAt legitimately changes; every other row/data/metadata field must match, including hidden data.
    const normalize = rows => rows.map(({ updatedAt, ...r }) => r).sort((a, b) => a.id.localeCompare(b.id))
    check('complete persisted records only contain intended change', hash(normalize(scoped(after.tableRows))) === hash(normalize(expectedRows)))
    result.resources = await page.evaluate(() => ({ nodes: document.querySelectorAll('*').length,
      mountedRows: document.querySelectorAll('table tbody tr').length, heapBytes: performance.memory?.usedJSHeapSize ?? null,
      devicePixelRatio, zoom: getComputedStyle(document.documentElement).zoom,
      gpu: (() => { try { return document.createElement('canvas').getContext('webgl')?.getParameter(7937) ?? null } catch { return null } })() }))
    await page.screenshot({ path: path.join(directory, 'table.png') })
    await page.reload({ waitUntil: 'load' })
    const reread = await readStores(page, opt.backend, server.dataFile)
    await write(path.join(directory, 'readback-reload.json'), reread)
    check('reload persisted readback', hash(normalize(scoped(reread.tableRows))) === hash(normalize(expectedRows)))
    check('no page errors', pageErrors.length === 0)
    result.stats = validateSamples(result.metricsSamples, plan)
    result.absolute = result.thresholds ? {
      openP50: result.stats.open.p50 <= result.thresholds.openP50, openMax: result.stats.open.worst <= result.thresholds.openMax,
      inputP95: result.stats.input.p95 <= result.thresholds.inputP95, saveP95: result.stats.save.p95 <= result.thresholds.saveP95,
      filterP95: result.stats.filter.p95 <= result.thresholds.filterP95, clearP95: result.stats.clear.p95 <= result.thresholds.clearP95,
      scrollP95: result.stats.scroll.p95 <= result.thresholds.scrollP95,
    } : null
    result.scrollDefinition = { stepPx: SCROLL_STEP_PX, steps: plan.scroll, timing: 'in-page (set scrollTop → wait 2 rAF)' }
    result.status = opt.mode === 'smoke' ? 'smoke-passed' : 'baseline-recorded'
    if (opt.mode === 'measure') result.baselineId = comparisonKey(result)
    if (opt.mode === 'compare') {
      const { changes, regressions } = compareBaseline(result, JSON.parse(await fs.readFile(path.resolve(opt.baseline), 'utf8')))
      result.relativeChanges = changes
      result.regressionLimits = REGRESSION_LIMITS
      result.regressions = regressions
      /**
       * 判定顺序（3.2.3 · 计量 v6）：
       *   ① 相对退化（比基线慢超限）⇒ `regression-failed`，**任何夹具都适用**；
       *   ② 有绝对阈值的夹具（medium/large）再判阈值；
       *   ③ 都没有（small/tree/mixed）才算 `comparison-passed`。
       * 🔴 旧写法把 ② 当成唯一条件：阈值缺失时 `absolute` 为 null ⇒ 永远 `threshold-failed`，
       *    小表/树形/混合等于没有退化闸；而「比上次慢 5 倍但没超上限」还会被判通过。
       */
      const absoluteOk = !result.absolute || Object.values(result.absolute).every(Boolean)
      result.status = regressions.length ? 'regression-failed' : (absoluteOk ? 'comparison-passed' : 'threshold-failed')
    }
  } catch (e) {
    result.error = String(e.stack ?? e)
    // 🔴 compare 不可比（环境/夹具/阈值/指纹不符）绝不能被当成「已记录基线」：那会 exit 0 报成功。
    if (opt.mode === 'compare') result.status = 'failed'
    if (page) await bounded(page.screenshot({ path: path.join(directory, 'failure.png'), timeout: 5000 }), 'failure capture', 6000).catch(e => { result.failureCaptureError = String(e) })
  } finally {
    await context?.close().catch(e => { result.cleanupError = String(e); result.status = 'failed' })
    await server?.close().catch(e => { result.cleanupError = String(e); result.status = 'failed' })
    result.integrityHash = hash(result)
    await write(path.join(directory, 'baseline.json'), result)
  }
  console.log(`${result.status}: ${directory}`)
  return result
}
async function main() {
  const opt = options(process.argv.slice(2))
  const parent = path.join(ROOT, '.workbuddy/tmp'); await fs.mkdir(parent, { recursive: true })
  if (path.relative(await fs.realpath(ROOT), await fs.realpath(parent)).startsWith('..')) throw new Error('Temporary root escapes workspace')
  const runRoot = await fs.mkdtemp(path.join(parent, 'table-performance-'))
  const inputs = await captureInputs(ROOT), report = { startedAt: new Date().toISOString(), inputs, options: opt, runRoot, results: [], p0Complete: false, scope: 'P0 core timing; not full P0 or performance acceptance' }
  let browser
  try {
    const git = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: ROOT, timeoutMs: 15000 })
    report.head = git.ok ? git.stdout.trim() : null
    report.version = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version
    report.plannedVersion = '3.2.3'
    const bundle = await build({ stdin: { contents: "export { TABS } from './src/lib/schema'; export { atlasColumnsOf } from './src/lib/atlas/columns'", resolveDir: ROOT, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, alias: { '@': path.join(ROOT, 'src') },
      plugins: [{ name: 'fixture-schema-no-storage', setup(b) {
        b.onResolve({ filter: /^@\/lib\/db$/ }, args => args.importer.endsWith('schemaShared.ts') ? { path: 'no-storage', namespace: 'fixture-schema' } : undefined)
        b.onLoad({ filter: /.*/, namespace: 'fixture-schema' }, () => ({ contents: "export async function getAllVolumes() { throw new Error('Fixture schema cannot access storage') }" }))
      } }] })
    const schemaFile = path.join(runRoot, 'fixture-schema.mjs'); await fs.writeFile(schemaFile, bundle.outputFiles[0].contents)
    const schema = await import(pathToFileURL(schemaFile).href)
    const fixtures = FIXTURE_NAMES.map(name => generateTableFixture({ tab: schema.TABS.find(t => t.id === 'races'), columnsOf: schema.atlasColumnsOf }, name))
    const fixtureDir = path.join(runRoot, 'fixtures'); await fs.mkdir(fixtureDir)
    for (const fixture of fixtures) await write(path.join(fixtureDir, fixture.name + '.json'), fixture)
    report.fixtures = fixtures.map(f => ({ name: f.name, ...f.manifest }))
    const buildDir = path.join(runRoot, 'build')
    const built = await runProcess(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', buildDir], { cwd: ROOT, timeoutMs: 180000 })
    await fs.writeFile(path.join(runRoot, 'build.log'), built.out)
    if (!built.ok) throw new Error('Production build failed')
    report.build = await hashPaths(buildDir, ['.'])
    await write(path.join(runRoot, 'build-manifest.json'), report.build)
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server', '--enable-precise-memory-info'] })
    const environment = { node: process.version, os: { platform: os.platform(), release: os.release(), arch: os.arch() },
      cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, totalMemory: os.totalmem(), browser: browser.version(),
      channel: 'msedge', headless: true, viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1,
      zoom: 1, theme: 'eye-care',
      cpuThrottling: 1, gpuMode: 'default', browserArgs: ['--no-proxy-server', '--enable-precise-memory-info'] }
    const cdp = await browser.newBrowserCDPSession()
    const info = await cdp.send('SystemInfo.getInfo')
    environment.gpu = { devices: info.gpu.devices, featureStatus: info.gpu.featureStatus }
    await cdp.detach()
    const measurementHash = (await hashPaths(ROOT, ['scripts/verify/table-performance.mjs', 'scripts/verify/table-metrics.mjs', 'scripts/verify/fixtures/table-fixtures.mjs', 'scripts/verify/evidence.mjs', 'scripts/verify/process.mjs'])).sha256
    for (const name of opt.fixtures) {
      const result = await measure(browser, fixtures.find(f => f.name === name), opt, runRoot, buildDir, environment, inputs.combined, report.build.sha256, measurementHash)
      report.results.push(result)
      // Never continue with fast timings after functional failure.
      if (result.status === 'failed') break
    }
    report.inputUnchanged = (await captureInputs(ROOT)).combined === inputs.combined
    if (!report.inputUnchanged) throw new Error('Source/tool inputs changed during measurement')
    report.code = report.results.length === opt.fixtures.length && report.results.every(r => ['baseline-recorded', 'smoke-passed', 'comparison-passed'].includes(r.status)) ? 0 : 1
  } catch (e) { report.error = String(e.stack ?? e); report.code = 1 }
  finally {
    await browser?.close().catch(e => { report.cleanupError = String(e); report.code = 1 })
    report.finishedAt = new Date().toISOString()
    // Failure of one fixture never promotes the selected suite, but must not erase another
    // fixture's complete evidence. Only a run-wide input/infrastructure failure invalidates all.
    if (!report.inputUnchanged || report.error || report.cleanupError) for (const result of report.results) {
      if (result.status === 'baseline-recorded') { result.status = 'invalidated'; await write(path.join(runRoot, result.backend + '-' + result.fixture, 'baseline.json'), result) }
    }
    report.artifacts = await hashPaths(runRoot, ['.'])
    await write(path.join(runRoot, 'report.json'), report)
    await fs.writeFile(path.join(runRoot, 'report.md'), ['# 大表 P0 核心指标测量', '', report.scope,
      `Input: ${inputs.combined}`, `Exit: ${report.code}`, '', '| Backend | Fixture | Status | Open P50/P95/worst | Input P50/P95/worst | Save P50/P95/worst |', '|---|---|---|---|---|---|',
      ...report.results.map(r => `| ${r.backend} | ${r.fixture} | ${r.status} | ${['open', 'input', 'save'].map(k => r.stats ? [r.stats[k].p50, r.stats[k].p95, r.stats[k].worst].map(n => Math.round(n)).join('/') : '-').join(' | ')} |`), '',
      'Times are ms. Baseline recording does not imply performance targets passed. Incomplete P0 metrics and fixture interaction coverage remain explicit in baseline.json.', report.error ?? ''].join('\n'))
    console.log('REPORT ' + path.join(runRoot, 'report.json')); process.exitCode = report.code
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
