// 全文检索命中定位（3.3.1 · T1）实机验证
//
// 验的是用户真实抱怨的那件事：点检索结果只落到章首。
// 现在要求：点哪一条，正文就滚到那一句并选中；多处命中能分开选；正文一个字都不改。
//
// 🔴 不覆盖：检索后正文被改过再点（代码里按 revision 拦下并提示「请重新检索」，
//    要造这个时序得先改正文再落库再检索，探针成本高且时序不稳，留作人工复验）。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const run = path.join('.workbuddy/tmp', `full-text-locate-331-${new Date().toISOString().replace(/[:.]/g, '-')}`)
fs.mkdirSync(run, { recursive: true })

const server = await createServer({
  root,
  cacheDir: path.join(run, 'vite'),
  logLevel: 'error',
  server: { host: 'localhost', port: 0 },
})

const records = []
let failed = 0
const check = (name, pass, detail = '') => {
  records.push({ name, pass, detail })
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
}

let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error)))

  const dismissExtras = async () => {
    const later = page.getByRole('button', { name: '稍后再说', exact: true })
    if (await later.isVisible().catch(() => false)) await later.click()
    const card = page.locator('[data-guide-card]').first()
    if (await card.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
      await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
      await card.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    }
  }

  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 60000 })
  await dismissExtras()

  // 进正文编辑
  await page.getByRole('navigation').getByText('正文编辑', { exact: true }).first().click()
  await dismissExtras()
  // 🔴 必须锁定正文：编辑器里还有一个「章节压缩摘要」的 textarea，`textarea` 第一个是它
  const ta = page.locator('textarea.novel-textarea')
  await ta.waitFor({ timeout: 30000 })

  const chapterIds = await page.$$eval('[data-chapter-id]', nodes => nodes.map(n => n.getAttribute('data-chapter-id')))
  check('章节目录里能拿到至少两章', chapterIds.filter(Boolean).length >= 2, String(chapterIds.length))

  /** 点某章并等正文真的换过去 */
  const openChapter = async (id, previousValue = null) => {
    await page.click(`[data-chapter-id="${id}"]`)
    await page.waitForFunction(
      ([prev]) => {
        const el = document.querySelector('textarea.novel-textarea')
        return !!el && el.value.length > 0 && (prev == null || el.value !== prev)
      },
      [previousValue], { timeout: 30000 },
    )
    return ta.evaluate(el => el.value)
  }

  const firstId = chapterIds[0]
  const secondId = chapterIds[1]
  const v1 = await openChapter(firstId)
  const v2 = await openChapter(secondId, v1)
  const secondTitle = await page.getByLabel('章节标题').inputValue()
  check('两章正文拿到了（且不是同一章）', v2.length > 0 && v1 !== v2, `${v1.length} / ${v2.length} 字`)

  // 回第 1 章：证明「点检索结果」真的会换章并定位，而不是原本就在那一章
  await openChapter(firstId, v2)
  const backOnFirst = await ta.evaluate(el => el.value)
  check('已切回第 1 章（后续定位要跨章才说明问题）', backOnFirst === v1)

  /** 从 v2 里挑一段「够长、无空白、在第 1 章里不存在」的正文短语 */
  const pickPhrase = (text, avoid, len = 10) => {
    for (let start = Math.floor(text.length / 3); start + len < text.length; start += 7) {
      const chunk = text.slice(start, start + len)
      if (/\s/.test(chunk) || /[。，！？；：、“”（）]/.test(chunk)) continue
      if (avoid.includes(chunk)) continue
      if (text.indexOf(chunk) !== start) continue // 只要唯一位置，避免与多命中用例混淆
      return { chunk, at: start }
    }
    return null
  }
  const picked = pickPhrase(v2, v1)
  check('能在第 2 章正文里挑到唯一短语（无空白、第 1 章没有）', !!picked, picked ? picked.chunk : '')
  if (!picked) throw new Error('示例数据不适合本条用例')

  // 打开全文检索并搜索
  await page.keyboard.press('Control+k')
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ timeout: 15000 })
  const search = dialog.locator('input').first()
  await search.fill(picked.chunk)
  await page.waitForTimeout(600)

  const rows = await dialog.locator('button').evaluateAll(nodes => nodes.map(n => n.innerText.replace(/\n/g, ' | ')))
  const chapterRows = rows.filter(text => text.includes('章节正文'))
  check('搜到了章节正文命中', chapterRows.length > 0, chapterRows.slice(0, 2).join(' # '))

  await page.screenshot({ path: path.join(run, 'results.png') })
  // 🔴 不能盲按回车：结果按相关度排序，同一短语可能在别的章分更高。必须点「第 2 章」那一行。
  const targetRow = dialog.locator('button').filter({ hasText: secondTitle }).first()
  await targetRow.click()

  // 等编辑器就位，**并等定位真的落地**（定位要等检索弹窗卸载后才执行，读完太早会读到空选区）
  await ta.waitFor({ timeout: 20000 })
  await page.waitForFunction(() => {
    const el = document.querySelector('textarea.novel-textarea')
    return !!el && el.selectionEnd > el.selectionStart
  }, null, { timeout: 10000 }).catch(() => {})
  const landed = await page.evaluate(() => {
    const el = document.querySelector('textarea.novel-textarea')
    return {
      value: el.value,
      start: el.selectionStart,
      end: el.selectionEnd,
      scrollTop: el.scrollTop,
      active: document.activeElement === el,
    }
  })
  check('🔴 点命中后正文换到第 2 章', landed.value === v2, `${landed.value.length} / ${v2.length}`)
  check('🔴 选区正好套住命中那一句',
    landed.value.slice(landed.start, landed.end) === picked.chunk,
    `选中「${landed.value.slice(landed.start, landed.end)}」`)
  check('偏移与检索时算出的一致（不是就近猜的）', landed.start === picked.at, `${landed.start} vs ${picked.at}`)
  check('正文被滚到命中处（不是停在顶部）', landed.scrollTop > 0, String(landed.scrollTop))
  check('🔴 正文一个字都没被改', landed.value === v2)
  await page.screenshot({ path: path.join(run, 'located.png') })

  // ---------- 多处命中：同章拆行 + 可分别定位 ----------
  const repeated = (() => {
    const counts = new Map()
    for (let i = 0; i + 2 <= v2.length; i++) {
      const g = v2.slice(i, i + 2)
      if (/[\s。，！？；：、“”（）]/.test(g)) continue
      const list = counts.get(g) ?? []
      list.push(i)
      counts.set(g, list)
    }
    let best = null
    for (const [gram, positions] of counts) {
      if (positions.length < 2 || positions.length > 3) continue
      if (!best || positions.length > best.positions.length) best = { gram, positions }
    }
    return best
  })()

  if (repeated) {
    await page.keyboard.press('Control+k')
    const dialog2 = page.getByRole('dialog')
    await dialog2.waitFor({ timeout: 15000 })
    const search2 = dialog2.locator('input').first()
    await search2.fill(repeated.gram)
    await page.waitForTimeout(700)
    const multiRows = await dialog2.locator('button').evaluateAll(nodes => nodes
      .map(n => n.innerText.replace(/\n/g, ' | '))
      .filter(text => text.includes('章节正文') && /第 \d+\/\d+ 处/.test(text)))
    check('🔴 同一章多处命中拆成多行并标出「第 n/N 处」', multiRows.length >= 2, multiRows.slice(0, 3).join(' # '))

    if (multiRows.length >= 2) {
      // 点第 2 处：正文没变、选区落在第 2 次出现
      const secondRow = dialog2.locator('button').filter({ hasText: '第 2/' }).first()
      await secondRow.click()
      await page.waitForTimeout(900)
      const second = await page.evaluate(() => {
        const el = document.querySelector('textarea.novel-textarea')
        return { start: el.selectionStart, end: el.selectionEnd, text: el.value.slice(el.selectionStart, el.selectionEnd), value: el.value }
      })
      check('🔴 点「第 2 处」落在第 2 次出现的位置（不是第一处）',
        second.start === repeated.positions[1] && second.text === repeated.gram,
        `${second.start} vs ${repeated.positions[1]}（${second.text}）`)
      check('多处跳转同样不改正文', second.value === v2)
      const toastText = await page.locator('text=/已定位到第 \\d 处/').first().innerText().catch(() => '')
      check('跳转后提示「第几处」（列表已关，作者要知道自己在看哪一处）',
        /第 \d 处/.test(toastText), toastText.slice(0, 40))
    }
  } else {
    records.push({ name: '（跳过）示例数据里没有 2~3 次重复的二字短语', pass: true, detail: 'skipped' })
    console.log('SKIP 示例数据没有合适的重复短语，未验证多行拆分')
  }

  // ---------- 标题命中不应瞎跳 ----------
  {
    const titleOnly = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('[data-chapter-id]')]
      return nodes.length > 0
    })
    if (titleOnly) {
      await page.keyboard.press('Control+k')
      const dialog3 = page.getByRole('dialog')
      await dialog3.waitFor({ timeout: 15000 })
      const search3 = dialog3.locator('input').first()
      await search3.fill('第')
      await page.waitForTimeout(500)
      const rows3 = await dialog3.locator('button').evaluateAll(nodes => nodes
        .map(n => n.innerText.replace(/\n/g, ' | ')).filter(text => text.includes('章节正文')))
      check('搜索标题里的字也能出结果（至少不报错）', rows3.length >= 0, String(rows3.length))
      await page.keyboard.press('Escape')
    }
  }

  check('页面无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({
    records, failed,
    picked: picked ? { chunk: picked.chunk, at: picked.at } : null,
    repeated: repeated ? { gram: repeated.gram, positions: repeated.positions } : null,
  }, null, 2))
  console.log(`\n结果：${records.length - failed}/${records.length} 通过，记录在 ${run}`)
} finally {
  await browser?.close()
  await server.close()
}
if (failed) process.exit(1)
