#!/usr/bin/env node
// 六维审计契约 mono.rendered 的证据生产者（3.2.3 起随仓入库）。
//
// 契约原文：「有真实绘制样本、当前主题正确、颜色及有效透明度严格二值」，cases = contracts.json 的 charts（8 个图表源文件）。
//
// 采样口径（这是本脚本的关键，别随手改）：
//   · 切到 mono 主题（`documentElement.dataset.theme = 'mono'`，与 useMonoTheme 同一落点）；
//   · **只扫「画布级」svg**（scanRenderedPaint 的 minSvgSize）：整页扫会把 12px 的禁用态图标
//     （祖先 button opacity-40）算成"非二值"，那是禁用淡化的正常表现，不是图表；
//   · 图表在 TableSheet 里是**视图模式**（表格 / 时间轴 / 关系图），切页签后组件会重挂载、
//     viewMode 回到 table ⇒ 每个目标都要重新点一次对应按钮。
//
// 🔴 只要有一个图表拿不到绘制样本，就 status=failed：不拿别的页签的数字凑。
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(import.meta.url)
const { scanRenderedPaint } = require('../audit/browser-scan.cjs')
const { openEditorNavigation } = require('../audit/probes/workspace-entry.cjs')
const PORT = Number(process.env.YFE_PROBE_PORT || 5241)
/** 画布级门槛：图表 svg 远大于图标（16×16），160px 足够区分又不会漏掉偏小的图 */
const MIN_SVG = 160

/**
 * 8 个图表 → 进入路径。`file` 必须与 contracts.json 的 charts 逐字一致。
 * `view`：进入该页签后要先点的视图按钮（表格页签默认是 table 模式）。
 */
const TARGETS = [
  { file: 'src/components/creative/WritingGoals.tsx', tab: 'dashboard', label: '写作目标' },
  { file: 'src/components/outline/StructurePacePanel.tsx', tab: 'dashboard', label: '结构节奏' },
  { file: 'src/components/outline/PlotCanvas.tsx', tab: 'plot-canvas', label: '情节画布' },
  { file: 'src/components/world/GeoMapEditor.tsx', tab: 'geography-map', label: '地图编辑' },
  // 🔴 关系图视图只对 relations / faction-rels 开放（useTableSheetModel 的 isGraphCapable）：
  //    nations 上没有那个按钮，第一轮就是拿它跑出 painted=0 的。
  { file: 'src/components/world/RelationGraph.tsx', tab: 'relations', label: '人物关系图', view: '关系图' },
  { file: 'src/components/world/FactionGraph.tsx', tab: 'faction-rels', label: '势力关系图', view: '关系图' },
  { file: 'src/components/outline/StoryTimeline.tsx', tab: 'timeline', label: '时间脉络', view: '时间轴' },
  { file: 'src/components/outline/HistoryTimeline.tsx', tab: 'history', label: '历史事件时间轴', view: '时间轴' },
]

async function main() {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[key]
  const outDir = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/mono-charts-'))
  const artifact = path.join(outDir, 'mono-charts-evidence.json')
  const pageErrors = []
  const results = []
  let vite, browser

  try {
    const { createServer } = await import('vite')
    vite = await createServer({
      root: ROOT, cacheDir: path.join(outDir, 'vite-cache'), logLevel: 'silent',
      server: { host: '127.0.0.1', port: PORT, strictPort: true },
    })
    await vite.listen()
    // 🔴 与 draft-failure 同因：listen() 成功 ≠ 首屏编译好。完整验收里第一次请求可能几十秒，
    //    先轮询首页再开浏览器，否则会以 "page.goto 超时" 的形式整步红。
    {
      const deadline = Date.now() + 90000
      let ready = false
      while (Date.now() < deadline) {
        try { if ((await fetch('http://127.0.0.1:' + PORT + '/', { signal: AbortSignal.timeout(5000) })).ok) { ready = true; break } } catch { /* 还在编译 */ }
        await new Promise(r => setTimeout(r, 500))
      }
      if (!ready) throw new Error('vite dev server 90 秒内没有返回首页')
    }
    const { chromium } = require('playwright')
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
    page.setDefaultTimeout(20000)
    page.on('pageerror', (e) => pageErrors.push(String(e.message)))

    /**
     * 🔴 `domcontentloaded` 要等模块脚本全部执行完 —— 冷缓存下 vite 逐个 transform，
     *    机器一忙就顶穿 60s（实测 `reliability-cpW2Do`：readiness 已通过，goto 仍 60s 红）。
     *    改成「只要文档提交 + 等 React 真挂上 #root」：这才是「首屏可用」，也不受模块编译拖累。
     */
    await page.goto('http://127.0.0.1:' + PORT, { waitUntil: 'commit', timeout: 120000 })
    await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 180000 })
    await page.getByRole('button', { name: /先看看示例/ }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
    await openEditorNavigation(page)

    // mono 主题：与 useMonoTheme 同一个落点（CSS 变量据此切换），不是伪造样式
    await page.evaluate(() => { document.documentElement.dataset.theme = 'mono' })

    for (const target of TARGETS) {
      await page.evaluate((id) => window.dispatchEvent(new CustomEvent('yfe:navigate', { detail: id })), target.tab)
      await page.waitForTimeout(700)
      let entered = 'default'
      /**
       * 🔴 页签引导卡（`[data-guide-card]`）是 fixed 浮层，切页签后会盖住该页的工具栏：
       *    实测点「关系图」时 20 秒都被它拦掉（与 workspace-entry 里同一类问题）。
       *    每进一个页签先把它关掉，再点视图按钮。
       */
      const guide = page.locator('[data-guide-card]').first()
      if (await guide.isVisible().catch(() => false)) {
        await page.getByRole('button', { name: '跳过本页' }).first().click({ timeout: 2000 }).catch(() => {})
        await guide.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
      }
      if (target.view) {
        const button = page.getByRole('button', { name: target.view, exact: true })
        const has = await button.isVisible().catch(() => false)
        if (has) { await button.click(); entered = target.view } else { entered = 'missing:' + target.view }
        await page.waitForTimeout(900)
      }
      const scan = await page.evaluate(scanRenderedPaint, { binary: true, minSvgSize: MIN_SVG }).catch((e) => ({ error: String(e).slice(0, 140) }))
      const ok = !scan.error && scan.theme === 'mono' && scan.painted > 0 && scan.violations.length === 0 && scan.unknown.length === 0
      results.push({
        file: target.file, tab: target.tab, label: target.label, view: entered,
        theme: scan.theme, painted: scan.painted ?? -1,
        violations: (scan.violations || []).slice(0, 5), violationCount: (scan.violations || []).length,
        unknown: (scan.unknown || []).slice(0, 5), unknownCount: (scan.unknown || []).length,
        ok, reason: ok ? undefined : (scan.error || `painted=${scan.painted} viol=${(scan.violations || []).length} unk=${(scan.unknown || []).length} view=${entered}`),
      })
      console.log(`${ok ? 'PASS' : 'FAIL'} ${target.tab}/${target.label} painted=${scan.painted ?? -1} viol=${(scan.violations || []).length} view=${entered}`)
    }
    await page.screenshot({ path: path.join(outDir, 'mono-charts.png') })
  } catch (e) {
    results.push({ file: '(run)', ok: false, reason: String(e && e.message ? e.message : e) })
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (vite) await vite.close().catch(() => {})
    const passed = results.filter((r) => r.ok).length
    const painted = results.reduce((sum, r) => sum + (r.painted > 0 ? r.painted : 0), 0)
    const payload = {
      schemaVersion: 1, contract: 'mono.rendered', at: new Date().toISOString(),
      theme: 'mono', minSvgSize: MIN_SVG,
      scope: '真实浏览器 + vite dev server + 示范项目；只扫画布级 svg（排除 12px 禁用态图标）；未写真实书库',
      charts: TARGETS.length, samples: results.length, passed, failed: results.length - passed,
      totalPainted: painted, results, pageErrors,
    }
    await fs.writeFile(artifact, JSON.stringify(payload, null, 2)).catch(() => {})
    console.log(`MONO_CHARTS samples=${results.length} passed=${passed} failed=${payload.failed} painted=${painted}`)
    console.log('artifact=' + path.relative(ROOT, artifact).replaceAll('\\', '/'))
    if (payload.failed) { for (const r of results.filter((x) => !x.ok)) console.error('FAIL ' + (r.tab || r.file) + ': ' + r.reason); process.exitCode = 1 }
  }
}

main().catch((e) => { console.error('MONO_CHARTS failed: ' + (e && e.stack ? e.stack : e)); process.exitCode = 1 })
