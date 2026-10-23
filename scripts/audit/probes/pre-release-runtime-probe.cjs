#!/usr/bin/env node
'use strict'
// 生产构建验收。所有书库、浏览器资料和模型请求都限制在新建临时目录/本机假服务。
// 不封装、不调用真实模型、不读真实用户资料；不证明原生对话框、安装流程或真实 U 盘表现。
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { chromium, _electron } = require('playwright')
const { sourceFingerprint } = require('../context.cjs')
const ROOT = path.resolve(__dirname, '../../..')
const BUILD = path.join(ROOT, '.workbuddy/tmp/pre-release-3.2.2/build')
const EDITOR = '落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）'
const SEED = '例：一个靠吞噬他人修为续命的少年，在正道与魔道之间越走越深。'
const checks = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const rows = value => Object.values(value ?? {})
const record = (data, store, id) => rows(data.stores[store]).find(r => (r.id ?? r.key) === id)
function check(name, passed, detail) {
  checks.push({ name, passed: !!passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + JSON.stringify(detail) : ''}`)
  if (!passed) throw new Error(name)
}
async function until(fn, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { if (await fn()) return; await delay(100) }
  throw new Error('等待实际状态超时')
}
async function copyTree(from, to) {
  await fs.mkdir(to, { recursive: true })
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, e.name), target = path.join(to, e.name)
    if (e.isDirectory()) await copyTree(source, target)
    else await fs.copyFile(source, target)
  }
}
function fixture(withChapter = true, provider) {
  const now = Date.now()
  const data = {
    app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: now,
    stores: {
      projects: Object.fromEntries(['A','B'].map(id => [id, { id, name: `发布验收作品${id}`, genre: '玄幻', intro: '', projectType: 'full', createdAt: now, updatedAt: now }])),
      volumes: withChapter ? { V: { id: 'V', projectId: 'A', title: '验收卷', description: '', order: 0, createdAt: now } } : {},
      chapters: withChapter ? { C: { id: 'C', projectId: 'A', volumeId: 'V', title: '验收章', content: '发布验收原稿。', summary: '', order: 0, wordCount: 7, status: 'draft', tags: [], createdAt: now, updatedAt: now } } : {},
      meta: { welcomeDone: { key: 'welcomeDone', value: '1' } },
    },
  }
  if (provider) {
    data.stores.meta.aiProviders = { key: 'aiProviders', value: [provider] }
    data.stores.meta.aiActiveProviderId = { key: 'aiActiveProviderId', value: provider.id }
  }
  return data
}
async function dismiss(page) {
  for (const name of ['稍后再说','知道了','跳过，直接开始']) {
    const b = page.getByRole('button', { name, exact: true })
    if (await b.isVisible().catch(() => false)) await b.click()
  }
}
async function open(page, id) {
  await page.getByRole('heading', { name: `发布验收作品${id}`, exact: true }).waitFor({ timeout: 45000 })
  await dismiss(page)
  await page.locator('div.card-hover').filter({ has: page.getByRole('heading', { name: `发布验收作品${id}`, exact: true }) }).getByRole('button', { name: '打开项目', exact: true }).click()
  await page.getByRole('button', { name: '稍后再说', exact: true }).click({ timeout: 1500 }).catch(() => {})
  await dismiss(page)
}
async function creative(page) {
  const nav = page.getByRole('navigation')
  if (!await nav.getByRole('button', { name: '创意写作', exact: true }).isVisible()) await nav.getByRole('button', { name: '灵感工具', exact: true }).click()
  await nav.getByRole('button', { name: '创意写作', exact: true }).click()
  await page.getByPlaceholder(SEED).waitFor()
}
async function main() {
  for (const key of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy','ELECTRON_RUN_AS_NODE','NODE_OPTIONS']) delete process.env[key]
  const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/pre-release-runtime-'))
  const result = { at: new Date().toISOString(), runRoot, sourceFingerprint: sourceFingerprint(ROOT), build: BUILD, scope: 'Production renderer; real portable server/files and Electron IPC; local hanging mock model', checks }
  let portable, browser, app, preview, mock, page
  try {
    const portableRoot = path.join(runRoot, 'portable')
    await copyTree(BUILD, path.join(portableRoot, 'dist'))
    await fs.mkdir(path.join(portableRoot, 'data'))
    const dataFile = path.join(portableRoot, 'data/youth-fantasy-engine-data.json')
    await fs.writeFile(dataFile, JSON.stringify(fixture()))
    const load = async () => JSON.parse(await fs.readFile(dataFile, 'utf8'))
    portable = spawn(process.execPath, [path.join(ROOT, 'scripts/portable-server.mjs'), '--root', portableRoot, '--port', '8879', '--no-open'], { cwd: ROOT, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let serverLog = ''
    portable.stdout.on('data', d => { serverLog += d }); portable.stderr.on('data', d => { serverLog += d })
    await until(async () => { try { return (await fetch('http://127.0.0.1:8879/api/ping')).ok } catch { return false } })
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
    page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
    page.setDefaultTimeout(15000)
    await page.goto('http://127.0.0.1:8879')
    await open(page, 'A')
    await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
    const editor = page.getByPlaceholder(EDITOR)
    await editor.fill('生产构建保存成功。')
    await page.keyboard.press('Control+s')
    await until(async () => record(await load(), 'chapters', 'C')?.content === '生产构建保存成功。')
    check('便携生产构建经真实服务写入实际资料文件', true)
    const failSave = route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'prerelease injected failure' }) }) : route.continue()
    await page.route('**/api/data', failSave)
    await editor.fill('写失败后必须能恢复的手稿。')
    await page.keyboard.press('Control+s')
    await page.getByText('未写入磁盘', { exact: true }).waitFor()
    check('保存失败时两处界面状态一致且旧磁盘正文保留', await page.getByText('保存出错', { exact: true }).isVisible() && record(await load(), 'chapters', 'C')?.content === '生产构建保存成功。')
    await page.screenshot({ path: path.join(runRoot, 'portable-save-failure.png') })
    await page.unroute('**/api/data', failSave)
    await page.keyboard.press('Control+s')
    await until(async () => record(await load(), 'chapters', 'C')?.content === '写失败后必须能恢复的手稿。')
    await page.reload()
    // 导航状态可能已恢复，也可能回项目首页。
    if (await page.getByRole('heading', { name: '发布验收作品A', exact: true }).isVisible()) await open(page, 'A')
    await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
    await until(async () => (await page.getByPlaceholder(EDITOR).inputValue()) === '写失败后必须能恢复的手稿。')
    check('恢复后重试写盘并刷新仍能读到手稿', true)
    const downloadEvent = page.waitForEvent('download')
    await page.getByTitle('导出数据文件：把全部数据导出为一个 JSON 文件（浏览器下载），用于留档或搬到别的电脑', { exact: true }).click()
    const download = await downloadEvent
    const exportFile = path.join(runRoot, 'portable-export.json')
    await download.saveAs(exportFile)
    check('导出文件实际含本次保存的正文', record(JSON.parse(await fs.readFile(exportFile, 'utf8')), 'chapters', 'C')?.content === '写失败后必须能恢复的手稿。')
    await page.getByPlaceholder(EDITOR).fill('导出后另改的一版。')
    await page.keyboard.press('Control+s')
    await until(async () => record(await load(), 'chapters', 'C')?.content === '导出后另改的一版。')
    await page.getByTitle('导入数据文件：选择之前导出的数据文件，替换本机全部数据', { exact: true }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '继续导入', exact: true }).click()
    await (await chooser).setFiles(exportFile)
    await until(async () => record(await load(), 'chapters', 'C')?.content === '写失败后必须能恢复的手稿。')
    await page.waitForLoadState('domcontentloaded')
    check('实际选择导出文件导入，磁盘恢复到导出版本', true)
    await fs.writeFile(path.join(runRoot, 'portable-server.log'), serverLog)
    await browser.close(); browser = null
    portable.kill(); portable = null

    const mockRequests = []
    mock = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      let body = ''; req.on('data', d => { body += d }); req.on('end', () => { mockRequests.push({ url: req.url, body }); /* 保持请求，供切项目中止 */ })
    })
    await new Promise(resolve => mock.listen(8880, '127.0.0.1', resolve))
    const profile = path.join(runRoot, 'profile'), appData = path.join(runRoot, 'appdata')
    await fs.mkdir(profile); await fs.mkdir(appData)
    const desktopFile = path.join(profile, 'youth-fantasy-engine-data.json')
    await fs.writeFile(desktopFile, JSON.stringify(fixture(false, { id: 'mock', name: '本机验收假模型', type: 'openai', baseUrl: 'http://127.0.0.1:8880/v1', apiKey: 'fixture-only', model: 'mock', local: false, contextWindow: 32000 })))
    const desktop = async () => JSON.parse(await fs.readFile(desktopFile, 'utf8'))
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
    await fs.writeFile(path.join(runRoot, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: 'bootstrap.cjs' }))
    await fs.writeFile(path.join(runRoot, 'bootstrap.cjs'), `const {app}=require('electron');app.setPath('appData',${JSON.stringify(appData)});require(${JSON.stringify(path.join(ROOT, 'electron/main.cjs'))});`)
    const { preview: startPreview } = await import('vite')
    preview = await startPreview({ root: ROOT, build: { outDir: BUILD }, preview: { host: '127.0.0.1', port: 5210, strictPort: true } })
    app = await _electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [runRoot, '--no-sandbox', '--no-proxy-server', '--user-data-dir=' + profile], env: { ...process.env, ELECTRON_START_URL: 'http://127.0.0.1:5210' }, timeout: 45000 })
    page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await open(page, 'B'); await creative(page)
    await page.getByPlaceholder(SEED).fill('B项目独有的想法：海上灯塔。')
    await page.getByTitle('立刻把当前输入保存到本项目（平时改动也会自动保存）', { exact: true }).click()
    await until(async () => record(await desktop(), 'meta', 'creativeSession:B')?.value?.inputs?.seed === 'B项目独有的想法：海上灯塔。')
    await page.getByRole('button', { name: '切换项目', exact: true }).click()
    await open(page, 'A'); await creative(page)
    await page.getByRole('button', { name: '只做大纲规划', exact: true }).click()
    await page.getByPlaceholder(SEED).fill('A项目刚输入就切走：山城旧信。')
    const switchAt = Date.now()
    await page.getByRole('button', { name: '切换项目', exact: true }).click()
    const switchMs = Date.now() - switchAt
    await open(page, 'B'); await creative(page)
    await until(async () => record(await desktop(), 'meta', 'creativeSession:A')?.value?.inputs?.seed === 'A项目刚输入就切走：山城旧信。')
    await delay(1300)
    check('防抖结束前切项目：A输入存回A，B已有输入未被覆盖', switchMs < 1000 && (await page.getByPlaceholder(SEED).inputValue()) === 'B项目独有的想法：海上灯塔。' && record(await desktop(), 'meta', 'creativeSession:B')?.value?.inputs?.seed === 'B项目独有的想法：海上灯塔。', { switchMs })
    await page.getByRole('button', { name: '切换项目', exact: true }).click()
    await open(page, 'A'); await creative(page)
    await page.getByRole('button', { name: '开始规划', exact: true }).click()
    await until(async () => mockRequests.length > 0)
    check('生产构建真正发起本机假模型请求并进入运行态', await page.getByRole('button', { name: '创作中…', exact: true }).isVisible(), { requests: mockRequests.length })
    await page.getByRole('button', { name: '切换项目', exact: true }).click()
    await open(page, 'B'); await creative(page)
    await delay(1500)
    const bData = await desktop()
    check('运行中切项目：B不继承A的运行态、输入或章节', !await page.getByRole('button', { name: '创作中…', exact: true }).isVisible() && !await page.getByText(/上次中止在：/).isVisible() && await page.getByPlaceholder(SEED).inputValue() === 'B项目独有的想法：海上灯塔。' && rows(bData.stores.chapters).filter(r => r.projectId === 'B').length === 0 && rows(bData.stores.volumes).filter(r => r.projectId === 'B').length === 0)
    await page.screenshot({ path: path.join(runRoot, 'creative-project-boundary.png') })
    await fs.writeFile(path.join(runRoot, 'mock-requests.json'), JSON.stringify(mockRequests, null, 2))
  } catch (error) {
    result.error = error.stack ?? String(error)
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(runRoot, 'failure.png') }).catch(() => {})
      await fs.writeFile(path.join(runRoot, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {})
    }
    throw error
  } finally {
    if (app) await app.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    if (portable) portable.kill()
    if (preview) await new Promise(resolve => preview.httpServer.close(resolve))
    if (mock) { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)) }
    await fs.writeFile(path.join(runRoot, 'results.json'), JSON.stringify(result, null, 2))
    console.log('EVIDENCE ' + path.join(runRoot, 'results.json'))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
