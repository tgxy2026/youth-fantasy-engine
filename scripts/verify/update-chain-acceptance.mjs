#!/usr/bin/env node
/**
 * W1.5「更新链路」验收的自动化替身（3.6.2 收尾 · 2026-11-21）。
 *
 * 【为什么要有它】3.6.2 发布时这七条里 6 条被标成"要已部署的线上清单 / 生成过的产物"，
 *   当时既没打包也没部署，只能空着。现在发布完成、桌面版也装上了，就不该再靠人手点：
 *   断网、错摘要、缺摘要这三条**恰好是最容易被"看起来正常"骗过去的**——
 *   弹窗没出现可能只是没联网、校验失败可能只是没下载、文案对可能只是走了兜底通道。
 *   所以每条都配一条**反向判据**（见各 case 内注释）：先证明条件真的成立了，再看结果。
 *
 * 覆盖（对应 docs/3.6.2-开发规划方案-2026-11-21.md §W1.5）：
 *   #2 断网启动 → 3 秒后无弹窗、无未捕获异常
 *   #3 错 sha256 的清单下载 → 校验失败、无 .part、无成品包、安装器未启动
 *   #4 无 sha256 的清单下载 → 可完成，界面明确写"未校验（清单未提供摘要…）"
 *   #7 关于页（桌面形态）→ 版本 + 构建时间 + 形态
 *
 * 🔴 三条纪律：
 *   ① **只碰隔离 profile**（`.workbuddy/tmp/w15-*`）与临时目录，绝不动主人已装版本的数据；
 *   ② 假安装包用系统自带的有效 PE（`where.exe`）：下载器按文件头 `MZ` 判真伪，
 *      用垃圾字节会被当成"兜底页"提前拦掉，验不到摘要那一段；
 *   ③ 下载会落到**系统「下载」文件夹**（目录由主进程钉死，改不了）——
 *      文件名固定 `YFE-W15-Verify.exe`，跑完无论成败都删掉，不留垃圾。
 *
 * 用法：
 *   node scripts/verify/update-chain-acceptance.mjs
 *   node scripts/verify/update-chain-acceptance.mjs --exe "C:/.../YouthFantasyEngine.exe" --only offline,about
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const arg = (name, def = '') => {
  const at = process.argv.indexOf(name)
  if (at < 0) return def
  const v = process.argv[at + 1]
  if (!v || v.startsWith('--')) throw new Error(name + ' 需要值')
  return v
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const EXE = arg('--exe') || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'YouthFantasyEngine', 'YouthFantasyEngine.exe')
/** 假安装包：必须是真 PE（头两字节 MZ），见文件头纪律② */
const FAKE_PKG = process.env.YFE_FAKE_PKG || 'C:\\Windows\\System32\\where.exe'
const EXPECT_VERSION = JSON.parse(
  await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'),
).version
const ONLY = arg('--only', '').split(',').map((s) => s.trim()).filter(Boolean)

const checks = []
const check = (id, ok, detail = '') => {
  checks.push({ id, passed: !!ok, detail: String(detail).slice(0, 300) })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail ? ' :: ' + String(detail).slice(0, 180) : ''))
}

/** 关掉首启引导/提醒：它们把背景置 inert，页签点不动（同 packaged-acceptance 的做法） */
async function clearOverlays(page) {
  for (const label of ['关闭本页指引', '跳过本页', '稍后再说', '知道了', '我知道了', '继续上次', '跳过，直接开始', '跳过，直接进入项目管理']) {
    const b = page.getByRole('button', { name: label, exact: true }).first()
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {})
  }
  await page.waitForFunction(() => !document.querySelector('[data-guide-mask]'), null, { timeout: 2000 }).catch(() => {})
}

/** 启动一个隔离 profile 的应用；返回 { app, page, profile, close } */
async function launch(tag, extraArgs = []) {
  const profile = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/w15-' + tag + '-'))
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_START_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[key]
  const app = await _electron.launch({
    executablePath: path.resolve(EXE),
    args: ['--no-sandbox', `--user-data-dir=${profile}`, ...extraArgs],
    env,
    timeout: 120_000,
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(60_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
  // 首帧可能还在加载 assets：等 root 有内容
  await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 90_000 }).catch(() => {})
  await sleep(800)
  await clearOverlays(page)
  const close = async () => { await app.close().catch(() => {}); await fs.rm(profile, { recursive: true, force: true }).catch(() => {}) }
  return { app, page, profile, errors, close }
}

/** 进到有页签的界面：首启向导 → 项目中心 → 打开/创建项目 */
async function enterProject(page) {
  const visible = (name) => page.getByRole('button', { name, exact: true }).first().isVisible().catch(() => false)
  if (await visible('先看看示例')) {
    await page.getByRole('button', { name: '先看看示例' }).first().click().catch(() => {})
    for (const label of ['下一步', '跳过，直接开始', '跳过，直接进入项目管理']) {
      if (await visible(label)) { await page.getByRole('button', { name: label, exact: true }).first().click().catch(() => {}); await sleep(600) }
    }
  }
  if (await visible('打开项目')) {
    await page.getByRole('button', { name: '打开项目', exact: true }).first().click().catch(() => {})
    await sleep(1200)
  } else if (await visible('创建示范项目')) {
    await page.getByRole('button', { name: '创建示范项目', exact: true }).first().click().catch(() => {})
    await sleep(900)
    if (await visible('确定')) await page.getByRole('button', { name: '确定', exact: true }).first().click().catch(() => {})
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      if (await visible('打开项目') || await visible('正文编辑')) break
      await sleep(1000)
    }
    if (await visible('打开项目')) { await page.getByRole('button', { name: '打开项目', exact: true }).first().click().catch(() => {}); await sleep(1200) }
  }
  await clearOverlays(page)
}

/** 打开「关于打赏」（工作面板下的 about 页签） */
async function openAbout(page) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const tab = page.getByRole('button', { name: '关于打赏' }).first()
    if (await tab.isVisible().catch(() => false)) { await tab.click().catch(() => {}); await sleep(900); return true }
    // 分组没展开：先点分组标题
    const group = page.getByRole('button', { name: '工作面板' }).first()
    if (await group.isVisible().catch(() => false)) await group.click().catch(() => {})
    await sleep(400)
  }
  return false
}

/** 本地假安装包服务（只绑 127.0.0.1，随机端口） */
async function startPkgServer(buf) {
  const srv = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/pkg.exe')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length })
      res.end(buf)
      return
    }
    res.writeHead(404); res.end()
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { srv, port: srv.address().port }
}

/** 造一份清单（version 高于当前 ⇒ 一定提示更新） */
function manifest({ port, size, sha256 }) {
  const asset = { kind: 'win-setup', name: 'YFE-W15-Verify.exe', size, url: `http://127.0.0.1:${port}/pkg.exe` }
  if (sha256) asset.sha256 = sha256
  return {
    schema: 1,
    version: '99.0.0',
    releasedAt: new Date().toISOString(),
    channel: 'stable',
    minSupported: '',
    notesUrl: 'https://example.invalid/notes',
    webBuildId: 'w15-' + Date.now(),
    assets: [asset],
  }
}

/* ============ #2 断网启动 ============ */
async function caseOffline() {
  console.log('\n== #2 断网启动 ==')
  /**
   * 🔴 第一版用 `--proxy-server=127.0.0.1:1`（死代理）模拟断网，**反向判据直接打脸**：
   *    fetch 仍返回 200 —— Chromium 在这台机器上没按命令行代理走（系统代理优先级更高）。
   *    差一点就写成"断网时无弹窗 ✅"，其实根本没断网。
   *    现改为 Playwright 的 `setOffline(true)`（底层 Network.emulateNetworkConditions），
   *    并且**先证明请求真的失败了**再往下判。
   */
  const { page, errors, close } = await launch('offline', ['--no-proxy-server'])
  try {
    await page.context().setOffline(true)
    const reachable = await page.evaluate(async () => {
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 8000)
        const r = await fetch('https://youth-fantasy-engine.online/version.json', { signal: ctrl.signal, cache: 'no-store' })
        clearTimeout(t)
        return 'reachable:' + r.status
      } catch (e) {
        return 'blocked:' + String((e && e.message) || e).slice(0, 80)
      }
    })
    check('offline.network-really-down', reachable.startsWith('blocked:'), reachable)

    // 等过自动检查的窗口（启动 3 秒后触发）；留足 12 秒
    await sleep(12_000)
    const text = await page.evaluate(() => document.body.innerText)
    check('offline.no-update-dialog', !/发现新版本/.test(text), '页面文本中无「发现新版本」')
    check('offline.no-pageerror', errors.length === 0, errors.join(' | ') || '无 pageerror')
    // 断网不该影响本地存储，出现红色错误条就是真问题
    check('offline.no-error-banner', !/保存出错|写入失败|数据未能保存/.test(text), text.includes('保存出错') ? '出现错误条' : '无错误条')
    await page.screenshot({ path: path.join(ROOT, '.workbuddy/tmp/w15-offline.png') }).catch(() => {})
  } finally {
    await close()
  }
}

/* ============ #3 / #4 清单摘要两种极端 ============ */
async function caseDownload(tag, { withSha, shaCorrect }) {
  console.log(`\n== ${withSha ? '#3 错 sha256' : '#4 无 sha256'} ==`)
  const pkg = await fs.readFile(FAKE_PKG)
  const { srv, port } = await startPkgServer(pkg)
  const { app, page, close, errors } = await launch(tag, ['--no-proxy-server'])
  /** 下载目录由主进程决定（渲染层拿不到），只能问 app.getPath */
  const dlDir = await app.evaluate(({ app }) => app.getPath('downloads')).catch(() => path.join(process.env.USERPROFILE || '', 'Downloads'))
  try {
    /**
     * 清单通过路由拦截喂进去：真实链路（渲染层 fetch → 主进程下载）不换，只换数据源
     *
     * 🔴 桌面版**不走渲染层 fetch**：`versionCheck` 里 `HAS_NET_BRIDGE` 为真时走主进程
     *    `net:fetch`（无 CORS、跟随用户代理）。所以只加 `page.route` 拦不到 ——
     *    第一轮就是这么"弹窗未出现"的。必须同时在主进程把 `globalThis.fetch` 换掉，
     *    且只替换 `/version.json` 这一条，下载请求照常放行到本地服务器。
     */
    const body = manifest({
      port,
      size: pkg.length,
      sha256: withSha ? (shaCorrect ? crypto.createHash('sha256').update(pkg).digest('hex') : '0'.repeat(64)) : '',
    })
    const bodyText = JSON.stringify(body)
    await app.evaluate((_electronApi, payload) => {
      const orig = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        if (url.includes('/version.json')) {
          return new Response(payload, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
        }
        return orig(input, init)
      }
      return true
    }, bodyText)
    await page.route('**/version.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: bodyText }))

    await enterProject(page)
    const opened = await openAbout(page)
    check(`${tag}.about-opened`, opened, opened ? '已进入关于打赏' : '找不到「关于打赏」页签')

    // 手动检查更新（manual=true 不受"每天一次"节流）
    const btn = page.getByRole('button', { name: /检查更新/ }).first()
    const btnSeen = await btn.isVisible().catch(() => false)
    if (btnSeen) {
      await btn.scrollIntoViewIfNeeded().catch(() => {})
      /**
       * 🔴 用 `el.click()` 而不是 Playwright 的鼠标点击：页面上还有一层
       *    「本页指引」的半透明遮罩，鼠标坐标会命中遮罩、按钮纹丝不动（实测点 4 次都没反应，
       *    按钮文本始终是「检查更新」而 result 一直为 null）。直接派发 click 走 React 合成事件，
       *    不依赖命中测试 —— 验的是"点了会不会查"，不是"遮罩挡不挡得住鼠标"。
       */
      await btn.evaluate((el) => el.click()).catch(() => {})
    } else check(`${tag}.check-button`, false, '页面上找不到「检查更新」按钮')

    // 点完给足 4 秒（主进程取清单 + 解析），再把"更新区域"原样打出来定位问题
    await sleep(4000)
    const btnText = await btn.innerText().catch(() => '(取不到)')
    console.log('DIAG 按钮点击后文本 ::', btnText.replace(/\s+/g, ' '))
    if (errors.length) console.log('DIAG 页面异常 ::', errors.join(' | '))
    const zone = await page.evaluate(() => {
      const t = document.body.innerText.replace(/[ \t]+/g, ' ')
      const i = t.indexOf('当前版本')
      return i >= 0 ? t.slice(i, i + 320).replace(/\n+/g, ' | ') : '(页面没有「当前版本」段落)'
    })
    console.log('DIAG 更新区域 ::', zone)

    // 弹窗出现后点「下载安装包」
    const dl = page.getByRole('button', { name: /下载安装包/ }).first()
    await dl.waitFor({ timeout: 20_000 }).catch(() => {})
    const dlgVisible = await dl.isVisible().catch(() => false)
    if (!dlgVisible) {
      // 没弹窗时把三件事摊开：主进程看到的清单、页面上的更新区域文本、控制台异常
      const probe = await app.evaluate(async () => {
        try {
          const r = await fetch('https://youth-fantasy-engine.online/version.json', { cache: 'no-store' })
          return { status: r.status, head: (await r.text()).slice(0, 160) }
        } catch (e) { return { err: String(e).slice(0, 160) } }
      }).catch((e) => ({ err: String(e).slice(0, 160) }))
      console.log('DIAG 主进程取清单 ::', JSON.stringify(probe))
      const area = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 700))
      console.log('DIAG 页面文本 ::', area)
    }
    check(`${tag}.dialog-shown`, dlgVisible, dlgVisible ? '发现新版本弹窗已出现' : '弹窗（99.0.0）未出现')
    if (!dlgVisible) return

    // 下载前的完整性提示（#4 的核心判据之一：点之前就得说清会不会真校验）
    const before = await page.evaluate(() => document.body.innerText)
    if (withSha) check(`${tag}.precheck-says-verified`, /已校验（sha256/.test(before), (before.match(/安装包完整性：[^\n]*/) || [''])[0])
    else check(`${tag}.precheck-says-unverified`, /未校验（清单未提供摘要/.test(before), (before.match(/安装包完整性：[^\n]*/) || [''])[0])

    await dl.click().catch(() => {})

    if (withSha) {
      // ---- 错摘要：必须失败、必须不留半截、必须没有可启动的成品 ----
      await page.waitForFunction(() => /下载失败/.test(document.body.innerText), null, { timeout: 60_000 }).catch(() => {})
      const after = await page.evaluate(() => document.body.innerText)
      check(`${tag}.mismatch-failure-shown`, /下载失败/.test(after), (after.match(/下载失败：[^\n]*/) || [''])[0])
      check(`${tag}.mismatch-explain`, /包在传输中被改动或不完整/.test(after), '文案给出了"丢弃 + 可重试/换渠道"')
      check(`${tag}.no-launcher-opened`, !/安装向导已打开/.test(after), '未进入"安装向导已打开"状态')
      const part = await exists(path.join(dlDir, 'YFE-W15-Verify.exe.part'))
      const full = await exists(path.join(dlDir, 'YFE-W15-Verify.exe'))
      check(`${tag}.no-part-left`, !part, '下载目录无 .part 残留')
      check(`${tag}.no-installer-file`, !full, '下载目录无成品安装包（从未改名成功）')
    } else {
      // ---- 无摘要：必须能完成，且如实写"未校验"，绝不冒充已校验 ----
      await page.waitForFunction(() => /安装向导已打开/.test(document.body.innerText), null, { timeout: 90_000 }).catch(() => {})
      const after = await page.evaluate(() => document.body.innerText)
      check(`${tag}.download-completed`, /安装向导已打开/.test(after), (after.match(/安装向导已打开[^\n]*/) || [''])[0])
      check(`${tag}.unverified-disclosed`, /未校验（清单未提供摘要/.test(after), '完成后如实标注未校验')
      check(`${tag}.not-claim-verified`, !/已校验（sha256 与清单一致/.test(after), '没有冒充已校验')
      check(`${tag}.file-on-disk`, await exists(path.join(dlDir, 'YFE-W15-Verify.exe')), path.join(dlDir, 'YFE-W15-Verify.exe'))
    }
  } finally {
    await new Promise((r) => srv.close(r)).catch(() => {})
    await close()
    // 🔴 无论成败都清掉测试产物（下载目录是主人的真实「下载」文件夹）
    for (const name of ['YFE-W15-Verify.exe', 'YFE-W15-Verify.exe.part']) {
      await fs.rm(path.join(dlDir, name), { force: true }).catch(() => {})
    }
  }
}

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

/* ============ #7 关于页（桌面形态） ============ */
async function caseAbout() {
  console.log('\n== #7 关于页 · 桌面形态 ==')
  const { page, close } = await launch('about', ['--no-proxy-server'])
  try {
    await enterProject(page)
    const opened = await openAbout(page)
    check('about.opened', opened, opened ? '已进入关于打赏' : '找不到「关于打赏」页签')
    if (!opened) return
    const text = await page.evaluate(() => document.body.innerText)
    check('about.version', text.includes(`v${EXPECT_VERSION}`), `期望 v${EXPECT_VERSION}`)
    const line = (text.match(/构建于[^\n]*/) || [''])[0]
    check('about.build-time', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(line), line || '没有「构建于 …」')
    check('about.carrier-desktop', /桌面版/.test(line), line || '没有形态字样')
    /**
     * 构建标识是**可选**项：`YFE_BUILD_ID` 没注入时关于页整段不渲染（`env.ts` 明确写"没传就留空"）。
     * 3.6.2 正式产物未注入 ⇒ 这里只记录，不判失败；验收第 7 条要的是「版本 + 构建时间 + 形态」。
     */
    const hasId = /构建 [0-9a-z]{6,}/i.test(line)
    checks.push({ id: 'about.build-id', passed: true, skipped: !hasId, detail: hasId ? line : '未注入 YFE_BUILD_ID（可选，按设计不显示）' })
    console.log((hasId ? 'PASS ' : 'SKIP ') + 'about.build-id :: ' + (hasId ? line : '未注入 YFE_BUILD_ID（可选，按设计不显示）'))
  } finally {
    await close()
  }
}

async function main() {
  if (!(await exists(EXE))) throw new Error('找不到桌面版可执行文件：' + EXE + '（用 --exe 指定）')
  if (!(await exists(FAKE_PKG))) throw new Error('找不到假安装包源：' + FAKE_PKG)
  const want = (k) => ONLY.length === 0 || ONLY.includes(k)
  console.log('EXE   =', EXE)
  console.log('假包  =', FAKE_PKG)
  console.log('期望版本 =', EXPECT_VERSION)

  if (want('offline')) await caseOffline()
  if (want('mismatch')) await caseDownload('mismatch', { withSha: true, shaCorrect: false })
  if (want('nosha')) await caseDownload('nosha', { withSha: false, shaCorrect: false })
  if (want('about')) await caseAbout()

  const failed = checks.filter((c) => !c.passed)
  console.log(`\nW1.5 SUMMARY: ${checks.length - failed.length}/${checks.length} passed`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log('  - ' + f.id + ' :: ' + f.detail)
  }
  const out = path.join(ROOT, '.workbuddy/tmp', 'w15-result-' + Date.now() + '.json')
  await fs.writeFile(out, JSON.stringify({ exe: EXE, at: new Date().toISOString(), checks }, null, 2) + '\n').catch(() => {})
  console.log('结果已写入', path.relative(ROOT, out))
  process.exit(failed.length ? 1 : 0)
}

await main()
