#!/usr/bin/env node
/**
 * 网页版「有新版本，刷新以应用」验收（3.6.2 · W1 第 5 条，2026-11-21 收尾）。
 *
 * 【为什么用本地服务而不是改线上清单】规划原文是"把线上 BUILD_ID 改成别的值 → 刷新出现提示"。
 *   两处都不成立，本轮实测后按**实现的实际口径**重写：
 *   ① 线上没有公开的 `/BUILD_ID`（部署脚本会把它 mv 出 dist），客户端读的是清单里的 `webBuildId`；
 *   ② 提示的基线是"这个页面第一次成功取到的 webBuildId"，**刷新后基线就变成新值** ——
 *      所以"改完再刷新"永远不会提示。真实场景是"标签页挂了好几天、期间发了新版"，
 *      触发靠 30 分钟轮询或切回前台（`visibilitychange`）。
 *   所以本脚本验的是：改清单 → 页面不刷新、切回前台 → 提示；点「今天不再提示」→ 当天不再提示。
 *
 * 🔴 隔离：临时复制一份 dist + 临时数据目录，改的是**副本**里的 version.json；
 *    不起公网域名、不碰线上文件。
 *
 * 用法：node scripts/verify/web-update-notice-acceptance.mjs [--port 8801]
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
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
const PORT = Number(arg('--port', '8801'))
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MARK = '网页版有新版本'

const checks = []
const check = (id, ok, detail = '') => {
  checks.push({ id, passed: !!ok, detail: String(detail).slice(0, 300) })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail ? ' :: ' + String(detail).slice(0, 180) : ''))
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true })
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, e.name), to = path.join(dst, e.name)
    if (e.isDirectory()) await copyDir(from, to)
    else await fs.copyFile(from, to)
  }
}

/**
 * 🔴 这版为什么不改 `dist/version.json`：`VERSION_MANIFEST_URL` 是
 *   `${WEB_APP_URL}/version.json`，而 `WEB_APP_URL` 是**写死的线上域名**（downloadLinks.ts）。
 *   改本地副本的文件根本不影响组件读到的内容 —— 前几轮"怎么改都不提示"就是这个原因，
 *   组件一直拿线上那份恒定清单，baseline 与 latest 永远相等。
 *   正确做法是在浏览器层拦这条 URL（网页版是渲染层 fetch，没有主进程桥），返回可变内容。
 */
const MANIFEST_ROUTE = '**/version.json'

/** 伪造"切回前台"：组件读的是 document.visibilityState，事件本身不带状态 */
async function pokeVisible(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

const bannerShown = (page) => page.evaluate((mark) => document.body.innerText.includes(mark), MARK)

async function main() {
  const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/web-notice-'))
  const www = path.join(ROOT, 'dist')
  const data = path.join(runRoot, 'data')
  await fs.mkdir(data, { recursive: true })
  const baseManifest = JSON.parse(await fs.readFile(path.join(www, 'version.json'), 'utf8'))
  const baseId = baseManifest.webBuildId
  /** 拦截层返回的内容：改这个变量就等于"线上发了一版新的" */
  const mutable = { ...baseManifest }
  let body = JSON.stringify(mutable)
  console.log('起始 webBuildId =', baseId)

  const env = { ...process.env, PORT: String(PORT), YFE_WWW: www, YFE_DATA: data }
  delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.http_proxy; delete env.https_proxy
  const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { env, stdio: 'ignore' })
  const stop = async () => {
    srv.kill()
    await sleep(300)
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {})
  }

  let browser = null
  try {
    // 等服务起来
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(BASE + '/version.json'); if (r.ok) break } catch { /* 还没起 */ }
      await sleep(250)
    }

    browser = await chromium.launch({ channel: 'msedge', args: ['--no-proxy-server'] })
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    // 🔴 拦清单：组件读的是线上域名，只有在这里替换才能改变它看到的内容
    await ctx.route(MANIFEST_ROUTE, (route) => route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body }))
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)))
    await page.goto(BASE + '/guest', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 60_000 }).catch(() => {})

    // 首查延迟 8s：等它把基线记下来
    await sleep(11_000)
    /**
     * 🔴 再主动切一次前台：基线是"第一次**成功**取到清单"时才定的，首查如果赶上页面刚起、
     *    fetch 失败，baseline 仍是空 —— 那样后面第一次改清单只会被当成"定基线"而静默，
     *    看起来就像功能坏了（第一轮实测正是如此）。这一步把基线钉死，再变清单才有意义。
     */
    await pokeVisible(page)
    await sleep(2000)
    check('notice.baseline-established', !(await bannerShown(page)), '同一构建基线建立后不提示')

    // ---- ① 改清单 + 切回前台 → 必须提示 ----
    const newId = 'w15-notice-' + Date.now()
    mutable.webBuildId = newId
    body = JSON.stringify(mutable)
    console.log('新 webBuildId =', newId)
    // 先确认**页面里**读到的确实是新值（别把"拦截没生效"当成"没变化"）
    const served = await page.evaluate(async () => {
      try { return (await (await fetch('https://youth-fantasy-engine.online/version.json', { cache: 'no-store' })).json()).webBuildId } catch (e) { return 'err:' + String(e).slice(0, 40) }
    }).catch(() => 'err')
    check('notice.manifest-served-new', served === newId, `页面读到 ${served}`)

    /**
     * 用**真实切 tab**制造 visibilitychange：先切到另一个页签（本页变 hidden），再切回来。
     * 直接 defineProperty 改 visibilityState 虽然能派发事件，但组件里 `document.visibilityState`
     * 已经被第一次覆盖定死，再改不会重新求值 —— 实测派发了事件却始终不提示，
     * 分不清是"事件没到"还是"状态没变"。切 tab 是浏览器自己改状态，最接近真实场景。
     */
    const other = await ctx.newPage()
    await other.goto('about:blank')
    await other.bringToFront()
    await sleep(800)
    await page.bringToFront()
    await sleep(1200)
    await pokeVisible(page)
    await sleep(1500)
    const shown = await bannerShown(page)
    check('notice.prompt-shown', shown, shown ? '出现「网页版有新版本，刷新即可用上」' : '切回前台后仍未提示')
    if (!shown) {
      // 三层诊断：载体标志、事件是否真的派发到 document、普通 fetch（不带 no-store）读到什么
      const diag = await page.evaluate(async () => {
        const flags = { web: window.__YFE_WEB__, guest: window.__YFE_GUEST__, portable: window.__YFE_PORTABLE__ }
        let via = 0
        document.addEventListener('visibilitychange', () => { via++ })
        document.dispatchEvent(new Event('visibilitychange'))
        let plain = '(取不到)'
        let fresh = '(取不到)'
        try { plain = (await fetch('/version.json').then((r) => r.json())).webBuildId } catch (e) { plain = 'err ' + String(e).slice(0, 40) }
        try { fresh = (await fetch('/version.json', { cache: 'no-store' }).then((r) => r.json())).webBuildId } catch (e) { fresh = 'err ' + String(e).slice(0, 40) }
        return { flags, via, plain, fresh, statusNodes: document.querySelectorAll('[role="status"]').length }
      }).catch((e) => ({ err: String(e).slice(0, 120) }))
      console.log('DIAG 提示未出现 ::', JSON.stringify(diag))
    }

    if (shown) {
      // ---- ② 点「今天不再提示」→ 当天不再出现 ----
      const dismiss = page.getByRole('button', { name: /今天不再提示/ }).first()
      const canDismiss = await dismiss.isVisible().catch(() => false)
      check('notice.dismiss-button', canDismiss, canDismiss ? '按钮可见' : '找不到「今天不再提示」')
      if (canDismiss) {
        await dismiss.evaluate((el) => el.click()).catch(() => {})
        await sleep(600)
        check('notice.hidden-after-dismiss', !(await bannerShown(page)), '点完立刻消失')
        await pokeVisible(page)
        await sleep(1200)
        check('notice.stays-hidden-today', !(await bannerShown(page)), '再次切回前台也不再出现')
      }
    }

    // ---- ③ 新会话（干净 localStorage）：基线=当前清单 → 不提示 ----
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await ctx2.route(MANIFEST_ROUTE, (route) => route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body }))
    const page2 = await ctx2.newPage()
    await page2.goto(BASE + '/guest', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page2.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 60_000 }).catch(() => {})
    await sleep(11_000)
    await pokeVisible(page2)
    await sleep(1200)
    check('notice.no-prompt-same-build', !(await bannerShown(page2)), '打开时就是最新清单 ⇒ 不提示')

    check('notice.no-pageerror', errs.length === 0, errs.join(' | ') || '无 pageerror')
    await ctx2.close()
    await ctx.close()
  } finally {
    if (browser) await browser.close().catch(() => {})
    await stop()
  }

  const failed = checks.filter((c) => !c.passed)
  console.log(`\nWEB NOTICE SUMMARY: ${checks.length - failed.length}/${checks.length} passed`)
  if (failed.length) for (const f of failed) console.log('  - ' + f.id + ' :: ' + f.detail)
  process.exit(failed.length ? 1 : 0)
}

await main()
