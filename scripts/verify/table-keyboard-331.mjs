// 设定表 · 方向键端到端（3.3.1 · §8）
//
// 验的是「真的按键之后焦点去了哪」，不是看代码里有没有写：
//   ① 在单元格里按 ↓ ⇒ 焦点落到**下一行的同一列**（不是页面上随便一个控件）；
//   ② 按 ↑ 能回来；
//   ③ 到底行再按 ↓ ⇒ 焦点不动（交回浏览器，不循环）；
//   ④ 全程没有改动任何单元格的值（跳行不能顺手改数据）；
//   ⑤ 0 页面脚本错误。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const run = path.join('.workbuddy/tmp', `table-keyboard-331-${stamp}`)
fs.mkdirSync(run, { recursive: true })

const report = { kind: 'table-keyboard-331', at: new Date().toISOString(), run, checks: [], errors: [] }
let failed = 0
const check = (name, pass, detail = '') => {
  report.checks.push({ name, pass: !!pass, detail })
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const server = await createServer({
  root,
  cacheDir: path.join('.workbuddy/tmp', `vite-table-keyboard-${stamp}`),
  logLevel: 'error',
  server: { host: 'localhost', port: 0 },
})

let browser
try {
  await server.listen()
  const origin = `http://localhost:${server.httpServer.address().port}`
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => (route.request().url().startsWith(origin + '/') ? route.continue() : route.abort()))
  const page = await context.newPage()
  page.setDefaultTimeout(120000)
  page.on('pageerror', error => report.errors.push(String(error)))

  await page.goto(origin, { waitUntil: 'domcontentloaded' })
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

  await page.getByRole('navigation').getByText('名词术语', { exact: true }).first().click()
  const body = page.locator('[data-guide="table-body"]').first()
  await body.waitFor({ timeout: 30000 })

  const rowCount = () => body.locator('tr[data-workspace-record]').count()
  if (await rowCount() < 2) {
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: /新增一行/ }).first().click()
      await sleep(400)
    }
  }
  check('名词术语表有至少两行可测', (await rowCount()) >= 2, String(await rowCount()))

  /** 点开第 n 行的第 col 列单元格，并返回它的定位信息 */
  const focusCell = async (rowIndex, colIndex) => {
    const cell = body.locator('tr[data-workspace-record]').nth(rowIndex).locator('td').nth(colIndex).locator('textarea, input').first()
    await cell.click()
    await sleep(150)
    return cell
  }
  const active = async () => page.evaluate(() => {
    const el = document.activeElement
    const cell = el?.closest?.('td')
    const row = cell?.closest?.('tr')
    return {
      tag: el?.tagName ?? null,
      cellIndex: cell ? [...cell.parentElement.children].indexOf(cell) : -1,
      rowId: row?.dataset?.workspaceRecord ?? null,
      value: el?.value ?? null,
    }
  })

  // 找一个「单行输入框」列（编号或名称），避开下拉/数字/折行长文本
  const firstCell = body.locator('tr[data-workspace-record]').first()
  const textareaCells = await firstCell.locator('td textarea').count()
  check('表里有可编辑的单元格文本域', textareaCells > 0, String(textareaCells))

  await focusCell(0, 2)
  const before = await active()
  const rowIds = await body.locator('tr[data-workspace-record]').evaluateAll(nodes => nodes.map(n => n.dataset.workspaceRecord))
  check('已聚焦第一行的可编辑格', before.tag === 'TEXTAREA' && before.rowId === rowIds[0], JSON.stringify(before))

  // 记下第一行那一格的值：跳行前后要一模一样（跳行不能顺手改数据）
  const valueOf = (rowIndex, colIndex) => page.evaluate(({ r, c }) => {
    const row = document.querySelectorAll('[data-guide="table-body"] tr[data-workspace-record]')[r]
    const cell = row?.children?.[c]
    const field = cell?.querySelector('textarea, input')
    return field ? field.value : null
  }, { r: rowIndex, c: before.cellIndex })
  const valueBefore = await valueOf(0, before.cellIndex)

  await page.keyboard.press('ArrowDown')
  await sleep(200)
  const afterDown = await active()
  check('🔴 按 ↓ 焦点落到下一行的同一列', afterDown.rowId === rowIds[1] && afterDown.cellIndex === before.cellIndex,
    JSON.stringify({ afterDown, want: { rowId: rowIds[1], cellIndex: before.cellIndex } }))
  const valueAfter = await valueOf(0, before.cellIndex)
  check('跳行没有改动原来那一格的值', valueAfter === valueBefore, `${JSON.stringify(valueBefore)} → ${JSON.stringify(valueAfter)}`)

  await page.keyboard.press('ArrowUp')
  await sleep(200)
  const afterUp = await active()
  check('按 ↑ 回到上一行同一列', afterUp.rowId === rowIds[0] && afterUp.cellIndex === before.cellIndex, JSON.stringify(afterUp))

  // 到底行再按 ↓：焦点不动（交回浏览器，不循环）
  const lastIndex = rowIds.length - 1
  await focusCell(lastIndex, 2)
  const lastBefore = await active()
  await page.keyboard.press('ArrowDown')
  await sleep(200)
  const lastAfter = await active()
  check('🔴 最后一行再按 ↓ 焦点不动（不循环、不跳走）',
    lastAfter.rowId === lastBefore.rowId && lastAfter.cellIndex === lastBefore.cellIndex, JSON.stringify(lastAfter))

  check('全程 0 页面脚本错误', report.errors.length === 0, report.errors.join(' | ').slice(0, 200))
  await page.screenshot({ path: path.join(run, 'table.png') }).catch(() => {})
} catch (error) {
  failed++
  check('探针执行未中断', false, String(error?.message ?? error).slice(0, 200))
} finally {
  report.failed = failed
  report.status = failed === 0 ? 'pass' : 'fail'
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(report, null, 2))
  await browser?.close().catch(() => {})
  await server.close().catch(() => {})
  console.log(`\n报告：${path.join(run, 'result.json')}`)
  console.log(failed === 0 ? 'TABLE_KEYBOARD_OK' : `TABLE_KEYBOARD_FAIL ${failed}`)
  if (failed > 0) process.exitCode = 1
}
