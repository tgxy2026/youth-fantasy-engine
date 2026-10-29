// 封装产物启动验收（打包后的正式 Electron，不是 node_modules/electron 的开发壳）。
//
// 目的：`storage.four-profiles` 那条 BLOCKED 里「安装包 + 实体设备」拿不到时，
// 至少把**产物本身**验到位：能起、能进工作台、能写字、能落盘、**重启后读回**、无未捕获异常。
// 这不替代实体设备/安装器验收，只证明「这个 exe 装出来的东西是能用的」。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const exeArg = process.argv.indexOf('--exe')
const EXE = exeArg > 0 ? path.resolve(process.argv[exeArg + 1]) : ''
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/packaged-boot-'))
const profile = path.join(run, 'user-data')
const fingerprint = snapshot(root).fingerprint
const report = { kind: 'packaged-boot', at: new Date().toISOString(), run, exe: EXE, fingerprint, checks: [], errors: [], status: 'running' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(name + ': ' + JSON.stringify(details))
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const DRAFT = '封装产物验收：这一行是在打包后的桌面端里写下的。'

let app, page
const launch = async () => {
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_START_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key]
  app = await electron.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--no-proxy-server', `--user-data-dir=${profile}`],
    env,
    timeout: 120_000,
  })
  page = await app.firstWindow()
  page.setDefaultTimeout(60_000)
  page.on('pageerror', error => report.errors.push(error.message))
  await page.waitForFunction(() => document.title.length > 0, null, { timeout: 60_000 })
  return page
}

try {
  if (!EXE) throw new Error('缺 --exe <打包后的 YouthFantasyEngine.exe>')
  const stat = await fs.stat(EXE)
  report.exeBytes = stat.size
  check('产物存在且体积接近基线（246,487,040 ± 1MB）', Math.abs(stat.size - 246487040) <= 1024 * 1024, stat.size)

  await launch()
  await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 60_000 })
  check('① 打包后的桌面端能启动并渲染出界面', await page.locator('#root').evaluate(el => el.childElementCount > 0))
  const title = await page.title()
  report.title = title
  check('① 窗口标题是产品名（不是 Electron 默认页）', /青春幻想引擎/.test(title), title)

  // 进示例项目
  for (const name of [/先看看示例/, /^下一步$/, /跳过，直接开始/, '稍后再说', '知道了']) {
    const button = page.getByRole('button', { name }).first()
    if (await button.count()) { await button.click().catch(() => {}); await sleep(1800) }
  }
  await page.getByRole('navigation').waitFor({ timeout: 60_000 })
  check('② 能进入工作台（左侧导航可见）', await page.getByRole('navigation').isVisible())

  await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
  const editor = page.locator('textarea.novel-textarea').first()
  await editor.waitFor()
  const before = await editor.inputValue()
  await editor.fill(DRAFT + '\n' + before)
  await page.keyboard.press('Control+s')
  await sleep(2500)
  report.wrote = true
  check('③ 能在打包端写入正文', (await editor.inputValue()).includes(DRAFT))
  await page.screenshot({ path: path.join(run, 'packaged-write.png'), animations: 'disabled' })

  // 重启读回（同一 user-data-dir）
  await app.close()
  await sleep(1500)
  await launch()
  await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 60_000 })
  await sleep(2500)
  // 🔴 重启后会先落到「我的作品」，还可能弹「备份提醒」—— 两处都得先过，否则导航栏根本不出现
  for (const label of ['稍后再说', '知道了', '继续上次', '打开项目']) {
    const button = page.getByRole('button', { name: label, exact: true }).first()
    if (await button.isVisible().catch(() => false)) { await button.click().catch(() => {}); await sleep(2500) }
  }
  await page.getByRole('navigation').waitFor({ timeout: 90_000 })
  await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
  const editor2 = page.locator('textarea.novel-textarea').first()
  await editor2.waitFor()
  await sleep(1500)
  const text2 = await editor2.inputValue()
  check('🔴 ④ 重启后读回刚才写的内容（真的落盘了）', text2.includes(DRAFT), text2.slice(0, 120))
  const errors = report.errors.filter(message => !/ResizeObserver|DevTools/i.test(message))
  check('⑤ 全程没有未捕获异常（生产包口径）', errors.length === 0, errors)

  await page.screenshot({ path: path.join(run, 'packaged-restart.png'), animations: 'disabled' })
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failure = String(error.stack || error)
  if (page) await page.screenshot({ path: path.join(run, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {})
} finally {
  report.stale = snapshot(root).fingerprint !== fingerprint
  if (report.stale) report.status = 'failed'
  report.passed = report.checks.filter(item => item.passed).length
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  await app?.close().catch(() => {})
  console.log(JSON.stringify({ run, status: report.status, passed: report.passed, total: report.checks.length, stale: report.stale, failure: report.failure }))
  if (report.status !== 'passed') process.exitCode = 1
}
