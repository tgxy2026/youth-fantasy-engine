// 3.4.0 · 导出产物实物核验（整页示例项目）
//
// 覆盖：Markdown / EPUB / DOCX（全书排版）/ 投稿稿 DOCX / 平台粘贴版。
// 说明：3.4.0 起 Markdown / Word / 平台粘贴版先打开「导出格式」弹窗，EPUB 仍是直接下载。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const run = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/export-products-340-'))
const server = await createServer({ cacheDir: path.join(run, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
const checks = []
const check = (id, ok, detail = '') => {
  checks.push({ id, ok: !!ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok || !detail ? '' : ` :: ${detail}`))
  if (!ok) throw new Error(`${id}${detail ? ' :: ' + detail : ''}`)
}
const unzip = async (file, name) => {
  const out = path.join(run, name)
  // 🔴 不能用 `tar`：本机 Git Bash 的 /usr/bin/tar 是 **GNU tar 1.35**，不认 ZIP（EPUB/DOCX 都是 ZIP），
  //    报 `This does not look like a tar archive`；传 Windows 绝对路径又会被当成 `host:path`。
  // 🔴 也不能用 Expand-Archive：它按扩展名判断，`.epub` 直接拒绝（只认 .zip）。
  //    改用 .NET ZipFile（不看扩展名），底层同一套压缩实现，能同时解 EPUB / DOCX。
  const quote = (value) => `'${value.replace(/'/g, "''")}'`
  execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(file)}, ${quote(out)})`,
  ], { stdio: 'pipe' })
  return out
}
const walk = async dir => {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(p))
    else out.push(p)
  }
  return out
}
const grab = async (page, trigger, name) => {
  const pending = page.waitForEvent('download', { timeout: 30000 })
  await trigger()
  const download = await pending
  const file = path.join(run, name)
  await download.saveAs(file)
  return file
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
  await page.getByRole('navigation').getByRole('button', { name: '正文编辑', exact: true }).click()
  await page.getByPlaceholder(/自动保存已开启/).waitFor({ timeout: 30000 })
  const exportMenu = () => page.getByTitle(/^导出全书：/).click()

  // ---- 1. Markdown（弹窗） ----
  await exportMenu()
  await page.getByRole('button', { name: /导出全书（Markdown）/ }).click()
  const md = await grab(page, () => page.getByRole('button', { name: '导出 Markdown', exact: true }).click(), 'book.md')
  const mdText = await readFile(md, 'utf8')
  check('Markdown 含卷标题', mdText.includes('# 第一卷'), mdText.slice(0, 120))
  check('Markdown 含章标题', /第1章|废脉/.test(mdText))
  check('Markdown 体量非空', mdText.length > 500, `len=${mdText.length}`)

  // ---- 2. EPUB（直接下载） ----
  await exportMenu()
  const epub = await grab(page, () => page.getByRole('button', { name: /导出全书（EPUB）/ }).click(), 'book.epub')
  const epubDir = await unzip(epub, 'epub-out')
  const epubFiles = await walk(epubDir)
  check('EPUB 是合法 ZIP 且含 mimetype', epubFiles.some(f => f.endsWith('mimetype')))
  const xhtml = epubFiles.filter(f => /\.(xhtml|html)$/i.test(f))
  check('EPUB 含 xhtml 内容文件', xhtml.length > 0, `files=${epubFiles.length}`)
  let epubText = ''
  for (const f of xhtml) epubText += await readFile(f, 'utf8')
  check('EPUB 正文含章节内容', /第1章|废脉/.test(epubText), `len=${epubText.length}`)

  // ---- 3. DOCX（弹窗，全书排版） ----
  await exportMenu()
  await page.getByRole('button', { name: /导出全书（Word · 可排版/ }).click()
  const docx = await grab(page, () => page.getByRole('button', { name: '导出 DOCX', exact: true }).click(), 'book.docx')
  const docxDir = await unzip(docx, 'docx-out')
  const docxXml = await readFile(path.join(docxDir, 'word', 'document.xml'), 'utf8')
  check('DOCX 含 word/document.xml', docxXml.length > 500, `len=${docxXml.length}`)
  check('DOCX 正文含章节内容', /第1章|废脉/.test(docxXml))

  // ---- 4. 投稿稿 DOCX（同一弹窗内切「投稿稿件」） ----
  await exportMenu()
  await page.getByRole('button', { name: /导出全书（Word · 可排版/ }).click()
  await page.getByRole('button', { name: '投稿稿件', exact: true }).click()
  const sub = await grab(page, () => page.getByRole('button', { name: '导出投稿稿', exact: true }).click(), 'submission.docx')
  const subDir = await unzip(sub, 'submission-out')
  const subXml = await readFile(path.join(subDir, 'word', 'document.xml'), 'utf8')
  check('投稿稿含书名', subXml.includes('吞天神脉'))
  check('投稿稿含章节内容', /第1章|废脉/.test(subXml))

  // ---- 5. 平台粘贴版（弹窗） ----
  await exportMenu()
  await page.getByRole('button', { name: /导出全书（平台粘贴版）/ }).click()
  const txt = await grab(page, () => page.getByRole('button', { name: '导出粘贴版', exact: true }).click(), 'platform.txt')
  const txtText = await readFile(txt, 'utf8')
  check('粘贴版含章节内容', /第1章|废脉/.test(txtText), `len=${txtText.length}`)

  for (const f of [md, epub, docx, sub, txt]) {
    const s = await stat(f)
    console.log(`  ${path.basename(f)} = ${s.size} bytes`)
  }
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`\nPASS ${checks.length} checks · export-products-340`)
} finally {
  await browser?.close().catch(() => {})
  await server.close().catch(() => {})
}