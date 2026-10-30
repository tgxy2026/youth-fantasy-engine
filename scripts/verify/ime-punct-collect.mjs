// 中文标点配对 · 真实输入法事件采集（3.3.1 · §12 取证）
//
// 为什么要有它：规划 §12.5 要求「真实输入法下的事件序列」，不接受 CDP 模拟。
// 手工开 F12 贴代码容易贴错、也容易漏掉应用侧的光标移动；这里改成**带窗口的浏览器 + 自动注入监听**：
//
//   ① 脚本起一个有头（能看到窗口）的 Edge，自动走到示范项目的正文编辑器；
//   ② 主人在窗口里用**自己的输入法**打三组字：
//         ⓐ「，」再打引号   ⓑ 汉字后打引号   ⓒ「《」再打书名
//   ③ 点右下角「结束采集并导出」⇒ 事件序列写进 .workbuddy/tmp/ime-punct-*.json；
//   ④ `node scripts/verify/ime-punct-analyze.mjs <那个文件>` 判读。
//
// 🔴 采集器只读 `textarea.novel-textarea` 的输入事件与光标移动，不读稿件内容以外的任何东西，
//    也不上传：数据只落本地文件。用的是临时浏览器 profile，不碰作者真实书库。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `ime-punct-collect-${stamp}`)
fs.mkdirSync(run, { recursive: true })
const outFile = path.join(run, 'events.json')

/** 采集器：注入到每个新文档（含 reload 后），只认正文编辑器那个 textarea */
function collector() {
  if (window.__imePunctInstalled) return
  window.__imePunctInstalled = true
  const log = []
  window.__imePunctLog = log
  const isTarget = node => !!node && typeof node.matches === 'function' && node.matches('textarea.novel-textarea')
  const push = (type, ta, extra) => {
    const caret = ta.selectionStart ?? 0
    const value = ta.value ?? ''
    const head = value.slice(Math.max(0, caret - 8), caret)
    const tail = value.slice(caret, caret + 8)
    log.push({ t: Math.round(performance.now()), type, caret, head, tail, around: head + tail, len: value.length, ...extra })
  }
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
    document.addEventListener(type, event => {
      if (!isTarget(event.target)) return
      push(type, event.target, {
        data: event.data ?? null,
        isComposing: event.isComposing ?? null,
        inputType: event.inputType ?? null,
      })
    }, true)
  }
  // 应用侧补标点后会 setSelectionRange —— 这是「应用有没有插手」最直接的证据
  const original = HTMLTextAreaElement.prototype.setSelectionRange
  HTMLTextAreaElement.prototype.setSelectionRange = function (start, end, direction) {
    if (isTarget(this)) push('app:setSelectionRange', this, { to: start })
    return original.call(this, start, end, direction)
  }

  const button = document.createElement('button')
  button.textContent = '结束采集并导出'
  button.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
    'padding:10px 16px', 'border-radius:10px', 'background:#f59e0b', 'color:#111',
    'font:600 14px/1 system-ui,sans-serif', 'box-shadow:0 8px 24px rgba(0,0,0,.4)',
    'cursor:pointer', 'border:0',
  ].join(';')
  button.onclick = () => {
    button.remove()
    window.__imePunctDone?.(JSON.stringify(window.__imePunctLog ?? []))
  }
  const mount = () => (document.body ? document.body.appendChild(button) : setTimeout(mount, 200))
  mount()
}

const server = await createServer({
  root,
  cacheDir: path.join('.workbuddy/tmp', `vite-ime-punct-${stamp}`),
  logLevel: 'error',
  server: { host: 'localhost', port: 0 },
})

let browser
let done = null
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--no-proxy-server', '--start-maximized'] })
  const context = await browser.newContext({ viewport: null, reducedMotion: 'reduce' })
  // 只放行本站：证明采集期间没有任何外部请求（输入法不受影响，它是系统级的）
  await context.route('**/*', route => (route.request().url().startsWith(origin + '/') ? route.continue() : route.abort()))
  const page = await context.newPage()
  page.setDefaultTimeout(120000)
  await page.addInitScript(collector)

  // 🔴 exposeFunction 必须 **await** 完成注册，再导航 —— 它本身是异步的，忘了 await 会在
  //    页面已经开始跑之后才注入，按钮点下去就找不到 `__imePunctDone`。
  let resolveDone
  const finished = new Promise(resolve => { resolveDone = resolve })
  await page.exposeFunction('__imePunctDone', text => {
    const events = JSON.parse(text || '[]')
    fs.writeFileSync(outFile, JSON.stringify(events, null, 2))
    resolveDone({ events })
  })

  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  // 走首启向导建一个隔离的示范项目（不碰作者真实书库）
  await page.getByRole('button', { name: /先看看示例/ }).click({ timeout: 60000 })
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  const guide = page.locator('[data-guide-card]').first()
  if (await guide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
    await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
    await guide.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  }
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) }).catch(() => {})

  // 定位到正文编辑框并让它拿到焦点（主人一进来就能打字）
  const editor = page.locator('textarea.novel-textarea').first()
  await editor.waitFor({ timeout: 60000 })
  await editor.click()
  await page.screenshot({ path: path.join(run, 'window.png') }).catch(() => {})

  console.log('READY 窗口已打开，可以开始打字了')
  console.log(`       截图：${path.join(run, 'window.png')}`)

  done = await Promise.race([
    finished,
    new Promise(resolve => setTimeout(() => resolve(null), 20 * 60 * 1000)),
  ])

  if (!done) {
    // 超时兜底：把页面里已经攒下的日志取出来，至少不留空手
    const events = await page.evaluate(() => JSON.parse(JSON.stringify(window.__imePunctLog ?? []))).catch(() => [])
    fs.writeFileSync(outFile, JSON.stringify(events, null, 2))
    console.log(`TIMEOUT 20 分钟没点「结束采集」，已保存 ${events.length} 条事件：${outFile}`)
    process.exitCode = 2
  } else {
    console.log(`COLLECTED ${done.events.length} 条事件：${outFile}`)
    if (done.events.length === 0) {
      console.log('EMPTY 没记录到事件：可能没在正文框里打字，或页面不是编辑器')
      process.exitCode = 3
    }
  }
} finally {
  await browser?.close().catch(() => {})
  await server.close().catch(() => {})
}
