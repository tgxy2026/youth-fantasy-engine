// 3.3.4 · P0 性能基线（规划 §3.3 末段 / §10.2-4）
//
// P0 只**记录**基线，不设通过线；P1 起用「相同流程 p95 不劣于基线 20%」判回归，
// 并要求输入不出现持续 >200ms 的可感知停顿。
//
// 测量协议（照 §10.2-4 写死，换设备/换夹具就不是同一条基线）：
//   · 固定夹具：示例项目 + 正文编辑（示例自带 3 章）＋ 固定的 5 个页签导航；
//   · 每项热身后 3 轮，输入每轮 100 字、导航每轮 100 次；
//   · **每轮单独记 p95**，不混设备、不挑最好一轮；
//   · 输入延迟 = 输入事件到对应可见更新（下一帧）；另记 longtask（>50ms）作为「卡顿」旁证。
//
// 明确不做：真机、软键盘、IME 组合输入、长时间连续写作的内存增长。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join(root, '.workbuddy/tmp', `perf-p0-334-${stamp}`)
await fs.mkdir(run, { recursive: true })

const KEYS_PER_ROUND = 100
const NAV_PER_ROUND = 100
const ROUNDS = 3
const NAV_TABS = ['char-main', 'chapter-master', 'geography', 'foreshadow', 'editor']

const report = {
  kind: 'perf-p0-334',
  at: new Date().toISOString(),
  fingerprint: snapshot(root).fingerprint,
  viewport: { width: 1280, height: 800 },
  protocol: { rounds: ROUNDS, keysPerRound: KEYS_PER_ROUND, navPerRound: NAV_PER_ROUND, warmup: 1 },
  input: [],
  nav: [],
  longtasks: [],
  errors: [],
  status: 'running',
}

const pct = (list, p) => {
  if (!list.length) return null
  const sorted = [...list].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10
}

let server, browser
try {
  server = await createServer({ root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: report.viewport, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage()
  page.on('pageerror', error => report.errors.push(error.message))

  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click({ timeout: 60000 })
  await page.getByRole('button', { name: '下一步', exact: true }).click({ timeout: 30000 })
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click({ timeout: 30000 })
  await page.getByText('继续写作', { exact: true }).first().waitFor({ timeout: 120000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  const guide = page.locator('[data-guide-card]').first()
  if (await guide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
    await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
  }
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })
  await page.getByText('继续写作', { exact: true }).first().click({ timeout: 30000 })
  await page.waitForTimeout(1200)

  /** 装测量钩：输入延迟 + longtask。装在 window 上，按轮清空。 */
  await page.evaluate(() => {
    const w = window
    w.__perf = { lat: [], long: [] }
    w.__perfObserver?.disconnect?.()
    try {
      w.__perfObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__perf.long.push(Math.round(entry.duration))
      })
      w.__perfObserver.observe({ entryTypes: ['longtask'] })
    } catch { /* 环境不支持 longtask 时只记输入延迟，不假装有数据 */ }
    const area = [...document.querySelectorAll('textarea')]
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
    w.__perfArea = area || null
    if (!area) return
    area.addEventListener('input', () => {
      const t0 = performance.now()
      requestAnimationFrame(() => w.__perf.lat.push(Math.round((performance.now() - t0) * 10) / 10))
    }, true)
  })

  const hasArea = await page.evaluate(() => !!window.__perfArea)
  if (!hasArea) throw new Error('正文编辑器里没找到 textarea，无法测输入延迟')

  for (let round = 1; round <= ROUNDS + 1; round++) {
    await page.evaluate(() => { window.__perf.lat = []; window.__perf.long = [] })
    await page.evaluate(() => window.__perfArea?.focus())
    // 用 1 个汉字重复输入：不引入 IME 组合，也不触发自动补全
    await page.keyboard.type('字'.repeat(KEYS_PER_ROUND), { delay: 0 })
    await page.waitForTimeout(500)
    const sample = await page.evaluate(() => ({ lat: window.__perf.lat.slice(), long: window.__perf.long.slice() }))
    const isWarmup = round === 1
    const record = {
      round: isWarmup ? 'warmup' : round - 1,
      samples: sample.lat.length,
      p50: pct(sample.lat, 0.5), p95: pct(sample.lat, 0.95), max: Math.max(0, ...sample.lat),
      over200: sample.lat.filter(v => v > 200).length,
      longTasks: sample.long.length, longestTask: Math.max(0, ...sample.long),
    }
    if (!isWarmup) report.input.push(record)
    console.log(`输入第 ${round} 轮${isWarmup ? '（热身）' : ''}：样本 ${record.samples} p50=${record.p50} p95=${record.p95} max=${record.max} >200ms=${record.over200} longtask=${record.longTasks}`)
    await page.evaluate(() => { window.__perf.long = [] })
  }

  for (let round = 1; round <= ROUNDS + 1; round++) {
    const durations = []
    for (let i = 0; i < NAV_PER_ROUND; i++) {
      const tabId = NAV_TABS[i % NAV_TABS.length]
      const tabName = await page.evaluate(async (id) => {
        const schema = await import('/src/lib/schema.ts')
        const tab = id === 'editor' ? schema.EDITOR_TAB : schema.getTab(id)
        return tab?.name ?? ''
      }, tabId)
      // 🔴 必须先取「点击前」的文本再点：写成点击后取值，等于把比较基准换成新页面，永远等不到变化
      const before = await page.evaluate(() => document.querySelector('main')?.innerText ?? '')
      const started = Date.now()
      try {
        await page.getByRole('navigation').getByRole('button', { name: tabName, exact: true }).first().click({ timeout: 8000 })
        // 等主区文本真的变了，再停表 —— 只等 click 返回会把渲染时间漏掉
        await page.waitForFunction((prev) => {
          const main = document.querySelector('main')
          return !!main && main.innerText.trim().length > 0 && main.innerText !== prev
        }, before, { timeout: 8000 })
        durations.push(Date.now() - started)
        await page.waitForTimeout(60)
      } catch (error) {
        durations.push(-1)
        report.errors.push(`导航 ${tabId}: ${String(error).slice(0, 120)}`)
      }
    }
    const ok = durations.filter(value => value >= 0)
    const isWarmup = round === 1
    const record = {
      round: isWarmup ? 'warmup' : round - 1,
      samples: ok.length, failed: durations.length - ok.length,
      p50: pct(ok, 0.5), p95: pct(ok, 0.95), max: Math.max(0, ...ok),
    }
    if (!isWarmup) report.nav.push(record)
    console.log(`导航第 ${round} 轮${isWarmup ? '（热身）' : ''}：样本 ${record.samples} 失败 ${record.failed} p50=${record.p50} p95=${record.p95} max=${record.max}`)
    // 回正文，下一轮输入仍在同一页
    await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).first().click().catch(() => {})
    await page.waitForTimeout(200)
  }

  const avg = (list, key) => {
    const values = list.map(item => item[key]).filter(v => typeof v === 'number')
    return values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null
  }
  report.baseline = {
    inputP95: avg(report.input, 'p95'),
    inputMax: Math.max(0, ...report.input.map(item => item.max ?? 0)),
    navP95: avg(report.nav, 'p95'),
    over200Total: report.input.reduce((sum, item) => sum + (item.over200 ?? 0), 0),
    longTaskTotal: report.input.reduce((sum, item) => sum + (item.longTasks ?? 0), 0),
  }
  report.status = 'complete'
  await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ run, fingerprint: report.fingerprint, baseline: report.baseline }, null, 2))
} catch (error) {
  report.status = 'failed'
  report.failure = String(error?.stack || error)
  await fs.writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2)).catch(() => {})
  console.error('FAILED', error)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  await server?.close().catch(() => {})
}
