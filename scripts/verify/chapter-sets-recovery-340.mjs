// 3.4.0 · 收藏集成员在「删章 → 回收站恢复」后的有效性（整页，示例项目）
//
// 验证点：
//   1. 建收藏集并加入一章 → 成员有效；
//   2. 删该章 → 收藏集显示「以下章节不可用 / 章节不存在」，且不静默移除成员；
//   3. 回收站恢复该章 → 成员自动回到有效（依赖恢复沿用原 chapter id）。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'

const run = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/chapter-sets-recovery-340-'))
const server = await createServer({ cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
const checks = []
const check = (id, ok, detail = '') => {
  checks.push({ id, ok: !!ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok || !detail ? '' : ` :: ${detail}`))
  if (!ok) throw new Error(`${id}${detail ? ' :: ' + detail : ''}`)
}
try {
  await server.listen()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => localStorage.setItem('yfe-ui:guide-auto', '0'))
  await page.goto(`http://localhost:${server.httpServer.address().port}`, { waitUntil: 'domcontentloaded' })

  await page.getByRole('button', { name: /先看看示例/ }).click()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  const later = page.getByRole('button', { name: '稍后再说', exact: true })
  if (await later.isVisible().catch(() => false)) await later.click()
  const nav = page.getByRole('navigation')
  await nav.getByRole('button', { name: '写作面板', exact: true }).click()

  const openSets = async () => {
    const toggle = page.getByRole('button', { name: /章节收藏集/ })
    await toggle.waitFor({ timeout: 30000 })
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    await page.getByRole('button', { name: '新建', exact: true }).waitFor({ timeout: 15000 })
  }

  // ---- 1. 建收藏集 + 加一章 ----
  await openSets()
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await page.getByPlaceholder(/收藏集名称/).fill('恢复验证')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await page.getByRole('button', { name: /恢复验证/ }).click()
  await page.getByRole('button', { name: /添加章节/ }).click()
  // 面板内第 1 个 button 是关闭 X，第 2 个起才是章节项。
  const candidate = page.locator('div.border.rounded.p-2 button').nth(1)
  await candidate.waitFor({ timeout: 15000 })
  const chapterTitle = (await candidate.innerText()).trim()
  await candidate.click()
  await page.getByTitle('进入章节正文').first().waitFor({ timeout: 15000 })
  check('加章后收藏集成员有效', true)

  // ---- 2. 删除该章 ----
  await page.getByTitle('进入章节正文').first().click()
  await page.getByPlaceholder(/自动保存已开启/).waitFor({ timeout: 30000 })
  const rowTitle = page.locator('span[title^="双击改章名"]').filter({ hasText: chapterTitle }).first()
  await rowTitle.waitFor({ timeout: 15000 })
  await rowTitle.locator('..').hover()
  await rowTitle.locator('..').getByLabel('删除该章节').click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await rowTitle.waitFor({ state: 'detached', timeout: 20000 })

  await nav.getByRole('button', { name: '写作面板', exact: true }).click()
  await openSets()
  await page.getByRole('button', { name: /恢复验证/ }).click()
  await page.getByText('以下章节不可用', { exact: false }).waitFor({ timeout: 15000 })
  check('删章后收藏集明确标出「以下章节不可用」', true)
  check('删章后失效成员仍保留（未被静默移除）', await page.getByText('章节不存在').first().isVisible())
  await page.screenshot({ path: path.join(run, 'set-missing.png') })

  // ---- 3. 回收站恢复 ----
  await nav.getByRole('button', { name: '正文编辑', exact: true }).click()
  await page.getByPlaceholder(/自动保存已开启/).waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: '编辑工具', exact: true }).click()
  await page.getByRole('button', { name: /回收站/ }).click()
  const trashTitle = page.getByText(chapterTitle, { exact: true }).first()
  await trashTitle.waitFor({ timeout: 15000 })
  await trashTitle.locator('xpath=../..').getByRole('button', { name: '恢复', exact: true }).click()
  await page.keyboard.press('Escape')

  await nav.getByRole('button', { name: '写作面板', exact: true }).click()
  await openSets()
  await page.getByRole('button', { name: /恢复验证/ }).click()
  await page.getByTitle('进入章节正文').first().waitFor({ timeout: 15000 })
  check('回收站恢复后成员重新变为有效', true)
  check('恢复后不再显示「以下章节不可用」',
    await page.getByText('以下章节不可用', { exact: false }).isHidden().catch(() => true))
  await page.screenshot({ path: path.join(run, 'set-restored.png') })

  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`\nPASS ${checks.length} checks · chapter-sets-recovery-340`)
} finally {
  await browser?.close().catch(() => {})
  await server.close().catch(() => {})
}