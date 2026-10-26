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
/** 密钥剥离场景用的假密钥（只为证明它不会出现在导出文件里） */
const SECRET = 'sk-probe-desktop-secret-do-not-export'
const AFTER = '导入之前先改成这样，看导入能不能把它换回导出那一刻。'
const EDITOR = '落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）'
const EXPORT_TITLE = '导出数据文件：把本机全部数据导出一个 JSON 文件，用于留档或搬到别的电脑'
const IMPORT_TITLE = '导入数据文件：选择之前导出的数据文件，替换本机全部数据'
/**
 * 从整库文本里取本章（行形态两种都要认）。
 * 桌面保存写的是主键→记录对象；云端/便携写的是数组。同一个 `portable-data` 形态因端而异，
 * 只认一种会静默读成 undefined（3.2.3 云端探针实测踩过）。
 */
const chapterOf = text => {
  const rows = JSON.parse(text)?.stores?.chapters
  const list = Array.isArray(rows) ? rows : Object.values(rows ?? {})
  return list.find(row => row && row.id === CH)
}
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
  // 🔴 备份提醒会把背景置为 inert/aria-hidden ⇒ 背景里的 `<nav>` 从可访问性树消失，
  //    `getByRole('navigation')` 连 attached 都等不到（2026-10-26 实测同款问题）。
  //    先按 CSS 等进 DOM，再循环关提醒，最后仍要求 role=导航可见。
  const navEl = page.locator('nav')
  await navEl.waitFor({ state: 'attached', timeout: 45000 })
  const nav = page.getByRole('navigation')
  const navDeadline = Date.now() + 45000
  while (Date.now() < navDeadline && !(await nav.isVisible().catch(() => false))) {
    for (const name of ['稍后再说', '知道了']) {
      await page.getByRole('button', { name, exact: true }).click({ timeout: 2000 }).catch(() => {})
    }
    await page.waitForTimeout(200)
  }
  await nav.waitFor({ timeout: 5000 })
  // 🔴 仅仅「导航可见」还不够：提醒层的挂载/关闭是异步的，可能在导航可见之后又盖上来
  //    （2026-10-26 实测 storage.desktop-save：点「正文编辑」被遮挡，等满 15s 超时）。
  //    这里改成「点一下 → 关提醒 → 再点」，直到真的进了正文编辑；进不去仍然报错。
  const enterDeadline = Date.now() + 45000
  let entered = false
  while (!entered && Date.now() < enterDeadline) {
    try {
      await nav.getByRole('button', { name: '正文编辑', exact: true }).click({ timeout: 4000 })
      await page.getByPlaceholder(EDITOR).waitFor({ timeout: 8000 })
      entered = true
    } catch {
      for (const name of ['稍后再说', '知道了', '跳过，直接开始']) {
        await page.getByRole('button', { name, exact: true }).click({ timeout: 1500 }).catch(() => {})
      }
      await page.waitForTimeout(200)
    }
  }
  if (!entered) throw new Error('无法进入正文编辑：导航不可用或仍有提醒遮挡')
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
const disk=require('node:fs/promises');
global.__desktopProbe={calls:[],filesystem:[],barrier:require(${JSON.stringify(path.join(ROOT, 'scripts/audit/probes/save-barrier.cjs'))}).createSaveBarrier()};
// Node's main-process fetch is outside Electron session.webRequest. Disable it before startup too.
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
 if(channel==='store:save')entry.body=JSON.parse(args[1]).stores.chapters[${JSON.stringify(CH)}]?.content;
 const invoke=async()=>{
  const result=await fn(...args);entry.result=result;entry.doneAt=Date.now();
  if(channel==='store:save'){
   try{const bytes=await disk.readFile(target,'utf8');entry.diskAtReturn={body:JSON.parse(bytes).stores.chapters[${JSON.stringify(CH)}]?.content,bytes:Buffer.byteLength(bytes)};}
   catch(error){entry.diskAtReturn={error:String(error)};}
  }
  return result;
 };
 return channel==='store:save'?global.__desktopProbe.barrier.run(invoke):invoke();
});
dialog.showSaveDialog=async()=>({canceled:false,filePath:global.__desktopProbe.savePath||${JSON.stringify(exportFile)}});
// 导入用的文件选择器：只对 openFile 生效（openDirectory 用于云同步选目录，保持取消，别误触发）
dialog.showOpenDialog=async(opts)=>{
 const properties=(opts&&opts.properties)||[];
 if(properties.includes('openFile'))return {canceled:false,filePaths:[global.__desktopProbe.savePath||${JSON.stringify(exportFile)}]};
 return {canceled:true,filePaths:[]};
};
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
  const barriers = []
  async function withPausedSaves(phase, mutate) {
    await app.evaluate(() => global.__desktopProbe.barrier.pause())
    try {
      const state = await app.evaluate(() => global.__desktopProbe.barrier.state)
      if (!state.paused || state.active !== 0) throw new Error('Fault environment is not quiescent')
      const event = { phase, at: Date.now(), ...state }
      barriers.push(event)
      await mutate()
      event.mutatedAt = Date.now()
    } finally { await app.evaluate(() => global.__desktopProbe.barrier.resume()) }
    await fs.writeFile(path.join(runRoot, 'save-barriers.json'), JSON.stringify(barriers, null, 2))
  }
  /**
   * Serialize probe-owned environment changes against actual saves; never restore old bytes.
   * The old intermittent failure was not reproduced with tracing, so do not claim a product root cause.
   */
  async function restoreFromBlocker() {
    await withPausedSaves('remove-blocker', async () => {
      let isDir = false
      try { isDir = (await fs.stat(activeFile)).isDirectory() } catch (e) { if (e.code !== 'ENOENT') throw e }
      if (isDir) await fs.rmdir(activeFile)
      blocked = false
    })
  }
  try {
    await launch()
    check('initial-flags', await page.evaluate(() => !!window.electronStore && !window.__YFE_PORTABLE__ && !window.__YFE_WEB__ && !window.__YFE_GUEST__))
    const locations = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), appData: app.getPath('appData') }))
    check('isolated-paths', locations.userData === profile && locations.appData === appData && (await page.evaluate(() => window.electronStore.dataPath())) === activeFile, locations)
    check('fixture-readback', (await page.getByPlaceholder(EDITOR).inputValue()) === ORIGINAL && JSON.parse(await fs.readFile(activeFile, 'utf8')).stores.chapters[CH].content === ORIGINAL)
    await withPausedSaves('install-blocker', async () => {
      await fs.rename(activeFile, keptFile); await fs.mkdir(activeFile); blocked = true
    })
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
    await restoreFromBlocker()
    check('recovery-barrier', barriers.length === 2 && barriers.every(item => item.paused && item.active === 0 && item.mutatedAt >= item.at))
    // 撤掉挡板后按一次 Ctrl+S —— 作者在「请恢复写权限后重试」之后真正会做的动作。
    // 「没有新输入也会自己重试」已由上面的 dirty-retry 单独证明；这里要证的是「故障排除后能存进去」。
    await page.keyboard.press('Control+s')
    await until(async () => { try { return chapterOf(await fs.readFile(activeFile, 'utf8'))?.content === DRAFT } catch { return false } }, 45000)
    check('retry-readback', true)
    await page.getByRole('button', { name: '已保存', exact: true }).waitFor()
    check('recovery-visible', !(await page.getByRole('button', { name: '保存出错', exact: true }).count()))
    const actualCalls = await calls(), successfulSaves = actualCalls.filter(call => call.channel === 'store:save' && call.result?.ok === true)
    check('backend-selection', actualCalls.some(call => call.channel === 'store:load' && call.result?.path === activeFile)
      && successfulSaves.some(call => call.body === DRAFT)
      && successfulSaves.every(call => call.diskAtReturn?.body === call.body), successfulSaves)
    await fs.writeFile(path.join(runRoot, 'ipc-before-restart.json'), JSON.stringify(await calls(), null, 2))
    await fs.writeFile(path.join(runRoot, 'filesystem-before-restart.json'), JSON.stringify(await app.evaluate(() => global.__desktopProbe.filesystem), null, 2))
    await app.close(); app = null
    await launch()
    check('restart-readback', (await page.getByPlaceholder(EDITOR).inputValue()) === DRAFT && JSON.parse(await fs.readFile(activeFile, 'utf8')).stores.chapters[CH].content === DRAFT)
    await page.screenshot({ path: path.join(runRoot, 'restart-readback.png') })
    await fs.writeFile(path.join(runRoot, 'chapter-readback.json'), JSON.stringify(JSON.parse(await fs.readFile(activeFile, 'utf8')).stores.chapters[CH], null, 2))
    // ---------- 端到端往返：真实导出 → 改库落盘 → 真实导入 → 重启核对 ----------
    // 方案要的是「各配置**端到端**导出→导入（实际落文件再导回）」，不是格式层拼装。
    // 全程真实 UI + 真实文件；只把文件选择器的目的地指到本次临时目录（原生弹窗无法自动化）。
    {
      const roundtripFile = path.join(runRoot, 'roundtrip-export.json')

      // ---------- 子场景 ①：sidecars（桌面把备份载荷外置成文件，导出必须内联回来）----------
      // 桌面与便携的取舍不同：vec/kb 留在独立 IDB（按设计不进整库 JSON），
      // 真正外置的是 backupPayloads（per-id 一份一个文件）。这里经**真实 IPC** 写一条载荷，
      // 再要求导出把它内联、导入把它拆回 —— 与便携侧那套同构。
      const PAYLOAD_ID = 'payload-probe-1'
      const payloadBody = JSON.stringify({ id: PAYLOAD_ID, projectId: PID, chapters: [{ id: 'c-payload', content: '外置载荷探针' }], at: 1 })
      await page.evaluate(({ id, body }) => window.electronStore.payloadWrite('backupPayloads', id, body), { id: PAYLOAD_ID, body: payloadBody })
      const payloadListed = await page.evaluate(() => window.electronStore.payloadList('backupPayloads'))
      check('sidecars.seeded', Array.isArray(payloadListed?.ids) && payloadListed.ids.includes('payload-probe-1'), JSON.stringify(payloadListed).slice(0, 120))

      // ---------- 子场景 ②：secret-stripping 的种子 ----------
      // 密钥住在数据文件的 meta 行里，只能让应用**从文件里读**才能证明"导出会剥掉"。
      // 所以：关掉应用 → 直接往数据文件塞一行 → 重新启动（应用读到的就是这枚密钥）。
      await app.close(); app = null
      {
        const raw = JSON.parse(await fs.readFile(activeFile, 'utf8'))
        raw.stores = raw.stores || {}
        raw.stores.meta = raw.stores.meta || {}
        raw.stores.meta.aiProviders = { key: 'aiProviders', value: { activeId: 'probe', providers: [{ id: 'probe', apiKey: SECRET }] } }
        await fs.writeFile(activeFile, JSON.stringify(raw))
      }
      await launch()
      const seededFile = await fs.readFile(activeFile, 'utf8')
      check('secret-stripping.secret-present-before', seededFile.includes(SECRET), '数据文件里应能看到播种的密钥')

      await app.evaluate((_electron, target) => { global.__desktopProbe.savePath = target }, roundtripFile)
      await page.getByTitle(EXPORT_TITLE, { exact: true }).click()
      await until(async () => {
        try { return chapterOf(await fs.readFile(roundtripFile, 'utf8'))?.content === DRAFT } catch { return false }
      }, 20000)
      check('roundtrip-export', true, 'exported snapshot holds the current draft')

      const exportedJson = JSON.parse(await fs.readFile(roundtripFile, 'utf8'))
      const exportedPayloads = exportedJson?.stores?.backupPayloads
      const exportedPayloadList = Array.isArray(exportedPayloads) ? exportedPayloads : Object.values(exportedPayloads ?? {})
      check('sidecars.inlined-on-export', exportedPayloadList.some(row => row && row.id === PAYLOAD_ID),
        `导出 ${exportedPayloadList.length} 份载荷${exportedPayloadList.some(r => r && r.id === PAYLOAD_ID) ? '（含探针载荷）' : '（缺探针载荷）'}`)
      const exportedMeta = exportedJson?.stores?.meta
      const exportedMetaKeys = Array.isArray(exportedMeta) ? exportedMeta.map(r => String(r?.key ?? '')) : Object.keys(exportedMeta ?? {})
      check('secret-stripping.absent-after-export',
        !(await fs.readFile(roundtripFile, 'utf8')).includes(SECRET) && !exportedMetaKeys.includes('aiProviders'),
        `meta 含 aiProviders=${exportedMetaKeys.includes('aiProviders')}`)

      // 先把库改成别的样子 —— 不改的话，「导入回到导出那一刻」什么都证明不了
      await page.getByPlaceholder(EDITOR).fill(AFTER)
      await page.keyboard.press('Control+s')
      await until(async () => chapterOf(await fs.readFile(activeFile, 'utf8'))?.content === AFTER, 25000)
      check('roundtrip-changed', true, 'library now differs from the export')

      // 导入：确认框 →「继续导入」→ 应用会 location.reload()
      // 🔴 必须真的等这次 reload：点了「继续导入」后页面还停在编辑器里，此时若按"textarea 在不在"判断，
      //    会立刻判成"已经回到编辑器"，然后 reload 一来又被打回项目中心（第一轮就这么超时的）。
      await page.getByTitle(IMPORT_TITLE, { exact: true }).click()
      const reloaded = page.waitForEvent('load', { timeout: 45000 })
      await page.getByRole('button', { name: '继续导入', exact: true }).click()
      await reloaded
      await openEditor(page)
      await until(async () => chapterOf(await fs.readFile(activeFile, 'utf8'))?.content === DRAFT, 25000)
      check('roundtrip-import-readback',
        (await page.getByPlaceholder(EDITOR).inputValue()) === DRAFT
        && chapterOf(await fs.readFile(activeFile, 'utf8'))?.content === DRAFT,
        await page.getByPlaceholder(EDITOR).inputValue())
      await page.screenshot({ path: path.join(runRoot, 'roundtrip-import.png') })

      // 导入的文件里载荷是内联的 ⇒ 导入后必须再拆回外置文件，否则每次导入都把外置数据搬回主 JSON
      let payloadRestored = false
      for (let i = 0; i < 40; i++) {
        const listed = await page.evaluate(() => window.electronStore.payloadList('backupPayloads'))
        if (Array.isArray(listed?.ids) && listed.ids.includes('payload-probe-1')) {
          const back = await page.evaluate(() => window.electronStore.payloadRead('backupPayloads', 'payload-probe-1'))
          if (back?.ok && JSON.stringify(back.value) === payloadBody) { payloadRestored = true; break }
        }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      check('sidecars.restored-after-import', payloadRestored, '导入后外置载荷应回到文件里且内容一致')

      // ---------- 子场景 ③④：两个必须被拒的导入（版本闸 / 损坏文件）----------
      const beforeReject = await fs.readFile(activeFile, 'utf8')
      const importExpectRefusal = async (file, pattern, label) => {
        await app.evaluate((_electron, target) => { global.__desktopProbe.savePath = target }, file)
        await page.getByTitle(IMPORT_TITLE, { exact: true }).click()
        await page.getByRole('button', { name: '继续导入', exact: true }).click()
        const toast = page.getByText(pattern).first()
        await toast.waitFor({ timeout: 25000 })
        check(label, true, ((await toast.textContent()) || '').trim().slice(0, 120))
      }
      const newerVersionFile = path.join(runRoot, 'newer-version.json')
      await fs.writeFile(newerVersionFile, JSON.stringify({ ...exportedJson, fileVersion: 999 }))
      await importExpectRefusal(newerVersionFile, /更新版本的软件导出/, 'schema-version.reject-newer')
      const afterVersionReject = await fs.readFile(activeFile, 'utf8')
      check('schema-version.data-unchanged', beforeReject === afterVersionReject, '被拒的导入居然改动了数据文件')

      const corruptFile = path.join(runRoot, 'corrupt.json')
      await fs.writeFile(corruptFile, '{"kind":"portable-data","stores":{')
      await importExpectRefusal(corruptFile, /已损坏/, 'restore-failure.corrupt-rejected')
      const afterCorruptReject = await fs.readFile(activeFile, 'utf8')
      check('restore-failure.data-unchanged', afterVersionReject === afterCorruptReject, '损坏文件被拒后数据文件却变了')
      await page.screenshot({ path: path.join(runRoot, 'rejected-imports.png') })

      await app.close(); app = null
      await launch()
      check('roundtrip-restart-readback',
        (await page.getByPlaceholder(EDITOR).inputValue()) === DRAFT
        && chapterOf(await fs.readFile(activeFile, 'utf8'))?.content === DRAFT)
    }

    check('no-pageerror', pageErrors.length === 0, pageErrors)
    check('unchanged-inputs', snapshot(ROOT).fingerprint === sourceFingerprint && (await hashPaths(build, ['.'])).sha256 === buildManifest.sha256)
  } catch (value) {
    error = String(value.stack ?? value)
    if (page) await page.screenshot({ path: path.join(runRoot, 'failure.png') }).catch(() => {})
  } finally {
    if (blocked) await restoreFromBlocker().catch(value => { error = [error, 'Blocker cleanup failed: ' + value].filter(Boolean).join('\n') })
    if (app) {
      await fs.writeFile(path.join(runRoot, 'ipc-final.json'), JSON.stringify(await calls().catch(() => []), null, 2)).catch(() => {})
      await fs.writeFile(path.join(runRoot, 'filesystem-final.json'), JSON.stringify(await app.evaluate(() => global.__desktopProbe.filesystem).catch(() => []), null, 2)).catch(() => {})
      await app.close().catch(() => {})
    }
    await fs.writeFile(path.join(runRoot, 'electron.log'), runtimeLog)
    const artifacts = []
    for (const file of await fs.readdir(runRoot)) if (/\.(png|json|log)$/.test(file) && !['result.json', 'package.json'].includes(file)) artifacts.push({ path: path.relative(ROOT, path.join(runRoot, file)), sha256: hash(await fs.readFile(path.join(runRoot, file))) })
    // 场景清单**算出来**：某场景只要有一条检查没过/没走完，就不出现在清单里（矩阵据此比对 policy）
    const scenarioGroups = {
      'schema-version': ['schema-version.reject-newer', 'schema-version.data-unchanged'],
      sidecars: ['sidecars.seeded', 'sidecars.inlined-on-export', 'sidecars.restored-after-import'],
      'secret-stripping': ['secret-stripping.secret-present-before', 'secret-stripping.absent-after-export'],
      'restore-failure': ['restore-failure.corrupt-rejected', 'restore-failure.data-unchanged'],
    }
    const passedIds = new Set(checks.filter(item => item.passed).map(item => item.id))
    const scenarios = Object.entries(scenarioGroups).filter(([, ids]) => ids.every(id => passedIds.has(id))).map(([name]) => name)
    const result = { schemaVersion: 1, profile: 'desktop', scenarios, scope: 'Production build via file URL; real Electron main/preload/IPC/files; rename blocked by isolated empty directory; chooser destination stubbed, no native-dialog/install/disk-full claim', runRoot, sourceFingerprint, build, buildManifest, at: new Date().toISOString(), passed: checks.filter(item => item.passed).length, failed: checks.filter(item => !item.passed).length + (error ? 1 : 0), checks, artifacts, pageErrors, error }
    const target = path.join(runRoot, 'result.json')
    await fs.writeFile(target, JSON.stringify(result, null, 2))
    if (output) await fs.writeFile(path.resolve(output), JSON.stringify(result, null, 2))
    console.log('DESKTOP_SAVE_RESULT ' + JSON.stringify({ result: target, passed: result.passed, failed: result.failed, error }))
    if (result.failed) process.exitCode = 1
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
