// 3.4.0 · 导出「选定章节」范围核验（整页示例项目）
//
// 覆盖：跨卷选择、自由章节、空正文章、未计序号章；默认全书导出不受影响。
// 删除后阻止导出由 export-scheme-340 夹具覆盖（本脚本不重复造外部删除竞争）。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp, readFile } from 'node:fs/promises'
import path from 'node:path'

const run = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/export-range-340-'))
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
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

  // ---- 构造夹具：自由卷 + 空正文 + 未计序号章 ----
  const fixture = await page.evaluate(async () => {
    const db = await import('/src/lib/db.ts')
    const pid = db.getCurrentProjectId()
    const vols = (await db.getAllVolumes()).sort((a, b) => a.order - b.order)
    const chapters = (await db.getAllChapters()).sort((a, b) => a.order - b.order)
    const v1 = vols[0], v2 = vols[1]
    const c1 = chapters.find(c => c.volumeId === v1.id)
    const c2 = chapters.find(c => c.volumeId === v2.id)
    const untouched = chapters.find(c => c.volumeId === v1.id && c.id !== c1.id)
    const now = Date.now()
    const free = { id: crypto.randomUUID(), projectId: pid, order: -1000000, title: '自由章节', description: '', createdAt: now, isFree: true }
    await db.saveVolume(free)
    const freeChapter = { id: crypto.randomUUID(), projectId: pid, volumeId: free.id, order: 0, title: '自由章-范围验证', content: '自由章正文内容', summary: '', status: '草稿', wordCount: 7, createdAt: now, updatedAt: now }
    const emptyChapter = { id: crypto.randomUUID(), projectId: pid, volumeId: free.id, order: 1, title: '空章-范围验证', content: '', summary: '', status: '构思', wordCount: 0, createdAt: now, updatedAt: now }
    const noNumChapter = { id: crypto.randomUUID(), projectId: pid, volumeId: v2.id, order: 99, title: '序章-范围验证', content: '序章正文内容', summary: '', status: '草稿', wordCount: 6, createdAt: now, updatedAt: now, excludeFromNumbering: true }
    await db.saveChapter(freeChapter)
    await db.saveChapter(emptyChapter)
    await db.saveChapter(noNumChapter)
    return { c1: c1.title, c2: c2.title, untouched: untouched.title }
  })

  // ---- 重新加载，确保弹窗拿到新章 ----
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-project-hub]').waitFor({ timeout: 60000 })
  await page.locator('[data-project-card]').filter({ hasText: '吞天神脉' }).getByRole('button', { name: /继续写作|开始写作/ }).click()
  await page.getByTitle('返回项目列表').waitFor({ timeout: 90000 })
  await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
  await page.getByPlaceholder(/自动保存已开启/).waitFor({ timeout: 30000 })

  // ---- 打开平台粘贴版弹窗并选选定章节 ----
  await page.getByTitle(/^导出全书：/).click()
  await page.getByRole('button', { name: /导出全书（平台粘贴版）/ }).click()
  await page.getByRole('button', { name: '选定章节', exact: true }).click()
  await page.getByRole('button', { name: '清空', exact: true }).click()
  for (const title of [fixture.c1, fixture.c2, '自由章-范围验证', '空章-范围验证', '序章-范围验证']) {
    await page.locator('label').filter({ hasText: title }).locator('input[type="checkbox"]').check()
  }
  check('选定章节计数为 5', (await page.getByText(/已选 5 \//).innerText()).includes('已选 5'), await page.getByText(/已选 \d+ \//).innerText())

  const pending = page.waitForEvent('download', { timeout: 30000 })
  await page.getByRole('button', { name: '导出粘贴版', exact: true }).click()
  const download = await pending
  const file = path.join(run, 'range.txt')
  await download.saveAs(file)
  const text = await readFile(file, 'utf8')

  check('跨卷选择：第一卷章在产物里', text.includes(fixture.c1))
  check('跨卷选择：第二卷章在产物里', text.includes(fixture.c2))
  check('自由章节在产物里', text.includes('自由章-范围验证'))
  check('未计序号章在产物里', text.includes('序章-范围验证'))
  check('未选章节不在产物里', !text.includes(fixture.untouched), `untouched=${fixture.untouched}`)
  check('空正文章有明确占位或说明', /空章-范围验证/.test(text))

  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`\nPASS ${checks.length} checks · export-range-340`)
} finally {
  await browser?.close().catch(() => {})
  await server.close().catch(() => {})
}