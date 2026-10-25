#!/usr/bin/env node
/**
 * AI-01 拒答呈现 + AI-06 首字分布 取证（3.2.1 T-01 / T-03）
 *
 * 做法：起**本地假模型服务**（`mock-model-server.cjs`，可控拒答/慢首字），
 *      用临时便携 root 起真前端，注入模型配置后驱动系统 Edge 触发 AI 伴写。
 *
 * 🔴 口径边界（不得扩写）：
 *   · 这里证明的是「给定这种响应，客户端怎么呈现」；
 *   · **不代表真实端点已验证** —— 官方/中转/Ollama 三端点仍须主人提供端点与额度。
 *
 * 用法：
 *   node scripts/audit/probes/ai-refusal-probe.cjs [--port 8802] [--mock-port 8799]
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k]

const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const ROOT = path.resolve(__dirname, '..', '..', '..')
const PORT = Number(argOf('--port', '8802'))
const MOCK_PORT = Number(argOf('--mock-port', '8799'))
const BASE = `http://127.0.0.1:${PORT}`
const MOCK = `http://127.0.0.1:${MOCK_PORT}`
/** 证实用新构建（`dist/` 是发布产物，不含新代码） */
const DIST = path.join(ROOT, 'dist-verify-t10')

const runId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
const appRoot = path.join(ROOT, '.workbuddy/tmp/ai-app-' + runId)
const outDir = path.join(ROOT, '.workbuddy/tmp/ai-evidence', runId)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const copyDir = (src, dst) => {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d)
  }
}

const asserts = []
const check = (name, ok, detail) => {
  asserts.push({ name, ok: !!ok, detail })
  console.log(ok ? '  PASS' : '  FAIL', name, detail ? ':: ' + detail : '')
}
const setMode = (m) => fetch(MOCK + '/_mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: m }) })
const stats = async () => (await (await fetch(MOCK + '/_stats')).json()).requests

const clickText = (page, text, exact = true) => page.evaluate(([t, ex]) => {
  const hit = [...document.querySelectorAll('button')].find((x) => {
    const s = (x.textContent || '').trim()
    return ex ? s === t : s.includes(t)
  })
  if (hit) { hit.click(); return true }
  return false
}, [text, exact])

async function closeModal(page) {
  const t = await page.evaluate(() => {
    const m = document.querySelector('.fixed.inset-0')
    return m ? (m.innerText || '').slice(0, 60) : ''
  })
  if (!t) return ''
  for (const label of ['稍后再说', '知道了', '关闭', '取消', '好的']) {
    if (await clickText(page, label)) { await sleep(1000); return label }
  }
  await page.keyboard.press('Escape')
  await sleep(500)
  return 'escape'
}

;(async () => {
  fs.mkdirSync(outDir, { recursive: true })
  if (!fs.existsSync(DIST)) throw new Error(`缺 ${DIST} —— 先跑 vite build --outDir dist-verify-t10`)
  copyDir(DIST, path.join(appRoot, 'dist'))

  const mockSrv = spawn(process.execPath, [path.join(__dirname, 'mock-model-server.cjs'), '--port', String(MOCK_PORT)], { stdio: 'ignore' })
  const appSrv = spawn(process.execPath, [path.join(ROOT, 'scripts/portable-server.mjs'), '--root', appRoot, '--port', String(PORT), '--no-open'], { stdio: 'ignore' })
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/api/ping')).ok && (await fetch(MOCK + '/_stats')).ok) break } catch {}
    await sleep(300)
  }

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  // 伴写总开关存在 localStorage（默认关）—— 取证需要它开着
  await ctx.addInitScript(() => { try { localStorage.setItem('novel-companion', '1') } catch {} })
  const page = await ctx.newPage()
  /** 抓真实请求体：区分'伴写'与'precheck/其他旁路'，否则断言失败时说不清是谁发的 */
  page.on('console', (m) => { const t = m.text(); if (t.includes('[PROBE]')) console.log('  [console]', t) })
  const wire = []
  page.on('request', (r) => {
    if (!r.url().includes('/chat/completions')) return
    let body = r.postData() || ''
    let brief = ''
    try { const j = JSON.parse(body); brief = JSON.stringify({ stream: j.stream, model: j.model, roles: (j.messages || []).map(m => m.role), firstSystem: String((j.messages || []).find(m => m.role === 'system')?.content || '').slice(0, 60), lastUser: String([...(j.messages || [])].reverse().find(m => m.role === 'user')?.content || '').slice(0, 60) }) } catch { brief = body.slice(0, 120) }
    wire.push(brief)
  })
  const shot = (n) => page.screenshot({ path: path.join(outDir, n + '.png') }).catch(() => {})

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(3500)
  await page.getByRole('button', { name: /先看看示例/ }).first().click()
  await sleep(2500)
  for (const name of [/^下一步$/, /跳过，直接开始/]) {
    const b = page.getByRole('button', { name }).first()
    if (await b.count()) { await b.click(); await sleep(name.source.includes('跳过') ? 4500 : 2000) }
  }
  await closeModal(page)

  // 注入假模型配置（走整库 meta，不点 UI：配置链路本身有单测覆盖，这里要验的是呈现）
  const injected = await page.evaluate(async (mockBase) => {
    // 🔴 便携服务 3.2.5 起要求条件写（缺 If-Match ⇒ 428），探针必须跟着守协议
    const current = await fetch('/api/data')
    const raw = await current.json()
    const revision = raw.revision || current.headers.get('etag')
    const doc = JSON.parse(raw.text || '{}')
    doc.stores = doc.stores || {}
    const provider = {
      id: 'mock', name: '假服务（取证）', type: 'openai',
      baseUrl: mockBase + '/v1', apiKey: 'mock-key', model: 'mock-model',
      contextWindow: 32000, local: true,
    }
    const meta = (doc.stores.meta || []).filter((m) => m.key !== 'aiProviders' && m.key !== 'aiActiveProviderId')
    meta.push({ key: 'aiProviders', value: [provider] }, { key: 'aiActiveProviderId', value: 'mock' })
    doc.stores.meta = meta
    const r = await fetch('/api/data', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(revision ? { 'If-Match': revision } : {}) },
      body: JSON.stringify(doc),
    })
    return { status: r.status, hasProviders: true, hasRevision: !!revision }
  }, MOCK)
  check('假模型配置注入成功（整库 meta，带版本）', injected.status === 200 && injected.hasRevision === true, JSON.stringify(injected))

  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(5000)
  await closeModal(page)
  // 重载后会停在「项目管理」（不是工作台）—— 先点项目卡进去
  const onList = await page.evaluate(() => /我的作品/.test(document.body.innerText || ''))
  if (onList) {
    await page.getByRole('button', { name: '打开项目' }).first().click().catch(() => {})
    await sleep(4500)
    await closeModal(page)
  }
  const entered = await clickText(page, '正文编辑')
  check('进入正文编辑', entered)
  await sleep(3500)
  await closeModal(page)
  await shot('01-editor')

  const ta = page.locator('textarea.novel-textarea').first()
  await ta.click()
  await page.keyboard.press('Control+End')

  /** 触发一次伴写（Alt+\ 手动）并等待请求或 ghost */
  const trigger = async (label) => {
    const before = (await stats()).length
    await page.keyboard.press('Alt+Backslash')
    for (let i = 0; i < 30; i++) {
      await sleep(300)
      if ((await stats()).length > before) return true
    }
    console.log(`  (${label}) 未观察到模型请求`)
    return false
  }

  // ---------- T-03 首字分布：normal ×3 ----------
  await setMode('normal')
  const normalTs = []
  for (let i = 0; i < 3; i++) {
    const fired = await trigger('normal-' + i)
    if (!fired) break
    await sleep(1200)
  }
  // ---------- T-03：slow（首字节 2500ms）----------
  await setMode('slow')
  const firedSlow = await trigger('slow')
  await sleep(3500)

  const all = await stats()
  for (const r of all) if (r.firstByteAt) normalTs.push({ mode: r.mode, firstByte: r.firstByteAt - r.arrivedAt })
  const fastOnes = normalTs.filter((x) => x.mode === 'normal').map((x) => x.firstByte)
  const slowOne = normalTs.find((x) => x.mode === 'slow')?.firstByte
  check('AI-06：正常模式确实收到流式响应', fastOnes.length >= 1, `样本 ${fastOnes.length} 条：${fastOnes.join('/')} ms`)
  check('AI-06：慢首字注入被如实记录（≥2000ms）', firedSlow && (slowOne ?? 0) >= 2000, `slow 首字节 ${slowOne ?? '未取到'} ms`)
  check('AI-06：正常与慢速可区分（相差一个量级）',
    fastOnes.length > 0 && (slowOne ?? 0) > Math.max(...fastOnes) * 3,
    `normal 最大 ${fastOnes.length ? Math.max(...fastOnes) : '?'} ms vs slow ${slowOne ?? '?'} ms`)

  // ---------- T-01 拒答呈现 ----------
  await setMode('refusal')
  const firedRefusal = await trigger('refusal')
  check('AI-01：拒答请求已发出', firedRefusal)
  // toast 8 秒才消失 —— 多点采样，既抓得快也不漏
  const samples = []
  for (let i = 0; i < 14; i++) {
    await sleep(600)
    const t = await page.evaluate(() => document.body.innerText || '')
    if (/内容政策|被平台|拒答|无法协助|伴写已连续失败|失败/.test(t)) samples.push(t)
  }
  const textAfter = samples[0] ?? await page.evaluate(() => document.body.innerText || '')
  await shot('02-refusal-toast')
  const toastDump = await page.evaluate(() => [...document.querySelectorAll('div')].filter((d) => /fixed/.test(String(d.className || '')) && (d.innerText || '').trim()).map((d) => (d.innerText || '').trim().slice(0, 120)).slice(0, 6))
  console.log('  fixed 容器文本：', JSON.stringify(toastDump))
  const allReq = await stats()
  console.log('  mock 请求：', JSON.stringify(allReq.map(r => ({ mode: r.mode, stream: r.stream, responded: r.responded }))))
  console.log('  线缆请求体：', JSON.stringify(wire.slice(-6)))
  check('AI-01：界面说明这是内容政策拒绝（不是配置错）',
    /内容政策/.test(textAfter), textAfter.match(/[^\n]*内容政策[^\n]*/)?.[0]?.slice(0, 120) ?? '(未找到)')
  check('AI-01：明确写「不是你的密钥 / 模型名 / 参数配置出错」',
    /不是你的密钥/.test(textAfter))
  check('AI-01：拒答不当作正文写进编辑器',
    await page.evaluate(() => !(document.querySelector('textarea.novel-textarea')?.value || '').includes('我无法协助')),
  )

  const requestsSnapshot = await stats().catch(() => [])
  await browser.close()
  try { mockSrv.kill() } catch {}
  try { appSrv.kill() } catch {}

  const passed = asserts.filter((a) => a.ok).length
  const payload = {
    runId, profile: 'portable', base: BASE, mock: MOCK,
    environment: `Windows · Playwright headless(msedge) · mock-model-server :${MOCK_PORT} · portable-server :${PORT}`,
    /** 首字分布原始数据（AI-06 证据；真实端点仍待主人） */
    firstByteSamples: normalTs,
    wireBodies: wire,
    mockRequests: requestsSnapshot,
    asserts, passed, total: asserts.length,
    scope: 'local-fake-endpoint：只证明呈现与计时链路，不等于真实端点验证',
  }
  const file = path.join(outDir, 'results.json')
  fs.writeFileSync(file, JSON.stringify(payload, null, 2))
  const sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  console.log(`\nEVIDENCE: ${path.relative(ROOT, file)}`)
  console.log('SHA256:', sha)
  console.log(`PASS ${passed}/${asserts.length}`)
  process.exit(passed === asserts.length ? 0 : 1)
})().catch((e) => { console.error('RUN_FAIL', e.message); process.exit(1) })
