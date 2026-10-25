#!/usr/bin/env node
'use strict'
// 项目内全部页签的窗口布局巡检，使用新浏览器上下文中的示范项目。
// 只观察布局，不调用 AI、不改真实书库；表格/画布自身可滚动区域不当成页面溢出。
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
/**
 * 源码指纹用统一验收那份实现（`audit/platform/source.mjs` 的 `snapshot`）。
 * 🔴 仓里另有一份老的 `audit/context.cjs#sourceFingerprint`，两边算出来不一样，
 *    用错会让证据被判「与当前源码不符」（本轮实测踩到）。
 */
let sourceFingerprintOf = null // 在 main() 里动态加载（.cjs 不能顶层 await）
const ROOT = path.resolve(__dirname, '../../..')
async function main() {
  const densityAt = process.argv.indexOf('--density')
  const density = densityAt >= 0 ? process.argv[densityAt + 1] : 'compact'
  if (!['compact', 'comfortable'].includes(density)) throw new Error('Expected --density compact|comfortable')
  sourceFingerprintOf = (await import('../platform/source.mjs')).snapshot
  /** `--result-file <path>`：把结果另存一份到固定路径，供验收执行器直接校验（3.2.6 接线用） */
  const ri = process.argv.indexOf('--result-file')
  const resultFile = ri >= 0 && process.argv[ri + 1] && !process.argv[ri + 1].startsWith('--') ? path.resolve(process.argv[ri + 1]) : null
  for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy']) delete process.env[k]
  const out = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/workspace-layout-'))
  const result = { at: new Date().toISOString(), sourceFingerprint: sourceFingerprintOf(ROOT).fingerprint, density, out, cases: [], errors: [] }
  let server, browser
  try {
    const { createServer } = await import('vite')
    server = await createServer({ root: ROOT, cacheDir: path.join(out, 'vite-cache'), logLevel: 'silent', server: { host: '127.0.0.1', port: 5213, strictPort: true } }); await server.listen()
    /**
     * 🔴 `vite.listen()` 只代表端口通了，首屏模块图还没编译完。
     *    2026-10-25 实测：冷缓存 + 机器刚跑完别的探针，直接 goto 45s 超时整步红
     *    （同一份代码单独重跑又正常）。这里是**取证工具的等待上限**，不是被测行为。
     */
    let ready = false
    for (let i = 0; i < 240; i++) {
      try { const r = await fetch('http://127.0.0.1:5213/'); if (r.ok) { ready = true; break } } catch { /* 还没起来 */ }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!ready) throw new Error('vite dev server 120 秒内没有返回首页')
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
    const page = await browser.newPage({ viewport: { width: 1000, height: 640 } })
    page.setDefaultTimeout(12000)
    page.on('pageerror', e => result.errors.push(e.message))
    await page.goto('http://127.0.0.1:5213', { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.getByRole('button', { name: /先看看示例/ }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
    await page.getByRole('navigation').waitFor()
    const later = page.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.isVisible()) await later.click()
    await page.evaluate(async value => {
      const { DENSITIES, DENSITY_PREF, applyDensity } = await import('/src/lib/settings/density.ts')
      const { writeEnumPref } = await import('/src/lib/settings/uiPrefs.ts')
      applyDensity(writeEnumPref(DENSITY_PREF, value, DENSITIES, 'compact'))
    }, density)
    // 不能只验酒馆空态：通过真实存储入口建立故事、角色和一场已有对话。
    await page.evaluate(async () => {
      const story = await import('/src/lib/tavern/story.ts')
      const store = await import('/src/lib/tavern/store.ts')
      const book = await story.createStory({ name: '窗口验收故事', setting: '临时浏览器中的海港故事，仅供布局验收。' })
      const card = await store.createFreeChar({ ...store.emptyFreeCharacter(), storyId: book.id, name: '验收角色', examples: '他说：欢迎来到港口。' })
      const session = await store.createFreeSession([card.id], '窗口适配测试对话', {}, {}, undefined, book.id)
      await store.saveFreeSession({ ...session, messages: [{ id: 'layout-message', role: 'assistant', content: '欢迎来到港口，这是一条用于验证窗口布局的本地记录。', charId: card.id, createdAt: Date.now() }] })
    })
    const tabs = await page.evaluate(async () => {
      const { TABS, EDITOR_TAB, tabVisible } = await import('/src/lib/schema.ts')
      return [EDITOR_TAB, ...TABS].filter(t => tabVisible(t.id, { type: 'full', features: [] })).map(t => ({ id: t.id, name: t.name, type: t.type }))
    })
    for (const scenario of [{ width: 768, height: 1024, zoom: 100 }, { width: 1024, height: 768, zoom: 100 }, { width: 1280, height: 800, zoom: 100 }, { width: 1366, height: 768, zoom: 100 }, { width: 1000, height: 640, zoom: 100 }, { width: 1000, height: 640, zoom: 160 }, { width: 768, height: 1024, zoom: 125 }]) {
      await page.setViewportSize({ width: scenario.width, height: scenario.height })
      await page.evaluate(async z => { const { applyZoom } = await import('/src/lib/settings/theme.ts'); applyZoom(z, { manual: true }) }, scenario.zoom)
      for (const tab of tabs) {
        await page.evaluate(id => window.dispatchEvent(new CustomEvent('yfe:navigate', { detail: id })), tab.id)
        await page.waitForTimeout(250)
        await page.getByText('加载中…', { exact: true }).waitFor({ state: 'hidden', timeout: 12000 }).catch(() => {})
        if (tab.id === 'tavern-free') {
          const session = page.getByRole('button', { name: /窗口适配测试对话/ }).first()
          if (await session.isVisible()) { await session.click(); await page.waitForTimeout(300) }
        }
        await page.locator('main').evaluate(e => { e.scrollTop = 0; e.scrollLeft = 0 })
        const measurement = await page.locator('main').evaluate(main => {
          const m = main.getBoundingClientRect(), issues = []
          if (main.scrollWidth > main.clientWidth + 2) issues.push({ kind: 'page-overflow', amount: main.scrollWidth - main.clientWidth })
          const reachable = (el, axis) => {
            for (let p = el.parentElement; p; p = p.parentElement) {
              const s = getComputedStyle(p), overflow = axis === 'x' ? s.overflowX : s.overflowY
              if (/(auto|scroll)/.test(overflow) && (axis === 'x' ? p.scrollWidth > p.clientWidth : p.scrollHeight > p.clientHeight)) return true
              if (p === main) break
            }
            return false
          }
          for (const e of main.querySelectorAll('button,input,select,textarea')) {
            const r = e.getBoundingClientRect(), s = getComputedStyle(e)
            if (!r.width || !r.height || s.visibility === 'hidden') continue
            const name = (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || e.getAttribute('placeholder') || e.tagName).trim().slice(0, 70)
            if ((r.left < m.left - 2 || r.right > m.right + 2) && !reachable(e, 'x')) issues.push({ kind: 'control-overflow', name, width: r.width, left: r.left, right: r.right })
            if (e.tagName === 'BUTTON' && e.textContent.trim().length >= 2 && r.width < 34 * Number(document.documentElement.style.zoom || 1) && r.height > 38 * Number(document.documentElement.style.zoom || 1)) issues.push({ kind: 'vertical-button', name, width: r.width, height: r.height })
            if ((r.bottom > window.innerHeight + 2 || r.top < 0) && !reachable(e, 'y')) issues.push({ kind: 'unreachable-control', name, top: r.top, bottom: r.bottom })
          }
          const header = main.querySelector('header')?.getBoundingClientRect()
          if (header && header.height > m.height * .6) issues.push({ kind: 'header-crowding', height: header.height })
          return { mainWidth: m.width, mainHeight: m.height, scrollWidth: main.scrollWidth, headerHeight: header?.height, issues }
        })
        const row = { ...scenario, density, ...tab, ...measurement }
        result.cases.push(row)
        if (measurement.issues.length || ['editor','dashboard','char-main','worldbase','positioning','volume-outline','tavern-free','creative-writing','trajectory','geography-map'].includes(tab.id)) {
          row.screenshot = `${scenario.width}-${scenario.zoom}-${tab.id}.png`
          await page.screenshot({ path: path.join(out, row.screenshot) })
        }
      }
      console.log('SCENARIO ' + JSON.stringify({ ...scenario, pages: tabs.length, issues: result.cases.filter(c => c.zoom === scenario.zoom && c.width === scenario.width).filter(c => c.issues.length).map(c => ({ id: c.id, issues: c.issues.slice(0, 8) })) }))
    }
  } catch (e) { result.error = e.stack; throw e }
  finally {
    result.stale = result.sourceFingerprint !== sourceFingerprintOf(ROOT).fingerprint
    await browser?.close().catch(() => {}); await server?.close().catch(() => {})
    const body = JSON.stringify(result, null, 2)
    await fs.writeFile(path.join(out, 'results.json'), body)
    if (resultFile) { await fs.mkdir(path.dirname(resultFile), { recursive: true }); await fs.writeFile(resultFile, body) }
    console.log('EVIDENCE ' + (resultFile || path.join(out, 'results.json')))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
