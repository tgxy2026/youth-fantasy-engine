#!/usr/bin/env node
/**
 * 3.2.2 隔离验收：实际 Electron 主进程/文件存储 + 开发前端。
 * 原生选目录/保存对话框仅替换返回值；不证明原生对话框交互、安装包或真实模型质量。
 * node scripts/audit/probes/revision-reliability-probe.cjs [--port 5206]
 * 所有资料均在本次新建的 .workbuddy/tmp/revision-reliability-* 内，不读取真实书库。
 */
'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { _electron, chromium } = require('playwright')
const ROOT = path.resolve(__dirname, '../../..')
const PID = 'reliability-project'
const CH = 'reliability-chapter'
const BEFORE = '雨停在城门外，守门人仍站在原地。'
const AFTER = '城门外雨歇，守门人静立如初。'
const MANUAL = BEFORE + '作者亲手补入一句，必须保留。'
const checks = []
function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + JSON.stringify(detail) : ''}`)
  if (!passed) throw new Error(name)
}
const hash = data => crypto.createHash('sha256').update(data).digest('hex')

async function main() {
  const { snapshot } = await import('../platform/source.mjs')
  const sourceFingerprint = snapshot(ROOT).fingerprint
  const runRoot = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/revision-reliability-'))
  const profile = path.join(runRoot, 'profile')
  const now = Date.now()
  await fs.mkdir(profile)
  // 主进程会主动探测旧版 appData；也将此根目录隔离，避免从真实旧书库复制 IndexedDB。
  const isolatedAppData = path.join(runRoot, 'appdata')
  await fs.mkdir(isolatedAppData)
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
  await fs.writeFile(path.join(runRoot, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: 'test-bootstrap.cjs' }))
  await fs.writeFile(path.join(runRoot, 'test-bootstrap.cjs'),
    `const {app}=require('electron');app.setPath('appData',${JSON.stringify(isolatedAppData)});require(${JSON.stringify(path.join(ROOT, 'electron/main.cjs'))});`)
  await fs.writeFile(path.join(profile, 'youth-fantasy-engine-data.json'), JSON.stringify({
    app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: now,
    stores: {
      projects: { [PID]: { id: PID, name: '可靠性验收临时作品', genre: '玄幻', intro: '', projectType: 'full', createdAt: now, updatedAt: now } },
      volumes: { 'reliability-volume': { id: 'reliability-volume', projectId: PID, title: '验收卷', description: '', order: 0, createdAt: now } },
      chapters: { [CH]: { id: CH, projectId: PID, volumeId: 'reliability-volume', title: '验收章', content: BEFORE, summary: '', order: 0, wordCount: 16, status: 'draft', tags: [], createdAt: now, updatedAt: now } },
      meta: { welcomeDone: { key: 'welcomeDone', value: '1' } },
    },
  }))
  for (const key of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy','ELECTRON_RUN_AS_NODE','NODE_OPTIONS']) delete process.env[key]
  const portAt = process.argv.indexOf('--port')
  const port = Number(portAt >= 0 ? process.argv[portAt + 1] : 5206)
  // Vite normalizes 127.0.0.1 documents to localhost. Electron's navigation guard must
  // receive that same canonical origin; otherwise reload can be treated as an external page.
  const origin = `http://localhost:${port}`
  let server, app, page
  const evidence = { schemaVersion: 1, kind: 'revision-reliability', sourceFingerprint, devOrigin: origin, runRoot, at: new Date().toISOString(), scope: 'Electron development renderer + real IPC/files; native chooser/save dialog return values stubbed', checks }
  try {
    const { createServer } = await import('vite')
    server = await createServer({ root: ROOT, cacheDir: path.join(runRoot, 'vite-cache'), server: { host: 'localhost', port, strictPort: true } })
    await server.listen()
    // A fresh Vite cache may need longer than the Electron debugger handshake timeout.
    // Prepare the real module graph in a separate empty browser context, then close it.
    // This does not seed Electron storage or replace any production IPC/action assertion.
    const preparationStarted = Date.now()
    const warmBrowser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
    try {
      const context = await warmBrowser.newContext()
      await context.route('**/*', route => {
        const target = new URL(route.request().url())
        return target.port === String(port) && ['127.0.0.1', 'localhost'].includes(target.hostname) ? route.continue() : route.abort()
      })
      const warmPage = await context.newPage()
      await warmPage.goto(origin, { waitUntil: 'commit', timeout: 120000 })
      await warmPage.getByRole('button', { name: /先看看示例/ }).waitFor({ timeout: 120000 })
      evidence.preparation = { kind: 'isolated-browser-module-prewarm', ready: true, elapsedMs: Date.now() - preparationStarted }
      console.log('PREPARED isolated Vite renderer')
    } finally { await warmBrowser.close() }
    app = await _electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [runRoot, '--no-sandbox', '--no-proxy-server', '--user-data-dir=' + profile], env: { ...process.env, ELECTRON_START_URL: origin }, timeout: 45000 })
    page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    const dismiss = async () => {
      for (const name of ['稍后再说','知道了','跳过，直接开始']) {
        const b = page.getByRole('button', { name, exact: true })
        if (await b.isVisible().catch(() => false)) await b.click()
      }
    }
    await page.getByRole('button', { name: '打开项目', exact: true }).waitFor({ timeout: 45000 })
    await dismiss()
    await page.getByRole('button', { name: '打开项目', exact: true }).click()
    await page.getByRole('button', { name: '稍后再说', exact: true }).click({ timeout: 5000 }).catch(() => {})
    await dismiss()
    await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
    await page.getByPlaceholder('落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）').waitFor()
    await dismiss()
    const actualAppData = await app.evaluate(({ app }) => app.getPath('appData'))
    evidence.initialURL = page.url()
    check('使用隔离资料区启动并打开测试作品', (await page.locator('body').innerText()).includes('可靠性验收临时作品') && path.normalize(actualAppData) === path.normalize(isolatedAppData) && new URL(page.url()).origin === origin)

    // 真实生产候选登记；随后在正文编辑器里手改，再由可见按钮应用旧候选。
    const intake = await page.evaluate(async ({ PID, CH, BEFORE, AFTER }) => {
      const { recordRewriteCandidate } = await import('/src/lib/revision/candidateIntake.ts')
      return recordRewriteCandidate({ projectId: PID, chapterId: CH, beforeText: BEFORE, text: AFTER, summary: '过期拒绝验收' })
    }, { PID, CH, BEFORE, AFTER })
    check('候选通过生产登记入口保存', intake.ok, intake)
    await page.getByPlaceholder('落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）').fill(MANUAL)
    await page.keyboard.press('Control+s')
    await page.waitForFunction(async ({ CH, MANUAL }) => {
      const data = JSON.parse((await window.electronStore.load()).text)
      return data.stores.chapters[CH]?.content === MANUAL
    }, { CH, MANUAL })
    const group = page.getByRole('navigation').getByRole('button', { name: '创作管理', exact: true })
    if (!await page.getByRole('navigation').getByRole('button', { name: '创作轨迹', exact: true }).isVisible()) await group.click()
    await page.getByRole('navigation').getByRole('button', { name: '创作轨迹', exact: true }).click()
    await page.getByRole('button', { name: '候选审阅', exact: true }).click()
    await page.getByRole('button', { name: '应用到正文', exact: true }).click()
    await page.getByText(/这一章在你产出后又被改动过/).waitFor()
    const rejected = await page.evaluate(async ({ CH, id }) => {
      const data = JSON.parse((await window.electronStore.load()).text)
      return { body: data.stores.chapters[CH].content, state: data.stores.revisionPayloads[id]?.report?.status }
    }, { CH, id: intake.candidateId })
    check('T-02 旧候选被界面拒绝且磁盘保留手改正文', rejected.body === MANUAL && rejected.state === 'pending', rejected)
    await page.screenshot({ path: path.join(runRoot, 'candidate-stale.png') })
    await page.getByRole('button', { name: '关闭', exact: true }).last().click()

    // 真正文件系统写入失败：用同名空目录阻止原子替换，仅作用于临时资料文件。
    const writeCase = await page.evaluate(async ({ PID, CH, MANUAL, AFTER }) => {
      const { recordRewriteCandidate } = await import('/src/lib/revision/candidateIntake.ts')
      return recordRewriteCandidate({ projectId: PID, chapterId: CH, beforeText: MANUAL, text: AFTER, summary: '写失败验收' })
    }, { PID, CH, MANUAL, AFTER })
    check('写失败用例的候选已先行落盘', writeCase.ok)
    const activeFile = await page.evaluate(() => window.electronStore.dataPath())
    const keptFile = activeFile + '.test-kept'
    await fs.rename(activeFile, keptFile)
    await fs.mkdir(activeFile)
    try {
      await page.getByRole('button', { name: '候选审阅', exact: true }).click()
      await page.locator('li').filter({ hasText: '写失败验收' }).getByRole('button', { name: '应用到正文', exact: true }).click()
      await page.getByText(/提交意图未保存，尚未替换正文/).waitFor()
      const kept = JSON.parse(await fs.readFile(keptFile, 'utf8'))
      const memoryBody = await page.evaluate(async CH => {
        const { chapterBodyOf } = await import('/src/lib/revision/candidateRunner.ts')
        return chapterBodyOf(CH)
      }, CH)
      check('真实写盘失败时界面停止，内存与磁盘原正文都未替换', kept.stores.chapters[CH].content === MANUAL && memoryBody === MANUAL)
      await page.screenshot({ path: path.join(runRoot, 'candidate-write-failure.png') })
    } finally {
      // 本测试刚创建的空目录；不递归删除，也不触碰任何真实资料区。
      await fs.rmdir(activeFile)
      await fs.rename(keptFile, activeFile)
    }
    await page.waitForFunction(async () => {
      const d = await import('/src/lib/app/desktop.ts')
      return !d.getDesktopState().saving && await d.flushDesktop()
    })
    await page.locator('li').filter({ hasText: '写失败验收' }).getByRole('button', { name: '应用到正文', exact: true }).click()
    await page.getByText(/已应用（新增/).waitFor()
    const applied = JSON.parse(await fs.readFile(activeFile, 'utf8'))
    check('恢复写盘后重试成功，正文与成功回执均已在磁盘', applied.stores.chapters[CH].content === AFTER && applied.stores.revisionPayloads[writeCase.candidateId]?.report?.receipt?.ok === true)
    await page.getByRole('button', { name: '关闭', exact: true }).last().click()

    // 直接注入迁移锁只验证横幅订阅/呈现，不替代真实模板迁移操作。
    await page.evaluate(async PID => {
      const { beginTabMigrationLock } = await import('/src/lib/templates/migrationGuard.ts')
      window.__reliabilityUnlock = beginTabMigrationLock(PID, 'nations')
    }, PID)
    await page.getByText(/正在更换模板，该页签的写入已暂停/).waitFor()
    await page.screenshot({ path: path.join(runRoot, 'migration-lock.png') })
    await page.evaluate(() => window.__reliabilityUnlock())
    await page.getByText(/正在更换模板，该页签的写入已暂停/).waitFor({ state: 'hidden' })
    check('迁移锁注入后横幅出现，释放后自动消失', true)

    // A1 请求契约：截获真正由 chat 发出的补写/压缩请求，无真实模型额度消耗。
    const wire = []
    await page.route('http://127.0.0.1:17991/**', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
      const body = route.request().postDataJSON()
      wire.push(body)
      const content = '雨'.repeat(wire.length === 1 ? 700 : 1000)
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) })
    })
    const invariant = '历史章冻结：不新增人物、地点与剧情事件；作者要求：保留守门人的身份。'
    await page.evaluate(async invariant => {
      const { enforceWordRange } = await import('/src/lib/editor/wordRange.ts')
      const cfg = { id: 'offline', name: '离线验收', type: 'openai', baseUrl: 'http://127.0.0.1:17991/v1', apiKey: 'test-only', model: 'fixture', local: false, contextWindow: 32000 }
      await enforceWordRange({ cfg, body: '雨'.repeat(100), target: 1000, maxExpand: 1, maxShrink: 0, invariants: invariant })
      await enforceWordRange({ cfg, body: '雨'.repeat(2000), target: 1000, maxExpand: 0, maxShrink: 1, invariants: invariant })
    }, invariant)
    check('A1 补写与压缩实际请求均携带冻结纪律与作者要求', wire.length === 2 && wire.every(r => r.messages.some(m => m.role === 'user' && m.content.includes(invariant))), { requests: wire.length })
    check('A1 有冻结纪律的补写请求不要求推进新剧情', !JSON.stringify(wire[0]).includes('情节要实质推进'))

    // C2：两份真实生产备份经真实 IPC 迁移，逐字节比较，并用生产载荷读取函数恢复读取。
    const backups = await page.evaluate(async PID => {
      const b = await import('/src/lib/db/backups.ts')
      const a = await b.createAutoBackup(PID, 'manual', '验收备份一')
      const c = await b.createAutoBackup(PID, 'manual', '验收备份二')
      return [a, c]
    }, PID)
    check('创建两份真实外置备份', backups.every(Boolean))
    const oldFile = await page.evaluate(() => window.electronStore.dataPath())
    const original = await Promise.all(backups.map(b => fs.readFile(path.join(path.dirname(oldFile), 'blobs/backupPayloads', b.id + '.json'))))
    const movedDir = path.join(runRoot, 'moved')
    await fs.mkdir(movedDir)
    const movedFile = path.join(movedDir, 'youth-fantasy-engine-data.json')
    const moved = await page.evaluate(async movedFile => {
      const { relocateDesktopDataFile } = await import('/src/lib/app/desktop.ts')
      return relocateDesktopDataFile(movedFile)
    }, movedFile)
    check('C2 真实 IPC 切换路径并报告已复制备份', moved.ok && !moved.adopted && moved.copied >= 2, moved)
    const copied = await Promise.all(backups.map(b => fs.readFile(path.join(movedDir, 'blobs/backupPayloads', b.id + '.json'))))
    check('C2 两份历史备份迁移后逐字节一致，旧位置仍存在', original.every((b, i) => b.equals(copied[i])) && await fs.stat(oldFile).then(() => true))
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.getByRole('button', { name: '打开项目', exact: true }).waitFor()
    const recovered = await page.evaluate(async ({ ids, AFTER }) => {
      const { getBackupPayload } = await import('/src/lib/db/backups.ts')
      return Promise.all(ids.map(async id => { const b = await getBackupPayload(id); return b?.chapters?.some(c => c.content === AFTER) ?? false }))
    }, { ids: backups.map(b => b.id), AFTER })
    check('C2 重载后生产读取入口仍能读出两份完整历史正文', recovered.every(Boolean), recovered)
    const restored = await page.evaluate(async ({ ids, PID, AFTER }) => {
      const db = await import('/src/lib/db.ts')
      const { restoreBackup } = await import('/src/lib/db/backups.ts')
      const { flushDesktop } = await import('/src/lib/app/desktop.ts')
      db.setCurrentProject(PID)
      const results = []
      for (const id of ids) {
        const [chapter] = await db.getAllChapters()
        await db.saveChapter({ ...chapter, content: '恢复前故意改动，必须被备份恢复', updatedAt: Date.now() })
        await flushDesktop()
        await restoreBackup(id)
        await flushDesktop()
        const raw = JSON.parse((await window.electronStore.load()).text)
        const chapters = Object.values(raw.stores.chapters).filter(c => c.projectId === PID)
        results.push(chapters.some(c => c.content === AFTER) && !chapters.some(c => c.content.includes('恢复前故意改动')))
      }
      return results
    }, { ids: backups.map(b => b.id), PID, AFTER })
    check('C2 两份迁移后的历史备份分别恢复成功，磁盘正文回到备份内容', restored.every(Boolean), restored)
    const blockedDir = path.join(runRoot, 'blocked')
    await fs.mkdir(blockedDir)
    await fs.writeFile(path.join(blockedDir, 'blobs'), '同名文件阻止目录复制')
    const failedMove = await page.evaluate(async target => {
      const { relocateDesktopDataFile } = await import('/src/lib/app/desktop.ts')
      const r = await relocateDesktopDataFile(target)
      return { ...r, active: await window.electronStore.dataPath() }
    }, path.join(blockedDir, 'youth-fantasy-engine-data.json'))
    check('C2 复制失败不切换资料位置，原备份保留', !failedMove.ok && path.normalize(failedMove.active) === path.normalize(movedFile), failedMove)

    // C1：仅替换原生 Save 对话框返回值；通过真实导出按钮跑收集、落盘与错误提示。
    const exportPath = path.join(runRoot, 'partial-export.json')
    await app.evaluate(({ dialog }, exportPath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath }) }, exportPath)
    await fs.writeFile(path.join(movedDir, 'blobs/backupPayloads', backups[1].id + '.json'), '{bad-json')
    await dismiss()
    await page.getByTitle(/导出数据文件/).filter({ has: page.locator('svg') }).first().click()
    await page.getByText(/这不是完整备份/).waitFor()
    const exported = JSON.parse(await fs.readFile(exportPath, 'utf8'))
    const rawPayloads = exported.stores.backupPayloads
    const payloads = Array.isArray(rawPayloads) ? rawPayloads : Object.values(rawPayloads || {})
    check('C1 一份备份损坏时仍导出健康载荷，并如实显示不完整', payloads.some(p => p.id === backups[0].id) && !payloads.some(p => p.id === backups[1].id))
    await page.screenshot({ path: path.join(runRoot, 'partial-export.png') })
    evidence.files = {}
    for (const f of ['src/lib/revision/candidateApply.ts','src/lib/revision/candidateStore.ts','src/lib/revision/candidateRunner.ts','src/components/revision/CandidatePanel.tsx','src/lib/db/revisionJobs.ts','electron/main.cjs', 'scripts/audit/probes/revision-reliability-probe.cjs']) evidence.files[f] = hash(await fs.readFile(path.join(ROOT, f)))
  } catch (error) {
    evidence.error = error.stack || String(error)
    console.error(evidence.error)
    if (page) {
      await fs.writeFile(path.join(runRoot, 'failed-ui.txt'), await page.locator('body').innerText().catch(() => 'unavailable'))
      await page.screenshot({ path: path.join(runRoot, 'failed-ui.png') }).catch(() => {})
    }
    process.exitCode = 1
  } finally {
    await app?.close().catch(() => {})
    await server?.close().catch(() => {})
    evidence.passed = checks.filter(c => c.passed).length
    evidence.stale = snapshot(ROOT).fingerprint !== sourceFingerprint
    evidence.status = !evidence.error && !evidence.stale && evidence.passed === 16 && checks.every(c => c.passed) ? 'passed' : 'failed'
    if (evidence.status !== 'passed') process.exitCode = 1
    await fs.writeFile(path.join(runRoot, 'results.json'), JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify({ evidence: path.join(runRoot, 'results.json'), passed: evidence.passed, failed: checks.filter(c => !c.passed).length, error: evidence.error }))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
