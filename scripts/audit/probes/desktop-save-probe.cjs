#!/usr/bin/env node
// Actual production renderer, preload, IPC handlers and filesystem; isolated data only.
'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { _electron } = require('playwright')
const ROOT = path.resolve(__dirname, '../../..')
const PID = 'desktop-save-project', VID = 'desktop-save-volume', CH = 'desktop-save-chapter'
const TITLE = '桌面保存故障临时作品', ORIGINAL = '隔离桌面模式的原始手稿。'
const DRAFT = '桌面写盘失败时仍保留这份草稿，恢复后无需重新输入。'
const EDITOR = '落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）'
const checks = [], pageErrors = []
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const arg = name => { const at = process.argv.indexOf(name); if (at < 0) return; const value = process.argv[at + 1]; if (!value || value.startsWith('--')) throw new Error(name + ' requires a value'); return value }
const check = (id, ok, detail) => { checks.push({ id, passed: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id); if (!ok) throw new Error(id) }
async function until(fn, timeout = 45000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error('Timed out waiting for actual state')
}
async function openEditor(page) {
  await page.getByRole('heading', { name: TITLE, exact: true }).waitFor({ timeout: 45000 })
  for (const name of ['稍后再说', '知道了', '跳过，直接开始']) {
    const button = page.getByRole('button', { name, exact: true })
    if (await button.isVisible().catch(() => false)) await button.click()
  }
  await page.locator('div.card-hover').filter({ has: page.getByRole('heading', { name: TITLE, exact: true }) }).getByRole('button', { name: '打开项目', exact: true }).click()
  await page.getByRole('navigation').waitFor()
  await page.getByRole('button', { name: '稍后再说', exact: true }).click({ timeout: 5000 }).catch(() => {})
  await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
  await page.getByPlaceholder(EDITOR).waitFor()
}
async function main() {
  const buildArg = arg('--build-dir')
  if (!buildArg) throw new Error('--build-dir is required')
  const build = await fs.realpath(path.resolve(buildArg))
  await fs.access(path.join(build, 'index.html'))
  const output = arg('--result-file')
  if (output && (!path.resolve(output).startsWith(path.join(ROOT, '.workbuddy/tmp') + path.sep) || !output.endsWith('.json'))) throw new Error('Result must be JSON under workspace .workbuddy/tmp')
  const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/desktop-save-'))
  const profile = path.join(runRoot, 'profile'), appData = path.join(runRoot, 'appdata')
  await fs.mkdir(profile); await fs.mkdir(appData)
  const activeFile = path.join(profile, 'youth-fantasy-engine-data.json'), keptFile = activeFile + '.test-kept'
  const exportFile = path.join(runRoot, 'failure-export.json')
  const { snapshot } = await import(pathToFileURL(path.join(ROOT, 'scripts/audit/platform/source.mjs')).href)
  const { hashPaths } = await import(pathToFileURL(path.join(ROOT, 'scripts/verify/evidence.mjs')).href)
  const sourceFingerprint = snapshot(ROOT).fingerprint, buildManifest = await hashPaths(build, ['.'])
  const now = Date.now(), pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
  await fs.writeFile(activeFile, JSON.stringify({ app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: now, stores: {
    projects: { [PID]: { id: PID, name: TITLE, genre: '玄幻', intro: '', projectType: 'full', createdAt: now, updatedAt: now } },
    volumes: { [VID]: { id: VID, projectId: PID, title: '验收卷', description: '', order: 0, createdAt: now } },
    chapters: { [CH]: { id: CH, projectId: PID, volumeId: VID, title: '桌面验收章', content: ORIGINAL, summary: '', wordCount: ORIGINAL.length, order: 0, status: '草稿', tags: [], createdAt: now, updatedAt: now } },
    meta: { welcomeDone: { key: 'welcomeDone', value: '1' } },
  } }))
  await fs.writeFile(path.join(runRoot, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: 'bootstrap.cjs' }))
  // Observe production handlers without replacing their save result. Only the chooser destination is stubbed.
  await fs.writeFile(path.join(runRoot, 'bootstrap.cjs'), `
const {app,ipcMain,dialog}=require('electron');
app.setPath('appData',${JSON.stringify(appData)});app.setPath('userData',${JSON.stringify(profile)});
global.__desktopProbe={calls:[]};
const handle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,fn)=>handle(channel,async(...args)=>{
 const entry={channel,at:Date.now()};global.__desktopProbe.calls.push(entry);
 if(channel==='store:save')entry.body=JSON.parse(args[1]).stores.chapters[${JSON.stringify(CH)}]?.content;
 const result=await fn(...args);entry.result=result;entry.doneAt=Date.now();return result;
});
dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(exportFile)}});
require(${JSON.stringify(path.join(ROOT, 'electron/main.cjs'))});
`)
  const env = { ...process.env, ELECTRON_START_URL: pathToFileURL(path.join(build, 'index.html')).href }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key]
  let app, page, blocked = false, error = null, runtimeLog = ''
  const launch = async () => {
    app = await _electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [runRoot, '--no-sandbox', '--no-proxy-server', '--user-data-dir=' + profile], env, timeout: 45000 })
    app.process().stdout?.on('data', value => { runtimeLog += value }); app.process().stderr?.on('data', value => { runtimeLog += value })
    // Refuse all network traffic in both renderer and main session. Local file assets remain usable.
    await app.evaluate(({ session }) => { session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })) })
    page = await app.firstWindow(); page.setDefaultTimeout(15000)
    page.on('pageerror', value => pageErrors.push(String(value)))
    await openEditor(page)
  }
  const calls = () => app.evaluate(() => global.__desktopProbe.calls)
  /**
   * 解除"用空目录挡住目标文件"的注入（幂等）。
   * · 目标仍是空目录 ⇒ 先移除它，**然后让应用自己写回来**；
   * · 目标已被应用自己写回（先删后改名）⇒ 保留应用那份，删掉我们暂存的旧字节；
   * · 应用 15s 内确实没写 ⇒ 才把旧字节补回去兜底（保证后续重启回读有料可读）。
   *
   * 🔴 为什么不"撤掉目录就立刻补回旧字节"：实测踩过 —— rmdir 与应用的 write→rename 撞在一起，
   *    应用刚写成功的 DRAFT 被探针补回的旧字节覆盖，随后 retry-readback 读到旧正文、
   *    整步被判超时（2026-10-24，reliability-SU3mP6）。挡板是我们造的，撤掉后应该等应用自己说结果。
   * 任何情况下都不许抛错，否则清理阶段会中断、Electron 不退出，整步被判超时。
   */
  async function restoreFromBlocker() {
    try {
      let isDir = false
      try { isDir = (await fs.stat(activeFile)).isDirectory() } catch (e) { if (e.code !== 'ENOENT') throw e }
      if (isDir) await fs.rmdir(activeFile)
      blocked = false
      const end = Date.now() + 15000
      let written = false
      while (Date.now() < end) {
        written = await fs.stat(activeFile).then(s => s.isFile(), () => false)
        if (written) break
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      if (written) await fs.rm(keptFile).catch(() => {})
      else if (await fs.stat(keptFile).then(() => true, () => false)) await fs.rename(keptFile, activeFile)
    } catch (e) {
      console.warn('[desktop-probe] 恢复阶段未能完全还原（不影响本次结论，已记录）：', e instanceof Error ? e.message : String(e))
    } finally {
      blocked = false
    }
  }
  try {
    await launch()
    check('initial-flags', await page.evaluate(() => !!window.electronStore && !window.__YFE_PORTABLE__ && !window.__YFE_WEB__ && !window.__YFE_GUEST__))
    const locations = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), appData: app.getPath('appData') }))
    check('isolated-paths', locations.userData === profile && locations.appData === appData && (await page.evaluate(() => window.electronStore.dataPath())) === activeFile, locations)
    check('fixture-readback', (await page.getByPlaceholder(EDITOR).inputValue()) === ORIGINAL && JSON.parse(await fs.readFile(activeFile, 'utf8')).stores.chapters[CH].content === ORIGINAL)
    // Wait for startup persistence to settle before moving only this probe's known file.
    await until(async () => !(await calls()).some(call => call.channel === 'store:save' && !call.doneAt))
    await fs.rename(activeFile, keptFile); await fs.mkdir(activeFile); blocked = true
    const originalBytes = await fs.readFile(keptFile)
    await page.getByPlaceholder(EDITOR).fill(DRAFT); await page.keyboard.press('Control+s')
    await until(async () => (await calls()).some(call => call.channel === 'store:save' && call.body === DRAFT && call.result?.ok === false))
    await page.getByRole('button', { name: '保存出错', exact: true }).waitFor()
    const failures = (await calls()).filter(call => call.channel === 'store:save' && call.body === DRAFT && call.result?.ok === false)
    check('failure-visible', failures.length > 0 && failures.every(call => /rename|EISDIR|EPERM|EACCES/i.test(call.result.error)), failures)
    check('failure-preserves-draft', (await page.getByPlaceholder(EDITOR).inputValue()) === DRAFT)
    check('accepted-vs-persisted', (await fs.stat(activeFile)).isDirectory() && hash(await fs.readFile(keptFile)) === hash(originalBytes) && JSON.parse(originalBytes).stores.chapters[CH].content === ORIGINAL)
    // A second real failed IPC write, with no new typing, proves dirty was retained for automatic retry.
    await until(async () => (await calls()).filter(call => call.channel === 'store:save' && call.body === DRAFT && call.result?.ok === false).length > failures.length)
    check('dirty-retry', true)
    await page.screenshot({ path: path.join(runRoot, 'write-failure.png') })
    await page.getByTitle('导出数据文件：把本机全部数据导出一个 JSON 文件，用于留档或搬到别的电脑', { exact: true }).click()
    await until(async () => { try { return JSON.parse(await fs.readFile(exportFile, 'utf8')).stores.chapters[CH].content === DRAFT } catch { return false } })
    check('failure-export', true)
    check('export-preserves-failure', (await fs.stat(activeFile)).isDirectory() && hash(await fs.readFile(keptFile)) === hash(originalBytes) && (await page.getByPlaceholder(EDITOR).inputValue()) === DRAFT)
    await page.screenshot({ path: path.join(runRoot, 'failure-export.png') })
    // Restore only the empty directory just created here; keep the original bytes until recovery.
    // 🔴 幂等：应用自己的写盘若「先删目标再 rename」，会在我们恢复前把空目录换掉 ——
    //    这时 rmdir 会 ENOENT（实测踩过，导致清理阶段抛错、Electron 没关、整步被 180s 超时判红）。
    await restoreFromBlocker()
    await until(async () => JSON.parse(await fs.readFile(activeFile, 'utf8')).stores.chapters[CH].content === DRAFT)
    check('retry-readback', true)
    await page.getByRole('button', { name: '已保存', exact: true }).waitFor()
    check('recovery-visible', !(await page.getByRole('button', { name: '保存出错', exact: true }).count()))
    check('backend-selection', (await calls()).some(call => call.channel === 'store:load' && call.result?.path === activeFile) && (await calls()).some(call => call.channel === 'store:save' && call.body === DRAFT && call.result?.ok === true))
    await fs.writeFile(path.join(runRoot, 'ipc-before-restart.json'), JSON.stringify(await calls(), null, 2))
    await app.close(); app = null
    await launch()
    check('restart-readback', (await page.getByPlaceholder(EDITOR).inputValue()) === DRAFT && JSON.parse(await fs.readFile(activeFile, 'utf8')).stores.chapters[CH].content === DRAFT)
    await page.screenshot({ path: path.join(runRoot, 'restart-readback.png') })
    await fs.writeFile(path.join(runRoot, 'chapter-readback.json'), JSON.stringify(JSON.parse(await fs.readFile(activeFile, 'utf8')).stores.chapters[CH], null, 2))
    check('no-pageerror', pageErrors.length === 0, pageErrors)
    check('unchanged-inputs', snapshot(ROOT).fingerprint === sourceFingerprint && (await hashPaths(build, ['.'])).sha256 === buildManifest.sha256)
  } catch (value) {
    error = String(value.stack ?? value)
    if (page) await page.screenshot({ path: path.join(runRoot, 'failure.png') }).catch(() => {})
  } finally {
    if (blocked) await restoreFromBlocker()
    if (app) { await fs.writeFile(path.join(runRoot, 'ipc-final.json'), JSON.stringify(await calls().catch(() => []), null, 2)).catch(() => {}); await app.close().catch(() => {}) }
    await fs.writeFile(path.join(runRoot, 'electron.log'), runtimeLog)
    const artifacts = []
    for (const file of await fs.readdir(runRoot)) if (/\.(png|json|log)$/.test(file) && !['result.json', 'package.json'].includes(file)) artifacts.push({ path: path.relative(ROOT, path.join(runRoot, file)), sha256: hash(await fs.readFile(path.join(runRoot, file))) })
    const result = { schemaVersion: 1, profile: 'desktop', scope: 'Production build via file URL; real Electron main/preload/IPC/files; rename blocked by isolated empty directory; chooser destination stubbed, no native-dialog/install/disk-full claim', runRoot, sourceFingerprint, build, buildManifest, at: new Date().toISOString(), passed: checks.filter(item => item.passed).length, failed: checks.filter(item => !item.passed).length + (error ? 1 : 0), checks, artifacts, pageErrors, error }
    const target = path.join(runRoot, 'result.json')
    await fs.writeFile(target, JSON.stringify(result, null, 2))
    if (output) await fs.writeFile(path.resolve(output), JSON.stringify(result, null, 2))
    console.log('DESKTOP_SAVE_RESULT ' + JSON.stringify({ result: target, passed: result.passed, failed: result.failed, error }))
    if (result.failed) process.exitCode = 1
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
