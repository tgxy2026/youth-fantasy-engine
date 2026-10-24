/**
 * 3.2.0 · 发布门槛 §13.2 容量实测：500 章 / 百万字 / 200 个候选载荷
 *
 * 依据：方案 §13.2 样本表「500 章/百万字量级、200 个候选载荷 → 列表惰性加载、内存、首屏与保存延迟；
 *       数据读取和渲染分别测量」。
 * 🔴 与 L4 的 1000×60 表格不是一件事（那个是自设更高标准，不构成发布门槛）。
 *
 * 隔离：`browser.newContext()` 自带独立 IndexedDB，500 章只写在这个临时上下文，
 *      **不碰主人真实书库**（不复制、不读写 %APPDATA%）。
 *
 * 用法：node scripts/bench/bench-release-500ch.cjs
 */
const path = require('node:path')
const fs = require('node:fs')
const ROOT = path.resolve(__dirname, '../..')
const TEMP = path.join(ROOT, '.workbuddy/tmp')
fs.mkdirSync(TEMP, { recursive: true })
const RUN = fs.mkdtempSync(path.join(TEMP, 'historical-bench-'))
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH
  || path.join(ROOT, 'node_modules/playwright-core'))

const BASE = process.env.APP_URL || 'http://localhost:5199/'
const EDGE = process.env.REVIEW_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const N = Number(process.env.CHAPTERS || 500)
const WORDS = Number(process.env.WORDS || 2000)
const PAYLOADS = Number(process.env.PAYLOADS || 200)
const OUT = path.join(RUN, 'release-capacity-500ch.json')

const R = { at: new Date().toISOString(), app: BASE, chapters: N, wordsPerChapter: WORDS, payloads: PAYLOADS, steps: {} }
const put = (k, v) => { R.steps[k] = v; console.log(`· ${k}:`, typeof v === 'string' ? v : JSON.stringify(v)) }

const HELPERS = `
  window.__yfeOpen = () => new Promise((res, rej) => {
    const r = indexedDB.open('youth-fantasy-engine')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
`

async function closeOverlays(page) {
  for (let i = 0; i < 4; i++) {
    const x = page.locator('button[title="关闭"], button[title="知道了"], button:has-text("知道了"), button:has-text("稍后再说")')
    if (await x.count()) { try { await x.first().click({ timeout: 800 }) } catch {} }
    await page.waitForTimeout(200)
  }
}

async function enterDemo(page) {
  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 })
  const inProject = () => page.evaluate(() => /工作面板/.test(document.body.innerText || ''))
  for (let round = 0; round < 4; round++) {
    if (await inProject()) return true
    // 点“创建示范项目”或“先看看示例”（用 evaluate，不要求元素可见）
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => /创建示范项目|先看看示例/.test(x.textContent || ''))
      b?.click()
    })
    await page.waitForTimeout(6000)
    // 引导里的下一步 / 跳过 / 开始写作
    for (const label of ['下一步', '跳过，直接开始', '开始写作', '知道了', '完成']) {
      await page.evaluate((l) => {
        const b = [...document.querySelectorAll('button')]
          .find(x => (x.textContent || '').replace(/\s+/g, '').startsWith(l.replace(/\s+/g, '')))
        b?.click()
      }, label)
      await page.waitForTimeout(1800)
    }
    if (await inProject()) return true
  }
  return await inProject()
}

async function main() {
  const browser = await chromium.launch({
    executablePath: EDGE, headless: true,
    args: ['--disable-gpu', '--enable-precise-memory-info', '--no-first-run'],
  })
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(HELPERS)
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 160)))

  const entered = await enterDemo(page)
  put('0 进入示范项目', entered)
  if (!entered) { fs.writeFileSync(OUT, JSON.stringify(R,null,1)); await browser.close(); console.log('RESULT', JSON.stringify({entered:false},null,1)); process.exitCode = 1; return }

  // ---------- 种 500 章 + 200 载荷 ----------
  const seed = await page.evaluate(async ({ n, words, payloads }) => {
    const db = await window.__yfeOpen()
    const all = store => new Promise(res => {
      const r = db.transaction(store, 'readonly').objectStore(store).getAll()
      r.onsuccess = () => res(r.result)
      r.onerror = () => res([])
    })
    const projects = await all('projects')
    const pid = projects[0].id
    const volsBefore = (await all('volumes')).filter(v => v.projectId === pid)
    const existingCh = (await all('chapters')).filter(c => c.projectId === pid)
    // 卷：优先复用已有卷；没有就自己建一卷（新建的示范项目可能 0 卷 ⇒ 章节会成孤儿）
    let volId = existingCh[0]?.volumeId || volsBefore[0]?.id || ''
    const needVol = !volId
    if (needVol) volId = 'cap-vol-1'

    const sentence = '容量测试正文。他推开门，风灌进来，灯影晃了一下，远处有人在喊他的名字。'
    const body = sentence.repeat(Math.ceil(words / sentence.length))
    const now = Date.now()

    const t0 = performance.now()
    await new Promise((res, rej) => {
      const tx = db.transaction(['chapters', 'volumes'], 'readwrite')
      const st = tx.objectStore('chapters')
      const vs = tx.objectStore('volumes')
      if (needVol) {
        vs.put({ id: volId, projectId: pid, order: 1, title: '第一卷 容量基准', description: '', createdAt: now })
      }
      const cur = st.getAll()
      cur.onsuccess = () => {
        for (const c of cur.result) if (c.projectId === pid) st.delete(c.id)
        for (let i = 1; i <= n; i++) {
          st.put({
            id: `cap-ch-${i}`, projectId: pid, volumeId: volId, order: i,
            title: `第${i}章 容量章${i}`, content: body, summary: `容量基准第 ${i} 章`,
            status: '草稿', wordCount: words, createdAt: now - (n - i) * 1000, updatedAt: now - (n - i) * 1000,
          })
        }
      }
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
    })
    const tChapters = performance.now() - t0

    const t1 = performance.now()
    await new Promise((res, rej) => {
      const tx = db.transaction(['revisionPayloads'], 'readwrite')
      const st = tx.objectStore('revisionPayloads')
      for (let i = 0; i < payloads; i++) {
        st.put({
          id: `cap-pl-${i}`, projectId: pid, kind: 'report', jobId: 'local-ticket',
          report: {
            checkId: 'chapter-check', source: 'local',
            result: [{ level: '中等', title: `容量载荷 ${i} 的问题标题`, detail: '容量基准载荷，用于测量载荷列表与配额表现', where: '容量测试正文' }],
            evidence: [{ quote: '容量测试正文', located: true, paragraphIndex: 0 }],
            chapterId: `cap-ch-${(i % n) + 1}`, chapterNo: (i % n) + 1,
          },
          summary: `容量载荷 ${i}`, bytes: 420, createdAt: now - i * 10,
        })
      }
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
    })
    const tPayloads = performance.now() - t1

    const t2 = performance.now()
    const rows = (await all('chapters')).filter(c => c.projectId === pid)
    const tRead = performance.now() - t2
    const bytes = rows.reduce((s, c) => s + (c.content || '').length, 0)
    return {
      pid, volumeId: volId, createdVolume: needVol,
      seedChaptersMs: Math.round(tChapters), seedPayloadsMs: Math.round(tPayloads),
      readAllMs: Math.round(tRead), chaptersInDb: rows.length,
      totalChars: bytes, looksLikeMillion: bytes >= 800000,
      statusSample: rows[0]?.status ?? null,
    }
  }, { n: N, words: WORDS, payloads: PAYLOADS })
  put('1 种数据', seed)

  // ---------- 首屏：刷新 ⇒ 回项目列表（应用设计如此）⇒ 点开项目 ⇒ 工作面板可见 ----------
  const t0 = Date.now()
  await page.reload({ waitUntil: 'load', timeout: 120000 })
  await page.waitForTimeout(1500)
  const backToProject = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('title') || '') === '打开项目')
    if (!b) return false
    b.click(); return true
  })
  let enteredAgain = false
  try {
    await page.waitForFunction(() => /工作面板/.test(document.body.innerText), null, { timeout: 180000 })
    enteredAgain = true
  } catch {}
  const firstScreenMs = Date.now() - t0
  put('2 首屏(刷新→点开项目→工作面板)', { ms: firstScreenMs, backToProject, enteredAgain })
  await page.waitForTimeout(1200)
  await closeOverlays(page)

  // ---------- 打开「正文编辑」（500 章列表 + 编辑器） ----------
  // 🔴 判据必须查 body：章节列表不在 <aside> 里（第一版查 aside 一直等不到，误判成"渲染不出来"）
  let editMs = null, editBlocked = ''
  await closeOverlays(page)
  try {
    const t1 = Date.now()
    await page.evaluate(() => {
      const b = [...(document.querySelector('aside')?.querySelectorAll('button') || [])]
        .find(x => (x.textContent || '').replace(/\s+/g, ' ').trim() === '正文编辑')
      b?.scrollIntoView({ block: 'center' }); b?.click()
    })
    await page.waitForFunction(() => /第500章 容量章500|容量第500章/.test(document.body.innerText), null, { timeout: 120000 })
    editMs = Date.now() - t1
  } catch (e) {
    editBlocked = String(e).slice(0, 100)
  }
  put('3 正文编辑(500 章)', editMs === null ? { blocked: editBlocked } : editMs)
  await page.screenshot({ path: path.join(RUN, '500ch-edit.png') })

  // ---------- 切章：点第 250 章，等编辑器换内容 ----------
  let switchMs = null, switchBlocked = ''
  try {
    const t2 = Date.now()
    const clicked = await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find(e =>
        e.children.length === 0 && /第250章\s*容量章250/.test((e.textContent || '').trim()))
      if (!el) return false
      el.scrollIntoView({ block: 'center' }); el.click(); return true
    })
    if (!clicked) throw new Error('找不到第250章的列表项')
    await page.waitForFunction(() => /容量第250章/.test(document.body.innerText), null, { timeout: 60000 })
    switchMs = Date.now() - t2
  } catch (e) {
    switchBlocked = String(e).slice(0, 100)
  }
  put('4 切到第250章', switchMs === null ? { blocked: switchBlocked } : switchMs)

  // ---------- 内存 ----------
  const mem = await page.evaluate(() => {
    const m = performance.memory
    return m ? { usedMB: Math.round(m.usedJSHeapSize / 1048576), totalMB: Math.round(m.totalJSHeapSize / 1048576) } : null
  })
  put('5 JS 堆', mem)

  // ---------- 写盘延迟（直接 IDB 写一章，代表保存侧存储成本） ----------
  const write = await page.evaluate(async () => {
    const db = await window.__yfeOpen()
    const t = performance.now()
    await new Promise(res => {
      const tx = db.transaction(['chapters'], 'readwrite')
      tx.objectStore('chapters').put({
        id: 'cap-ch-write', projectId: 'cap', volumeId: 'v', order: 9999,
        title: '第9999章 写入测速', content: '写入测速正文', summary: '', status: 'draft',
        wordCount: 6, createdAt: Date.now(), updatedAt: Date.now(),
      })
      tx.oncomplete = () => res()
    })
    return Math.round(performance.now() - t)
  })
  put('6 单章写盘', write)

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(R, null, 1))
  console.log('RESULT', JSON.stringify({
    firstScreenMs, editMs, switchMs, heapMB: mem?.usedMB ?? null, readAllMs: seed.readAllMs, chars: seed.totalChars,
  }, null, 1))
  await browser.close()
}

main().catch(e => { console.error('FATAL', e); process.exitCode = 1 })
