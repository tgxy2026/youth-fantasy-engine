// 3.7.0 · W7 真机探针：语音入口配置闸（无真实转写 Key 时只验「不可用说明 + 配置后启用」）。
// 隔离：临时 vite + 临时浏览器上下文（独立 IDB），真 Edge；不碰真实作者数据。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = await fs.mkdtemp(path.join(root, '.workbuddy/tmp/frontend-voice-gate-'))
const report = { run, checks: [], errors: [], status: 'running', transcription: '未跑：缺转写服务（无可用 Key）' }
const check = (name, passed, details) => {
  report.checks.push({ name, passed: !!passed, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${passed ? '' : ' :: ' + JSON.stringify(details)}`)
  if (!passed) throw new Error(name)
}
let server, browser, page
try {
  server = await createServer({
    root, cacheDir: path.join(run, 'vite-cache'), logLevel: 'error',
    server: { host: 'localhost', port: 0, watch: { ignored: ['**/.workbuddy/**', '**/release/**', '**/dist/**'] } },
  })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => (route.request().url().startsWith(origin + '/') ? route.continue() : route.abort()))
  page = await context.newPage()
  page.setDefaultTimeout(60000)
  page.on('pageerror', e => report.errors.push(e.message))

  await page.goto(origin, { waitUntil: 'commit' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })
  if (await page.locator('[data-guide-overlay]').count()) {
    const skip = page.getByRole('button', { name: /跳过本页|跳过|知道了|关闭/ }).first()
    if (await skip.isVisible().catch(() => false)) await skip.click()
    else await page.keyboard.press('Escape')
  }

  const nav = page.getByRole('navigation')
  await nav.getByRole('button', { name: '灵感启发', exact: true }).click()
  const voice = page.getByRole('button', { name: '语音', exact: true }).first()
  await voice.waitFor()
  check('未配置时「语音」按钮不可用', await voice.isDisabled())
  check('未配置时如实说明原因', await page.getByText('需先配置转写服务').first().isVisible())

  // 配置三项后启用（配置只落本机 meta，不发网络）
  await nav.getByRole('button', { name: '模型设置', exact: true }).click()
  const section = page.locator('[data-guide="settings-transcribe"]')
  await section.waitFor()
  check('模型设置出现「语音转写」配置组', await section.getByText('语音转写', { exact: true }).isVisible())
  check('配置组初始显示未配置', await section.getByText('未配置', { exact: true }).isVisible())
  await section.getByPlaceholder('https://api.example.com/v1').fill('https://voice.example.com/v1')
  await section.getByPlaceholder('whisper-1').fill('whisper-1')
  await section.getByPlaceholder('只存在本机配置里').fill('probe-key')
  await section.getByRole('button', { name: '保存转写配置' }).click()
  await section.getByText('已配置', { exact: true }).waitFor()

  await nav.getByRole('button', { name: '灵感启发', exact: true }).click()
  const voice2 = page.getByRole('button', { name: '语音', exact: true }).first()
  await voice2.waitFor()
  check('配置完整后「语音」按钮启用', !(await voice2.isDisabled()))

  const stored = await page.evaluate(async () => {
    const { loadTranscribeConfig } = await import('/src/lib/aiCore/transcribe.ts')
    const cfg = await loadTranscribeConfig()
    return { hasKey: !!cfg.apiKey, hasAudio: Object.keys(cfg).some(k => /audio|blob/i.test(k)) }
  })
  check('配置只含三项且无音频字段', stored.hasKey && !stored.hasAudio, stored)

  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = String(error?.stack || error)
  console.error(error)
  process.exitCode = 1
} finally {
  try { await page?.screenshot({ path: path.join(run, 'shot.png') }) } catch { /* 现场 */ }
  await browser?.close().catch(() => undefined)
  await server?.close().catch(() => undefined)
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
  console.log('REPORT ' + path.join(run, 'report.json'), report.status, report.transcription)
}