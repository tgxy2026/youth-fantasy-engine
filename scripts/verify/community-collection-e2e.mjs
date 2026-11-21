#!/usr/bin/env node
/**
 * 投稿合集 · 真机端到端（3.6.2）
 *
 * 【为什么单测不够】`tests/communityCollections.test.ts` 是在**测试进程里**把 api 挂到
 * http 上跑的，用的是测试头模拟登录。它证明不了：真实 server 起来后、真实前端 dist 加载后、
 * 真浏览器点进去，那一行「收录于《…》」到底长什么样、浏览数有没有显示、合集浮层能不能打开。
 *
 * 【它做什么】
 *   ① 用临时 DATA_DIR 起真实 `server/index.mjs`（不碰任何已有数据）；
 *   ② HTTP 造数据：三个账号（作者 / 审核 / 读者）→ 作者发 3 篇 → 审核通过 → 建合集 → 归集；
 *   ③ Playwright 打开真实前端，走**读者路径**：项目中心 → 投稿广场 → 卡片浏览数与合集角标
 *      → 详情「收录于」+ 上一篇/下一篇 → 合集目录 → 篇目跳转；
 *   ④ 顺手验「刚看完立刻显示 1」（浏览量在内存缓冲里，展示必须带上未落盘增量）。
 *
 * 【前置】`npm run build` 产出最新 `dist/`（本脚本不替你构建）。
 *
 * 用法：node scripts/verify/community-collection-e2e.mjs [--headful]
 */
import { createServer } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const ROOT = process.cwd()
const HEADFUL = process.argv.includes('--headful')
const runDir = await mkdtemp(path.join(ROOT, '.workbuddy/tmp/community-e2e-'))
const dataDir = path.join(runDir, 'data')
const wwwDir = path.join(ROOT, 'dist')

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 找一个空闲端口 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

const envBase = () => ({
  ...process.env,
  YFE_DATA: dataDir,
  YFE_WWW: wwwDir,
  YFE_REGISTER: 'open',
  YFE_SCHEDULER: 'off',
  YFE_STATS: path.join(runDir, 'stats.log'),
  HOST: '127.0.0.1',
})

/** 起 server，等到它打印 listening */
async function startServer(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], {
    env: { ...envBase(), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 30_000)
    const onData = (buf) => {
      out += String(buf)
      if (/listening on/.test(out)) { clearTimeout(timer); resolve(true) }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', () => { clearTimeout(timer); resolve(false) })
  })
  if (!ready) throw new Error('服务端启动失败：\n' + out.slice(-1200))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise((r) => {
    const t = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } r() }, 5000)
    child.on('exit', () => { clearTimeout(t); r() })
  })
}

/** 带 Cookie 的极简客户端 */
class Client {
  constructor(base) { this.base = base; this.cookie = '' }
  async req(p, { method = 'GET', body, headers = {} } = {}) {
    const h = { ...headers }
    if (body !== undefined) h['Content-Type'] = 'application/json'
    if (this.cookie) h.Cookie = this.cookie
    const res = await fetch(this.base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) this.cookie = setCookie.split(';')[0]
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, json, text }
  }
}

const BASE_USERS = {
  author: { name: 'e2e_author', password: 'pw-e2e-123456' },
  mod: { name: 'e2e_mod', password: 'pw-e2e-123456' },
  reader: { name: 'e2e_reader', password: 'pw-e2e-123456' },
}

let server = null
let ctx = null
try {
  if (!existsSync(path.join(wwwDir, 'index.html'))) {
    throw new Error('缺少 dist/index.html —— 先跑 npm run build')
  }
  const distAge = (await stat(path.join(wwwDir, 'index.html'))).mtimeMs
  const srcNewest = 0 // 只做提示，不阻断
  void srcNewest
  console.log(`dist/index.html: ${new Date(distAge).toISOString()}（若早于最近一次前端改动，先重新构建）`)

  const port = await freePort()
  const base = `http://127.0.0.1:${port}`

  // ---------- 第一轮：起 server 只为注册三个账号 ----------
  console.log('\n[1/4] 起服务并注册账号')
  server = await startServer(port)
  for (const [key, u] of Object.entries(BASE_USERS)) {
    const c = new Client(base)
    const r = await c.req('/api/auth/register', { method: 'POST', body: u })
    ok(`注册 ${key}（${u.name}）`, r.status === 200 || r.status === 201, `${r.status} ${r.text.slice(0, 160)}`)
  }
  await stopServer(server)

  // ---------- 提权：审核员要 moderator，用官方 CLI 改 users.json ----------
  console.log('[2/4] 提升审核员角色')
  {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'server/admin.mjs'), 'role', BASE_USERS.mod.name, 'moderator'], {
      env: envBase(), encoding: 'utf8',
    })
    ok('admin.mjs 设置 moderator 成功', r.status === 0, (r.stdout || '') + (r.stderr || ''))
  }

  // ---------- 第二轮：起 server 造数据 ----------
  console.log('[3/4] 造数据：3 篇 + 审核通过 + 建合集 + 归集')
  server = await startServer(port)

  const author = new Client(base)
  const mod = new Client(base)
  const reader = new Client(base)
  await author.req('/api/auth/login', { method: 'POST', body: BASE_USERS.author })
  await mod.req('/api/auth/login', { method: 'POST', body: BASE_USERS.mod })
  await reader.req('/api/auth/login', { method: 'POST', body: BASE_USERS.reader })

  const postIds = []
  const titles = ['归墟·一 渡口', '归墟·二 铜钱', '归墟·三 对岸']
  for (const title of titles) {
    const created = await author.req('/api/community/posts', {
      method: 'POST',
      body: { title, body: '雨下了三天。林昭站在城门口，摸了摸怀里的半块玉佩。'.repeat(3), tags: ['短篇'], display: 'nickname' },
    })
    if (!created.json?.post) throw new Error('发稿失败：' + created.text.slice(0, 300))
    postIds.push(created.json.post.id)
    const decision = await mod.req('/api/community/admin/decision', {
      method: 'POST',
      body: { targetType: 'post', id: created.json.post.id, versionId: created.json.post.pendingVersionId, action: 'approve' },
    })
    if (decision.status !== 200) throw new Error('审核失败：' + decision.text.slice(0, 300))
  }
  ok('三篇投稿已发布', postIds.length === 3)

  const col = await author.req('/api/community/collections', { method: 'POST', body: { title: '归墟（连载）', intro: '渡口与玉佩' } })
  const colId = col.json?.collection?.id
  ok('合集已创建', !!colId, col.text.slice(0, 200))
  for (const id of postIds) {
    await author.req(`/api/community/collections/${colId}/posts`, { method: 'POST', body: { postId: id } })
  }
  // 列表接口是否带上了合集信息（卡片角标全靠它）
  const listProbe = await reader.req('/api/community/posts')
  ok('列表接口首项带 collection', !!listProbe.json?.items?.[0]?.collection,
    JSON.stringify(listProbe.json?.items?.[0] ?? null).slice(0, 240))

  const page0 = await reader.req(`/api/community/collections/${colId}`)
  ok('合集公开页有 3 篇', page0.json?.collection?.postCount === 3, JSON.stringify(page0.json?.collection?.postCount))

  // ---------- Playwright：读者路径 ----------
  console.log('[4/4] 真浏览器走读者路径')
  const profileDir = path.join(runDir, 'profile')
  ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'msedge',
    headless: !HEADFUL,
    viewport: { width: 1440, height: 900 },
    args: ['--no-first-run', '--no-proxy-server'],
  })
  const page = ctx.pages()[0] ?? await ctx.newPage()
  page.setDefaultTimeout(60_000)

  // 登录页 → 用读者账号登录
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#name', { timeout: 30_000 })
  await page.fill('#name', BASE_USERS.reader.name)
  await page.fill('#pwd', BASE_USERS.reader.password)
  await page.press('#pwd', 'Enter')
  // 新账号首启会进欢迎向导（不是项目中心）—— 先跳到项目管理
  await page.waitForFunction(() => {
    if (document.querySelector('[data-project-hub]')) return true
    return [...document.querySelectorAll('button')].some((b) => /跳过，直接进入项目管理/.test(b.textContent || ''))
  }, null, { timeout: 60_000 })
  const skipWizard = page.getByRole('button', { name: /跳过，直接进入项目管理/ }).first()
  if (await skipWizard.isVisible().catch(() => false)) await skipWizard.click()
  // 登录成功后进入项目中心
  await page.waitForSelector('[data-project-hub]', { timeout: 60_000 })
  ok('登录后进入项目中心', true)

  // 项目中心 → 投稿广场
  await page.getByRole('button', { name: /投稿广场/ }).first().click()
  await page.waitForSelector('[aria-label="投稿广场"]', { timeout: 60_000 })
  ok('投稿广场浮层已打开', true)

  // 卡片：浏览数 + 合集角标
  await page.waitForSelector('[title="浏览量（同一人一天只计一次）"]', { timeout: 30_000 })
  const viewsNodes = page.locator('[title="浏览量（同一人一天只计一次）"]')
  ok('卡片上出现浏览数', (await viewsNodes.count()) >= 3, String(await viewsNodes.count()))
  ok('🔴 卡片上有合集角标', (await page.locator('[data-collection-badge]').count()) >= 3,
    'badge=' + String(await page.locator('[data-collection-badge]').count()))

  // 打开第一篇
  await page.getByText(titles[0], { exact: true }).first().click()
  await page.waitForSelector('text=收录于《', { timeout: 30_000 })
  ok('🔴 详情显示「收录于《归墟（连载）》」', (await page.getByText(/收录于《归墟（连载）》/).count()) >= 1)
  ok('详情显示第 1 / 共 3 篇', (await page.getByText(/第 1 \/ 3 篇/).count()) >= 1)
  ok('🔴 刚打开的这篇立刻显示浏览数', (await page.locator('[title="浏览量（同一人一天只计一次）"]').count()) >= 1)

  // 下一篇
  await page.getByRole('button', { name: /下一篇/ }).first().click()
  await page.waitForSelector('text=第 2 / 3 篇', { timeout: 30_000 })
  ok('下一篇跳到第 2 / 3 篇', (await page.getByText(/第 2 \/ 3 篇/).count()) >= 1)

  // 打开合集浮层
  await page.locator('[data-collection-entry]').first().click()
  await page.waitForSelector('text=合计浏览', { timeout: 30_000 })
  ok('合集浮层显示合计浏览', (await page.getByText(/合计浏览/).count()) >= 1)
  const colItems = page.locator('ol li button')
  ok('合集目录列出 3 篇', (await colItems.count()) === 3, String(await colItems.count()))
  ok('🔴 合集页写明是篇次口径', (await page.getByText(/按第 1 篇起顺序阅读/).count()) >= 1)

  // 从目录跳到第 3 篇
  await colItems.nth(2).click()
  await page.waitForSelector('text=第 3 / 3 篇', { timeout: 30_000 })
  ok('从合集目录能跳到第 3 篇', (await page.getByText(/第 3 \/ 3 篇/).count()) >= 1)

  await page.screenshot({ path: path.join(runDir, 'collection-detail.png'), fullPage: false })
  console.log(`\n截图：${path.relative(ROOT, runDir)}/collection-detail.png`)

  // 浏览量确实涨了（读者读了 2 篇不同文章）
  const finalPage = await reader.req(`/api/community/collections/${colId}`)
  const total = finalPage.json?.collection?.totalViews ?? -1
  ok('🔴 合集合计浏览已增长（读者读了 2 篇）', total >= 2, String(total))
} catch (e) {
  console.error('\nE2E_FAIL', e && e.message ? e.message : e)
  if (ctx) {
    const p = ctx.pages()[0]
    if (p) {
      const snippet = await p.evaluate(() => (document.body.innerText || '').slice(0, 500)).catch(() => '')
      console.error('页面片段：', snippet.replace(/\s+/g, ' '))
    }
  }
  fail++
} finally {
  if (ctx) await ctx.close().catch(() => {})
  if (server) await stopServer(server)
  await rm(runDir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\ncommunityCollectionE2E: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
