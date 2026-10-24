#!/usr/bin/env node
// 3.2.3 · R4：web-cloud 并发（同浏览器多标签）**事实取证**探针
//
// 与其它探针不同，这个探针**不做通过/失败判定**：它只把「两个标签页同时用同一账号会发生什么」
// 如实测出来。原因是 `src/lib/app/tabGuard.ts` 已明确写了当前策略是「只提示、不拦人」，
// 真正的互斥要服务端 revision + If-Match（尚未实现）。
// 所以这里输出 `findings`（事实），不是 checks（门禁）；不接进 reliability 的契约判定，
// 避免把「确认了缺口」伪装成「这道闸通过了」。
'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { chromium } = require('playwright')

const ROOT = path.resolve(__dirname, '../../..')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const arg = name => {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(name + ' requires a value')
  return value
}
const until = async (fn, timeout = 30000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 120)) }
  throw new Error('Timed out waiting for actual state')
}

const PASSWORD = 'probe-pass-2026'
const USER = 'probe-conc-' + Date.now().toString(36)
const BANNER = '检测到另一个窗口也在用这个账号'
const mkData = marker => JSON.stringify({
  app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: Date.now(),
  stores: { chapters: [{ id: 'ch-1', projectId: 'p1', volumeId: 'v1', title: '并发章', content: marker }] },
})

async function main() {
  const buildArg = arg('--build-dir')
  if (!buildArg) throw new Error('--build-dir is required')
  const build = await fs.realpath(path.resolve(buildArg))
  await fs.access(path.join(build, 'index.html'))
  const output = arg('--result-file')
  if (output && (!path.resolve(output).startsWith(path.join(ROOT, '.workbuddy', 'tmp') + path.sep) || !output.endsWith('.json'))) throw new Error('Result must be a JSON file under workspace .workbuddy/tmp')

  const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/web-cloud-concurrency-'))
  const data = path.join(runRoot, 'server-data')
  await fs.mkdir(data)
  const { snapshot } = await import(pathToFileURL(path.join(ROOT, 'scripts/audit/platform/source.mjs')).href)
  const { hashPaths } = await import(pathToFileURL(path.join(ROOT, 'scripts/verify/evidence.mjs')).href)
  const sourceFingerprint = snapshot(ROOT).fingerprint
  const buildManifest = await hashPaths(build, ['.'])

  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer()
    listener.on('error', reject)
    listener.listen(0, '127.0.0.1', () => { const p = listener.address().port; listener.close(() => resolve(p)) })
  })
  const origin = 'http://127.0.0.1:' + port
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), YFE_DATA: data, YFE_WWW: build, YFE_REGISTER: 'open', YFE_BOOTSTRAP_INVITE: '' }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete env[key]

  const findings = []
  const note = (id, observed, detail) => { findings.push({ id, observed: !!observed, detail }); console.log((observed ? 'OBSERVED ' : 'not-observed ') + id) }
  let server, ctx, serverLog = '', error = null
  const pageErrors = []

  const waitUser = async page => {
    await page.waitForFunction(() => window.__YFE_USER__?.name, null, { timeout: 30000 }).catch(() => {})
    return page.evaluate(() => window.__YFE_USER__?.name ?? null)
  }
  const putFrom = (page, marker) => page.evaluate(async body => {
    const res = await fetch('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
    return { status: res.status, etag: res.headers.get('etag'), text: await res.text() }
  }, mkData(marker))
  const readFrom = page => page.evaluate(async () => {
    const res = await fetch('/api/data')
    return { status: res.status, etag: res.headers.get('etag'), text: await res.text() }
  })

  try {
    server = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    server.on('error', v => { serverLog += String(v) })
    server.stdout.on('data', v => { serverLog += v })
    server.stderr.on('data', v => { serverLog += v })
    await until(async () => { try { return (await fetch(origin + '/api/ping', { signal: AbortSignal.timeout(1000) })).ok } catch { return false } })

    const profile = await fs.mkdtemp(path.join(runRoot, 'profile-'))
    ctx = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, viewport: { width: 1440, height: 1000 }, args: ['--no-proxy-server'], env })
    await ctx.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === origin) return route.continue()
      if (['data:', 'blob:'].includes(url.protocol)) return route.continue()
      return route.abort()
    })
    ctx.on('page', p => p.on('pageerror', v => pageErrors.push(String(v))))
    const res = await ctx.request.post(origin + '/api/auth/register', { data: { name: USER, password: PASSWORD } })
    if (!res.ok()) throw new Error('register failed: ' + res.status() + ' ' + (await res.text()))

    // ---------- ① 两个标签页：界面是否如实提示 ----------
    const tab1 = ctx.pages()[0] ?? await ctx.newPage()
    tab1.setDefaultTimeout(15000)
    await tab1.goto(origin + '/', { waitUntil: 'domcontentloaded' })
    const u1 = await waitUser(tab1)
    const tab2 = await ctx.newPage()
    tab2.setDefaultTimeout(15000)
    await tab2.goto(origin + '/', { waitUntil: 'domcontentloaded' })
    const u2 = await waitUser(tab2)
    const banner1 = await tab1.waitForSelector('#yfe-tab-guard', { timeout: 15000 }).then(async el => (await el.textContent()) ?? '').catch(() => '')
    const banner2 = await tab2.waitForSelector('#yfe-tab-guard', { timeout: 15000 }).then(async el => (await el.textContent()) ?? '').catch(() => '')
    note('two-tabs-warning', banner1.includes(BANNER) && banner2.includes(BANNER),
      { user1: u1, user2: u2, banner1: banner1.trim(), banner2: banner2.trim() })
    await tab2.screenshot({ path: path.join(runRoot, 'two-tabs-warning.png') })

    // ---------- ② 陈旧整库覆盖：后保存的整库写回会不会吃掉先写的 ----------
    const first = await putFrom(tab1, '先写的那一版-甲')
    const second = await putFrom(tab2, '后写的那一版-乙') // 模拟 tab2 内存里没有甲的内容
    const after = await readFrom(tab1)
    const finalText = JSON.parse(after.text).text ?? ''
    const overwrote = finalText.includes('后写的那一版-乙') && !finalText.includes('先写的那一版-甲')
    note('stale-overwrite', overwrote, {
      firstStatus: first.status, secondStatus: second.status,
      firstEtag: first.etag, secondEtag: second.etag, readEtag: after.etag,
      finalHash: hash(finalText), keptFirst: finalText.includes('先写的那一版-甲'),
    })

    // ---------- ③ 有没有版本前置条件（If-Match / ETag 协商） ----------
    const conditional = await tab1.evaluate(async body => {
      const res = await fetch('/api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': '"definitely-stale-revision"' },
        body,
      })
      return { status: res.status, etag: res.headers.get('etag') }
    }, mkData('带过期版本号的写'))
    note('no-version-precondition', conditional.status === 200 && !conditional.etag,
      { status: conditional.status, etag: conditional.etag })

    note('page-errors', pageErrors.length === 0, pageErrors)
    note('unchanged-inputs', snapshot(ROOT).fingerprint === sourceFingerprint, {})
  } catch (value) {
    error = String(value.stack ?? value)
  } finally {
    if (ctx) await ctx.close().catch(() => {})
    if (server) {
      const closed = new Promise(resolve => server.once('close', resolve))
      server.kill()
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))])
    }
    await fs.writeFile(path.join(runRoot, 'server.log'), serverLog)
    const artifacts = []
    for (const file of await fs.readdir(runRoot)) {
      if (!/\.(png|json|log)$/.test(file) || file === 'result.json') continue
      artifacts.push({ path: path.relative(ROOT, path.join(runRoot, file)), sha256: hash(await fs.readFile(path.join(runRoot, file))) })
    }
    const result = {
      schemaVersion: 1, kind: 'finding-probe', profile: 'web-cloud',
      scope: 'Production renderer; actual local server; throwaway account; two tabs in one browser context; records facts, asserts no protection',
      runRoot, sourceFingerprint, build, buildManifest, at: new Date().toISOString(),
      findings, artifacts, pageErrors, error,
    }
    const target = path.join(runRoot, 'result.json')
    await fs.writeFile(target, JSON.stringify(result, null, 2))
    if (output) await fs.writeFile(path.resolve(output), JSON.stringify(result, null, 2))
    console.log('WEB_CLOUD_CONCURRENCY_RESULT ' + JSON.stringify({ result: target, findings: findings.length, error }))
    if (error) process.exitCode = 1
  }
}

main().catch(e => { console.error(e); process.exitCode = 1 })
