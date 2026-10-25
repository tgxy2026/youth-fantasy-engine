#!/usr/bin/env node
/**
 * 在途编辑 / 切项目 / 关窗写失败 · **便携配置**（3.2.6 · storage.four-profiles 最后一块）
 *
 * 为什么要有它：`storage.four-profiles` 一直 block 的欠项里，最后一块就是
 * 「在途编辑、切项目、关窗时的写失败」—— 三条都只能在真浏览器 + 真落盘上看，
 * 静态审计和单测都证明不了。云端已有 close-during-save（真关页），desktop / portable / guest 还缺。
 *
 * 三个场景（每个场景独立算分，缺一条就不算完成）：
 *   ① inflight-edit      保存请求在途时继续打字 → 最终落盘的必须是**最新那笔**，且文件仍是完整 JSON
 *                        （在途证据靠 route 延迟 + 请求体时间戳，不用「等一会儿看看」冒充）
 *   ② project-switch     保存请求在途时切到另一本书 → 原书那笔必须落盘、另一本书一个字节都不许动
 *   ③ close-write-failure 写失败态下**真关页** → 数据文件仍是关页前那份、草稿不许被静默当成已保存，
 *                        重开一页要能正常读到已落盘内容
 *
 * 纪律：
 *   · 真实便携服务（`scripts/portable-server.mjs --root <临时目录>`）+ 真实浏览器 + 真实磁盘读回；
 *   · dist 必须来自**本次源码构建**（`--build-dir`，统一验收必传）：便携服务要 If-Match，
 *     旧页面不带就被 428 拒写，会把三条全判成红；
 *   · 关页用 `page.close()` 真关，**不用**合成 beforeunload；
 *   · 只碰本次临时目录，不读主人真实书库。
 */
'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { chromium } = require('playwright')

for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_OPTIONS']) delete process.env[key]

const ROOT = path.resolve(__dirname, '../../..')
const PA = 'inflight-pa', VA = 'inflight-va', CA = 'inflight-ca', TA = '在途验收甲书'
const PB = 'inflight-pb', VB = 'inflight-vb', CB = 'inflight-cb', TB = '在途验收乙书'
const ORIG_A = '甲书原始手稿：这一句必须能被在途写入后的最新一笔替换。'
const ORIG_B = '乙书原始手稿：切项目过程中一个字节都不许动。'
const EDITOR = '落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）'
const BACK = '返回项目列表'

const TEXT_A = '[inflight] 第一笔：保存请求还在途中时用户已经继续打字。'
const TEXT_B = '[inflight] 第二笔：最终落盘的必须是这一笔，而不是在途那笔旧的。'
const TEXT_C = '[inflight] 切项目那一笔：切走之前必须落盘，不许跟着项目一起丢。'
const TEXT_D = '[inflight] 写失败那一笔：关页后不许被静默当成已保存。'

const checks = [], pageErrors = []
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const arg = name => { const at = process.argv.indexOf(name); if (at < 0) return undefined; const value = process.argv[at + 1]; if (!value || value.startsWith('--')) throw new Error(name + ' requires a value'); return value }
const check = (id, ok, detail) => { checks.push({ id, passed: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail ? ' :: ' + detail : '')); if (!ok) throw new Error(id) }
async function until(fn, timeout = 45000, label = '') {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await sleep(100) }
  throw new Error('Timed out waiting for actual state' + (label ? ': ' + label : ''))
}
/** 自写递归复制：本机 cpSync 会杀进程（历史踩过） */
async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true })
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name), to = path.join(dst, entry.name)
    if (entry.isDirectory()) await copyDir(from, to)
    else await fs.copyFile(from, to)
  }
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer()
    listener.on('error', reject)
    listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)) })
  })
}
async function dismiss(page) {
  for (const label of ['稍后再说', '知道了', '我知道了', '关闭']) {
    const hit = await page.evaluate(l => {
      const button = [...document.querySelectorAll('button')].find(node => (node.textContent || '').trim() === l)
      if (button) { button.click(); return true }
      return false
    }, label)
    if (hit) { await sleep(500); return }
  }
}

async function main() {
  const buildArg = arg('--build-dir')
  if (!buildArg) throw new Error('--build-dir is required; stale dist is never selected implicitly')
  const build = await fs.realpath(path.resolve(buildArg))
  await fs.access(path.join(build, 'index.html'))
  const output = arg('--result-file')
  if (output && (!path.resolve(output).startsWith(path.join(ROOT, '.workbuddy', 'tmp') + path.sep) || !output.endsWith('.json'))) throw new Error('Result must be a JSON file under workspace .workbuddy/tmp')

  const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/inflight-portable-'))
  const appRoot = path.join(runRoot, 'app')
  const dataFile = path.join(appRoot, 'data', 'youth-fantasy-engine-data.json')
  const { snapshot } = await import(pathToFileURL(path.join(ROOT, 'scripts/audit/platform/source.mjs')).href)
  const { hashPaths } = await import(pathToFileURL(path.join(ROOT, 'scripts/verify/evidence.mjs')).href)
  const sourceFingerprint = snapshot(ROOT).fingerprint
  const buildManifest = await hashPaths(build, ['.'])

  await copyDir(build, path.join(appRoot, 'dist'))
  await fs.mkdir(path.join(appRoot, 'data'), { recursive: true })
  const now = Date.now()
  await fs.writeFile(dataFile, JSON.stringify({
    app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: now, stores: {
      projects: [{ id: PA, name: TA, genre: '玄幻', intro: '', projectType: 'full', createdAt: now, updatedAt: now },
        { id: PB, name: TB, genre: '玄幻', intro: '', projectType: 'full', createdAt: now, updatedAt: now }],
      volumes: [{ id: VA, projectId: PA, title: '甲卷', description: '', order: 0, createdAt: now },
        { id: VB, projectId: PB, title: '乙卷', description: '', order: 0, createdAt: now }],
      chapters: [{ id: CA, projectId: PA, volumeId: VA, title: '甲章', content: ORIG_A, summary: '', wordCount: ORIG_A.length, order: 0, status: '草稿', tags: [], createdAt: now, updatedAt: now },
        { id: CB, projectId: PB, volumeId: VB, title: '乙章', content: ORIG_B, summary: '', wordCount: ORIG_B.length, order: 0, status: '草稿', tags: [], createdAt: now, updatedAt: now }],
      meta: [{ key: 'welcomeDone', value: '1' }],
    },
  }))

  const port = await freePort()
  const base = 'http://127.0.0.1:' + port
  let server = null, browser = null, context = null, page = null, serverLog = '', error = null
  /** /api/data 的 PUT 轨迹：在途证据靠它，不靠「等一会儿看看」 */
  const puts = []
  let putDelay = 0, putFail = false

  const diskText = async () => { try { return await fs.readFile(dataFile, 'utf8') } catch { return '' } }
  const chapterOf = text => {
    try {
      const rows = JSON.parse(text)?.stores?.chapters
      const list = Array.isArray(rows) ? rows : Object.values(rows ?? {})
      return list.find(row => row && typeof row.content === 'string')
    } catch { return null }
  }
  const diskChapter = async id => {
    try {
      const rows = JSON.parse(await fs.readFile(dataFile, 'utf8'))?.stores?.chapters
      const list = Array.isArray(rows) ? rows : Object.values(rows ?? {})
      return list.find(row => row && row.id === id) ?? null
    } catch { return null }
  }
  const openProject = async (target, title) => {
    await target.getByRole('heading', { name: title, exact: true }).first().waitFor({ timeout: 45000 })
    await dismiss(target)
    await target.locator('div.card-hover').filter({ has: target.getByRole('heading', { name: title, exact: true }) })
      .getByRole('button', { name: '打开项目', exact: true }).click()
    await target.getByRole('navigation').first().waitFor({ timeout: 45000 })
    await target.getByRole('button', { name: '稍后再说', exact: true }).click({ timeout: 5000 }).catch(() => {})
    await dismiss(target)
    await target.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
    await target.getByPlaceholder(EDITOR).waitFor({ timeout: 45000 })
  }
  const backToHub = async () => {
    await page.getByTitle(BACK).first().click()
    await page.getByRole('heading', { name: TA, exact: true }).first().waitFor({ timeout: 45000 })
    await dismiss(page)
  }

  try {
    server = spawn(process.execPath, [path.join(ROOT, 'scripts/portable-server.mjs'), '--root', appRoot, '--port', String(port), '--no-open'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    server.on('error', value => { serverLog += String(value) })
    server.stdout.on('data', value => { serverLog += value })
    server.stderr.on('data', value => { serverLog += value })
    await until(async () => { try { return (await fetch(base + '/api/ping', { signal: AbortSignal.timeout(1000) })).ok } catch { return false } }, 60000, 'portable server')

    browser = await chromium.launch({ channel: 'msedge', headless: true })
    context = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    // 只延/断 PUT：GET（整库载入）必须正常，否则「打不开」和「写不进去」会混在一起
    await context.route('**/api/data', async route => {
      const request = route.request()
      if (request.method() !== 'PUT') return route.continue()
      const entry = { at: Date.now(), body: request.postData() || '', doneAt: null, aborted: null }
      puts.push(entry)
      if (putDelay) await sleep(putDelay)
      if (putFail) { entry.aborted = 'probe-injected'; await route.abort('failed').catch(() => {}); entry.doneAt = Date.now(); return }
      try { await route.continue() } catch (value) { entry.aborted = String(value) }
      entry.doneAt = Date.now()
    })
    page = await context.newPage()
    page.setDefaultTimeout(20000)
    page.on('pageerror', value => pageErrors.push(String(value)))
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await openProject(page, TA)
    check('fixture-readback', (await page.getByPlaceholder(EDITOR).inputValue()) === ORIG_A && (await diskChapter(CA))?.content === ORIG_A)
    const ta = () => page.getByPlaceholder(EDITOR)

    // ---------- ① inflight-edit：保存在途时继续打字 ----------
    {
      putDelay = 4000
      const before = puts.length
      await ta().fill(TEXT_A)
      await page.keyboard.press('Control+s')
      await sleep(900)
      // 这一笔此刻确实还在途中：延迟 4 秒，而我们已经开始写第二笔
      await ta().fill(TEXT_B)
      const editedAt = Date.now()
      await until(async () => (await diskChapter(CA))?.content === TEXT_B, 60000, 'latest text persisted')
      const inFlight = puts.slice(before).filter(entry => entry.body.includes(TEXT_A.slice(0, 8)) && entry.doneAt && entry.doneAt > editedAt)
      check('inflight-edit.in-flight-during-edit', inFlight.length > 0,
        `在途请求 ${inFlight.length} 笔，最晚一笔在改字后 ${inFlight.length ? Math.round((inFlight[inFlight.length - 1].doneAt - editedAt) / 100) / 10 : 0}s 才结束`)
      const afterText = await diskText()
      let valid = false
      try { JSON.parse(afterText); valid = true } catch { valid = false }
      check('inflight-edit.file-valid', valid && (await diskChapter(CA))?.content === TEXT_B)
      check('inflight-edit.ui-latest', (await ta().inputValue()) === TEXT_B)
      // 再等一会儿：迟到的在途回包不许把最新一笔盖回旧文
      await sleep(2500)
      check('inflight-edit.no-late-clobber', (await diskChapter(CA))?.content === TEXT_B, String((await diskChapter(CA))?.content).slice(0, 20))
      putDelay = 0
      await page.screenshot({ path: path.join(runRoot, 'inflight-edit.png') })
    }

    // ---------- ② project-switch：保存在途时切到另一本书 ----------
    {
      putDelay = 4000
      const before = puts.length
      await ta().fill(TEXT_C)
      await sleep(300)
      await page.keyboard.press('Control+s')
      await sleep(700)
      const switchedAt = Date.now()
      await backToHub()
      await openProject(page, TB)
      const inFlight = puts.slice(before).filter(entry => entry.body.includes(TEXT_C.slice(0, 8)) && entry.doneAt && entry.doneAt > switchedAt)
      check('project-switch.in-flight-during-switch', inFlight.length > 0, `在途请求 ${inFlight.length} 笔`)
      await until(async () => (await diskChapter(CA))?.content === TEXT_C, 45000, 'first project write landed')
      const other = await diskChapter(CB)
      check('project-switch.write-landed', (await diskChapter(CA))?.content === TEXT_C)
      check('project-switch.other-untouched', other?.content === ORIG_B && other?.projectId === PB, JSON.stringify(other?.content ?? '').slice(0, 24))
      await page.screenshot({ path: path.join(runRoot, 'project-switch.png') })
      // 切回来：编辑器里读到的必须是切走前那笔，不能是旧文
      await backToHub()
      await openProject(page, TA)
      check('project-switch.reopen-readback', (await ta().inputValue()) === TEXT_C)
      putDelay = 0
    }

    // ---------- ③ close-write-failure：写失败态下真关页 ----------
    {
      const beforeText = await diskText()
      putFail = true
      await ta().fill(TEXT_D)
      await page.keyboard.press('Control+s')
      await page.getByRole('button', { name: '保存出错', exact: true }).first().waitFor({ timeout: 30000 })
      check('close-write-failure.failure-visible', true)
      await page.screenshot({ path: path.join(runRoot, 'close-write-failure.png') })
      await page.close()                      // 🔴 真关页，不派发 beforeunload
      await sleep(3000)
      const afterText = await diskText()
      let valid = false
      try { JSON.parse(afterText); valid = true } catch { valid = false }
      check('close-write-failure.file-valid', valid, `${(afterText.length / 1024).toFixed(1)} kB`)
      /**
       * 关页那一刻：写失败那笔**不许**把文件写坏，内容只可能是
       *   · 关页前已落盘那笔（关页兜底也没写进去），或
       *   · 关页时兜底写进去的失败草稿（`flushPortableOnLeave` 走同步 XHR，Playwright 路由拦不到 ——
       *     这本身就是「关窗时草稿被救回来」的产品行为，属于允许的第二种结果）
       * 两种都算过；不算过的只有「文件坏了 / 内容既不是旧的也不是新的 / 重开读不回来」。
       */
      const diskContent = (await diskChapter(CA))?.content
      check('close-write-failure.old-or-new', diskContent === TEXT_C || diskContent === TEXT_D,
        `关页前=${String(chapterOf(beforeText)?.content ?? '').slice(0, 8)}… 关页后=${String(diskContent ?? '').slice(0, 8)}…`)
      check('close-write-failure.not-empty', typeof diskContent === 'string' && diskContent.length > 0)

      // 故障注入到此结束：再开着的话，重开后连「打开项目」都会写失败，测的就不是关页了
      putFail = false
      // 重开一页：应用必须还能正常打开，且读到的就是磁盘上那份（不许界面与磁盘两种结论）
      page = await context.newPage()
      page.setDefaultTimeout(20000)
      page.on('pageerror', value => pageErrors.push(String(value)))
      await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
      await openProject(page, TA)
      check('close-write-failure.reopen-readback', (await ta().inputValue()) === diskContent, String(await ta().inputValue()).slice(0, 20))
      check('close-write-failure.no-false-error', (await page.getByRole('button', { name: '保存出错', exact: true }).count()) === 0)
      await page.screenshot({ path: path.join(runRoot, 'close-write-failure-reopen.png') })
      putFail = false
    }

    check('no-pageerror', pageErrors.length === 0, pageErrors)
    check('unchanged-inputs', snapshot(ROOT).fingerprint === sourceFingerprint && (await hashPaths(build, ['.'])).sha256 === buildManifest.sha256)
  } catch (value) {
    error = String(value.stack ?? value)
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(runRoot, 'failure.png') }).catch(() => {})
  } finally {
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    if (server) {
      const closed = new Promise(resolve => server.once('close', resolve))
      server.kill()
      await Promise.race([closed, sleep(3000)])
    }
    await fs.writeFile(path.join(runRoot, 'server.log'), serverLog)
    await fs.writeFile(path.join(runRoot, 'put-trail.json'), JSON.stringify(puts.map(entry => ({ at: entry.at, doneAt: entry.doneAt, aborted: entry.aborted, body: entry.body.slice(0, 200) })), null, 2))
    const artifacts = []
    for (const file of await fs.readdir(runRoot)) {
      if (!/\.(png|json|log)$/.test(file) || file === 'result.json') continue
      artifacts.push({ path: path.relative(ROOT, path.join(runRoot, file)), sha256: hash(await fs.readFile(path.join(runRoot, file))) })
    }
    // 场景清单**算出来**：某场景只要有一条检查没过/没走完，就不出现在清单里
    const scenarioGroups = {
      'inflight-edit': ['inflight-edit.in-flight-during-edit', 'inflight-edit.file-valid', 'inflight-edit.ui-latest', 'inflight-edit.no-late-clobber'],
      'project-switch': ['project-switch.in-flight-during-switch', 'project-switch.write-landed', 'project-switch.other-untouched', 'project-switch.reopen-readback'],
      'close-write-failure': ['close-write-failure.failure-visible', 'close-write-failure.file-valid', 'close-write-failure.old-or-new', 'close-write-failure.not-empty', 'close-write-failure.reopen-readback', 'close-write-failure.no-false-error'],
    }
    const passedIds = new Set(checks.filter(item => item.passed).map(item => item.id))
    const scenarios = Object.entries(scenarioGroups).filter(([, ids]) => ids.every(id => passedIds.has(id))).map(([name]) => name)
    const result = {
      schemaVersion: 1, profile: 'portable', scenarios,
      scope: 'Production build served by actual portable server over isolated app dir; real browser; real disk readback; PUT delayed/aborted at the HTTP layer; page really closed; no real U-disk or native dialog claim',
      runRoot, sourceFingerprint, build, buildManifest, at: new Date().toISOString(),
      passed: checks.filter(item => item.passed).length,
      failed: checks.filter(item => !item.passed).length + (error ? 1 : 0),
      checks, artifacts, pageErrors, error,
    }
    const target = path.join(runRoot, 'result.json')
    await fs.writeFile(target, JSON.stringify(result, null, 2))
    if (output) await fs.writeFile(path.resolve(output), JSON.stringify(result, null, 2))
    console.log('INFLIGHT_PORTABLE_RESULT ' + JSON.stringify({ result: target, passed: result.passed, failed: result.failed, scenarios, error }))
    if (result.failed) process.exitCode = 1
  }
}
main().catch(value => { console.error(value); process.exitCode = 1 })
