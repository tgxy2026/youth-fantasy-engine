#!/usr/bin/env node
/**
 * 在途编辑 / 切项目 / 关窗写失败 · **桌面安装版**（3.2.6 · storage.four-profiles 最后一块）
 *
 * 与 portable / web-guest 同三条场景，但走的是真实 Electron 主进程 + preload + IPC + 文件系统：
 *   ① inflight-edit         `store:save` 还在主进程里跑的时候继续打字 → 最终落盘必须是最新那笔
 *   ② project-switch        保存在途时切到另一本书 → 原书那笔必须落盘、另一本书一个字节都不许动
 *   ③ close-write-failure   写失败态下**真关应用**（不是派发 beforeunload）→ 文件不许写坏、
 *                           重开读到的要么是关窗前那笔、要么是关窗兜底那笔，界面与磁盘不许两种结论
 *
 * 在途怎么造：`bootstrap.cjs` 里给 `store:save` 加一个**探针可控的延迟**（`saveDelay`），
 * 延迟包在真实 handler 里、和保存屏障同一处 —— 所以 `barrier.state.active === 1` 就是
 * 「确实有一笔保存在跑」。不用「等一会儿看看」冒充在途。
 *
 * 🔴 边界：只碰本次临时 appData / userData；网络在渲染层与主进程都被掐断；
 *    只把「另存为 / 打开文件」的目的地指到临时目录（原生弹窗无法自动化）。
 */
'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { _electron } = require('playwright')
const { openEditorNavigation } = require('./workspace-entry.cjs')

const ROOT = path.resolve(__dirname, '../../..')
const PA = 'inflight-dpa', VA = 'inflight-dva', CA = 'inflight-dca', TA = '桌面在途验收甲书'
const PB = 'inflight-dpb', VB = 'inflight-dvb', CB = 'inflight-dcb', TB = '桌面在途验收乙书'
const ORIG_A = '甲书原始手稿：在途写入后必须被最新一笔替换。'
const ORIG_B = '乙书原始手稿：切项目时一个字节都不许动。'
const EDITOR = '落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）'
const BACK = '返回项目列表'

const TEXT_A = '[inflight] 第一笔：保存在主进程里还没写完，用户已经继续打字。'
const TEXT_B = '[inflight] 第二笔：最终落盘的必须是这一笔。'
const TEXT_C = '[inflight] 切项目那一笔：切走之前必须落盘。'
const TEXT_D = '[inflight] 写失败那一笔：关应用后不许被静默当成已保存。'

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
/** 桌面写的是「主键 → 记录对象」，但容错读取两种形态都认 */
const chapterOf = (text, id) => {
  const rows = JSON.parse(text)?.stores?.chapters
  const list = Array.isArray(rows) ? rows : Object.values(rows ?? {})
  return list.find(row => row && row.id === id) ?? null
}

async function main() {
  const buildArg = arg('--build-dir')
  if (!buildArg) throw new Error('--build-dir is required')
  const build = await fs.realpath(path.resolve(buildArg))
  await fs.access(path.join(build, 'index.html'))
  const output = arg('--result-file')
  if (output && (!path.resolve(output).startsWith(path.join(ROOT, '.workbuddy', 'tmp') + path.sep) || !output.endsWith('.json'))) throw new Error('Result must be a JSON file under workspace .workbuddy/tmp')

  const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/inflight-desktop-'))
  const profile = path.join(runRoot, 'profile'), appData = path.join(runRoot, 'appdata')
  await fs.mkdir(profile); await fs.mkdir(appData)
  const activeFile = path.join(profile, 'youth-fantasy-engine-data.json'), keptFile = activeFile + '.test-kept'
  const { snapshot } = await import(pathToFileURL(path.join(ROOT, 'scripts/audit/platform/source.mjs')).href)
  const { hashPaths } = await import(pathToFileURL(path.join(ROOT, 'scripts/verify/evidence.mjs')).href)
  const sourceFingerprint = snapshot(ROOT).fingerprint
  const buildManifest = await hashPaths(build, ['.'])
  const now = Date.now()
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
  await fs.writeFile(activeFile, JSON.stringify({ app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: now, stores: {
    projects: {
      [PA]: { id: PA, name: TA, genre: '玄幻', intro: '', projectType: 'full', createdAt: now, updatedAt: now },
      [PB]: { id: PB, name: TB, genre: '玄幻', intro: '', projectType: 'full', createdAt: now, updatedAt: now },
    },
    volumes: {
      [VA]: { id: VA, projectId: PA, title: '甲卷', description: '', order: 0, createdAt: now },
      [VB]: { id: VB, projectId: PB, title: '乙卷', description: '', order: 0, createdAt: now },
    },
    chapters: {
      [CA]: { id: CA, projectId: PA, volumeId: VA, title: '甲章', content: ORIG_A, summary: '', wordCount: ORIG_A.length, order: 0, status: '草稿', tags: [], createdAt: now, updatedAt: now },
      [CB]: { id: CB, projectId: PB, volumeId: VB, title: '乙章', content: ORIG_B, summary: '', wordCount: ORIG_B.length, order: 0, status: '草稿', tags: [], createdAt: now, updatedAt: now },
    },
    meta: { welcomeDone: { key: 'welcomeDone', value: '1' } },
  } }))
  await fs.writeFile(path.join(runRoot, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: 'bootstrap.cjs' }))
  // 观察真实 handler，不替换它的结果；只加「可控延迟」和「文件选择器目的地」
  await fs.writeFile(path.join(runRoot, 'bootstrap.cjs'), `
const {app,ipcMain,dialog}=require('electron');
app.setPath('appData',${JSON.stringify(appData)});app.setPath('userData',${JSON.stringify(profile)});
const disk=require('node:fs/promises');
global.__desktopProbe={calls:[],filesystem:[],saveDelay:0,barrier:require(${JSON.stringify(path.join(ROOT, 'scripts/audit/probes/save-barrier.cjs'))}).createSaveBarrier()};
globalThis.fetch=async()=>{throw new Error('Network disabled in isolated desktop storage probe');};
const target=${JSON.stringify(activeFile)};
for(const name of ['rename','unlink','rmdir']){
 const original=disk[name].bind(disk);
 disk[name]=async(...args)=>{
  const observed=args.some(value=>typeof value==='string'&&value.startsWith(target));
  const event=observed?{name,args,at:Date.now()}:null;
  if(event)global.__desktopProbe.filesystem.push(event);
  try{const result=await original(...args);if(event)event.ok=true;return result;}
  catch(error){if(event)event.error=String(error);throw error;}
  finally{if(event)event.doneAt=Date.now();}
 };
}
const handle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,fn)=>handle(channel,async(...args)=>{
 const entry={channel,at:Date.now()};global.__desktopProbe.calls.push(entry);
 if(channel==='store:save')entry.body=JSON.parse(args[1]).stores.chapters[${JSON.stringify(CA)}]?.content;
 const invoke=async()=>{
  if(channel==='store:save'&&global.__desktopProbe.saveDelay)await new Promise(r=>setTimeout(r,global.__desktopProbe.saveDelay));
  const result=await fn(...args);entry.result=result;entry.doneAt=Date.now();
  if(channel==='store:save'){
   try{const bytes=await disk.readFile(target,'utf8');entry.diskAtReturn={body:JSON.parse(bytes).stores.chapters[${JSON.stringify(CA)}]?.content,bytes:Buffer.byteLength(bytes)};}
   catch(error){entry.diskAtReturn={error:String(error)};}
  }
  return result;
 };
 return channel==='store:save'?global.__desktopProbe.barrier.run(invoke):invoke();
});
dialog.showSaveDialog=async()=>({canceled:false,filePath:global.__desktopProbe.savePath||${JSON.stringify(path.join(runRoot, 'export.json'))}});
dialog.showOpenDialog=async(opts)=>{
 const properties=(opts&&opts.properties)||[];
 if(properties.includes('openFile'))return {canceled:false,filePaths:[global.__desktopProbe.savePath||${JSON.stringify(path.join(runRoot, 'export.json'))}]};
 return {canceled:true,filePaths:[]};
};
require(${JSON.stringify(path.join(ROOT, 'electron/main.cjs'))});
`)
  const env = { ...process.env, ELECTRON_START_URL: pathToFileURL(path.join(build, 'index.html')).href }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key]

  let app = null, page = null, blocked = false, error = null, runtimeLog = ''
  const launch = async () => {
    app = await _electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [runRoot, '--no-sandbox', '--no-proxy-server', '--user-data-dir=' + profile], env, timeout: 45000 })
    app.process().stdout?.on('data', value => { runtimeLog += value })
    app.process().stderr?.on('data', value => { runtimeLog += value })
    await app.evaluate(({ session }) => { session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })) })
    page = await app.firstWindow(); page.setDefaultTimeout(20000)
    page.on('pageerror', value => pageErrors.push(String(value)))
    await openProject(TA)
  }
  /**
   * 进正文编辑器。两种入口都要认：
   *   · 停在项目中心 → 点书卡上的「打开项目」；
   *   · 重启后应用自己回到了上次那本书（`meta.lastProject`）→ 已经在项目里，直接点页签。
   * 🔴 不认第二种就会在重启后干等项目中心标题 45 秒（本轮实测）。
   */
  const openProject = async title => {
    const card = page.getByRole('heading', { name: title, exact: true }).first()
    await Promise.race([
      card.waitFor({ timeout: 45000 }).catch(() => {}),
      page.locator('nav').first().waitFor({ state: 'attached', timeout: 45000 }).catch(() => {}),
    ])
    if (await card.isVisible()) {
      for (const name of ['稍后再说', '知道了', '跳过，直接开始']) {
        const button = page.getByRole('button', { name, exact: true })
        if (await button.isVisible().catch(() => false)) await button.click()
      }
      await page.locator('div.card-hover').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
        .getByRole('button', { name: '打开项目', exact: true }).click()
    }
    await openEditorNavigation(page)
    await page.getByPlaceholder(EDITOR).waitFor({ timeout: 45000 })
  }
  const calls = () => app.evaluate(() => global.__desktopProbe.calls)
  const setDelay = ms => app.evaluate((_electron, value) => { global.__desktopProbe.saveDelay = value }, ms)
  const diskText = async () => { try { return await fs.readFile(activeFile, 'utf8') } catch { return '' } }
  const diskChapter = async id => { const text = await diskText(); try { return chapterOf(text, id) } catch { return null } }
  const ta = () => page.getByPlaceholder(EDITOR)

  async function withPausedSaves(phase, mutate) {
    await app.evaluate(() => global.__desktopProbe.barrier.pause())
    try {
      const state = await app.evaluate(() => global.__desktopProbe.barrier.state)
      if (!state.paused || state.active !== 0) throw new Error('Fault environment is not quiescent')
      await mutate()
    } finally { await app.evaluate(() => global.__desktopProbe.barrier.resume()) }
  }
  /** 恢复被「占位成目录」的数据文件（用保存屏障串行化，别和数据保存抢） */
  async function removeBlocker() {
    await withPausedSaves('remove-blocker', async () => {
      let isDir = false
      try { isDir = (await fs.stat(activeFile)).isDirectory() } catch (e) { if (e.code !== 'ENOENT') throw e }
      if (isDir) await fs.rmdir(activeFile)
      blocked = false
    })
  }

  try {
    await launch()
    check('fixture-readback', (await ta().inputValue()) === ORIG_A && (await diskChapter(CA))?.content === ORIG_A)

    // ---------- ① inflight-edit ----------
    {
      await setDelay(4000)
      await ta().fill(TEXT_A)
      await page.keyboard.press('Control+s')
      await until(async () => (await calls()).some(call => call.channel === 'store:save' && call.body === TEXT_A && !call.doneAt), 30000, 'save in flight')
      await ta().fill(TEXT_B)
      const editedAt = Date.now()
      await until(async () => (await diskChapter(CA))?.content === TEXT_B, 60000, 'latest text persisted')
      const inFlight = (await calls()).filter(call => call.channel === 'store:save' && call.body === TEXT_A && call.doneAt && call.doneAt > editedAt)
      check('inflight-edit.in-flight-during-edit', inFlight.length > 0,
        `在途保存 ${inFlight.length} 笔，最晚一笔在改字后 ${inFlight.length ? Math.round((inFlight[inFlight.length - 1].doneAt - editedAt) / 100) / 10 : 0}s 才完成`)
      let valid = false
      try { JSON.parse(await diskText()); valid = true } catch { valid = false }
      check('inflight-edit.file-valid', valid && (await diskChapter(CA))?.content === TEXT_B)
      check('inflight-edit.ui-latest', (await ta().inputValue()) === TEXT_B)
      await sleep(2000)
      check('inflight-edit.no-late-clobber', (await diskChapter(CA))?.content === TEXT_B, String((await diskChapter(CA))?.content ?? '').slice(0, 20))
      await setDelay(0)
      await page.screenshot({ path: path.join(runRoot, 'inflight-edit.png') })
    }

    // ---------- ② project-switch ----------
    {
      await setDelay(4000)
      await ta().fill(TEXT_C)
      await sleep(300)
      await page.keyboard.press('Control+s')
      await until(async () => (await calls()).some(call => call.channel === 'store:save' && call.body === TEXT_C && !call.doneAt), 30000, 'switch text save in flight')
      const switchedAt = Date.now()
      await page.getByTitle(BACK).first().click()
      await page.getByRole('heading', { name: TA, exact: true }).first().waitFor({ timeout: 45000 })
      await openProject(TB)
      await until(async () => (await diskChapter(CA))?.content === TEXT_C, 45000, 'first project write landed')
      // 切换后允许请求尚未结束；磁盘读回后再核对这一笔的起止时间。
      const inFlight = (await calls()).filter(call => call.channel === 'store:save' && call.body === TEXT_C && call.at <= switchedAt && call.doneAt > switchedAt)
      check('project-switch.in-flight-during-switch', inFlight.length > 0, `切走时仍在途 ${inFlight.length} 笔`)
      const other = await diskChapter(CB)
      check('project-switch.write-landed', (await diskChapter(CA))?.content === TEXT_C)
      check('project-switch.other-untouched', other?.content === ORIG_B && other?.projectId === PB, JSON.stringify(other?.content ?? '').slice(0, 24))
      await setDelay(0)
      await page.screenshot({ path: path.join(runRoot, 'project-switch.png') })
      await page.getByTitle(BACK).first().click()
      await page.getByRole('heading', { name: TA, exact: true }).first().waitFor({ timeout: 45000 })
      await openProject(TA)
      check('project-switch.reopen-readback', (await ta().inputValue()) === TEXT_C)
    }

    // ---------- ③ close-write-failure：写失败态下真关应用 ----------
    {
      const beforeText = await diskText()
      await withPausedSaves('install-blocker', async () => {
        await fs.rename(activeFile, keptFile); await fs.mkdir(activeFile); blocked = true
      })
      await ta().fill(TEXT_D)
      await page.keyboard.press('Control+s')
      await page.locator('[data-storage-write-status="error"]').first().waitFor({ timeout: 30000 })
      check('close-write-failure.failure-visible', true)
      await page.screenshot({ path: path.join(runRoot, 'close-write-failure.png') })
      await app.close(); app = null            // 🔴 真关应用，不派发 beforeunload
      await sleep(1500)
      check('close-write-failure.blocker-still-blocked', (await fs.stat(activeFile)).isDirectory(),
        '关窗兜底竟把数据写进了被占位的路径')
      // 应用已经真关了 ⇒ 没有并发写者，直接撤挡板（屏障要 app 还活着才能用）
      await fs.rmdir(activeFile); blocked = false
      const keptText = await fs.readFile(keptFile, 'utf8')
      let valid = false
      try { JSON.parse(keptText); valid = true } catch { valid = false }
      check('close-write-failure.file-valid', valid, `${(keptText.length / 1024).toFixed(1)} kB`)
      const keptContent = chapterOf(keptText, CA)?.content
      check('close-write-failure.old-or-new', keptContent === TEXT_C || keptContent === TEXT_D,
        `关窗前=${String(chapterOf(beforeText, CA)?.content ?? '').slice(0, 8)}… 关窗后=${String(keptContent ?? '').slice(0, 8)}…`)
      // 撤挡板只是拿走那个占位目录，数据文件本身要放回去 —— 否则重开就是「首次使用」
      await fs.rename(keptFile, activeFile)

      await launch()
      check('close-write-failure.reopen-readback', (await ta().inputValue()) === keptContent, String(await ta().inputValue()).slice(0, 20))
      check('close-write-failure.no-false-error', (await page.locator('[data-storage-write-status="error"]').count()) === 0)
      await page.screenshot({ path: path.join(runRoot, 'close-write-failure-reopen.png') })
    }

    check('no-pageerror', pageErrors.length === 0, pageErrors)
    check('unchanged-inputs', snapshot(ROOT).fingerprint === sourceFingerprint && (await hashPaths(build, ['.'])).sha256 === buildManifest.sha256)
  } catch (value) {
    error = String(value.stack ?? value)
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(runRoot, 'failure.png') }).catch(() => {})
  } finally {
    if (blocked) await removeBlocker().catch(value => { error = [error, 'Blocker cleanup failed: ' + value].filter(Boolean).join('\n') })
    if (app) {
      await fs.writeFile(path.join(runRoot, 'ipc-final.json'), JSON.stringify(await calls().catch(() => []), null, 2)).catch(() => {})
      await app.close().catch(() => {})
    }
    await fs.writeFile(path.join(runRoot, 'electron.log'), runtimeLog)
    const artifacts = []
    for (const file of await fs.readdir(runRoot)) {
      if (!/\.(png|json|log)$/.test(file) || ['result.json', 'package.json'].includes(file)) continue
      artifacts.push({ path: path.relative(ROOT, path.join(runRoot, file)), sha256: hash(await fs.readFile(path.join(runRoot, file))) })
    }
    const scenarioGroups = {
      'inflight-edit': ['inflight-edit.in-flight-during-edit', 'inflight-edit.file-valid', 'inflight-edit.ui-latest', 'inflight-edit.no-late-clobber'],
      'project-switch': ['project-switch.in-flight-during-switch', 'project-switch.write-landed', 'project-switch.other-untouched', 'project-switch.reopen-readback'],
      'close-write-failure': ['close-write-failure.failure-visible', 'close-write-failure.blocker-still-blocked', 'close-write-failure.file-valid', 'close-write-failure.old-or-new', 'close-write-failure.reopen-readback', 'close-write-failure.no-false-error'],
    }
    const passedIds = new Set(checks.filter(item => item.passed).map(item => item.id))
    const scenarios = Object.entries(scenarioGroups).filter(([, ids]) => ids.every(id => passedIds.has(id))).map(([name]) => name)
    const result = {
      schemaVersion: 1, profile: 'desktop', scenarios,
      scope: 'Production build via file URL; real Electron main/preload/IPC/filesystem; isolated appData/userData; probe-controlled save delay inside the real handler; whole app really closed; no native-dialog or install claim',
      runRoot, sourceFingerprint, build, buildManifest, at: new Date().toISOString(),
      passed: checks.filter(item => item.passed).length,
      failed: checks.filter(item => !item.passed).length + (error ? 1 : 0),
      checks, artifacts, pageErrors, error,
    }
    const target = path.join(runRoot, 'result.json')
    await fs.writeFile(target, JSON.stringify(result, null, 2))
    if (output) await fs.writeFile(path.resolve(output), JSON.stringify(result, null, 2))
    console.log('INFLIGHT_DESKTOP_RESULT ' + JSON.stringify({ result: target, passed: result.passed, failed: result.failed, scenarios, error }))
    if (result.failed) process.exitCode = 1
  }
}
main().catch(value => { console.error(value); process.exitCode = 1 })
