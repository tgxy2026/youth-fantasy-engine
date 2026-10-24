/**
 * 3.2.0 · L4 容量基准：1000 条 × 60 自定义字段（真实应用 + 真 IndexedDB）
 *
 * 背景：`docs/3.2.0-W0-开工复核报告-2026-10-19.md` 里 L4 写着「现引用旧 perfBaseline」——
 * 那份闸跑的是内存存储桩、表格只有 3000 行 × 3 列，回答不了「一张表 1000 条、每条 60 个
 * 自定义字段，表格还能不能正常用」。
 *
 * 本脚本在**真 Chromium + 真 IndexedDB + 真 dev 应用**上量这些数：
 *   ① 进页签：点击 → 1000 行全部进 DOM 的端到端耗时（含 IDB 读取与 6 万个单元格渲染）
 *   ② 数据量：IDB 读取耗时、行数据 JSON 体积、DOM 节点数
 *   ③ 滚动：滚到底 / 回到顶的帧耗时（表格无虚拟化，1000 行 × 75 列全量在 DOM 里）
 *   ④ 筛选：表头输入 → 只剩 1 行 → 清空恢复 1000 行
 *   ⑤ 编辑：改一个自定义字段 → 落草稿的重渲染耗时 → 保存 → 回读库确认值已变
 *   ⑥ 切走再切回：重新挂载并重读整表的耗时
 *   ⑦ JS 堆与长任务（longtask）
 *
 * 🔴 数据隔离：`browser.newPage()` 自带独立 browser context（独立 IndexedDB）。
 *    1000 条样本只写在这个临时上下文里，**不碰主人的真实书库**。
 *
 * 用法：node scripts/bench/bench-capacity-1000x60.cjs
 * 可选环境变量：APP_URL / PLAYWRIGHT_CORE_PATH / REVIEW_BROWSER_PATH / ROWS / FIELDS
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
const BROWSER_PATH = process.env.REVIEW_BROWSER_PATH
  || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const ROWS = Number(process.env.ROWS || 1000)
const FIELDS = Number(process.env.FIELDS || 60)
const OUT = path.join(RUN, 'l4-capacity.json')

process.on('unhandledRejection', e => {
  const msg = String((e && e.message) || e)
  if (/TargetClosedError|has been closed/.test(msg)) return
  console.error('unhandledRejection:', e)
  process.exitCode = 1
})

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS ' + name + (extra ? '　' + extra : '')) }
  else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

async function closeOverlays(page) {
  for (let i = 0; i < 5; i++) {
    const overlay = page.locator('div.fixed.inset-0.bg-black\\/60')
    if (await overlay.count() === 0) return
    const btn = page.getByRole('button', { name: /稍后再说|知道了|关闭|开始使用|跳过|取消|不用了/ })
    if (await btn.count() > 0) await btn.first().click()
    else await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }
}

/** 切页签：先点分组、再点页签名 */
async function gotoTab(page, group, tabName) {
  const h1 = page.locator('h1', { hasText: tabName })
  if (await page.getByText(tabName, { exact: true }).count() > 0) {
    await page.getByText(tabName, { exact: true }).first().click()
    await page.waitForTimeout(500)
  }
  if (await h1.count() === 0) {
    const g = page.getByText(group, { exact: true })
    if (await g.count() > 0) { await g.first().click(); await page.waitForTimeout(400) }
    if (await page.getByText(tabName, { exact: true }).count() > 0) {
      await page.getByText(tabName, { exact: true }).first().click()
      await page.waitForTimeout(500)
    }
  }
  return (await h1.count()) > 0
}

const PAGE_HELPERS = `
  window.__yfeOpen = () => new Promise((res, rej) => {
    const r = indexedDB.open('youth-fantasy-engine')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  window.__longTasks = []
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) window.__longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) })
    }).observe({ entryTypes: ['longtask'] })
  } catch {}
  window.__frames = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))
`

async function enterDemoProject(page) {
  await page.goto(BASE, { waitUntil: 'load', timeout: 40000 })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步' }).click()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.waitForFunction(() => document.body.innerText.includes('工作面板'), { timeout: 120000 })
  await page.waitForTimeout(1200)
  await closeOverlays(page)
}

/**
 * 种数据：直接写示例项目的 IndexedDB（独立上下文）。
 * 60 个自定义字段的**类型按真实使用搭配**（不是 60 个纯文本）：
 * 前 30 文本 / 10 长文本 / 10 数字 / 5 单选 / 5 布尔。
 */
async function seed(page, rows, fields) {
  return page.evaluate(async ({ rows, fields }) => {
    const db = await window.__yfeOpen()
    const readAll = store => new Promise(res => {
      const r = db.transaction(store, 'readonly').objectStore(store).getAll()
      r.onsuccess = () => res(r.result)
    })
    const projects = await readAll('projects')
    const pid = projects[0].id

    const typeOf = i =>
      i < 30 ? 'text' : i < 40 ? 'longText' : i < 50 ? 'number' : i < 55 ? 'select' : 'boolean'
    const fieldDefs = Array.from({ length: fields }, (_, i) => ({
      id: `cf_cap_${i}`, label: `容量字段${String(i + 1).padStart(2, '0')}`,
      type: typeOf(i), description: `L4 容量基准字段 ${i + 1}`,
      options: typeOf(i) === 'select' ? ['甲', '乙', '丙', '丁'] : [],
      appliesTo: '*', groupId: 'extra', order: 100 + i,
      tableVisible: true, detailVisible: true, searchable: true,
      aiReadable: true, aiWritable: false, archived: false,
    }))
    const atlas = {
      formatVersion: 1, revision: 1, fields: fieldDefs, groups: [],
      builtinPresentation: {}, summaryKeys: [],
    }

    const t0 = performance.now()
    await new Promise(res => {
      const tx = db.transaction(['settingsKV', 'tableRows'], 'readwrite')
      tx.objectStore('settingsKV').put({ key: `${pid}::atlasSchema::races`, value: atlas })
      const st = tx.objectStore('tableRows')
      // 先清掉这个页签的旧行（示范项目自带少量示例行）
      const cur = st.getAll()
      cur.onsuccess = () => {
        for (const r of cur.result) {
          if (r.projectId === pid && r.tabId === 'races') st.delete(r.id)
        }
        const now = Date.now()
        for (let i = 0; i < rows; i++) {
          const data = {
            编号: `R${String(i + 1).padStart(4, '0')}`,
            名称: `条目${String(i + 1).padStart(4, '0')}`,
            上级: '', 别称: i % 5 === 0 ? `别称${i}` : '',
            保密等级: ['S', 'A', 'B', 'C'][i % 4],
            类别: ['人族', '神族', '魔族', '魔兽', '灵兽', '古族', '异种'][i % 7],
            分布区域: `分布区${i % 20}`, 威胁等级: ['无害', '低', '中', '高', '灾难级'][i % 5],
            能力特性: `特性样本${i}`,
            弱点: i % 3 === 0 ? `弱点${i}` : '',
            契约驯化关系: '', 社会结构: `结构${i % 10}`, 与主线关系: '',
            备注: i % 10 === 0 ? `长备注样本 ${i}` : '',
          }
          for (let f = 0; f < fields; f++) {
            const t = typeOf(f)
            data[`cf_cap_${f}`] =
              t === 'number' ? String((i * 7 + f) % 1000)
                : t === 'select' ? ['甲', '乙', '丙', '丁'][(i + f) % 4]
                  : t === 'boolean' ? ((i + f) % 2 === 0 ? 'true' : 'false')
                    : t === 'longText' ? `长文本样本 ${i}-${f}：这是一段用于容量测试的较长字段内容，用来观察渲染与搜索成本。`
                      : `值${i}-${f}`
          }
          st.put({
            id: `cap-${i}`, projectId: pid, tabId: 'races', data,
            order: i, createdAt: now + i, updatedAt: now + i,
          })
        }
      }
      tx.oncomplete = () => res()
      tx.onerror = () => res()
    })
    return { pid, seedMs: Math.round(performance.now() - t0), fields: fieldDefs.length, rows }
  }, { rows, fields })
}

/** 进图鉴表格并计时到 1000 行全部进 DOM */
async function openTable(page, rows) {
  const t0 = Date.now()
  const arrived = await gotoTab(page, '世界构建', '种族生物')
  let rendered = false
  try {
    await page.waitForFunction(n => document.querySelectorAll('table tbody tr').length >= n,
      rows, { timeout: 300000 })
    rendered = true
  } catch { /* 超时也把数字报出来 */ }
  const ms = Date.now() - t0
  await page.waitForTimeout(300)
  return { arrived, rendered, ms }
}

async function snap(page) {
  return page.evaluate(async () => {
    const mem = performance.memory ? performance.memory.usedJSHeapSize : 0
    const scroll = document.querySelector('[data-table-scroll]')
    return {
      nodes: document.querySelectorAll('*').length,
      rows: document.querySelectorAll('table tbody tr').length,
      cells: document.querySelectorAll('table tbody td').length,
      textareas: document.querySelectorAll('table tbody textarea').length,
      inputs: document.querySelectorAll('table tbody input').length,
      selects: document.querySelectorAll('table tbody select').length,
      scrollHeight: scroll ? scroll.scrollHeight : 0,
      heapMB: +(mem / 1048576).toFixed(1),
    }
  })
}

/** 读库：行数 / 数据体积 / 全表读取耗时 */
async function readBack(page) {
  return page.evaluate(async () => {
    const db = await window.__yfeOpen()
    const rows = await new Promise(res => {
      const r = db.transaction('tableRows', 'readonly').objectStore('tableRows').getAll()
      r.onsuccess = () => res(r.result.filter(x => x.tabId === 'races'))
    })
    const json = JSON.stringify(rows.map(r => r.data))
    const t = performance.now()
    await new Promise(res => {
      const r = db.transaction('tableRows', 'readonly').objectStore('tableRows').getAll()
      r.onsuccess = () => res()
    })
    return {
      rows: rows.length,
      jsonMB: +(new Blob([json]).size / 1048576).toFixed(2),
      readMs: Math.round(performance.now() - t),
      first: (rows.find(r => r.id === 'cap-0') || rows[0] || {}).data || null,
    }
  })
}

/** 滚动三档：顶 → 中 → 底，每档量两帧 */
async function scrollTiming(page) {
  return page.evaluate(async () => {
    const el = document.querySelector('[data-table-scroll]')
    if (!el) return null
    const samples = []
    for (const frac of [0.5, 1, 0]) {
      const t0 = performance.now()
      el.scrollTop = (el.scrollHeight - el.clientHeight) * frac
      await window.__frames()
      samples.push(Math.round(performance.now() - t0))
    }
    return { ms: samples, max: Math.max(...samples) }
  })
}

/** 表头筛选：输入唯一值 → 等到只剩 1 行；清空 → 等到恢复 */
async function filterTiming(page, rows) {
  const setFilter = value => page.evaluate(v => {
    const th = [...document.querySelectorAll('table thead th')]
      .find(t => (t.textContent || '').trim().startsWith('名称'))
    if (!th) return false
    const input = th.querySelector('input')
    if (!input) return false
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, value)

  const t1 = Date.now()
  const set = await setFilter('条目1000')
  console.log(`   [筛选] 输入已派发（${Date.now() - t1}ms），等待 1 行…`)
  let one = false
  try {
    await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 1, null, { timeout: 120000 })
    one = true
  } catch {}
  const filterMs = Date.now() - t1
  console.log(`   [筛选] 结果 ${one ? '1 行' : '超时未收敛'}（${filterMs}ms），准备清空…`)
  await page.waitForTimeout(200)

  const t2 = Date.now()
  await setFilter('')
  console.log(`   [筛选] 清空已派发，等待恢复 ${rows} 行…`)
  let back = false
  try {
    await page.waitForFunction(n => document.querySelectorAll('table tbody tr').length === n, rows, { timeout: 120000 })
    back = true
  } catch {}
  const clearMs = Date.now() - t2
  console.log(`   [筛选] 恢复 ${back ? '完成' : '超时未收敛'}（${clearMs}ms）`)
  return { set, one, filterMs, back, clearMs }
}

/** 编辑第一行第一个自定义字段：量「输入 → 重渲染完成」，再保存并回读 */
async function editTiming(page) {
  const typed = await page.evaluate(async () => {
    const ths = [...document.querySelectorAll('table thead th')]
    const idx = ths.findIndex(t => (t.textContent || '').trim().startsWith('容量字段01'))
    if (idx < 0) return null
    const tr = document.querySelector('table tbody tr')
    const td = tr ? tr.children[idx] : null
    const area = td ? td.querySelector('textarea') : null
    if (!area) return null
    const t0 = performance.now()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, '容量基准-已编辑')
    area.dispatchEvent(new Event('input', { bubbles: true }))
    await window.__frames()
    return { ms: Math.round(performance.now() - t0), value: area.value }
  })
  if (!typed) return { typed: false }
  console.log(`   [编辑] 输入完成（${typed.ms}ms），准备保存…`)

  // 超大表下 Playwright 的可操作性等待会因主线程忙而超时；直接走 DOM click（测的是应用不是动画）
  const dirty = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '保存')
    if (!btn) return null
    btn.click()
    return !btn.disabled
  })
  console.log(`   [编辑] 保存按钮 ${dirty === null ? '未找到' : (dirty ? '已点（有未保存改动）' : '已点（按钮本就禁用）')}，等待落盘…`)

  // 🔴 不能用「页面里出现『已保存』」当完成信号：应用外壳（桌面/网页版状态条）本身就常驻这四个字。
  //    直接轮询数据库里第一行目标字段，写入成功才算完 —— 这才是「保存」的语义。
  const t0 = Date.now()
  let saved = false
  for (let i = 0; i < 300; i++) {
    await page.waitForTimeout(200)
    const v = await page.evaluate(async () => {
      const db = await window.__yfeOpen()
      const row = await new Promise(res => {
        const r = db.transaction('tableRows', 'readonly').objectStore('tableRows').get('cap-0')
        r.onsuccess = () => res(r.result)
      })
      return row ? row.data['cf_cap_0'] : null
    })
    if (v === '容量基准-已编辑') { saved = true; break }
  }
  const saveMs = Date.now() - t0
  const persisted = saved
  return { typed: true, typeMs: typed.ms, saveMs, saved, persisted }
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: BROWSER_PATH,
    args: ['--no-sandbox', '--disable-gpu', '--enable-precise-memory-info'],
  })
  const result = { at: new Date().toISOString(), rows: ROWS, fields: FIELDS, samples: {} }
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
    await page.addInitScript(PAGE_HELPERS)

    console.log(`—— 进入示范项目（独立 context，样本 ${ROWS} 条 × ${FIELDS} 字段）——`)
    await enterDemoProject(page)
    console.log('   示范项目已就绪，开始种数据…')
    const seeded = await seed(page, ROWS, FIELDS)
    console.log(`   种数据完成（${seeded.seedMs}ms），准备打开表格`)
    result.seedMs = seeded.seedMs
    result.pid = seeded.pid

    const dbBefore = await readBack(page)
    result.db = { rows: dbBefore.rows, jsonMB: dbBefore.jsonMB, readMs: dbBefore.readMs }
    ok(`种子写入完成（${dbBefore.rows} 条，数据 ${dbBefore.jsonMB} MB）`, dbBefore.rows === ROWS,
      `写入 ${seeded.seedMs}ms · 全表读取 ${dbBefore.readMs}ms`)

    // ① 打开表格
    const opened = await openTable(page, ROWS)
    result.open = opened
    ok('① 进入「种族生物」并渲染全部行', opened.arrived && opened.rendered, `${opened.ms}ms`)
    const s1 = await snap(page)
    result.snapshot = s1
    console.log(`   DOM ${s1.nodes} 节点 · ${s1.rows} 行 · ${s1.cells} 单元格 · `
      + `${s1.textareas} textarea / ${s1.inputs} input / ${s1.selects} select · 堆 ${s1.heapMB} MB · `
      + `滚动高 ${s1.scrollHeight}px`)

    // ② 滚动
    const scroll = await scrollTiming(page)
    result.scroll = scroll
    ok('② 滚动三档均完成（两帧内）', !!scroll, scroll ? `${scroll.ms.join(' / ')}ms` : '未找到滚动容器')

    // ③ 编辑 + 保存 + 回读（放在筛选前：即使筛选/清空在超大表上拖慢，也已拿到主指标）
    let edit = { typed: false }
    try { edit = await editTiming(page) } catch (e) { console.log('   [编辑] 异常：' + (e && e.message)) }
    result.edit = edit
    ok('③a 单元格输入重渲染', edit.typed, edit.typed ? `${edit.typeMs}ms` : '未完成')
    ok('③b 保存并提示「已保存」', edit.saved === true, `${edit.saveMs ?? '-'}ms`)
    ok('③c 回读库：值确实落盘', edit.persisted === true)

    // ④ 切走再切回
    const back = await openTable(page, ROWS)
    result.remount = back
    ok('④ 切走再切回（重新挂载 + 重读整表）', back.rendered, `${back.ms}ms`)

    // ⑤ 筛选 / 清空（放最后：这是最重的一次「卸掉 999 行再装回来」）
    let filter = { set: false, one: false, filterMs: 0, back: false, clearMs: 0 }
    try { filter = await filterTiming(page, ROWS) } catch (e) { console.log('   [筛选] 异常：' + (e && e.message)) }
    result.filter = filter
    ok('⑤a 表头筛选到 1 行', filter.set && filter.one, `${filter.filterMs}ms`)
    ok('⑤b 清空筛选恢复全量', filter.back, `${filter.clearMs}ms`)

    const s2 = await snap(page)
    result.snapshotAfter = s2
    const tasks = await page.evaluate(() => window.__longTasks)
    result.longTasks = { count: tasks.length, max: tasks.reduce((m, t) => Math.max(m, t.dur), 0) }
    console.log(`   长任务 ${result.longTasks.count} 条 · 最长 ${result.longTasks.max}ms · 堆 ${s2.heapMB} MB`)

    ok('全程无 pageerror / console.error', errors.length === 0, errors.slice(0, 3).join(' | '))
  } catch (e) {
    result.error = String((e && e.message) || e)
    console.error('基准中断：', result.error)
    fail++
  } finally {
    await browser.close().catch(() => {})
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2))
  console.log(`\n—— 汇总 ——`)
  console.log(`打开 ${result.open ? result.open.ms + 'ms' : '-'} · 读库 ${result.db ? result.db.readMs + 'ms' : '-'} · `
    + `滚动 ${result.scroll ? result.scroll.ms.join('/') + 'ms' : '-'} · `
    + `筛选 ${result.filter ? result.filter.filterMs + 'ms' : '-'} / 清空 ${result.filter ? result.filter.clearMs + 'ms' : '-'} · `
    + `输入 ${result.edit && result.edit.typeMs != null ? result.edit.typeMs + 'ms' : '-'} · 保存 ${result.edit && result.edit.saveMs != null ? result.edit.saveMs + 'ms' : '-'} · `
    + `切回 ${result.remount ? result.remount.ms + 'ms' : '-'} · 堆 ${result.snapshot ? result.snapshot.heapMB : '-'}→${result.snapshotAfter ? result.snapshotAfter.heapMB : '-'}MB`)
  console.log(`原始数据：${OUT}`)
  console.log(`\n—— L4 容量基准：${pass} 通过 / ${fail} 失败 ——\n`)
  if (fail > 0) process.exitCode = 1
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => { console.error(e); process.exit(1) })
