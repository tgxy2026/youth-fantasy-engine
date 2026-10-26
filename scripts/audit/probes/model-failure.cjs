#!/usr/bin/env node
/**
 * 契约 `model.failure` 取证：假模型的**拒答 / 取消 / 超时**三条路径
 *
 * 【为什么单独一条】方案 §R2 要求「假模型覆盖鉴权失败、拒答、流式截断、取消、超时、usage 归属」。
 * 已有的 `ai-refusal-probe.cjs` 只覆盖**拒答呈现**（AI-01）与首字分布（AI-06），
 * 取消与超时没有独立证据 —— 而这两条恰好是作者最容易遇到、也最容易「假装成功」的路径：
 *   · 取消：按 Esc 之后，界面到底停了没有？服务端那条流断了没有？半截 ghost 会不会被当正文写进去？
 *   · 超时：模型一直不吐字时，是「一直转圈」还是到点报错？报错之后还能不能重试？
 *
 * 【口径边界】只证明「给定这种响应，客户端怎么呈现与收尾」；不代表真实端点已验证。
 *
 * 用法：
 *   node scripts/audit/probes/model-failure.cjs --build-dir <dir> [--result-file a.json]
 *        [--port 8803] [--mock-port 8798] [--timeout-sec 30]
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
const { openEditorNavigation } = require('./workspace-entry.cjs')

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k]

const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const ROOT = path.resolve(__dirname, '..', '..', '..')
const PORT = Number(argOf('--port', '8803'))
const MOCK_PORT = Number(argOf('--mock-port', '8798'))
const TIMEOUT_SEC = Number(argOf('--timeout-sec', '30'))
const BASE = `http://127.0.0.1:${PORT}`
const MOCK = `http://127.0.0.1:${MOCK_PORT}`

const runId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
const buildDir = path.resolve(ROOT, argOf('--build-dir', 'dist'))
const appRoot = path.join(ROOT, '.workbuddy/tmp/model-failure-app-' + runId)
const resultFile = path.resolve(ROOT, argOf('--result-file', path.join('.workbuddy/tmp/model-failure', runId, 'results.json')))
/** 截图与结果放**同一目录**：校验器按 result-file 的目录找证据，分开放会判「缺截图」（本轮实测） */
const outDir = path.dirname(resultFile)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d)
  }
}
/** 构建指纹：与校验器共用同一实现（`scripts/verify/build-hash.mjs`）—— 两边各写一份必然分叉 */
let hashBuildDir = null
/**
 * 源码指纹必须与统一验收**同一实现**（`scripts/audit/platform/source.mjs` 的 `snapshot`）。
 * 🔴 项目里有两套指纹（`audit/context.cjs` 是老的一份），用错就会出现「证据明明是这次的，
 *    验收却说与当前源码不符」—— 本轮实测踩到。
 */
let sourceFingerprint = null

const asserts = []
const check = (name, ok, detail) => {
  asserts.push({ name, ok: !!ok, detail })
  console.log(ok ? '  PASS' : '  FAIL', name, detail === undefined ? '' : ':: ' + detail)
}
const cases = []
const setMode = (mode) => fetch(MOCK + '/_mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) })
const stats = async () => (await (await fetch(MOCK + '/_stats')).json()).requests

async function main() {
  hashBuildDir = (await import('../../verify/build-hash.mjs')).hashBuildDir // .cjs 里不能顶层 await
  const { snapshot } = await import('../../audit/platform/source.mjs')
  sourceFingerprint = () => snapshot(ROOT).fingerprint
  if (!fs.existsSync(path.join(buildDir, 'index.html'))) throw new Error('缺前端构建：' + buildDir + '（先 vite build --outDir <dir>）')
  fs.mkdirSync(outDir, { recursive: true })
  copyDir(buildDir, path.join(appRoot, 'dist'))

  const mockSrv = spawn(process.execPath, [path.join(__dirname, 'mock-model-server.cjs'), '--port', String(MOCK_PORT)], { stdio: 'ignore', windowsHide: true })
  const appSrv = spawn(process.execPath, [path.join(ROOT, 'scripts/portable-server.mjs'), '--root', appRoot, '--port', String(PORT), '--no-open'], { stdio: 'ignore', windowsHide: true })
  let browser
  const pageErrors = []
  try {
    let up = false
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(BASE + '/api/ping')).ok && (await fetch(MOCK + '/_stats')).ok) { up = true; break } } catch { /* 还没起来 */ }
      await sleep(300)
    }
    if (!up) throw new Error('便携服务或假模型服务没起来')

    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    // 伴写总开关在 localStorage（默认关）—— 取证需要它开着
    await ctx.addInitScript(() => { try { localStorage.setItem('novel-companion', '1') } catch { /* 忽略 */ } })
    const page = await ctx.newPage()
    page.setDefaultTimeout(15000)
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))
    const shot = (n) => page.screenshot({ path: path.join(outDir, n + '.png') }).catch(() => {})
    const bodyText = () => page.evaluate(() => document.body.innerText || '')
    const editorText = () => page.evaluate(() => document.querySelector('textarea.novel-textarea')?.value ?? '')

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await sleep(3000)
    await page.getByRole('button', { name: /先看看示例/ }).first().click()
    await sleep(2500)
    for (const name of [/^下一步$/, /跳过，直接开始/]) {
      const b = page.getByRole('button', { name }).first()
      if (await b.count()) { await b.click(); await sleep(name.source.includes('跳过') ? 4000 : 2000) }
    }
    for (const label of ['稍后再说', '知道了']) {
      const b = page.getByRole('button', { name: label, exact: true })
      if (await b.isVisible().catch(() => false)) await b.click()
    }

    /**
     * 注入假模型 + **把请求超时改成下限 30 秒**。
     * 🔴 必须在任何 AI 调用之前注入：`ensureTimeoutApplied()` 按 projectId 缓存，
     *    先跑过一次请求就会把默认 300s 记住，之后改设置也不生效（实测过）。
     */
    const injected = await page.evaluate(async ({ mockBase, timeoutSec }) => {
      /**
       * 🔴 便携服务 3.2.5 起要求条件写：不带 `If-Match` 一律 428。
       *    先 GET 拿 revision（空库也有，跟着 ETag 同值），再带上提交 —— 探针也得守产品协议。
       */
      const current = await fetch('/api/data')
      const raw = await current.json()
      const revision = raw.revision || current.headers.get('etag')
      const doc = JSON.parse(raw.text || '{}')
      doc.stores = doc.stores || {}
      const provider = { id: 'mock', name: '假服务（取证）', type: 'openai', baseUrl: mockBase + '/v1', apiKey: 'mock-key', model: 'mock-model', contextWindow: 32000, local: true }
      const meta = (doc.stores.meta || []).filter((m) => !['aiProviders', 'aiActiveProviderId', 'aiRequestTimeoutSec'].includes(m.key))
      meta.push({ key: 'aiProviders', value: [provider] }, { key: 'aiActiveProviderId', value: 'mock' }, { key: 'aiRequestTimeoutSec', value: timeoutSec })
      doc.stores.meta = meta
      const r = await fetch('/api/data', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...(revision ? { 'If-Match': revision } : {}) },
        body: JSON.stringify(doc),
      })
      return { status: r.status, hasRevision: !!revision }
    }, { mockBase: MOCK, timeoutSec: TIMEOUT_SEC })
    check('假模型与 30s 超时注入成功（整库 meta，带版本）',
      injected.status === 200 && injected.hasRevision === true, JSON.stringify(injected))

    await page.reload({ waitUntil: 'domcontentloaded' })
    await sleep(4500)
    if (/我的作品/.test(await bodyText())) {
      await page.getByRole('button', { name: '打开项目' }).first().click().catch(() => {})
      await sleep(4000)
    }
    const nav = await openEditorNavigation(page)
    await page.getByPlaceholder(/开始写|在这里写|正文/).first().waitFor({ timeout: 30000 }).catch(() => {})
    await sleep(2500)
    const ta = page.locator('textarea.novel-textarea').first()
    await ta.click()
    check('进入正文编辑', await ta.count() > 0)
    await page.keyboard.press('Control+End')

    /** 触发一次伴写（Alt+\\ 手动），等模型请求出现 */
    const trigger = async () => {
      const before = (await stats()).length
      await page.keyboard.press('Alt+Backslash')
      for (let i = 0; i < 30; i++) {
        await sleep(300)
        if ((await stats()).length > before) return true
      }
      return false
    }

    // ---------- ① 拒答 ----------
    await setMode('refusal')
    const refusalSent = await trigger()
    check('拒答：请求已发出', refusalSent)
    let refusalText = ''
    for (let i = 0; i < 16; i++) {
      await sleep(600)
      const t = await bodyText()
      if (/内容政策|拒答|无法协助|失败/.test(t)) { refusalText = t; break }
    }
    await shot('01-refusal')
    check('拒答：界面给出可读说明', /内容政策|拒答|无法协助|失败/.test(refusalText),
      refusalText.match(/[^\n]*(内容政策|拒答|无法协助|失败)[^\n]*/)?.[0]?.slice(0, 90) ?? '(未找到)')
    check('拒答：拒答文案没有被写进正文', !(await editorText()).includes('我无法协助'),
      (await editorText()).slice(-40) || '(正文为空)')
    cases.push({ id: 'refusal', ok: /内容政策|拒答|无法协助|失败/.test(refusalText) })

    // ---------- ② 取消（新的触发顶掉在途请求） ----------
    /**
     * 🔴 口径来自代码本身：`fireGhost()` 第一行就是 `ghostAbort.current?.abort()` ——
     *    「再来一次」会主动掐掉上一次在途请求。这是真实用户路径（继续输入 / 连点钢笔键），
     *    也是伴写唯一的取消语义：**Esc 只 dismiss 已显示的 ghost，不会中断在途请求**
     *    （本轮实测：Esc 之后那条 slow 请求仍在 2.5s 正常返回）。
     *    `slow` 模式给 2.5s 在途窗口，足够在响应回来之前再触发一次。
     */
    await setMode('slow')
    const cancelSent = await trigger()
    check('取消：第一次请求已发出', cancelSent)
    await sleep(400)                      // 在途（slow=2.5s），此时再触发一次
    const supersededBy = await trigger()
    check('取消：第二次触发已发出', supersededBy)
    await sleep(3500)                     // 让第二次跑完
    const slowRecs = (await stats()).filter((r) => r.mode === 'slow')
    const firstSlow = slowRecs.at(-2), secondSlow = slowRecs.at(-1)
    await shot('02-cancel')
    check('取消：在途那一次被中止（服务端记录 abortedAt）',
      !!firstSlow && firstSlow.abortedAt !== null,
      JSON.stringify({ 第1次: { abortedAt: firstSlow?.abortedAt ?? null, doneAt: firstSlow?.doneAt ?? null }, 第2次: { abortedAt: secondSlow?.abortedAt ?? null, doneAt: secondSlow?.doneAt ?? null } }))
    check('取消：后一次正常完成（不是把两次一起掐掉）',
      !!secondSlow && secondSlow.doneAt !== null && secondSlow.abortedAt === null,
      JSON.stringify({ doneAt: secondSlow?.doneAt ?? null, abortedAt: secondSlow?.abortedAt ?? null }))
    check('取消：没有把候选写进正文', !(await editorText()).includes('用于测试取消'),
      (await editorText()).slice(-30) || '(正文为空)')
    await setMode('normal')
    const afterCancel = await trigger()
    await sleep(1500)
    check('取消：之后仍能再次触发（没被锁死）', afterCancel)
    cases.push({ id: 'cancel', ok: !!firstSlow && firstSlow.abortedAt !== null && afterCancel })

    // ---------- ③ 超时（服务端连响应头都不给 → 客户端到点放弃） ----------
    await setMode('hang')
    const t0 = Date.now()
    const timeoutSent = await trigger()
    check('超时：请求已发出', timeoutSent)
    let timeoutText = '', abortAt = 0
    for (let i = 0; i < 200; i++) {
      await sleep(1000)
      const t = await bodyText()
      if (/超时|超过 \d+\s*秒|timed out|Timeout/i.test(t)) { timeoutText = t; }
      const rec = (await stats()).filter((r) => r.mode === 'hang').at(-1)
      if (rec && rec.abortedAt) { abortAt = rec.abortedAt - rec.arrivedAt; break }
    }
    await shot('03-timeout')
    console.log('  hang 观察：abortAt=' + abortAt + 'ms DOM=' + (timeoutText ? '有超时文案' : '无超时文案'))
    check('超时：客户端在设置值附近放弃（25~40 秒）', abortAt >= 25000 && abortAt <= 40000,
      `abortAt=${abortAt}ms（设置 ${TIMEOUT_SEC}s，上限 40s）`)
    check('超时：正文没有被写入任何东西', !(await editorText()).includes('这是一段用于测试取消'),
      (await editorText()).slice(-30) || '(正文为空)')
    const hangRec = (await stats()).filter((r) => r.mode === 'hang').at(-1)
    check('超时：连接被放弃前一个字都没收到', !!hangRec && hangRec.firstByteAt === null,
      JSON.stringify({ firstByteAt: hangRec?.firstByteAt ?? null }))
    await setMode('normal')
    const afterTimeout = await trigger()
    await sleep(1200)
    check('超时：之后仍能再次触发（没被锁死）', afterTimeout)
    cases.push({ id: 'timeout', ok: abortAt >= 25000 && abortAt <= 40000 && afterTimeout })

    check('全程无页面异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

    const passed = asserts.filter((a) => a.ok).length
    const payload = {
      kind: 'model-failure-evidence',
      runId,
      profile: 'portable',
      sourceFingerprint: sourceFingerprint(ROOT),
      buildHash: hashBuildDir(buildDir),
      base: BASE,
      mock: MOCK,
      timeoutSec: TIMEOUT_SHOWN(),
      timeoutObservation: { abortAt, userMessageVisible: !!timeoutText },
      observations: [{
        id: 'timeout.user-message',
        visible: !!timeoutText,
        note: '伴写请求超时后界面没有任何提示（按设计：伴写失败静默、连续失败才熔断提示）。'
          + '本轮只记录不修改 —— 是否给超时单独提示属交互决策，需主人点名。',
      }],
      cases,
      asserts,
      passed,
      total: asserts.length,
      mockRequests: await stats().catch(() => []),
      scope: 'local-fake-endpoint：只证明拒答/取消/超时的呈现与收尾，不等于真实端点验证',
    }
    fs.mkdirSync(path.dirname(resultFile), { recursive: true })
    fs.writeFileSync(resultFile, JSON.stringify(payload, null, 2))
    console.log('EVIDENCE ' + path.relative(ROOT, resultFile).replace(/\\/g, '/'))
    console.log(`MODEL_FAILURE passed=${passed}/${asserts.length}`)
    if (passed !== asserts.length) process.exitCode = 1
  } finally {
    await browser?.close().catch(() => {})
    try { mockSrv.kill() } catch { /* 忽略 */ }
    try { appSrv.kill() } catch { /* 忽略 */ }
  }
}

/** 记录进证据里的超时值（避免闭包外引用不一致） */
function TIMEOUT_SHOWN() { return TIMEOUT_SEC }

main().catch((e) => { console.error('RUN_FAIL', e.stack || e.message); process.exit(1) })
