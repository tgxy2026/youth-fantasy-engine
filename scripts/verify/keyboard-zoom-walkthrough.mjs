#!/usr/bin/env node
/**
 * W6「键盘走查 + 界面缩放」的可判定部分（3.6.2 收尾 · 2026-11-21）。
 *
 * 【这份脚本能替人做什么、不能替什么】
 *   能替：连续按 Tab 并把每一格焦点记下来（序列、是否落在 body、是否在视口内）、
 *        弹窗里 Tab 是否留在弹窗内、Esc 后焦点是否回到触发按钮、Ctrl+S 后焦点是否被抢走、
 *         132% / 200% 两档截图与"有没有横向溢出"。
 *   不能替：**焦点顺序合不合理**（要人看着界面判断）、读屏器朗读顺序（要 NVDA/VoiceOver）。
 *   所以结论里明确写「由自动化驱动、由人判读」，不把"没落到 body"当成"顺序合理"。
 *
 * 🔴 200% 为什么不用应用内缩放：应用内档位只有 80%~160%（`src/lib/settings/theme.ts`），
 *    200% 只能靠浏览器/Chromium 缩放（用户按 Ctrl+加号就是这条路）。这里用
 *    `webContents.setZoomFactor(2)` 复现，并在报告里注明两者的区别。
 *
 * 用法：node scripts/verify/keyboard-zoom-walkthrough.mjs [--exe <路径>] [--out <目录>]
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const arg = (name, def = '') => {
  const at = process.argv.indexOf(name)
  if (at < 0) return def
  const v = process.argv[at + 1]
  if (!v || v.startsWith('--')) throw new Error(name + ' 需要值')
  return v
}
const EXE = arg('--exe') || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'YouthFantasyEngine', 'YouthFantasyEngine.exe')
const OUT = path.resolve(ROOT, arg('--out', '.workbuddy/evidence/w6-' + new Date().toISOString().slice(0, 10)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
const check = (id, ok, detail = '') => {
  checks.push({ id, passed: !!ok, detail: String(detail).slice(0, 400) })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail ? ' :: ' + String(detail).slice(0, 200) : ''))
}
const notes = []
const note = (id, detail) => {
  notes.push({ id, detail })
  console.log('NOTE ' + id + ' :: ' + String(detail).slice(0, 200))
}

async function clearOverlays(page) {
  for (const label of ['关闭本页指引', '跳过本页', '稍后再说', '知道了', '我知道了', '继续上次']) {
    const b = page.getByRole('button', { name: label, exact: true }).first()
    if (await b.isVisible().catch(() => false)) await b.evaluate((el) => el.click()).catch(() => {})
  }
  await sleep(200)
}

/** 读当前焦点：描述 + 是否在视口内 + 是否在弹窗内 */
async function focusInfo(page) {
  return page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body || el === document.documentElement) return { tag: 'BODY' }
    const r = el.getBoundingClientRect()
    const inViewport = r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 30),
      w: Math.round(r.width),
      h: Math.round(r.height),
      inViewport,
      inDialog: !!el.closest('[role="dialog"]'),
    }
  })
}

async function tapSequence(page, n) {
  const seq = []
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab')
    await sleep(120)
    seq.push(await focusInfo(page))
  }
  return seq
}

/** 按顺序试几个入口，返回第一个真的打开 `[role="dialog"]` 的按钮名（没有则空串） */
async function openAnyDialog(page, names) {
  for (const name of names) {
    const b = page.getByRole('button', { name, exact: true }).first()
    if (!(await b.isVisible().catch(() => false))) continue
    await b.evaluate((el) => el.click()).catch(() => {})
    await sleep(900)
    const opened = await page.evaluate(() => !!document.querySelector('[role="dialog"]'))
    if (opened) return name
    await page.keyboard.press('Escape').catch(() => {})
    await sleep(300)
  }
  return ''
}

async function main() {
  if (!(await fs.stat(EXE).catch(() => null))) throw new Error('找不到桌面版 exe：' + EXE)
  await fs.mkdir(OUT, { recursive: true })
  const profile = await fs.mkdtemp(path.join(ROOT, '.workbuddy/tmp/w6-'))
  const env = { ...process.env }
  for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_START_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k]

  const app = await _electron.launch({
    executablePath: path.resolve(EXE),
    args: ['--no-sandbox', `--user-data-dir=${profile}`, '--no-proxy-server'],
    env,
    timeout: 120_000,
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(60_000)
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)))

  try {
    await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, null, { timeout: 90_000 }).catch(() => {})
    await sleep(1500)
    await clearOverlays(page)

    // ---- 阶段 A：项目中心 Tab 序列 ----
    // 首启向导先跳过到项目中心（这样有稳定的入口做键盘走查）
    for (const label of ['跳过，直接进入项目管理', '跳过，直接开始']) {
      const b = page.getByRole('button', { name: label, exact: true }).first()
      if (await b.isVisible().catch(() => false)) { await b.evaluate((el) => el.click()).catch(() => {}); await sleep(1200); break }
    }
    await clearOverlays(page)
    await page.evaluate(() => document.body.focus()).catch(() => {})

    const seqA = await tapSequence(page, 14)
    const bodyHits = seqA.filter((f) => f.tag === 'BODY').length
    const zeroSize = seqA.filter((f) => f.tag !== 'BODY' && (f.w === 0 || f.h === 0)).length
    const offscreen = seqA.filter((f) => f.tag !== 'BODY' && !f.inViewport).length
    check('kbd.no-body-focus', bodyHits === 0, `${seqA.length} 格中落在 body ${bodyHits} 次`)
    check('kbd.focus-has-box', zeroSize === 0, `零尺寸焦点 ${zeroSize} 个`)
    check('kbd.focus-in-viewport', offscreen === 0, `视口外焦点 ${offscreen} 个`)
    note('kbd.sequence', seqA.map((f, i) => `${i + 1}.${f.tag}「${f.text}」`).join(' → '))
    await page.screenshot({ path: path.join(OUT, '01-project-center-tab.png') }).catch(() => {})

    // ---- 阶段 B：弹窗 Tab 圈定 + Esc 还原 ----
    /**
     * 「新建小说项目」是**新建流程页**（不是 dialog），点了不弹窗 —— 第一版把它当弹窗入口，
     * 直接得到一个假 FAIL。这里改为按顺序试几个确定会开浮层的入口，取第一个真的出现
     * `[role="dialog"]` 的；一个都没有就如实标"未取到入口"，不硬造通过。
     */
    const candidates = ['外观', '帮助', '模型设置', '后台任务', '备份']
    const openerName = await openAnyDialog(page, candidates)
    if (openerName) {
      check('dialog.opens', true, `入口「${openerName}」打开了浮层`)
      const seqB = await tapSequence(page, 5)
      const outside = seqB.filter((f) => f.tag === 'BODY' || !f.inDialog).length
      check('dialog.focus-trapped', outside === 0, `${seqB.length} 格中跑出弹窗 ${outside} 次`)
      note('dialog.tab-sequence', seqB.map((f, i) => `${i + 1}.${f.tag}「${f.text}」`).join(' → '))
      await page.screenshot({ path: path.join(OUT, '02-dialog-tab.png') }).catch(() => {})
      await page.keyboard.press('Escape')
      await sleep(800)
      const closed = await page.evaluate(() => !document.querySelector('[role="dialog"]'))
      check('dialog.esc-closes', closed, closed ? 'Esc 已关闭' : 'Esc 后弹窗仍在')
      const back = await focusInfo(page)
      check('dialog.focus-restored', !!back.text && back.text.includes(openerName), `Esc 后焦点：${back.tag}「${back.text || ''}」`)
    } else {
      note('dialog.opens', '试过 ' + candidates.join('/') + ' 均未打开 role=dialog 浮层，本次未取到入口（static a11yDialogGate 已覆盖四处的三件套）')
    }

    // ---- 阶段 C：进项目并验 Ctrl+S 不抢焦点 ----
    const openBtn = page.getByRole('button', { name: '打开项目', exact: true }).first()
    if (await openBtn.isVisible().catch(() => false)) { await openBtn.click().catch(() => {}); await sleep(1500) }
    else {
      const demo = page.getByRole('button', { name: '创建示范项目', exact: true }).first()
      if (await demo.isVisible().catch(() => false)) {
        await demo.evaluate((el) => el.click()).catch(() => {})
        await sleep(900)
        const ok = page.getByRole('button', { name: '确定', exact: true }).first()
        if (await ok.isVisible().catch(() => false)) await ok.evaluate((el) => el.click()).catch(() => {})
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
          if (await page.getByRole('button', { name: '打开项目', exact: true }).first().isVisible().catch(() => false)) break
          await sleep(1000)
        }
        if (await openBtn.isVisible().catch(() => false)) { await openBtn.click().catch(() => {}); await sleep(1500) }
      }
    }
    await clearOverlays(page)
    const tabEditor = page.getByRole('button', { name: '正文编辑', exact: true }).first()
    if (await tabEditor.isVisible().catch(() => false)) { await tabEditor.evaluate((el) => el.click()).catch(() => {}); await sleep(1500) }
    await clearOverlays(page)

    const box = page.locator('textarea.novel-textarea').first()
    if (await box.count()) {
      await box.click().catch(() => {})
      await page.keyboard.type('键盘走查标记', { delay: 20 })
      await page.keyboard.press('Control+s')
      await sleep(1500)
      const still = await page.evaluate(() => {
        const el = document.activeElement
        return el ? el.tagName.toLowerCase() + '.' + (el.className || '').toString().slice(0, 40) : 'null'
      })
      check('editor.focus-kept-after-save', /textarea/.test(still), `Ctrl+S 后焦点：${still}`)
      const saved = await page.evaluate(() => /已保存|已同步/.test(document.body.innerText))
      check('editor.saved-hint', saved, saved ? '出现「已保存/已同步」' : '没看到保存提示')
    } else note('editor.focus-kept-after-save', '没进到正文编辑区，跳过（可能在项目中心）')

    // ---- 阶段 D：缩放 132% / 200% ----
    const zoomInfo = await page.evaluate(() => ({
      css: getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom').trim(),
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))
    note('zoom.current', `--ui-zoom=${zoomInfo.css}（80%~160% 是应用内档位，自动适配）`)
    check('zoom.no-h-overflow-132', zoomInfo.scrollWidth <= zoomInfo.innerWidth + 1, `scrollWidth=${zoomInfo.scrollWidth} innerWidth=${zoomInfo.innerWidth}`)
    await page.screenshot({ path: path.join(OUT, '03-zoom-auto.png') }).catch(() => {})

    // 200%：Chromium 缩放（等价用户按 Ctrl+加号），非应用内档位
    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.webContents.setZoomFactor(2)
    })
    await sleep(1500)
    const z200 = await page.evaluate(() => ({ innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }))
    check('zoom.no-h-overflow-200', z200.scrollWidth <= z200.innerWidth + 1, `scrollWidth=${z200.scrollWidth} innerWidth=${z200.innerWidth}`)
    await page.screenshot({ path: path.join(OUT, '04-zoom-200.png') }).catch(() => {})
    // 200% 下再开一次浮层，确认关闭按钮仍在视口内可点
    const opener200 = await openAnyDialog(page, ['外观', '帮助', '模型设置', '备份', '导出'])
    if (opener200) {
      const closeBox = await page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]')
        if (!dlg) return null
        const btn = [...dlg.querySelectorAll('button')].find((b) => /关闭|取消/.test(b.textContent || b.getAttribute('aria-label') || ''))
        if (!btn) return { found: false }
        const r = btn.getBoundingClientRect()
        return { found: true, inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth, w: Math.round(r.width), h: Math.round(r.height) }
      })
      check('zoom200.dialog-close-reachable', !!closeBox && closeBox.found && closeBox.inViewport, JSON.stringify(closeBox))
      await page.screenshot({ path: path.join(OUT, '05-zoom-200-dialog.png') }).catch(() => {})
      await page.keyboard.press('Escape').catch(() => {})
    } else note('zoom200.dialog-close-reachable', '200% 下没打开浮层，跳过（入口不可见）')

    // ---- 阶段 E：xs 档命中区实测 ----
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1)
    })
    await sleep(800)
    const xs = await page.evaluate(() => {
      return [...document.querySelectorAll('[data-button-size="xs"]')]
        // 🔴 必须过滤不可见元素：折叠面板里的按钮 rect 全 0，不过滤就会把"根本没显示"
        //    量成 0×0，然后判成"命中区不达标"（第一版正是这样假红）
        .filter((b) => b.offsetParent !== null && b.getBoundingClientRect().width > 0)
        .map((b) => {
          const r = b.getBoundingClientRect()
          return { text: (b.textContent || '').trim().slice(0, 12), w: Math.round(r.width), h: Math.round(r.height) }
        })
        // 按"较短边"排序：WCAG 2.2 的目标尺寸判据是最小边，不是宽度
        .sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h))
    })
    if (xs.length) {
      const minSide = Math.min(xs[0].w, xs[0].h)
      check('hit.xs-min-size', minSide >= 24, `最小 ${xs[0].w}×${xs[0].h}「${xs[0].text || '(图标)'}」（WCAG 2.2 下限 24）`)
      note('hit.xs-samples', xs.slice(0, 5).map((x) => `${x.text || '(图标)'} ${x.w}×${x.h}`).join(' / '))
    } else note('hit.xs-min-size', '当前视图没有 xs 档按钮')

    check('global.no-pageerror', errs.length === 0, errs.join(' | ') || '无 pageerror')
  } finally {
    await app.close().catch(() => {})
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {})
  }

  const failed = checks.filter((c) => !c.passed)
  const result = { at: new Date().toISOString(), exe: EXE, checks, notes, screenshots: OUT }
  await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2) + '\n').catch(() => {})
  console.log(`\nW6 SUMMARY: ${checks.length - failed.length}/${checks.length} passed`)
  if (failed.length) for (const f of failed) console.log('  - ' + f.id + ' :: ' + f.detail)
  console.log('证据目录：' + path.relative(ROOT, OUT))
  process.exit(failed.length ? 1 : 0)
}

await main()
