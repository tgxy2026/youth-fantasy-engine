// 3.4.0 · 文件后端创意连写强杀（桌面 / 便携）
//
// 背景：3.3.5 遗留「桌面和便携文件后端的创意连写强杀及章与检查点之间的各故障窗口」。
// 前面只做过 IndexedDB（浏览器）强杀，文件后端没有证据。
//
// 用法：
//   node scripts/verify/creative-kill-file-340.mjs --surface=desktop --timing=after-checkpoint --followup=unchanged
//   node scripts/verify/creative-kill-file-340.mjs --surface=portable --timing=before-first-chapter --followup=changed
//
// 参数：
//   --surface=desktop|portable
//   --timing=before-first-chapter | after-checkpoint     （检查点前/后的「章有检查点无」见下方说明）
//   --followup=unchanged | changed | deleted             （重开后：原样继续 / 改正文 / 删章）
//
// 🔴 架构事实（本脚本据此判定，不硬凑「章有检查点无」）：
//    桌面与便携都把所有 store 放在**同一个整库 JSON**里，写入是「防抖 + tmp→rename 原子写」；
//    创意连写的每章检查点会 `putStrict(meta)` 后立刻 `flush` 整库。
//    ⇒ 磁盘上只可能出现「两者都旧」或「两者都新」，**不存在「章节已落盘、检查点没落」的中间态**。
//    因此本脚本验证的是：每次强杀后文件仍是合法 JSON、章节数与检查点计数一致（同一快照），
//    以及重开后的续跑/阻止行为；并在报告里显式记录这个「窗口不可达」的结论。
//
// 🔴 强杀只杀本次启动的进程：桌面用 ElectronApplication 的主进程 PID；便携用自己 spawn 的服务 PID。
import { createServer } from 'vite'
import { chromium, _electron } from 'playwright'
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'

const ROOT = process.cwd()
const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const surface = arg('surface', 'desktop')
const timing = arg('timing', 'after-checkpoint')
const followup = arg('followup', 'unchanged')
if (!['desktop', 'portable'].includes(surface)) throw new Error('--surface must be desktop|portable')
if (!['before-first-chapter', 'after-checkpoint'].includes(timing)) throw new Error('unknown --timing')
if (!['unchanged', 'changed', 'deleted', 'roundtrip'].includes(followup)) throw new Error('unknown --followup')

const tag = `${surface}-${timing}-${followup}`
const run = await mkdtemp(path.join(ROOT, '.workbuddy/tmp/creative-kill-file-340-'))
const checks = []
const check = (id, ok, detail = '') => {
  checks.push({ id, ok: !!ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok || !detail ? '' : ` :: ${detail}`))
  if (!ok) throw new Error(`${id}${detail ? ' :: ' + detail : ''}`)
}

let vite, mock, electronApp, browser, page, portableServer
let dataFile = ''
let origin = ''
let mockLog = ''

const startMock = async () => {
  mockLog = path.join(run, 'mock.log')
  mock = spawn(process.execPath, [path.join(ROOT, 'scripts/verify/mock-openai-endpoint.mjs')], {
    env: { ...process.env, MOCK_PORT: '18080', MOCK_DELAY_MS: '500', MOCK_LOG: path.join(run, 'mock-requests.log') },
    stdio: 'ignore',
  })
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://127.0.0.1:18080/v1/models', { signal: AbortSignal.timeout(600) }); if (r.ok || r.status < 500) return } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('假模型端点没有就绪')
}

const readData = async () => {
  const text = await readFile(dataFile, 'utf8')
  const parsed = JSON.parse(text)
  return { parsed, text }
}
// store 形态两端不同：桌面是「主键 → 记录」对象，便携是数组。两种都吃。
const rowsOf = (parsed, store) => {
  const v = parsed?.stores?.[store]
  if (!v) return []
  return Array.isArray(v) ? v : Object.values(v)
}
const setRows = (parsed, store, rows) => {
  const v = parsed?.stores?.[store]
  parsed.stores[store] = Array.isArray(v) ? rows : Object.fromEntries(rows.map(r => [r.id ?? r.key, r]))
}
const chaptersOf = parsed => rowsOf(parsed, 'chapters')
const findSession = parsed => {
  const meta = parsed?.stores?.meta ?? {}
  const projectId = Array.isArray(meta)
    ? meta.find(r => r?.key === 'lastProject')?.value
    : meta.lastProject?.value
  const pid = projectId ?? Object.keys(parsed?.stores?.projects ?? {})[0]
  if (!pid) return null
  const row = Array.isArray(meta) ? meta.find(r => r?.key === 'creativeSession:' + pid) : meta['creativeSession:' + pid]
  return row?.value ?? row ?? null
}
const writeData = async text => { await writeFile(dataFile, text, 'utf8') }

const patchData = async mutator => {
  const { parsed } = await readData()
  mutator(parsed)
  await writeData(JSON.stringify(parsed))
}

const launchDesktop = async (url) => {
  const profile = path.join(run, 'profile')
  const appData = path.join(run, 'appdata')
  await mkdir(profile, { recursive: true })
  await mkdir(appData, { recursive: true })
  await writeFile(path.join(run, 'package.json'), JSON.stringify({ name: 'yfe-kill-file', version: '3.4.0', main: 'bootstrap.cjs' }))
  await writeFile(path.join(run, 'bootstrap.cjs'),
    `const {app}=require('electron');app.setPath('appData',${JSON.stringify(appData)});require(${JSON.stringify(path.join(ROOT, 'electron/main.cjs'))});`)
  electronApp = await _electron.launch({
    executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: [run, '--no-sandbox', '--no-proxy-server', '--user-data-dir=' + profile],
    env: { ...process.env, ELECTRON_START_URL: url },
    timeout: 90000,
  })
  page = await electronApp.firstWindow()
  page.setDefaultTimeout(20000)
  // 隔离 profile 里把引导自动开启关掉，避免每次重启都弹遮罩挡住导航
  await page.evaluate(() => localStorage.setItem('yfe-ui:guide-auto', '0')).catch(() => {})
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  // 🔴 --user-data-dir 会覆盖 app.getPath('userData')：数据文件就落在 profile 下
  dataFile = path.join(profile, 'youth-fantasy-engine-data.json')
}

const launchPortable = async () => {
  const appRoot = path.join(run, 'app')
  await mkdir(appRoot, { recursive: true })
  // 重启复用同一应用目录与数据文件；dist 只拷一次
  if (!existsSync(path.join(appRoot, 'dist', 'index.html'))) {
    await cp(path.join(ROOT, 'dist'), path.join(appRoot, 'dist'), { recursive: true })
  }
  dataFile = path.join(appRoot, 'data', 'youth-fantasy-engine-data.json')
  origin = 'http://127.0.0.1:8909'
  portableServer = spawn(process.execPath, [path.join(ROOT, 'scripts/portable-server.mjs'), '--root', appRoot, '--no-open', '--port', '8909'], { stdio: 'ignore' })
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(origin, { signal: AbortSignal.timeout(800) }); if (r.ok) return } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error('便携服务没有就绪')
}

const openBrowser = async () => {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.addInitScript(() => localStorage.setItem('yfe-ui:guide-auto', '0'))
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
}

/** 首启向导建一个空白项目（不依赖示例作品） */
/** 关掉新手引导遮罩：它会把背景置为 inert 并拦截点击（项目里已知的测试坑） */
const dismissGuide = async () => {
  for (let i = 0; i < 8; i++) {
    if (!(await page.locator('[data-guide-mask]').count())) return
    for (const name of ['关闭本页指引', '跳过本页', '稍后再说']) {
      const btn = page.getByRole('button', { name, exact: true })
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ force: true }).catch(() => {})
        await page.waitForTimeout(250)
      }
    }
    // 遮罩自己声明了「关闭（Esc）」；按钮还没渲染/不可见时，Esc 是唯一稳定出口
    if (await page.locator('[data-guide-mask]').count()) {
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(250)
    }
  }
}

const createProject = async (name) => {
  // 向导顺序：选卡片 → 填书名（输入框在卡片下方，不在"下一步"之后）→ 下一步 → 模型步骤跳过
  await page.getByRole('button', { name: /写我的第一本书/ }).click({ timeout: 60000 })
  await page.getByPlaceholder(/给这本书起个名字/).fill(name)
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  const skip = page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).first()
  await skip.waitFor({ timeout: 30000 })
  await skip.click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  await dismissGuide()
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
}

const openProject = async () => {
  const card = page.locator('[data-project-card]').first()
  await card.waitFor({ timeout: 60000 })
  await card.getByRole('button', { name: /继续写作|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  await dismissGuide()
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
}

const injectModelDesktop = async () => {
  // 🔴 不在页面里 setMeta + reload：整库写盘有 800ms 防抖，reload 会掐掉定时器，
  //    配置时有时无（实测 changed/before 两个场景就是这么挂的）。
  //    改成「优雅关闭 → 直接改整库 JSON → 冷启动」，与便携同一套机制，确定性更高。
  await page.waitForTimeout(1200)
  await electronApp.close().catch(() => {})
  electronApp = undefined
  await patchData(parsed => {
    const meta = parsed.stores.meta ?? (parsed.stores.meta = {})
    meta.aiProviders = { key: 'aiProviders', value: [{
      id: 'mock-1', name: 'Mock 本地端点', type: 'openai',
      baseUrl: 'http://127.0.0.1:18080/v1', apiKey: 'test-key', model: 'mock-1', local: true,
    }] }
    meta.aiActiveProviderId = { key: 'aiActiveProviderId', value: 'mock-1' }
  })
  await launchDesktop(origin)
  await page.goto(origin)
  await openProject()
}

const injectModelPortable = async () => {
  // 等待防抖落盘，然后关闭浏览器（避免客户端缓存回写覆盖我们注入的 meta）
  await new Promise(r => setTimeout(r, 2000))
  await browser.close()
  browser = undefined
  const { parsed } = await readData()
  // 🔴 便携的 meta 是**数组**、桌面是对象映射：两种都要支持（写错形状会静默丢配置）
  const meta = parsed.stores.meta ?? (parsed.stores.meta = [])
  const put = (key, value) => {
    if (Array.isArray(meta)) {
      const hit = meta.find(r => r?.key === key)
      if (hit) hit.value = value
      else meta.push({ key, value })
      return
    }
    const hit = meta[key]
    if (hit && typeof hit === 'object' && 'value' in hit) hit.value = value
    else meta[key] = { key, value }
  }
  put('aiProviders', [{
    id: 'mock-1', name: 'Mock 本地端点', type: 'openai',
    baseUrl: 'http://127.0.0.1:18080/v1', apiKey: 'test-key', model: 'mock-1', local: true,
  }])
  put('aiActiveProviderId', 'mock-1')
  await writeData(JSON.stringify(parsed))
  // 🔴 便携服务把整库读进内存：只改文件、不重启，新页面 GET 到的还是服务端旧内存 ⇒ aiReady=false。
  //    所以改完文件必须重启服务进程。
  portableServer?.kill('SIGKILL')
  portableServer = undefined
  await new Promise(r => setTimeout(r, 1000))
  await launchPortable()
  await openBrowser()
  await openProject()
}

const goCreative = async () => {
  await dismissGuide()
  await page.getByRole('navigation').getByRole('button', { name: '创意写作', exact: true }).click()
  const seedBox = page.locator('textarea[placeholder*="吞噬他人修为"]')
  await seedBox.waitFor({ timeout: 30000 })
  await seedBox.fill('一个靠替人记仇的抄书人，在王朝崩塌前夜发现自己记下的每一条仇都要由他来还。')
  const chapterCount = page.getByTitle(/本次写几章：/)
  const wordCount = page.getByTitle(/每章目标字数：/)
  await chapterCount.fill('3'); await chapterCount.blur()
  await wordCount.fill('800'); await wordCount.blur()
  // 填完回读：React 受控组件若没吃到输入，会退回默认值（默认可能是 1 章），强杀就变成「杀一个已完成的跑批」
  const planned = Number(await chapterCount.inputValue().catch(() => '0'))
  const words = Number(await wordCount.inputValue().catch(() => '0'))
  console.log('[setup]', JSON.stringify({ planned, words }))
  if (planned !== 3) throw new Error('章节数没有填进表单：' + planned)
  await page.waitForTimeout(500)
  await dismissGuide()
  // 🔴 「逐章确认初稿」默认开启 ⇒ 每章写完会停下来等人确认，永远到不了「写下一章」的窗口。
  //    强杀验证要的是「连写」，这里显式关掉（报告里注明这个前置）。
  const confirmToggle = page.getByRole('button', { name: /逐章确认初稿：已开启/ })
  if (await confirmToggle.isVisible().catch(() => false)) {
    await confirmToggle.click()
    await page.waitForTimeout(300)
  }
  const startBtn = page.getByRole('button', { name: '开始创作', exact: true })
  await startBtn.waitFor({ timeout: 30000 })
  // AI 就绪/表单校验是异步的：按钮会先渲染成 disabled，等它真的可点再点
  for (let i = 0; i < 60 && !(await startBtn.isEnabled()); i++) await page.waitForTimeout(500)
  if (!(await startBtn.isEnabled())) {
    const why = await page.locator('main').innerText().then(t => t.replace(/\s+/g, ' ').slice(0, 400)).catch(() => '')
    throw new Error('开始创作一直不可点：' + why)
  }
  await startBtn.click()
}

/** 只点 UI（不 import /src），便携与桌面通用；返回点到了什么 */
const poke = async () => {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const label = b => (b.textContent || '').trim()
    let clicked = null
    if (!window.__kConfirmed) {
      const confirm = btns.find(b => /^确认设定（[1-9]/.test(label(b)))
      if (confirm) { confirm.click(); window.__kConfirmed = true; clicked = label(confirm) }
      else {
        const all = btns.find(b => /^全选新建$/.test(label(b)))
        if (all) { all.click(); clicked = '全选新建' }
      }
    } else if (!window.__kWriting) {
      const go = btns.find(b => /^保存大纲并开始连写/.test(label(b)))
      if (go) { go.click(); window.__kWriting = true; clicked = label(go) }
    }
    return { clicked, labels: btns.map(label).filter(t => /确认|连写|继续|中止|已写/.test(t)).slice(0, 8) }
  })
}

const snapshot = async () => {
  const { parsed } = await readData()
  const chapters = chaptersOf(parsed)
  const session = findSession(parsed)
  return {
    parsed, chapterCount: chapters.length,
    ids: chapters.map(c => c.id),
    contents: Object.fromEntries(chapters.map(c => [c.id, c.content ?? ''])),
    doneChapters: session?.resume?.doneChapters ?? null,
    status: session?.progress?.status ?? null,
    savedAt: parsed.savedAt ?? null,
  }
}

const killDesktop = async () => {
  const pid = electronApp.process().pid
  if (!pid) throw new Error('拿不到 Electron 主进程 PID')
  // 精确杀**本次启动**的进程树（主进程 + 渲染进程）；/T 只作用于该 PID 的子进程。
  // SIGKILL 语义：不给保存机会，这就是强杀。
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' }) }
  catch { process.kill(pid, 'SIGKILL') }
  electronApp = undefined
  await new Promise(r => setTimeout(r, 2000))
  // SIGKILL 会留下 Chromium 的 profile 锁文件，不清掉下次启动会失败（Target closed）
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await rm(path.join(run, 'profile', f), { force: true }).catch(() => {})
  }
}

const killPortable = async () => {
  const pid = portableServer.pid
  if (!pid) throw new Error('拿不到便携服务 PID')
  process.kill(pid, 'SIGKILL')
  portableServer = undefined
  if (browser) { await browser.close().catch(() => {}); browser = undefined }
  await new Promise(r => setTimeout(r, 1500))
}

const closeAll = async () => {
  await browser?.close().catch(() => {})
  await electronApp?.close().catch(() => {})
  portableServer?.kill('SIGKILL')
  await vite?.close().catch(() => {})
  mock?.kill('SIGKILL')
}

try {
  if (surface === 'desktop') {
    vite = await createServer({ cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
    await vite.listen()
    origin = `http://127.0.0.1:${vite.httpServer.address().port}`
  }
  await startMock()

  // ---- 1. 建项目 + 注入假模型 + 进创意页 ----
  if (surface === 'desktop') {
    await launchDesktop(origin)
    await page.goto(origin) // ELECTRON_START_URL 已加载，这里确保页面就绪
    await createProject(`强杀夹具-${tag}`)
    await injectModelDesktop()
  } else {
    await launchPortable()
    await openBrowser()
    await createProject(`强杀夹具-${tag}`)
    await injectModelPortable()
  }
  await goCreative()

  // ---- 2. 打点：按 timing 决定强杀时机 ----
  let killed = false
  let before = null
  if (timing === 'before-first-chapter') {
    // 停在设定/大纲闸门（还没写第一章）时强杀
    const deadline = Date.now() + 120000
    let startedWriting = false
    while (Date.now() < deadline) {
      await page.waitForTimeout(400)
      const r = await poke()
      if (r?.clicked === '保存大纲并开始连写') startedWriting = true
      const s2 = await snapshot().catch(() => null)
      // 「章写入前」= 已经放行连写、但第一章还没落库。这里不等闸门消失，点完就连杀。
      if (s2 && s2.chapterCount === 0 && (startedWriting || s2.status === 'running')) {
        killed = true
        console.log('[kill]', JSON.stringify({ chapters: 0, startedWriting, status: s2.status }))
        break
      }
    }
    check('命中「章写入前」时机（闸门在、章节为 0）', killed)
  } else {
    const deadline = Date.now() + 180000
    let round = 0
    while (Date.now() < deadline) {
      await page.waitForTimeout(250)
      const clicked = await poke()
      const s = await snapshot().catch(() => null)
      if (round++ % 16 === 0) {
        const exists = await readFile(dataFile, 'utf8').then(() => true).catch(() => false)
        const text = await page.locator('main').innerText().then(t => t.replace(/\s+/g, ' ').slice(0, 160)).catch(() => '')
        console.log('[poll]', JSON.stringify({ exists, chapters: s?.chapterCount, status: s?.status, done: s?.doneChapters, clicked: clicked?.clicked, labels: clicked?.labels?.slice(0, 5), text }))
      }
      if (s && s.chapterCount >= 1 && s.status === 'running') { before = s; killed = true; console.log('[kill]', JSON.stringify({ chapters: s.chapterCount, done: s.doneChapters, status: s.status })); break }
    }
    check('命中「首个检查点后」时机（至少 1 章已落库）', killed)
  }

  // ---- 3. 强杀 + 磁盘一致性 ----
  const preKill = before ?? await snapshot().catch(() => null)
  if (surface === 'desktop') await killDesktop()
  else await killPortable()

  const after = await snapshot()
  check('强杀后数据文件仍是合法 JSON', !!after.parsed)
  check('章节数与检查点 doneChapters 一致（同一快照，无「章有检查点无」）',
    after.doneChapters === null ? after.chapterCount === 0 : after.chapterCount === after.doneChapters,
    `chapters=${after.chapterCount} done=${after.doneChapters} status=${after.status}`)

  // ---- 4. 按 followup 改造数据（模拟恢复前被改 / 删章）----
  const targetId = after.ids[0]
  // 只有「改正文 / 删章」才改数据；roundtrip 必须保持数据原样，否则等于把断点证据自己删了
  if ((followup === 'changed' || followup === 'deleted') && targetId) {
    await patchData(parsed => {
      const chapters = chaptersOf(parsed)
      if (followup === 'changed') {
        const ch = chapters.find(c => c.id === targetId)
        ch.content = `${ch.content ?? ''}\n【恢复前外部修改】`
      } else {
        setRows(parsed, 'chapters', chapters.filter(c => c.id !== targetId))
      }
    })
  }

  // ---- 5. 重启（同一数据目录）并核验 ----
  if (surface === 'desktop') {
    await launchDesktop(origin)
    await page.goto(origin)
  } else {
    await launchPortable()
    await openBrowser()
  }
  await openProject()
  // 「切项目」窗口：强杀后先回项目列表、再重进同一本（走真实的项目卸载/重载），然后再看断点
  if (followup === 'roundtrip') {
    const before = await snapshot()
    console.log('[roundtrip] before', JSON.stringify({ chapters: before.chapterCount, done: before.doneChapters, status: before.status }))
    await page.getByTitle('返回项目列表').click()
    await page.locator('[data-project-card]').first().waitFor({ timeout: 30000 })
    const mid = await snapshot()
    console.log('[roundtrip] at-hub', JSON.stringify({ chapters: mid.chapterCount, done: mid.doneChapters, status: mid.status }))
    await openProject()
    const back = await snapshot()
    console.log('[roundtrip] reopened', JSON.stringify({ chapters: back.chapterCount, done: back.doneChapters, status: back.status }))
  }
  await page.getByRole('navigation').getByRole('button', { name: '创意写作', exact: true }).click()
  await page.getByText('创意写作').first().waitFor({ timeout: 30000 })
  // 创意页的断点/阻止结论是异步算出来的，页面会先停在「加载中…」；轮询到真正稳定再断言
  const settled = async (timeout = 60000) => {
    const deadline = Date.now() + timeout
    let text = ''
    while (Date.now() < deadline) {
      text = await page.locator('main').innerText().catch(() => '')
      const action = await page.getByRole('button', { name: /继续写作|开始创作|从头重写/ }).first().count()
      if (text.length > 60 && !text.includes('加载中') && (action > 0 || /已被改动|已被删除|断点记录损坏|无法.*续跑/.test(text))) return text
      await page.waitForTimeout(400)
    }
    return text
  }
  let bodyText = await settled()

  if (followup === 'unchanged' || followup === 'roundtrip') {
    if (after.chapterCount === 0) {
      // 章写入前被强杀：磁盘上应仍是 0 章、没有断点记录；页面也不该凭空显示「上次中止在」。
      // （不断言「开始创作」可点：它受 aiReady/表单校验影响，与本次故障窗口无关）
      const now = await snapshot()
      check('章前强杀后仍是 0 章', now.chapterCount === 0, 'chapters=' + now.chapterCount)
      check('没有伪造断点记录', now.doneChapters === null && !/上次中止在/.test(bodyText), bodyText.slice(0, 300))
    } else {
      const resume = page.getByRole('button', { name: '继续写作', exact: true })
      await resume.waitFor({ timeout: 30000 })
      for (let i = 0; i < 40 && !(await resume.isEnabled()); i++) await page.waitForTimeout(300)
      check('有断点时可继续', await resume.isEnabled(), bodyText.slice(0, 300))
      await resume.click()
      let latest = null
      const deadline = Date.now() + 180000
      while (Date.now() < deadline) {
        latest = await snapshot().catch(() => null)
        if (latest && latest.chapterCount >= 3 && latest.status !== 'running') break
        await poke()
        await page.waitForTimeout(700)
      }
      check('续跑到 3 章完成', !!latest && latest.chapterCount === 3, `chapters=${latest?.chapterCount}`)
      check('章节 id 无重复（没有写成两份）', !!latest && new Set(latest.ids).size === latest.ids.length)
      check('已落库章节内容未被重写', !!latest && latest.contents[targetId] === after.contents[targetId])
      check('最终检查点与章节数一致',
        !!latest && (latest.doneChapters === null || latest.doneChapters === latest.chapterCount),
        `chapters=${latest?.chapterCount} done=${latest?.doneChapters}`)
    }
  } else {
    // 阻止态可能直接不给「继续写作」（只给「从头重写」），所以「按钮不存在」也算拒绝
    const resume = page.getByRole('button', { name: '继续写作', exact: true })
    const hasResume = await resume.count() > 0
    const disabled = hasResume ? await resume.isDisabled().catch(() => true) : true
    const expect = followup === 'changed' ? /已被改动/ : /已被删除/
    check(`${followup}：阻止续跑`, disabled && expect.test(bodyText), bodyText.slice(0, 500))
  }

  console.log(`\nPASS ${checks.length} checks · creative-kill-file-340 [${tag}]`)
} catch (error) {
  console.error(`\nFAIL [${tag}]`, String(error?.stack || error))
  process.exitCode = 1
} finally {
  await closeAll()
}
