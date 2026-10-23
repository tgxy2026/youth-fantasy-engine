#!/usr/bin/env node
'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')
const { sourceFingerprint } = require('../context.cjs')
const ROOT = path.resolve(__dirname, '../../..')
async function main() {
  for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy']) delete process.env[k]
  const out = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/tablet-interaction-'))
  const result = { at: new Date().toISOString(), sourceFingerprint: sourceFingerprint(ROOT), out, checks: [], errors: [] }
  const check = (name, passed) => { result.checks.push({ name, passed: !!passed }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`); if (!passed) throw new Error(name) }
  let server, browser, page
  try {
    const { createServer } = await import('vite')
    server = await createServer({ root: ROOT, cacheDir: path.join(out, 'vite-cache'), logLevel: 'silent', server: { host: '127.0.0.1', port: 5214, strictPort: true } }); await server.listen()
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] })
    for (const size of [{ width: 768, height: 1024, zoom: 100 }, { width: 1024, height: 768, zoom: 100 }, { width: 1000, height: 640, zoom: 160 }]) {
      page = await browser.newPage({ viewport: { width: size.width, height: size.height }, hasTouch: true })
      page.setDefaultTimeout(15000)
      page.on('pageerror', e => result.errors.push(e.message))
      const label = `${size.width}x${size.height}-${size.zoom}`
      await page.goto('http://127.0.0.1:5214')
      await page.getByRole('button', { name: /先看看示例/ }).click()
      await page.getByRole('button', { name: '下一步', exact: true }).click()
      await page.getByRole('button', { name: /跳过，直接开始|开始写作/ }).click()
      await page.locator('main').getByRole('heading', { name: '写作面板', exact: true }).waitFor({ timeout: 45000 })
      const later = page.getByRole('button', { name: '稍后再说', exact: true })
      if (await later.isVisible()) await later.click()
      await page.evaluate(async z => { const { applyZoom } = await import('/src/lib/settings/theme.ts'); applyZoom(z, { manual: true }) }, size.zoom)
      const menu = page.getByRole('button', { name: '打开项目菜单', exact: true })
      if (await menu.isVisible()) await menu.click()
      await page.getByRole('navigation').getByRole('button', { name: '作品信息', exact: true }).click()
      await page.locator('main h1').filter({ hasText: '作品信息' }).waitFor()
      check(label + ' 主菜单可以选页，抽屉自动收起', !await page.getByRole('dialog', { name: '项目菜单', exact: true }).isVisible())
      const marker = '窗口适配保存验收-' + label
      await page.locator('main textarea').first().fill(marker)
      await page.keyboard.press('Control+s')
      await page.waitForFunction(async marker => { const db = await import('/src/lib/db.ts'); return Object.values(await db.getFormData('positioning')).includes(marker) }, marker)
      check(label + ' 表单输入和保存实际写入临时库', true)

      await page.evaluate(() => window.dispatchEvent(new CustomEvent('yfe:navigate', { detail: 'editor' })))
      const editor = page.getByPlaceholder('落笔即入江湖……（自动保存已开启 · Ctrl+S 立即保存）')
      await editor.waitFor()
      const chapters = page.getByTitle('打开章节目录', { exact: true })
      if (await chapters.isVisible()) {
        await chapters.click()
        const dialog = page.getByRole('dialog', { name: '章节目录', exact: true })
        await dialog.locator('[data-chapter-id]').first().click()
        check(label + ' 章节抽屉可选章并回到正文', !await dialog.isVisible())
      } else check(label + ' 常驻章节列表可达', await page.locator('[data-chapter-id]').first().isVisible())
      const original = await editor.inputValue()
      await editor.fill(original + '\n' + marker)
      await page.keyboard.press('Control+s')
      await page.waitForFunction(async marker => { const db = await import('/src/lib/db.ts'); return (await db.getAllChapters()).some(c => c.content.includes(marker)) }, marker)
      check(label + ' 正文输入和保存实际生效', true)
      await editor.fill(original); await page.keyboard.press('Control+s')
      await page.getByTitle('打开设定检索', { exact: true }).click()
      const search = page.getByRole('dialog', { name: '设定检索', exact: true })
      await search.getByPlaceholder('搜角色名 / 伏笔 / 境界 / 地名…').fill('陈渊')
      await search.getByText('陈渊', { exact: true }).first().waitFor()
      check(label + ' 检索抽屉可以搜索已存角色', true)
      await page.screenshot({ path: path.join(out, label + '-search.png') })
      await page.keyboard.press('Escape')

      const settings = page.getByRole('button', { name: '界面与数据设置', exact: true })
      if (await settings.isVisible()) await settings.click()
      const zoom = page.getByTitle('手动输入缩放比例（80% ~ 160%），回车或失焦生效', { exact: true })
      const nextZoom = size.zoom === 160 ? 140 : 110
      await zoom.fill(String(nextZoom)); await zoom.press('Enter')
      await page.waitForFunction(z => parseFloat(document.documentElement.style.zoom) === z / 100, nextZoom)
      await zoom.fill(String(size.zoom)); await zoom.press('Enter')
      await page.waitForFunction(z => parseFloat(document.documentElement.style.zoom) === z / 100, size.zoom)
      check(label + ' 缩放设置可修改并还原', true)
      const appearance = page.getByRole('button', { name: '展开外观设置', exact: true })
      if (await appearance.isVisible()) await appearance.click()
      await page.getByRole('button', { name: '字体设置', exact: true }).click()
      const font = page.getByRole('dialog', { name: '字体设置', exact: true })
      const rect = await font.boundingBox()
      check(label + ' 字体弹窗完整落在窗口内', rect && rect.x >= -1 && rect.y >= -1 && rect.x + rect.width <= size.width + 1 && rect.y + rect.height <= size.height + 1)
      await page.screenshot({ path: path.join(out, label + '-font.png') })
      await page.keyboard.press('Escape')
      if (await page.getByRole('dialog', { name: '项目菜单', exact: true }).isVisible()) await page.keyboard.press('Escape')
      await page.screenshot({ path: path.join(out, label + '-editor.png') })
      await page.close()
    }
    check('全程没有浏览器运行错误', result.errors.length === 0)
  } catch (e) {
    result.error = e.stack
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
      await fs.writeFile(path.join(out, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => ''))
    }
    throw e
  } finally {
    result.stale = result.sourceFingerprint !== sourceFingerprint(ROOT)
    await browser?.close().catch(() => {}); await server?.close().catch(() => {})
    await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
    console.log('EVIDENCE ' + path.join(out, 'results.json'))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
