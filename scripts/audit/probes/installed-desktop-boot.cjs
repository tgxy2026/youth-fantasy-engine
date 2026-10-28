#!/usr/bin/env node
// 已安装产物（Setup 装出来的 exe）的桌面取证：启动 → 后端选中 → 重启读回。
//
// 与 `desktop-save-probe` 的区别（两条载体，不是替代关系）：
//   · desktop-save-probe 跑「开发壳 electron + dist」，能在主进程里注入钩子（save barrier / 对话框桩），
//     所以它能查写失败、导出导入往返；
//   · 本探针跑**装好的产品**（app.asar），不能注入钩子 —— 但它验的正是用户手里那份东西：
//     桌面标志、IPC 落盘到 `<userData>/youth-fantasy-engine-data.json`、关掉重开还能读回。
// 🔴 只声明它真能证明的三个场景（initial-flags / backend-selection / restart-readback），
//    写失败与往返仍由 dist 载体那一轮负责，绝不在这里冒充。
'use strict'
const fs = require('node:fs/promises')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { _electron } = require('playwright')

const ROOT = path.resolve(__dirname, '../../..')
const arg = name => {
  const at = process.argv.indexOf(name)
  if (at < 0) return ''
  const value = process.argv[at + 1]
  if (!value || value.startsWith('--')) throw new Error(name + ' requires a value')
  return value
}
const checks = [], pageErrors = []
const check = (id, ok, detail) => {
  checks.push({ id, passed: !!ok, detail: String(detail ?? '').slice(0, 300) })
  console.log((ok ? 'PASS ' : 'FAIL ') + id)
  if (!ok) throw new Error(id + ': ' + String(detail ?? '').slice(0, 300))
}
const sha256 = file => crypto.createHash('sha256').update(readFileSync(file)).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const exe = path.resolve(arg('--exe') || path.join(process.env.LOCALAPPDATA || '', 'Programs/YouthFantasyEngine/YouthFantasyEngine.exe'))
  const resultFile = arg('--result-file')
  const runRoot = path.join(ROOT, '.workbuddy/tmp', 'installed-desktop-' + crypto.randomBytes(3).toString('hex'))
  const profile = path.join(runRoot, 'user-data')
  await fs.mkdir(profile, { recursive: true })
  const dataFile = path.join(profile, 'youth-fantasy-engine-data.json')
  const asar = path.join(path.dirname(exe), 'resources', 'app.asar')
  if (!existsSync(exe)) throw new Error('找不到已安装的主程序：' + exe)
  if (!existsSync(asar)) throw new Error('找不到 resources/app.asar：' + asar)

  const { snapshot } = await import(pathToFileURL(path.join(ROOT, 'scripts/audit/platform/source.mjs')).href)
  const sourceFingerprint = snapshot(ROOT).fingerprint
  const packagedBuild = {
    exeSha256: sha256(exe), exeBytes: (await fs.stat(exe)).size, asarSha256: sha256(asar),
    asarBytes: (await fs.stat(asar)).size, exePath: exe,
  }
  const DRAFT = '已安装产物取证：这一行写在装好的桌面版里。'
  let app, page
  const launch = async () => {
    const env = { ...process.env }
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_START_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key]
    app = await _electron.launch({ executablePath: exe, args: ['--no-sandbox', '--no-proxy-server', `--user-data-dir=${profile}`], env, timeout: 120_000 })
    page = await app.firstWindow()
    page.setDefaultTimeout(60_000)
    page.on('pageerror', value => pageErrors.push(String(value)))
    await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 90_000 })
    await sleep(2000)
    // 首次启动会走示例引导；重启后先落「我的作品」还可能弹备份提醒 —— 两套入口都要过
    for (const label of [/先看看示例/, /^下一步$/, /跳过，直接开始/, '稍后再说', '知道了', '继续上次', '打开项目']) {
      const button = page.getByRole('button', { name: label }).first()
      if (await button.count()) { await button.click().catch(() => {}); await sleep(2000) }
    }
  }

  let error = null
  try {
    await launch()

    // ① initial-flags：真的是桌面载体（不是网页版/便携/游客冒充）
    const flags = await page.evaluate(() => ({
      hasStore: !!window.electronStore,
      web: !!window.__YFE_WEB__,
      portable: !!window.__YFE_PORTABLE__,
      guest: !!window.__YFE_GUEST__,
    }))
    check('initial-flags', flags.hasStore && !flags.web && !flags.portable && !flags.guest, JSON.stringify(flags))

    // ② backend-selection：正文落盘到 <userData>/youth-fantasy-engine-data.json（IPC→文件，不是 IDB）
    await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
    const editor = page.locator('textarea.novel-textarea').first()
    await editor.waitFor()
    const before = await editor.inputValue()
    await editor.fill(DRAFT + '\n' + before)
    await page.keyboard.press('Control+s')
    let onDisk = ''
    for (let i = 0; i < 60; i++) {
      try { onDisk = await fs.readFile(dataFile, 'utf8') } catch { onDisk = '' }
      if (onDisk.includes(DRAFT)) break
      await sleep(300)
    }
    check('backend-selection', onDisk.includes(DRAFT), dataFile + ' 命中=' + onDisk.includes(DRAFT))

    // ③ restart-readback：关掉重开同一 user-data-dir，正文与磁盘内容都还在
    await app.close()
    await sleep(1500)
    await launch()
    await page.getByRole('navigation').waitFor({ timeout: 90_000 })
    await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
    const editor2 = page.locator('textarea.novel-textarea').first()
    await editor2.waitFor()
    await sleep(1500)
    const after = await editor2.inputValue()
    const diskAfter = await fs.readFile(dataFile, 'utf8')
    check('restart-readback', after.includes(DRAFT) && diskAfter.includes(DRAFT), 'ui=' + after.includes(DRAFT) + ' disk=' + diskAfter.includes(DRAFT))

    await page.screenshot({ path: path.join(runRoot, 'installed-readback.png'), animations: 'disabled' })
    check('no-pageerror', pageErrors.length === 0, pageErrors.join(' | '))
    // 载体在跑的过程中没被换掉（半路换包/被覆盖都会让证据作废）
    check('unchanged-inputs',
      sha256(exe) === packagedBuild.exeSha256 && sha256(asar) === packagedBuild.asarSha256
      && snapshot(ROOT).fingerprint === sourceFingerprint, 'exe/asar/源码在取证期间发生变化')
  } catch (failure) {
    error = String(failure.stack || failure)
    if (page) await page.screenshot({ path: path.join(runRoot, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {})
  } finally {
    await app?.close().catch(() => {})
  }

  const payload = {
    schemaVersion: 1, profile: 'desktop', carrier: 'packaged',
    scope: 'installed-desktop-boot', runRoot, at: new Date().toISOString(),
    sourceFingerprint, packagedBuild,
    passed: checks.filter(item => item.passed).length, failed: checks.filter(item => !item.passed).length,
    checks, pageErrors, error,
    artifacts: [], dataFile,
  }
  if (resultFile) { await fs.mkdir(path.dirname(resultFile), { recursive: true }); await fs.writeFile(resultFile, JSON.stringify(payload, null, 2)) }
  console.log('INSTALLED_DESKTOP_RESULT ' + JSON.stringify({ result: resultFile, passed: payload.passed, failed: payload.failed, error: error ? error.split('\n')[0] : null }))
  if (error || payload.failed) process.exitCode = 1
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
