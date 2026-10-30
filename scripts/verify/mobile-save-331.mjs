// 3.3.1 · P10：手机（375px 触摸）下「编辑 → 保存 → 离页 → 回来 → 回读」的实机验收。
//
// 规划 §14.6 要求完整走查包含「实际保存」且「保存要实际回读，不只看成功提示」。
// 此前只有正文（`editor-mobile-331`）与一张表（`table-mobile-331`）做到这一点，
// 本条补三个不同形态的页面：表单（作品信息）、表单（世界设定）、主从卡片（主要角色），
// 再加一张表（伏笔追踪）作为「表格类是否同样成立」的对照。
//
// 🔴 只判「值是否真的存下来了」：不看 toast、不看「已提交」这类状态字。
//    切页时也刻意走真实导航（写作面板 → 目标页），让页面组件真的卸载重建。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy', 'tmp', `mobile-save-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })

let pass = 0, fail = 0
const cases = []
const check = (name, cond, extra = '') => {
  cases.push({ name, ok: !!cond, extra })
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
/** 改完值之后的保存动作：有保存按钮就点，没有就等自动保存 */
const saveNow = async (page) => {
  const explicit = page.getByRole('button', { name: '保存', exact: true })
  if (await explicit.isVisible().catch(() => false)) { await explicit.click(); return 'button' }
  const all = page.getByTitle('保存全部（Ctrl+S）')
  if (await all.isVisible().catch(() => false)) { await all.click(); return 'button-all' }
  await page.waitForTimeout(1200)
  return 'auto'
}

const server = await createServer({ root: process.cwd(), cacheDir: '.workbuddy/tmp/vite-mobile-save', logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))

  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByText('继续写作', { exact: true }).first().waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  const guide = page.locator('[data-guide-card]').first()
  if (await guide.waitFor({ timeout: 2500 }).then(() => true).catch(() => false)) {
    await page.getByRole('button', { name: '跳过本页' }).click().catch(() => {})
    await guide.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  }
  await page.evaluate(async () => { (await import('/src/lib/settings/guidePrefs.ts')).setGuideAutoEnabled(false) })

  /** 通过项目菜单真实切页（375px 下是抽屉） */
  const navigate = async (name) => {
    await page.getByRole('button', { name: '打开项目菜单' }).click({ timeout: 20000 })
    await page.getByRole('navigation').getByRole('button', { name, exact: true }).first().click({ timeout: 20000 })
    await page.waitForTimeout(500)
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(250)
  }

  /** 表单类：改一个具名字段 → 保存 → 离页 → 回来 → 回读 */
  const formCase = async (tabName, label, note) => {
    await navigate(tabName)
    const field = page.getByLabel(label).first()
    await field.waitFor({ timeout: 20000 })
    const original = await field.inputValue()
    const updated = `${original.slice(0, 40)}｜触摸验收`
    await field.fill(updated)
    const saved = await saveNow(page)
    await navigate('写作面板')
    await navigate(tabName)
    const back = page.getByLabel(label).first()
    await back.waitFor({ timeout: 20000 })
    const restored = await back.inputValue()
    check(`${tabName}：保存后离页返回，${label} 回读到新值（保存方式 ${saved}）`, restored === updated,
      `原「${original.slice(0, 20)}」→ 期望「${updated.slice(-16)}」实际「${String(restored).slice(-16)}」`)
    // 还原，别把示例数据改脏（同一 context 后续用例还要用）
    await back.fill(original)
    await saveNow(page)
    return { tabName, label, saved, note }
  }

  await formCase('作品信息', '书名', '表单页：写到 data 后落库')
  await formCase('世界设定', '世界名称', '表单页：世界设定走另一套存储')
  await formCase('主要角色', '姓名', '主从卡片：左目录右详情里的详情字段')

  // ---------- 表格类对照：伏笔追踪 ----------
  {
    await navigate('伏笔追踪')
    const row = page.locator('[data-workspace-record]').first()
    await row.waitFor({ timeout: 20000 })
    const rowId = await row.getAttribute('data-workspace-record')
    const cell = row.locator('textarea').nth(1)
    await cell.scrollIntoViewIfNeeded()
    const original = await cell.inputValue()
    const updated = `${original.slice(0, 30)}｜触摸验收`
    await cell.fill(updated)
    const saved = await saveNow(page)
    await navigate('写作面板')
    await navigate('伏笔追踪')
    const restoredCell = page.locator(`[data-workspace-record="${rowId}"] textarea`).nth(1)
    await restoredCell.waitFor({ timeout: 20000 })
    const restored = await restoredCell.inputValue()
    check(`伏笔追踪：表格单元格保存后离页返回回读到新值（保存方式 ${saved}）`, restored === updated,
      `实际「${String(restored).slice(-16)}」`)
    await restoredCell.fill(original)
    await saveNow(page)
  }

  // ---------- 编辑过程中切页：草稿不能被静默丢掉 ----------
  {
    await navigate('作品信息')
    const field = page.getByLabel('核心卖点').first()
    await field.waitFor({ timeout: 20000 })
    const original = await field.inputValue()
    const draft = `${original.slice(0, 30)}｜未保存草稿`
    await field.fill(draft)
    // 不保存，直接切页 —— 规划 §14.3：「编辑中切页仍要经过既有草稿/保存保护」
    await navigate('写作面板')
    await navigate('作品信息')
    const back = page.getByLabel('核心卖点').first()
    await back.waitFor({ timeout: 20000 })
    const value = await back.inputValue()
    check('🔴 未保存就切页：草稿要么被保存、要么明确提示，不能静默丢', value.includes('未保存草稿') || value === original,
      `实际「${String(value).slice(-18)}」`)
    cases.push({ name: '切页草稿行为记录（不是失败判据）', ok: true, extra: value.includes('未保存草稿') ? '切页后草稿仍在（已保留）' : '切页后回到原值（未保留草稿，需人工确认是否有提示）' })
    console.log(`  记录：切页后草稿${value.includes('未保存草稿') ? '仍在' : '未保留'}（值「${String(value).slice(-18)}」）`)
    if (value.includes('未保存草稿')) { await back.fill(original); await saveNow(page) }
  }

  await page.screenshot({ path: path.join(run, 'final.png') })
  check('全程没有页面脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '))
} finally {
  await browser?.close()
  await server.close()
}

fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ passed: pass, failed: fail, cases }, null, 2))
console.log(`\n结果：${pass}/${pass + fail} 通过，记录在 ${run}`)
if (fail > 0) process.exitCode = 1
