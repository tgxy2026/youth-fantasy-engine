#!/usr/bin/env node
// 六维审计契约 draft.failure 的证据生产者（3.2.3 起随仓入库）。
//
// 契约原文：「旧草稿保存失败时不换选择、不关闭导入、不丢原编辑」。
// 真实路径（OutlineSheet.switchTo）：切卡前先 `saveCardRecord(旧草稿)`，抛错 ⇒ toast +
// **不 setActiveId**，作者留在原处、编辑仍在。
//
// 取证方式：真实浏览器（vite dev server + 示范项目），只给 IDBObjectStore.put 加一层
// 「仅拦截目标卡名」的失败注入 —— 不碰产品代码、不改保存结果、不动真实书库（示范项目在临时上下文）。
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(import.meta.url)
const { sourceFingerprint } = require('../audit/context.cjs')
const PORT = Number(process.env.YFE_PROBE_PORT || 5227)
const TAB_ID = 'chapter-outline'
const TYPED = '注入失败后这段编辑必须还在'

/** 页面上找「目录卡片」：带 title 且内含 span.truncate 的可点区域 */
const CARD_SELECTOR = '[title]'

async function main() {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[key]
  const outDir = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/draft-failure-'))
  const artifact = path.join(outDir, 'draft-failure-evidence.json')
  const cases = []
  const fail = []
  const record = (kase, ok, detail) => {
    cases.push({ case: kase, ok, ...detail })
    if (!ok) fail.push(kase + ': ' + detail.reason)
  }
  const pageErrors = []
  let vite, browser, dirtyBeforeSwitch = false, patchInPlace = null

  try {
    const { createServer } = await import('vite')
    vite = await createServer({
      root: ROOT, cacheDir: path.join(outDir, 'vite-cache'), logLevel: 'silent',
      server: { host: '127.0.0.1', port: PORT, strictPort: true },
    })
    await vite.listen()
    const origin = 'http://127.0.0.1:' + PORT
    /**
     * 🔴 `vite.listen()` 返回只代表监听成功，**首屏模块图还没编译好**。
     *    在完整验收里（前面刚跑完 Electron + 多个浏览器）第一次请求常要几十秒，
     *    直接 goto 会 60s 超时 —— 实测 `draft.failure` 因此整步红（reliability-MEqZl9）。
     *    这里先轮询一个页面请求，确认 dev server 真能出 HTML 再开浏览器。
     */
    {
      const deadline = Date.now() + 90000
      let ready = false
      while (Date.now() < deadline) {
        try {
          const r = await fetch(origin + '/', { signal: AbortSignal.timeout(5000) })
          if (r.ok) { ready = true; break }
        } catch { /* 还在编译 */ }
        await new Promise(r => setTimeout(r, 500))
      }
      if (!ready) throw new Error('vite dev server 90 秒内没有返回首页')
    }
    const { chromium } = require('playwright')
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    page.setDefaultTimeout(20000)
    page.on('pageerror', (e) => pageErrors.push(String(e.message)))

    // 🔴 60s 不够：vite 冷缓存 + 机器正忙时，首屏模块图编译会顶到 60s 边界
    //    （实测 reliability-T7pF8Z：整个 audit.contracts 就挂在这一步，单独重跑又 3/3 通过）。
    //    这是取证工具的等待上限，不是被测行为 —— 放宽到 120s。
    /**
     * 与 `mono-charts` 同口径：`domcontentloaded` 要等模块脚本执行完，冷缓存 + 机器忙时会顶穿。
     * 改成「文档提交 + 等 React 真挂上 #root」，并且**把超时留给真正的首屏可用**。
     */
    await page.goto(origin, { waitUntil: 'commit', timeout: 120000 })
    await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 180000 })
    // 示范项目：真实入口「先看看示例」
    await page.getByRole('button', { name: /先看看示例/ }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
    await page.getByRole('navigation').waitFor()
    const later = page.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.isVisible().catch(() => false)) await later.click()

    // 切到章节细纲（走真实应用事件，与布局巡检同口径）
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent('yfe:navigate', { detail: id })), TAB_ID)
    await page.getByPlaceholder(/^搜.*名…$/).waitFor()

    // 目录列表：每张卡是带 title 的可点区域；至少要有两张才能验「不换选择」
    await page.waitForFunction((selector) => {
      const nodes = [...document.querySelectorAll(selector)].filter((n) => n.querySelector('span.truncate'))
      return nodes.length >= 2
    }, CARD_SELECTOR, { timeout: 30000 })

    const cards = page.locator(CARD_SELECTOR).filter({ has: page.locator('span.truncate') })
    const names = await cards.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('title') || ''))
    const first = names[0]
    const second = names[1]
    if (!first || !second) throw new Error('读不到卡片标题：' + JSON.stringify(names))

    // 选中第一张
    await cards.nth(0).click()
    const fields = page.getByPlaceholder('点击填写…')
    await fields.first().waitFor()
    const fieldCount = await fields.count()
    if (fieldCount < 2) throw new Error('章节卡可用字段不足两个，无法避开「名称」字段')

    // 🔴 先装注入、再编辑：产品在输入后有自动保存，若等输入完才注入，那次自动保存已经成功、
    //    卡片就变干净了，切卡时自然没有「旧草稿」可存（第一轮就是这么假红的）。
    await page.evaluate((target) => {
      window.__draftProbe = { hit: 0, seen: [] }
      const proto = IDBObjectStore.prototype
      const original = proto.put
      proto.put = function patched(value, key) {
        const rec = value || {}
        if (window.__draftProbe.seen.length < 20) window.__draftProbe.seen.push(this.name + ':' + String(rec.name || ''))
        if (this.name === 'cardRecords' && rec.name === target) {
          window.__draftProbe.hit += 1
          throw new DOMException('probe injected write failure', 'UnknownError')
        }
        return key === undefined ? original.call(this, value) : original.call(this, value, key)
      }
    }, first)
    patchInPlace = await page.evaluate(() => ({ name: IDBObjectStore.prototype.put.name, hasProbe: !!window.__draftProbe }))

    // 🔴 改的是**第二个**字段，不是第一个 —— 第一个是「姓名」，改它会把卡片 name 也改掉，
    //    注入条件（按 name 命中）就再也对不上了。真实键入而不是 fill：AutoTextarea 是受控组件。
    const field = fields.nth(1)
    await field.click()
    await field.pressSequentially(TYPED, { delay: 12 })
    await page.waitForTimeout(900)
    // 切卡前确认「这张卡仍是脏的」——自动保存必须真的失败，否则这里就干净了
    dirtyBeforeSwitch = await page.evaluate((selector) => {
      const nodes = [...document.querySelectorAll(selector)].filter((n) => n.querySelector('span.truncate'))
      const active = nodes.find((n) => (n.className || '').includes('bg-amber/15'))
      return active ? !!active.querySelector('[title*="未保存"]') : false
    }, CARD_SELECTOR)
    if (!dirtyBeforeSwitch) throw new Error('键入后卡片没有保持脏状态（自动保存没被注入拦住）—— 无法验证切换守卫')

    // ===== 关键动作：点第二张卡 =====
    await cards.nth(1).click()
    await page.waitForTimeout(700)
    const probeState = await page.evaluate(() => (window.__draftProbe ? { hit: window.__draftProbe.hit, seen: window.__draftProbe.seen } : { hit: 0, seen: [] }))
    const hit = probeState.hit

    // ① 注入确实命中了旧草稿的写入
    record('save-failure', hit >= 1, {
      hit, targetCard: first, patchInPlace, seenPuts: probeState.seen,
      reason: hit >= 1 ? undefined : '注入一次都没命中 —— 说明切换时根本没有尝试保存旧草稿',
    })

    // ② 选择没有换：仍停在第一张（活跃卡带 bg-amber/15）
    const activeTitle = await page.evaluate((selector) => {
      const nodes = [...document.querySelectorAll(selector)].filter((n) => n.querySelector('span.truncate'))
      const active = nodes.find((n) => (n.className || '').includes('bg-amber/15'))
      return active ? active.getAttribute('title') || '' : ''
    }, CARD_SELECTOR)
    record('preserve-selection', activeTitle === first, {
      activeTitle, expected: first,
      reason: activeTitle === first ? undefined : '选择被换到了「' + activeTitle + '」（应当留在「' + first + '」）',
    })

    // ③ 原编辑还在、dirty 仍在（写盘失败不等于编辑蒸发）
    // 🔴 用 includes 而不是全等：pressSequentially 是**在光标处插入**，字段原本就有内容时
    //    值会是「原文 + 键入」，全等比较会把「编辑确实还在」误判成「编辑消失」。
    const stillTyped = await page.evaluate((typed) => {
      const inputs = [...document.querySelectorAll('input, textarea')]
      return inputs.some((i) => (i.value || '').includes(typed))
    }, TYPED)
    const dirtyDot = await page.evaluate((selector) => {
      const nodes = [...document.querySelectorAll(selector)].filter((n) => n.querySelector('span.truncate'))
      const active = nodes.find((n) => (n.className || '').includes('bg-amber/15'))
      return active ? !!active.querySelector('[title*="未保存"]') : false
    }, CARD_SELECTOR)
    record('preserve-storage', stillTyped && dirtyDot, {
      stillTyped, dirtyDot,
      reason: stillTyped
        ? (dirtyDot ? undefined : '编辑还在但「未保存」标记消失了（下次切换会被当成干净卡片直接丢掉）')
        : '编辑内容已从界面消失',
    })

    await page.screenshot({ path: path.join(outDir, 'draft-failure.png') })
  } catch (e) {
    record('save-failure', false, { reason: String(e && e.message ? e.message : e) })
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (vite) await vite.close().catch(() => {})
    const passed = cases.filter((c) => c.ok).length
    const payload = {
      schemaVersion: 1, contract: 'draft.failure', at: new Date().toISOString(),
      sourceFingerprint: sourceFingerprint(ROOT), tab: TAB_ID,
      injection: 'patch IDBObjectStore.prototype.put：仅命中 cardRecords 中指定卡名的记录',
      scope: '真实浏览器 + vite dev server + 示范项目（临时上下文，未写真实书库）',
      samples: cases.length, passed, failed: cases.length - passed, failures: fail, cases, pageErrors, dirtyBeforeSwitch, patchInPlace,
    }
    await fs.writeFile(artifact, JSON.stringify(payload, null, 2)).catch(() => {})
    console.log('DRAFT_FAILURE samples=' + cases.length + ' passed=' + passed + ' failed=' + payload.failed)
    console.log('artifact=' + path.relative(ROOT, artifact).replaceAll('\\', '/'))
    if (payload.failed) { for (const f of fail) console.error('FAIL ' + f); process.exitCode = 1 }
  }
}

main().catch((e) => { console.error('DRAFT_FAILURE failed: ' + (e && e.stack ? e.stack : e)); process.exitCode = 1 })
