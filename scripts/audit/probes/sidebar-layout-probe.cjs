#!/usr/bin/env node
'use strict'
// 使用独立 Electron 资料区查看小窗口侧栏；--capture-only 可记录改动前截图。
const fs = require('node:fs/promises')
const path = require('node:path')
const { _electron } = require('playwright')
const ROOT = path.resolve(__dirname, '../../..')
async function main() {
  const captureOnly = process.argv.includes('--capture-only')
  const out = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/sidebar-layout-'))
  const profile = path.join(out, 'profile'), appData = path.join(out, 'appdata')
  await fs.mkdir(profile); await fs.mkdir(appData)
  const now = Date.now()
  await fs.writeFile(path.join(profile, 'youth-fantasy-engine-data.json'), JSON.stringify({ app: 'youth-fantasy-engine', kind: 'portable-data', fileVersion: 2, savedAt: now, stores: { projects: { P: { id: 'P', name: '侧栏布局验收', genre: '玄幻', intro: '', projectType: 'full', createdAt: now, updatedAt: now } }, meta: { welcomeDone: { key: 'welcomeDone', value: '1' } } } }))
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
  await fs.writeFile(path.join(out, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: 'bootstrap.cjs' }))
  await fs.writeFile(path.join(out, 'bootstrap.cjs'), `const {app}=require('electron');app.setPath('appData',${JSON.stringify(appData)});require(${JSON.stringify(path.join(ROOT, 'electron/main.cjs'))});`)
  for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy','ELECTRON_RUN_AS_NODE','NODE_OPTIONS']) delete process.env[k]
  const results = { out, captureOnly, cases: [] }
  let server, app
  try {
    const { createServer } = await import('vite')
    server = await createServer({ root: ROOT, cacheDir: path.join(out, 'vite-cache'), server: { host: '127.0.0.1', port: 5212, strictPort: true } }); await server.listen()
    app = await _electron.launch({ executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), args: [out, '--no-sandbox', '--no-proxy-server', '--user-data-dir=' + profile], env: { ...process.env, ELECTRON_START_URL: 'http://127.0.0.1:5212' } })
    const page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.evaluate(() => localStorage.setItem('yfe-sidebar-w', '200'))
    await page.reload()
    await page.getByRole('button', { name: '打开项目', exact: true }).click({ timeout: 45000 })
    await page.getByRole('button', { name: '稍后再说', exact: true }).click({ timeout: 1500 }).catch(() => {})
    for (const scenario of [ { width: 768, height: 1024, sidebar: 200, zoom: 100 }, { width: 1024, height: 768, sidebar: 200, zoom: 100 }, { width: 1000, height: 640, sidebar: 200, zoom: 160 }, { width: 1366, height: 768, sidebar: 200, zoom: 100 } ]) {
      await app.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setSize(size.width, size.height) }, scenario)
      await page.evaluate(async ({ zoom, sidebar }) => {
        localStorage.setItem('yfe-sidebar-w', String(sidebar))
        const { applyZoom } = await import('/src/lib/settings/theme.ts'); applyZoom(zoom, { manual: true })
      }, scenario)
      await page.waitForTimeout(300)
      const menu = page.getByRole('button', { name: '打开项目菜单', exact: true })
      if (await menu.isVisible()) await menu.click()
      await page.getByRole('navigation').waitFor()
      await page.waitForTimeout(400)
      const base = `${scenario.width}x${scenario.height}-${scenario.zoom}`
      await page.screenshot({ path: path.join(out, base + '.png') })
      const measure = () => page.locator('aside:visible').first().evaluate(aside => {
        const nav = aside.querySelector('nav'), footer = nav.nextElementSibling
        const n = nav.getBoundingClientRect(), f = footer.getBoundingClientRect(), a = aside.getBoundingClientRect()
        const overflowing = [...footer.querySelectorAll('button,input')].filter(e => {
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && (r.left < a.left - 1 || r.right > a.right + 1)
        }).map(e => e.getAttribute('title') || e.textContent)
        return { drawer: !!aside.closest('[role="dialog"]'), scrollable: aside.scrollHeight > aside.clientHeight, navHeight: n.height, footerHeight: f.height, asideHeight: a.height, viewportHeight: window.innerHeight, overflowing }
      })
      const normal = await measure()
      let expanded
      if (!captureOnly) {
        if (normal.navHeight < 90 || normal.overflowing.length || (!normal.drawer && normal.footerHeight > normal.asideHeight * 0.46)) throw new Error('默认侧栏超出布局边界：' + JSON.stringify(normal))
        await page.getByRole('button', { name: '展开外观设置', exact: true }).click()
        await page.getByRole('button', { name: '展开云盘文件同步设置', exact: true }).click()
        expanded = await measure()
        if (expanded.navHeight < 90 || expanded.overflowing.length || (!expanded.drawer && expanded.footerHeight > expanded.asideHeight * 0.46)) throw new Error('展开侧栏超出布局边界：' + JSON.stringify(expanded))
        const body = page.locator('[data-sidebar-tools]')
        await body.evaluate(e => { e.scrollTop = e.scrollHeight })
        await page.getByRole('button', { name: '选择同步目录', exact: true }).waitFor({ state: 'visible' })
        await page.getByRole('button', { name: '选择同步目录', exact: true }).scrollIntoViewIfNeeded()
        const reachable = await page.getByRole('button', { name: '选择同步目录', exact: true }).boundingBox()
        if (!reachable || reachable.y < 0 || reachable.y + reachable.height > await page.evaluate(() => innerHeight)) throw new Error('同步设置不能滚动到窗口内')
        await page.screenshot({ path: path.join(out, base + '-expanded.png') })
        await page.getByRole('button', { name: '收起左下角工具栏', exact: true }).click()
        await page.getByRole('button', { name: '展开左下角工具栏', exact: true }).click()
        await page.getByRole('button', { name: '收起外观设置', exact: true }).click()
        await page.getByRole('button', { name: '收起云盘文件同步设置', exact: true }).click()
        // 收回设置后，缩放和保存必须仍可从同一区域操作。
        await page.getByTitle('缩小界面', { exact: true }).click()
        await page.getByTitle('放大界面', { exact: true }).click()
        if ((await page.getByTitle('手动输入缩放比例（80% ~ 160%），回车或失焦生效').inputValue()) !== String(scenario.zoom)) throw new Error('缩放操作未保持可用')
      }
      results.cases.push({ ...scenario, normal, expanded })
      console.log('PASS ' + base + ' ' + JSON.stringify({ normal, expanded }))
      if (await page.getByRole('dialog', { name: '项目菜单', exact: true }).isVisible()) await page.keyboard.press('Escape')
    }
  } catch (e) {
    results.error = e.stack
    if (app) {
      const page = await app.firstWindow()
      await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
      await fs.writeFile(path.join(out, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => ''))
    }
    throw e
  }
  finally {
    await app?.close().catch(() => {}); await server?.close().catch(() => {})
    await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2))
    console.log('EVIDENCE ' + path.join(out, 'results.json'))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
