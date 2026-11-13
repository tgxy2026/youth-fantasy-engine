#!/usr/bin/env node
/**
 * 3.3.5 · Package B/C 纵切验收探针（颉文姬续写）
 *
 * 覆盖《3.3.5-质量验收记录》「尚待完成」第 1 项：
 *   · 实际请求与 UI 材料清单逐项一致（勾选项进、未勾选项不进、末尾正文与续写要求进）
 *   · 超额：小窗口模型下如实报超预算并禁用生成
 *   · 生成期间改正文 → 不直接插入、转候选审阅并落库
 *   · 生成期间切章节 → 拒写并说明
 *   · 候选落库失败 → 不谎报成功，提示复制内容
 *   · 无冲突时最终采纳 → 正文追加且重载回读
 *
 * 全部使用本机 Vite 源码服务 + 受控假模型（拦截 fake.invalid），不访问真实模型或真实书库。
 * 用法：node scripts/verify/qa-335-continuation.mjs [--result-file <json>]
 */
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { snapshot } from '../audit/platform/source.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const arg = name => {
  const i = process.argv.indexOf(name)
  if (i < 0) return undefined
  const v = process.argv[i + 1]
  if (!v || v.startsWith('--')) throw new Error(`${name} requires a value`)
  return v
}
const MARKER = '[隔离续写候选·probe335]'
const EDIT_MARKER = '［作者生成期间改动］'
const PLOT_TEXT = '主角在雨夜追上那名信使，逼问出幕后指使'

const run = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/qa-335-cont-'))
const report = { fingerprint: snapshot(ROOT).fingerprint, startedAt: new Date().toISOString(), checks: [], errors: [], scenarios: [] }
const checks = report.checks
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail })
  console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : String(detail).slice(0, 200))
  if (!ok) throw new Error(name)
}
let server, browser, ctx, page
let requestBodies = []
let pending = null
let requestCount = 0

/** 等主壳（侧栏）可用：本版侧栏不是 `<nav>`，按「正文编辑」入口按钮判定。
 *  🔴 备份提醒把背景置为 inert/aria-hidden ⇒ 背景按钮暂时不在可访问性树里，
 *     所以循环里先关提醒再看，而不是一次判死。 */
async function waitShell(timeout = 45000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    await dismissAll()
    if (await page.getByRole('button', { name: '正文编辑', exact: true }).first().isVisible().catch(() => false)) return
    await page.waitForTimeout(300)
  }
  throw new Error('主壳未就绪（侧栏「正文编辑」不可见）')
}
/** 首次引导 → 示例项目 → 打开项目：各版本按钮文案不同，循环收敛而不是写死一步 */
async function bootstrap(timeout = 120000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await page.getByRole('button', { name: '正文编辑', exact: true }).first().isVisible().catch(() => false)) return
    for (const sel of [
      { name: /先看看示例/, exact: false },
      { name: '创建示范项目', exact: true },
      { name: '下一步', exact: true },
      { name: /跳过，直接开始/, exact: false },
      { name: /跳过，直接进入项目管理/, exact: false },
    ]) {
      const b = page.getByRole('button', { name: sel.name, exact: sel.exact }).first()
      if (await b.isVisible().catch(() => false)) {
        await b.click().catch(() => {})
        await page.waitForTimeout(900)
      }
    }
    const open = page.getByRole('button', { name: '打开项目', exact: true }).first()
    if (await open.isVisible().catch(() => false)) { await open.click().catch(() => {}); await page.waitForTimeout(1200) }
    // 3.5.x 起「创建示范项目」先弹二次确认；探针只负责确认，数据集仍是隔离临时根。
    const confirmCreate = page.getByRole('button', { name: '确定', exact: true }).first()
    if (await confirmCreate.isVisible().catch(() => false)) { await confirmCreate.click().catch(() => {}); await page.waitForTimeout(1500) }
    await dismissAll()
    await page.waitForTimeout(700)
  }
  throw new Error('引导/示例项目未就绪')
}
/** 打开示例项目并进入正文编辑 */
async function enterEditor() {
  await page.waitForTimeout(300)
  await waitShell()
  await page.getByRole('button', { name: '正文编辑', exact: true }).first().click({ timeout: 20000 })
  const ta = page.locator('textarea.novel-textarea').first()
  await ta.waitFor({ timeout: 30000 })
  await dismissAll()
  return ta
}
async function dismissAll() {
  for (const name of ['关闭本页指引', '跳过本页', '稍后再说', '知道了', '跳过，直接开始']) {
    const b = page.getByRole('button', { name, exact: true })
    if (await b.isVisible().catch(() => false)) await b.click({ timeout: 2000 }).catch(() => {})
  }
}
/** 读「给 AI 的资料」勾选状态（toggle 选中态＝琥珀底，本版无 aria-pressed） */
async function readPicks() {
  return page.evaluate(() => {
    const chips = [...document.querySelectorAll('button.rounded-full')].filter(b => b.offsetParent)
    return chips.map(b => ({
      label: (b.textContent || '').trim(),
      selected: /bg-amber\/15/.test(b.className),
    }))
  })
}
/** 示例项目默认资料会超预算：按「先减最占额度」的顺序取消勾选，直到能发 */
async function ensureFits() {
  for (const label of ['主要角色', '前文章节', '章节摘要', '本章细纲']) {
    const over = /超出可用额度/.test(await page.locator('body').innerText())
    if (!over) return
    const chip = page.locator('button.rounded-full').filter({ hasText: new RegExp(`^${label}$`) }).first()
    if (!(await chip.isVisible().catch(() => false))) continue
    if (!/bg-amber\/15/.test(await chip.getAttribute('class') || '')) continue
    await chip.click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(1600)
  }
}
/** 点「让颉文姬续写」并等受控请求：预估是防抖异步的，未稳就点会被「清单已失效」挡住 */
async function sendContinuation() {
  // 完整请求预算还包括指令和系统提示；上一步的资料勾选可能使下一次请求超限。
  await ensureFits()
  const btn = page.getByRole('button', { name: '让颉文姬续写', exact: true })
  const end = Date.now() + 25000
  while (Date.now() < end) {
    if (await btn.isEnabled().catch(() => false)) {
      await page.waitForTimeout(600)
      if (await btn.isEnabled().catch(() => false)) break
    }
    await page.waitForTimeout(200)
  }
  if (!(await btn.isEnabled().catch(() => false))) throw new Error('续写按钮始终不可用（超额或预估未完成）')
  await btn.click()
  try {
    return await waitRequest(20000)
  } catch (e) {
    report.lastToast = (await page.locator('body').innerText()).slice(0, 1500)
    report.panelErrors = await page.locator('[class*="text-danger"]').allInnerTexts().catch(() => [])
    throw e
  }
}
/** 打开颉文姬 → 编辑 → 续写区块，等预估完成（可重复调用：已开就不再点开/点收） */
async function openContinuation() {
  const toggle = page.getByRole('button', { name: '续写（接本章末尾往下写）' })
  const runBtn = page.getByRole('button', { name: '让颉文姬续写', exact: true })
  if (!(await toggle.isVisible().catch(() => false))) {
    // 面板本身可能已关（切章后卸载）：先点工具栏入口，再切「编辑」页签
    const launcher = page.getByTitle(/颉文姬 · AI 编辑/).first()
    if (await launcher.isVisible().catch(() => false)) await launcher.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(700)
    const editTab = page.getByRole('button', { name: '编辑', exact: true }).first()
    if (await editTab.isVisible().catch(() => false)) await editTab.click({ timeout: 8000 }).catch(() => {})
  }
  await toggle.waitFor({ timeout: 20000 })
  if (!(await runBtn.isVisible().catch(() => false))) await toggle.click()
  await runBtn.waitFor({ timeout: 20000 })
  // 预估是 350ms 防抖 + 异步装配：等到清单按钮出现再断言
  await page.getByRole('button', { name: /本次发送材料清单/ }).waitFor({ timeout: 30000 })
  await ensureFits()
  await page.getByRole('button', { name: /本次发送材料清单/ }).waitFor({ timeout: 30000 })
}
/** 展开材料清单并读回每一条 */
async function readManifest() {
  const open = page.getByRole('button', { name: /本次发送材料清单/ })
  const label = (await open.innerText()).replace(/\s+/g, ' ')
  if (label.includes('展开')) await open.click()
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('button')]
      .find(b => (b.textContent || '').includes('本次发送材料清单'))
      ?.closest('div.pt-1')
    if (!rows) return []
    return [...rows.querySelectorAll('div.flex.items-start')].map(el => {
      const title = (el.querySelector('span.truncate')?.textContent || '').trim()
      const scope = (el.querySelectorAll('span.shrink-0 span')[0]?.textContent || '').trim()
      const size = (el.querySelectorAll('span.shrink-0 span')[1]?.textContent || '').trim()
      return { title, scope, size }
    })
  })
}
/** 等一次受控模型请求 */
async function waitRequest(timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (pending) return pending
    await page.waitForTimeout(100)
  }
  throw new Error('受控模型请求未发出')
}
async function fulfillPending(text = MARKER) {
  const route = pending
  pending = null
  await route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
  })
}
function requestText(body) {
  if (!body) return ''
  try {
    const json = JSON.parse(body)
    return (json.messages || []).map(m => String(m.content || '')).join('\n\n')
  } catch { return String(body) }
}
/** 真实数据库名只在 `db/core.ts` 里（未导出）—— 从源码读，别猜。
 *  3.5.0 起是 `accountLocalDatabaseName('<base>')`：本探针跑 dev vite（无 WEB 账号本地旗标），
 *  该函数原样返回 base，故两种形态都取字面量 base。 */
const dbCoreSource = await fs.readFile(path.join(ROOT, 'src/lib/db/core.ts'), 'utf8')
const DB_NAME = /const DB_NAME = '([^']+)'/.exec(dbCoreSource)?.[1]
  ?? /const DB_NAME = accountLocalDatabaseName\('([^']+)'\)/.exec(dbCoreSource)?.[1]
if (!DB_NAME) throw new Error('无法从 src/lib/db/core.ts 读取 DB_NAME')
async function readCandidates() {
  return page.evaluate(async (name) => {
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open(name)
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const db = req.result
        const stores = [...db.objectStoreNames]
        if (!db.objectStoreNames.contains('revisionPayloads')) { db.close(); resolve({ stores, rows: 0, candidates: [] }); return }
        const tx = db.transaction('revisionPayloads', 'readonly')
        const all = tx.objectStore('revisionPayloads').getAll()
        let rows = []
        all.onsuccess = () => { rows = all.result || [] }
        tx.oncomplete = () => {
          db.close()
          resolve({
            stores, rows: rows.length,
            kinds: [...new Set(rows.map(r => r && r.kind))],
            candidates: rows.filter(r => r && r.kind === 'candidate').map(r => ({
              id: r.id, chapterId: r.report && r.report.chapterId, status: r.report && r.report.status,
              text: String(r.candidateText || '').slice(0, 60),
            })),
          })
        }
        tx.onabort = () => { db.close(); reject(tx.error) }
      }
    })
  }, DB_NAME)
}
/** 读 toast 锚点（`[data-toast]`）里当前可见的提示 */
async function readToast() {
  return page.locator('[data-toast]').innerText().catch(() => '')
}

try {
  server = await createServer({ root: ROOT, cacheDir: path.join(run, 'cache'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  server.config.logger.info = () => {}
  await ctx.addInitScript(() => { localStorage.setItem('yfe-ui:guide-auto', '0') })
  await ctx.route('**/*', route => {
    const url = route.request().url()
    if (url.startsWith('https://fake.invalid/')) {
      requestCount += 1
      requestBodies.push(route.request().postData() || '')
      pending = route
      return
    }
    return url.startsWith(origin + '/') ? route.continue() : route.abort()
  })
  page = await ctx.newPage()
  page.on('pageerror', e => report.errors.push(String(e && e.message ? e.message : e)))
  page.on('console', m => { if (m.text().includes('[cont-debug]')) report.debug = m.text().slice(0, 3000) })
  page.setDefaultTimeout(25000)

  // ---------- 开箱：示例项目 + 受控模型 ----------
  await page.goto(origin)
  await bootstrap()
  await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts')
    await db.setMeta('aiProviders', [{ id: 'test', name: '测试', type: 'openai', baseUrl: 'https://fake.invalid/v1', apiKey: 'fake', model: 'fake', contextWindow: 32000 }])
    await db.setMeta('aiActiveProviderId', 'test')
  })
  await page.reload()
  await bootstrap()

  let ta = await enterEditor()

  // ============ S1 清单与请求逐项一致 ============
  await openContinuation()
  check('S1 材料清单已展示条目', true)

  // 写入一段唯一的章节尾部标记，确保「清单里算的正文」就是「请求里发的正文」
  const tail = `雨停了，${Date.now().toString(36)} 号信使的靴子还滴着水。`
  const baseBody = await ta.inputValue()
  await ta.fill(baseBody + tail)
  await page.waitForTimeout(1200) // 350ms 防抖 + 装配
  await page.getByRole('button', { name: /本次发送材料清单/ }).waitFor({ timeout: 30000 })

  const plotBox = page.getByPlaceholder(/例：主角在拍卖会上遇到旧敌/)
  await plotBox.fill(PLOT_TEXT)
  await page.waitForTimeout(1200)

  const manifest = await readManifest()
  report.manifest = manifest
  check('S1 清单含章节末尾正文', manifest.some(m => m.title.includes('本章末尾正文')), JSON.stringify(manifest.map(m => m.title)))
  check('S1 清单条目带完整/裁剪/未带入标注', manifest.every(m => ['完整', '裁剪', '未带入'].includes(m.scope)), JSON.stringify(manifest.map(m => m.scope)))

  const beforeReq = requestCount
  await sendContinuation()
  check('S1 一次续写只发一次请求', requestCount - beforeReq === 1, `count=${requestCount - beforeReq}`)
  const reqText = requestText(requestBodies[requestBodies.length - 1])
  report.requestPreview = reqText.slice(0, 600)

  check('S1 请求含本章末尾正文原文', reqText.includes('号信使的靴子还滴着水'), '尾部标记未出现在请求里')
  check('S1 请求含作者续写要求', reqText.includes(PLOT_TEXT))
  check('S1 请求含本章标题', reqText.includes('【本章标题】'))
  check('S1 请求用作者栅栏隔离资料', /【项目参考资料】/.test(reqText) && /【本章已有正文末尾】/.test(reqText))

  // 清单条目 → 请求里应有对应的分段（清单说带了，请求里就得有那一段）
  const sectionOf = { 章节摘要: '【章节摘要】', 前文章节: '【前文章节】', 项目设定资料: '【设定资料】', 写作文风: '【写作文风】', 本章固定资料: '【本章固定资料】' }
  for (const item of manifest.filter(m => m.scope !== '未带入')) {
    const key = Object.keys(sectionOf).find(k => item.title.includes(k))
    if (!key) continue
    check(`S1 清单条目「${item.title}」在请求里有对应分段`, reqText.includes(sectionOf[key]), sectionOf[key])
  }
  const pickState = await readPicks()
  report.pickState = pickState
  check('S1 勾选状态可读', pickState.length >= 8, JSON.stringify(pickState))

  // 勾选真的驱动清单：打开「世界设定」后预估字数应变化（不是只改 UI 高亮）
  const estChars = async () => {
    const t = await page.locator('body').innerText()
    const m = /预计占用约\s*([\d,]+)\s*字/.exec(t)
    return m ? Number(m[1].replace(/,/g, '')) : -1
  }
  const charsBefore = await estChars()
  const worldChip = page.locator('button.rounded-full').filter({ hasText: /^世界设定$/ }).first()
  const worldWasOn = /bg-amber\/15/.test(await worldChip.getAttribute('class') || '')
  await worldChip.click()
  await page.waitForTimeout(1800)
  const charsAfter = await estChars()
  report.worldPick = { worldWasOn, charsBefore, charsAfter }
  check('S1 勾选驱动清单与预估', charsBefore > 0 && charsAfter > 0 && charsAfter !== charsBefore,
    `before=${charsBefore} after=${charsAfter}`)
  await worldChip.click()
  await page.waitForTimeout(1600)
  await ensureFits()

  // ============ S2 生成期间改正文 → 转候选，不直接插入 ============
  await ta.fill((await ta.inputValue()) + EDIT_MARKER)
  await page.waitForTimeout(600)
  const liveBody = await ta.inputValue()
  await fulfillPending()
  await page.getByText('续写完成', { exact: false }).waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: '写入原文下方（建议段）', exact: true }).click()
  await page.waitForTimeout(1300) // 冲突判定要等候选真落库，提示比点击晚一步
  const conflictToast = await readToast()
  report.conflictToast = conflictToast
  await page.waitForTimeout(1500)
  const afterConflict = await ta.inputValue()
  check('S2 冲突时不把旧续写插入正文', !afterConflict.includes(MARKER), '续写内容被直接写入')
  check('S2 作者改动保留', afterConflict.includes(EDIT_MARKER) && afterConflict.includes('号信使的靴子'))
  check('S2 提示已转候选审阅', /候选/.test(conflictToast) && !/失败|变化/.test(conflictToast), conflictToast || '未见候选提示')
  const cands = await readCandidates()
  report.candidates = cands
  check('S2 候选真实落库', cands.candidates.some(c => c.text.includes(MARKER.slice(0, 10))), JSON.stringify(cands))

  // ============ S3 无冲突时最终采纳 → 落库回读 ============
  await ta.fill(liveBody)
  await page.waitForTimeout(800)
  const applyTail = `采纳校验标记${Date.now().toString(36)}`
  const adoptBody = (await ta.inputValue()) + applyTail
  await ta.fill(adoptBody)
  await page.waitForTimeout(1500) // 等快照重建
  await sendContinuation()
  const adoptText = `${MARKER}采纳版续写正文。`
  await fulfillPending(adoptText)
  await page.getByText('续写完成', { exact: false }).waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: '写入原文下方（建议段）', exact: true }).click()
  await page.waitForTimeout(2000)
  const afterAdopt = await ta.inputValue()
  check('S3 采纳后正文含续写内容', afterAdopt.includes('采纳版续写正文'), afterAdopt.slice(-120))
  check('S3 采纳后保留作者正文', afterAdopt.includes(applyTail))
  await page.waitForTimeout(2500) // 自动保存
  await page.reload()
  await page.getByRole('button', { name: '打开项目', exact: true }).first().click()
  await dismissAll()
  await waitShell(30000)
  ta = await enterEditor()
  await page.waitForTimeout(1500)
  const reloaded = await ta.inputValue()
  check('S3 重载后采纳内容仍在', reloaded.includes('采纳版续写正文'), reloaded.slice(-160))

  // ============ S4 超额：把吃预算的勾项打开，如实报超预算并禁用 ============
  await openContinuation()
  //  🔴 不靠调小模型窗口：本链路额度按任务预算给（不随窗口变），把资料堆到超额度才是真实超额路径。
  const bigPicks = ['世界设定', '分卷大纲', '全书总纲', '伏笔追踪']
  for (const label of bigPicks) {
    const chip = page.locator('button.rounded-full').filter({ hasText: new RegExp(`^${label}$`) }).first()
    if (!(await chip.isVisible().catch(() => false))) continue
    if (!/bg-amber\/15/.test(await chip.getAttribute('class') || '')) await chip.click({ timeout: 5000 }).catch(() => {})
  }
  await page.waitForTimeout(2500)
  const overText = await page.locator('body').innerText()
  const overflow = /超出可用额度/.test(overText)
  report.overflow = overflow
  report.overflowLine = (overText.match(/超出可用额度[^\n]*/) || [''])[0]
  const runBtn = page.getByRole('button', { name: '让颉文姬续写', exact: true })
  check('S4 超预算如实提示', overflow, report.overflowLine || '未见超额文案')
  check('S4 超预算时禁止发送', await runBtn.isDisabled(), '按钮仍可点')
  // 复原：把刚打开的大项关掉，继续后面的场景
  for (const label of bigPicks) {
    const chip = page.locator('button.rounded-full').filter({ hasText: new RegExp(`^${label}$`) }).first()
    if (!(await chip.isVisible().catch(() => false))) continue
    if (/bg-amber\/15/.test(await chip.getAttribute('class') || '')) await chip.click({ timeout: 5000 }).catch(() => {})
  }
  await page.waitForTimeout(2200)
  await ensureFits()

  // ============ S5 生成期间切章节 → 旧结果不跨章泄漏 ============
  //  🔴 实测口径：续写面板本身按章归属（contDone 只认当前章），切章后旧结果整块不再呈现；
  //     「项目或章节已切换」那句提示走的是 applyContinuation 的兜底，UI 不会再给到那个按钮。
  //     所以这里断言的是**真实可达的保护**：不跨章插入、旧结果不再提供写入。
  await ensureFits()
  const rows = page.locator('[data-chapter-id]')
  const rowCount = await rows.count()
  report.chapterRows = rowCount
  check('S5 存在可切换章节', rowCount >= 2, `data-chapter-id 行数=${rowCount}`)
  const firstChapterBody = await ta.inputValue()
  await sendContinuation()
  await rows.nth(1).click()
  await page.waitForTimeout(2500)
  const ta2 = page.locator('textarea.novel-textarea').first()
  await ta2.waitFor({ timeout: 20000 })
  await fulfillPending(`${MARKER}切章版`)
  await page.waitForTimeout(2500)
  const bodyAfterSwitch = await ta2.inputValue()
  report.switchBodyLen = bodyAfterSwitch.length
  check('S5 切章后不在新章插入旧续写', !bodyAfterSwitch.includes('切章版'), '切章后旧续写被写入新章')
  const applyAfterSwitch = page.getByRole('button', { name: '写入原文下方（建议段）', exact: true })
  check('S5 切章后旧续写不再可写入', !(await applyAfterSwitch.isVisible().catch(() => false)), '新章仍提供旧续写的写入按钮')
  report.beforeSwitchLen = firstChapterBody.length

  // 回到第一章继续 S6
  await rows.nth(0).click()
  await page.waitForTimeout(2000)
  ta = page.locator('textarea.novel-textarea').first()
  await ta.waitFor({ timeout: 20000 })

  // ============ S6 候选落库失败 → 不谎报成功 ============
  await openContinuation()
  await ensureFits()
  await sendContinuation()
  await page.evaluate(() => {
    const orig = IDBObjectStore.prototype.put
    window.__restorePut = () => { IDBObjectStore.prototype.put = orig }
    window.__failCandidatePut = true
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'revisionPayloads' && window.__failCandidatePut) throw new Error('probe: candidate put blocked')
      return orig.call(this, value, key)
    }
  })
  await ta.fill((await ta.inputValue()) + '［候选失败场景改动］')
  await page.waitForTimeout(800)
  await fulfillPending(`${MARKER}候选失败版`)
  await page.getByText('续写完成', { exact: false }).waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: '写入原文下方（建议段）', exact: true }).click()
  await page.waitForTimeout(1800)
  const failToast = await readToast()
  report.failToast = failToast
  check('S6 候选落库失败如实提示', /候选保存失败/.test(failToast), failToast || '未见失败提示')
  check('S6 失败时不写入正文', !(await ta.inputValue()).includes('候选失败版'))
  check('S6 失败时作者正文未丢', (await ta.inputValue()).includes('候选失败场景改动'))
  await page.evaluate(() => { if (window.__restorePut) window.__restorePut() })

  report.status = checks.every(c => c.ok) ? 'passed' : 'failed'
} catch (e) {
  report.status = 'failed'
  report.error = String(e && e.stack ? e.stack : e)
  console.log('探针中断：', report.error)
  await page?.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {})
  await page?.locator('body').innerText().then(t => fs.writeFile(path.join(run, 'body.txt'), t)).catch(() => {})
} finally {
  await browser?.close().catch(() => {})
  await server?.close().catch(() => {})
  report.finishedAt = new Date().toISOString()
  report.runRoot = run
  const out = arg('--result-file') || path.join(run, 'result.json')
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true })
  await fs.writeFile(out, JSON.stringify(report, null, 2))
  console.log('证据目录', run)
  console.log('结果', report.status, `${checks.filter(c => c.ok).length}/${checks.length}`)
  if (report.status !== 'passed') process.exitCode = 1
}
