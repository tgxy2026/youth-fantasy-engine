#!/usr/bin/env node
/**
 * 「关于页三形态」里的**浏览器两形态**验收（3.6.2 收尾 · W1.5 第 7 条）。
 *
 * 两种用法：
 *   ① 便携版（默认）：解压**已发布的压缩包** → 起包内 portable-server → 浏览器打开；
 *   ② 网页版：`--base https://youth-fantasy-engine.online --expect 网页版` 直接打线上游客入口。
 *
 * 【为什么单独一支】桌面形态能用 Playwright 直连 Electron；这两种是
 *   「服务端 + 浏览器」，载体判定完全不同（`PORTABLE` / `WEB`，而不是 `DESKTOP`）。
 *   关于页那行「构建于 … · 便携版／网页版」是排障时用户唯一报得准的载体信息，
 *   而它依赖显式标志，写错就会把便携版说成桌面版（或反过来）。
 *
 * 🔴 便携模式用**已发布的压缩包**解压出来跑（不是仓库里的 dist）：
 *   验的是产物里那份 dist 与包内脚本，跑仓库 dist 等于只验了源码。
 *
 * 用法：
 *   node scripts/verify/carrier-about-check.mjs
 *   node scripts/verify/carrier-about-check.mjs --zip release/xxx.zip --port 8811
 *   node scripts/verify/carrier-about-check.mjs --base https://youth-fantasy-engine.online --expect 网页版
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const arg = (name, def = '') => {
  const at = process.argv.indexOf(name)
  if (at < 0) return def
  const v = process.argv[at + 1]
  if (!v || v.startsWith('--')) throw new Error(name + ' 需要值')
  return v
}
const VERSION = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version
const ZIP = arg('--zip', path.join(ROOT, 'release', `青春幻想引擎-便携版-${VERSION}-Windows.zip`))
const PORT = Number(arg('--port', '8811'))
const REMOTE_BASE = arg('--base', '')
const EXPECT = arg('--expect', REMOTE_BASE ? '网页版' : '便携版')
const START_URL = REMOTE_BASE ? REMOTE_BASE.replace(/\/$/, '') + '/guest' : `http://127.0.0.1:${PORT}/`
const SEVEN_ZIP = 'C:\\Program Files\\7-Zip\\7z.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
const check = (id, ok, detail = '') => {
  checks.push({ id, passed: !!ok, detail: String(detail).slice(0, 300) })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail ? ' :: ' + String(detail).slice(0, 180) : ''))
}

/** 过首启向导 + 打开项目，直到出现页签 */
async function reachWorkspace(page) {
  const visible = (name) => page.getByRole('button', { name, exact: true }).first().isVisible().catch(() => false)
  for (const label of ['关闭本页指引', '跳过本页', '稍后再说', '知道了', '我知道了']) {
    if (await visible(label)) await page.getByRole('button', { name: label, exact: true }).first().click().catch(() => {})
  }
  if (await visible('先看看示例')) {
    await page.getByRole('button', { name: '先看看示例' }).first().click().catch(() => {})
    await sleep(900)
  }
  /**
   * 首启向导是多步的：点完「先看看示例」还要过「下一步」／「跳过，直接进入项目管理」。
   * 一步只点一次会卡在第二屏（实测就是这样：页面还停在"你想怎么开始？"）。
   */
  for (let step = 0; step < 8; step++) {
    const next = page.getByRole('button', { name: '下一步', exact: true }).first()
    const skip = page.getByRole('button', { name: '跳过，直接进入项目管理', exact: true }).first()
    const skip2 = page.getByRole('button', { name: '跳过，直接开始', exact: true }).first()
    if (await next.isVisible().catch(() => false)) { await next.click().catch(() => {}); await sleep(900); continue }
    if (await skip.isVisible().catch(() => false)) { await skip.click().catch(() => {}); await sleep(1500); continue }
    if (await skip2.isVisible().catch(() => false)) { await skip2.click().catch(() => {}); await sleep(900); continue }
    break
  }
  if (await visible('打开项目')) { await page.getByRole('button', { name: '打开项目', exact: true }).first().click().catch(() => {}); await sleep(1500) }
  else if (await visible('创建示范项目')) {
    await page.getByRole('button', { name: '创建示范项目', exact: true }).first().click().catch(() => {})
    await sleep(900)
    if (await visible('确定')) await page.getByRole('button', { name: '确定', exact: true }).first().click().catch(() => {})
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      if (await visible('打开项目') || await visible('正文编辑')) break
      await sleep(1000)
    }
    if (await visible('打开项目')) { await page.getByRole('button', { name: '打开项目', exact: true }).first().click().catch(() => {}); await sleep(1500) }
  }
}

async function openAbout(page) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const tab = page.getByRole('button', { name: '关于打赏' }).first()
    if (await tab.isVisible().catch(() => false)) { await tab.evaluate((el) => el.click()).catch(() => {}); await sleep(900); return true }
    const group = page.getByRole('button', { name: '工作面板' }).first()
    if (await group.isVisible().catch(() => false)) await group.click().catch(() => {})
    await sleep(400)
  }
  return false
}

async function main() {
  const tag = REMOTE_BASE ? 'web' : 'portable'
  const runRoot = await fs.mkdtemp(path.join(ROOT, `.workbuddy/tmp/${tag}-about-`))
  let srv = null
  let browser = null
  try {
    if (!REMOTE_BASE) {
      if (!(await fs.stat(ZIP).catch(() => null))) throw new Error('找不到便携包：' + ZIP)
      const extracted = path.join(runRoot, 'app')
      await fs.mkdir(extracted, { recursive: true })
      console.log('解压', path.basename(ZIP))
      const unzip = spawnSync(SEVEN_ZIP, ['x', ZIP, `-o${extracted}`, '-y'], { encoding: 'utf8' })
      if (unzip.status !== 0) throw new Error('解压失败：' + (unzip.stderr || unzip.stdout || '').slice(0, 200))
      const serverJs = path.join(extracted, 'scripts', 'portable-server.mjs')
      check(`${tag}.package-has-server`, !!(await fs.stat(serverJs).catch(() => null)), 'scripts/portable-server.mjs')
      check(`${tag}.package-has-dist`, !!(await fs.stat(path.join(extracted, 'dist', 'index.html')).catch(() => null)), 'dist/index.html')
      const env = { ...process.env }
      for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k]
      srv = spawn(process.execPath, [serverJs, '--no-open', '--port', String(PORT), '--root', extracted], { env, stdio: 'ignore' })
      for (let i = 0; i < 60; i++) {
        try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.ok) break } catch { /* 还没起 */ }
        await sleep(250)
      }
    }

    browser = await chromium.launch({ channel: 'msedge', args: ['--no-proxy-server'] })
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)))
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 90_000 }).catch(() => {})
    await sleep(1500)

    await reachWorkspace(page)
    const opened = await openAbout(page)
    check(`${tag}.about-opened`, opened, opened ? '已进入关于打赏' : '找不到「关于打赏」页签')
    if (!opened) {
      const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 600))
      console.log('DIAG 页面文本 ::', t)
      await page.screenshot({ path: path.join(ROOT, `.workbuddy/tmp/${tag}-about-fail.png`) }).catch(() => {})
      return
    }

    const text = await page.evaluate(() => document.body.innerText)
    check(`${tag}.version`, text.includes(`v${VERSION}`), `期望 v${VERSION}`)
    const line = (text.match(/构建于[^\n]*/) || [''])[0]
    check(`${tag}.build-time`, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(line), line || '没有「构建于 …」')
    check(`${tag}.carrier`, new RegExp(EXPECT).test(line), line || `没有「${EXPECT}」字样`)
    const others = ['桌面版', '便携版', '网页版'].filter((x) => x !== EXPECT)
    check(`${tag}.carrier-not-confused`, !others.some((x) => new RegExp(x).test(line)), `不应出现 ${others.join('/')}`)
    check(`${tag}.no-pageerror`, errs.length === 0, errs.join(' | ') || '无 pageerror')
    await page.screenshot({ path: path.join(ROOT, `.workbuddy/tmp/${tag}-about.png`) }).catch(() => {})
    await ctx.close()
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (srv) { srv.kill(); await sleep(300) }
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {})
  }

  const failed = checks.filter((c) => !c.passed)
  console.log(`\nCARRIER ABOUT SUMMARY (${tag}): ${checks.length - failed.length}/${checks.length} passed`)
  if (failed.length) for (const f of failed) console.log('  - ' + f.id + ' :: ' + f.detail)
  process.exit(failed.length ? 1 : 0)
}

await main()
