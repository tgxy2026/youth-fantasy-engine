#!/usr/bin/env node
/**
 * CO-07「不同状态正确汇总」取证 · 空章跳过（3.2.1 T-05）
 *
 * 验的是什么：诊断全书时，**空章要被单独计为「跳过」**，不能混进「已检」，
 * 更不能因为"没查出问题"就显示成一片绿（WQ1 登记的老毛病）。
 *
 * 做法：临时便携 root 载入示范项目 → 往库里注入 2 个空章 → 跑全书优化工单的诊断
 *      （五个本地引擎，零 AI、零额度）→ 抓界面汇总文案 → 产出证据。
 *
 * 🔴 边界：只证明「本地诊断的空章/汇总口径」。CO-07 里「审查失败」「作者跳过条目」
 *    与「批次请求上限」不在此脚本覆盖范围（作者跳过条目当前无 UI 入口，已登记为缺口）。
 *
 * 用法：node scripts/audit/probes/co07-summary-probe.cjs [--port 8832]
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k]

const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const ROOT = path.resolve(__dirname, '..', '..', '..')
const PORT = Number(argOf('--port', '8832'))
const BASE = `http://127.0.0.1:${PORT}`
const DIST = path.join(ROOT, 'dist-verify-t10')
const runId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
const appRoot = path.join(ROOT, '.workbuddy/tmp/co07-app-' + runId)
const outDir = path.join(ROOT, '.workbuddy/tmp/co07-evidence', runId)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const copyDir = (src, dst) => {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d)
  }
}
const asserts = []
const check = (name, ok, detail) => { asserts.push({ name, ok: !!ok, detail }); console.log(ok ? '  PASS' : '  FAIL', name, detail ? ':: ' + detail : '') }
const clickText = (page, text, exact = true) => page.evaluate(([t, ex]) => {
  const hit = [...document.querySelectorAll('button')].find((x) => {
    const s = (x.textContent || '').trim()
    return ex ? s === t : s.includes(t)
  })
  if (hit) { hit.click(); return true }
  return false
}, [text, exact])

;(async () => {
  fs.mkdirSync(outDir, { recursive: true })
  if (!fs.existsSync(DIST)) throw new Error(`缺 ${DIST} —— 先跑 vite build --outDir dist-verify-t10`)
  copyDir(DIST, path.join(appRoot, 'dist'))
  const srv = spawn(process.execPath, [path.join(ROOT, 'scripts/portable-server.mjs'), '--root', appRoot, '--port', String(PORT), '--no-open'], { stdio: 'ignore' })
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/ping')).ok) break } catch {} await sleep(300) }

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const shot = (n) => page.screenshot({ path: path.join(outDir, n + '.png') }).catch(() => {})

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(3500)
  await page.getByRole('button', { name: /先看看示例/ }).first().click()
  await sleep(2500)
  for (const name of [/^下一步$/, /跳过，直接开始/]) {
    const b = page.getByRole('button', { name }).first()
    if (await b.count()) { await b.click(); await sleep(name.source.includes('跳过') ? 4500 : 2000) }
  }
  for (const l of ['稍后再说', '知道了']) { if (await clickText(page, l)) { await sleep(900); break } }

  // 注入 2 个空章（复制首章结构，清空正文）
  const injected = await page.evaluate(async () => {
    const raw = await (await fetch('/api/data')).json()
    const doc = JSON.parse(raw.text || '{}')
    const chapters = doc.stores.chapters || []
    if (!chapters.length) return { ok: false, reason: '没有章节' }
    const base = chapters[0]
    const now = Date.now()
    for (let i = 0; i < 2; i++) {
      chapters.push({
        ...base,
        id: 'empty' + now + i,
        title: `空章测试${i + 1}`,
        content: '',
        summary: '',
        wordCount: 0,
        order: 9000 + i,
        createdAt: now,
        updatedAt: now,
      })
    }
    doc.stores.chapters = chapters
    const r = await fetch('/api/data', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) })
    return { ok: r.status === 200, status: r.status, total: chapters.length }
  })
  check('注入 2 个空章成功', injected.ok, JSON.stringify(injected))

  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(5000)
  for (const l of ['稍后再说', '知道了']) { if (await clickText(page, l)) { await sleep(900); break } }
  if (await page.evaluate(() => /我的作品/.test(document.body.innerText || ''))) {
    await page.getByRole('button', { name: '打开项目' }).first().click().catch(() => {})
    await sleep(4500)
    for (const l of ['稍后再说', '知道了']) { if (await clickText(page, l)) { await sleep(900); break } }
  }

  const nav = await clickText(page, '检查工具')
  check('进入「检查工具」页签', nav)
  await sleep(2500)
  await shot('01-check-tools')

  const genBtn = await clickText(page, '生成工单', false)
  check('找到「生成工单」入口', genBtn)
  // 诊断是本地五引擎，23 章大约几秒；给足 60s
  let done = false
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    const t = await page.evaluate(() => document.body.innerText || '')
    if (/优化工单已生成|诊断完成|条待处理|章没检成/.test(t)) { done = true; break }
  }
  check('诊断跑完（出现汇总文案）', done)
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(e => /已检 \d+ \/ \d+ 章|章空章/.test(e.textContent || '') && e.children.length < 6)
    el?.scrollIntoView({ block: 'center' })
  }).catch(() => {})
  await sleep(600)
  await shot('02-summary')

  const body = await page.evaluate(() => document.body.innerText || '')
  // 🔴 严格匹配同一句「N 章空章，跳过」—— 放宽成 /空章/ + /跳过/ 会被章节名"空章测试1"蒙混过关
  const skipLine = body.match(/[^\n]*\d+\s*章空章[^\n]*跳过[^\n]*/)?.[0] ?? ''
  check('汇总里点名「N 章空章，跳过」而不是算作已检', /\d+\s*章空章/.test(skipLine), skipLine.slice(0, 120) || '(未找到「N 章空章，跳过」)')
  check('汇总里有「已检」口径（覆盖率说明）', /已检/.test(body), body.match(/[^\n]*已检[^\n]*/)?.[0]?.slice(0, 120) ?? '')
  check('没有把空章说成「查过没问题」', !/23\s*章\s*全部通过/.test(body))

  await browser.close()
  srv.kill()

  const passed = asserts.filter((a) => a.ok).length
  const file = path.join(outDir, 'results.json')
  fs.writeFileSync(file, JSON.stringify({
    runId, scope: 'co07 空章跳过汇总（本地诊断）', base: BASE,
    injected, asserts, passed, total: asserts.length,
    at: new Date().toISOString(),
  }, null, 2))
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  console.log(`\nEVIDENCE: ${path.relative(ROOT, file)}\nSHA256: ${sha}\nPASS ${passed}/${asserts.length}`)
  process.exit(passed === asserts.length ? 0 : 1)
})().catch((e) => { console.error('RUN_FAIL', e.message); process.exit(1) })
