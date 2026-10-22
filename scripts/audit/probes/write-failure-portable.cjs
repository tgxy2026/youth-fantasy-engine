#!/usr/bin/env node
/**
 * write-failure 取证 · portable 配置（3.2.1 T-06）
 *
 * 为什么要有它：平台矩阵 `scripts/audit/platform/policy.json` 的 `write-failure` 单元要求
 * 「区分内存接受与持久化确认，失败不清 dirty / 不刷新 / 可导出」，三个场景：
 *   accepted-vs-persisted ／ failure-preserves-draft ／ retry-readback
 * 这三条只能真跑浏览器看界面与落盘，静态审计证明不了。
 *
 * 做法（自包含，可重复执行）：
 *   ① 在 `.workbuddy/tmp/wf-app-<runId>/` 复制一份 dist（**自写递归复制**：本机 cpSync 会被 shim 杀进程）
 *      ⇒ 每次都是干净数据目录，不碰主人的真实书库；
 *   ② 起一个便携服务（`scripts/portable-server.mjs --root <上面那个目录>`）；
 *   ③ 驱动系统 Edge（`channel:'msedge'`，本机 ms-playwright 缓存为空，免下载内核）；
 *   ④ 载入示范项目 → 进正文 → 用 `route.abort()` 掐掉 `PUT /api/data`，模拟「写盘失败」；
 *   ⑤ 三条断言 + 磁盘级读回，产出 results.json 与矩阵可认的 ledger-entry.json。
 *
 * 用法：
 *   node scripts/audit/probes/write-failure-portable.cjs              # 跑完自动停服务
 *   node scripts/audit/probes/write-failure-portable.cjs --keep       # 保留服务方便排查
 *   node scripts/audit/probes/write-failure-portable.cjs --port 8791  # 换端口
 *
 * 🔴 边界：只覆盖 portable。web-cloud 需要真实账号，web-guest 走 IndexedDB 无请求可拦，
 *    desktop 需真机或封装包 ⇒ 三者保持 blocked，**不得**把本脚本结果扩写成四端通过。
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

// shell 注入的代理会拖死 127.0.0.1 请求（历史踩过）
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k]

const ROOT = path.resolve(__dirname, '..', '..', '..')
const argOf = (flag, dflt) => { const i = process.argv.indexOf(flag); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt }
const runId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
const PORT = Number(argOf('--port', '8790'))
const BASE = `http://127.0.0.1:${PORT}`
const TMP = path.join(ROOT, '.workbuddy', 'tmp')
const appRoot = path.join(TMP, 'wf-app-' + runId)
const outDir = path.join(TMP, 'wf-evidence', runId)
const MARKER = '【故障注入测试】'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const copyDir = (src, dst) => {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d)
  }
}

const results = { runId, profile: 'portable', base: BASE, startedAt: new Date().toISOString(), steps: [], asserts: [] }
const step = (name, data) => { results.steps.push({ name, at: Date.now(), ...(data || {}) }); console.log('[step]', name, data && data.note ? '- ' + data.note : '') }
const check = (name, ok, detail) => { results.asserts.push({ name, ok: !!ok, detail }); console.log(ok ? '  PASS' : '  FAIL', name, detail ? ':: ' + detail : '') }
const shot = async (page, name) => { try { await page.screenshot({ path: path.join(outDir, name + '.png') }) } catch {} }

async function waitServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/ping'); if (r.ok) return } catch {}
    await sleep(300)
  }
  throw new Error('便携服务未就绪（端口被占？换 --port）')
}

/** 关掉首启后可能出现的模态（如「该导出备份了」提醒），否则点击被遮罩拦截 */
async function dismissModal(page) {
  const text = await page.evaluate(() => {
    const m = document.querySelector('.fixed.inset-0')
    return m ? (m.innerText || '').slice(0, 200) : ''
  })
  if (!text) return ''
  console.log('[step] modal -', text.replace(/\n+/g, ' / '))
  for (const label of ['稍后再说', '知道了', '我知道了', '关闭', '取消', '确定', '好的']) {
    const hit = await page.evaluate((l) => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === l)
      if (b) { b.click(); return true }
      return false
    }, label)
    if (hit) { await sleep(1000); return label }
  }
  await page.keyboard.press('Escape')
  await sleep(600)
  return 'escape'
}

const readEditor = (page, tag) => page.evaluate((t) => {
  const v = (document.querySelector('textarea.novel-textarea') || {}).value || ''
  const leaf = [...document.querySelectorAll('*')]
    .filter((e) => !e.children.length && /保存|同步|失败|出错|未落盘/.test(e.textContent || ''))
    .map((e) => e.textContent.trim()).slice(0, 10)
  return { tag: t, len: v.length, hasMarker: v.includes('【故障注入测试】'), leaf }
}, tag)

;(async () => {
  fs.mkdirSync(outDir, { recursive: true })
  copyDir(path.join(ROOT, 'dist'), path.join(appRoot, 'dist'))
  step('prepare-root', { note: appRoot })

  const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'portable-server.mjs'), '--root', appRoot, '--port', String(PORT), '--no-open'], { stdio: 'ignore' })
  await waitServer()

  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const putLog = []
  page.on('request', (r) => { if (r.url().includes('/api/data') && r.method() === 'PUT') putLog.push(r.url()) })

  // ---------- 1. 向导 + 示范项目 ----------
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(4000)
  await shot(page, '01-welcome')
  const demo = page.getByRole('button', { name: /先看看示例/ }).first()
  check('欢迎向导出现（干净数据目录）', (await demo.count()) > 0)
  await demo.click()
  await sleep(3000)
  for (const label of [/^下一步$/, /跳过，直接开始/]) {
    const b = page.getByRole('button', { name: label }).first()
    if (await b.count()) { await b.click(); await sleep(label.source.includes('跳过') ? 5000 : 2500) }
  }
  await shot(page, '02-project')

  // ---------- 2. 进正文编辑 ----------
  const entered = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '正文编辑')
    if (b) { b.click(); return true }
    return false
  })
  check('找到「正文编辑」入口', entered)
  await sleep(4000)
  await dismissModal(page)
  await shot(page, '03-editor')

  // ---------- 3. 掐掉 PUT，制造写盘失败 ----------
  const ta = page.locator('textarea.novel-textarea').first()
  const before = await ta.inputValue().catch(() => '')
  step('editor-value', { note: `原长 ${before.length}` })
  await page.route('**/api/data', (r) => r.abort())
  await ta.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(MARKER)
  await sleep(4000)
  const failed = await readEditor(page, 'after-abort')
  await shot(page, '04-write-failed')
  console.log('\n失败态：', JSON.stringify(failed))

  // ---------- 4. 恢复 + Ctrl+S 重试 ----------
  await page.unroute('**/api/data')
  await ta.click()
  await page.keyboard.press('Control+s')
  await sleep(4000)
  const retried = await readEditor(page, 'after-retry')
  await shot(page, '05-retry')
  console.log('重试态：', JSON.stringify(retried))

  // ---------- 5. 三条断言（retry 用磁盘级读回，最硬） ----------
  const failedText = failed.leaf.join(' ')
  check('accepted-vs-persisted：失败时明确说「保存出错」而非「已保存」',
    /保存出错|保存失败/.test(failedText) && !failed.leaf.some((t) => t === '已保存'), failedText.slice(0, 160))
  check('failure-preserves-draft：失败后正文输入未丢失',
    failed.hasMarker && failed.len >= before.length, `len=${failed.len}（原 ${before.length}）`)
  const dataFile = path.join(appRoot, 'data', 'youth-fantasy-engine-data.json')
  const raw = fs.existsSync(dataFile) ? fs.readFileSync(dataFile, 'utf8') : ''
  check('retry-readback：恢复后重试保存成功且磁盘可读回',
    raw.includes(MARKER) && retried.leaf.some((t) => /已保存/.test(t)),
    `磁盘命中=${raw.includes(MARKER)} 数据文件=${(raw.length / 1024).toFixed(1)} kB`)

  await browser.close()
  if (!process.argv.includes('--keep')) server.kill()

  // ---------- 6. 产出证据 + 矩阵可认条目 ----------
  const passed = results.asserts.filter((a) => a.ok).length
  const allOk = passed === results.asserts.length && results.asserts.length >= 3
  const evidencePath = path.join(outDir, 'results.json')
  fs.writeFileSync(evidencePath, JSON.stringify({
    ...results, putCount: putLog.length, samples: 1,
    environment: `Windows · Playwright headless(msedge) · portable-server :${PORT} · run ${runId}`,
    status: allOk ? 'passed' : 'failed',
  }, null, 2))
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(evidencePath)).digest('hex')
  const relArtifact = path.relative(ROOT, evidencePath).replace(/\\/g, '/')
  fs.writeFileSync(path.join(outDir, 'ledger-entry.json'), JSON.stringify({
    id: 'write-failure', profile: 'portable', status: allOk ? 'passed' : 'failed', samples: 1,
    scenarios: ['accepted-vs-persisted', 'failure-preserves-draft', 'retry-readback'],
    environment: `Windows · Playwright headless(msedge) · portable-server :${PORT}`,
    artifact: { path: relArtifact, sha256 },
  }, null, 2))

  console.log('\nEVIDENCE:', relArtifact)
  console.log('SHA256:', sha256)
  console.log(`PASS ${passed}/${results.asserts.length} ⇒ ${allOk ? 'passed' : 'failed'}`)
  process.exit(allOk ? 0 : 1)
})().catch((e) => {
  console.error('RUN_FAIL', e.message)
  try { fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ ...results, error: e.message }, null, 2)) } catch {}
  process.exit(1)
})
