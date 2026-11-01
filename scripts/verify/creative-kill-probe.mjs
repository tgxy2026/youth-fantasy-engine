import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// 3.3.3 · B-04 强杀探针（**测试脚手架，不是产品代码**）
//
// 用途：真实 Edge + 真实 IndexedDB 跑「设定奠基 → 确认 → 分卷大纲 → 逐章连写」，
//       在首章落库瞬间强杀进程，供下一步验证断点续跑三态。
// 前置：`npm run dev`（5199）+ `node scripts/verify/mock-openai-endpoint.mjs`（18080）+ 已注入 mock 模型配置。
// 用法：`node scripts/verify/creative-kill-probe.mjs`
//   YFE_PROFILE 覆盖 Edge profile 目录；YFE_OUT 覆盖截图/状态输出目录。
//
// 🔴 两条实测教训（别重复踩）：
//   ① 整套 UI **必须一次会话跑完**：中途 reload 会丢草稿（bag 只在内存）；
//   ② 「确认设定」确认后会变成「确认设定（0）」，**只能点一次**，再点就是空转。
const PROFILE = process.env.YFE_PROFILE
  || 'F:/软件项目/青春幻想引擎/youth-fantasy-engine开发源码/.workbuddy/tmp/edge-profile-b04'
const OUT = process.env.YFE_OUT || '.workbuddy/tmp'
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'msedge', viewport: { width: 1600, height: 950 }, args: ['--no-first-run'],
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6500)
await page.evaluate(() => document.querySelector('[data-project-card] button[title="打开项目"]')?.click())
await page.waitForTimeout(7000)
for (let i = 0; i < 5; i++) {
  const c = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /稍后再|稍后|知道了|跳过本页/.test((x.textContent || '').trim()))
    if (!b) return false
    b.click(); return true
  })
  if (!c) break
  await page.waitForTimeout(400)
}
// 🔴 先清掉上一轮残留的 progress/resume：草稿只在内存里，残留的 "等待确认" 会卡死新一轮
await page.evaluate(async () => {
  const db = await import('/src/lib/db.ts')
  const pid = db.getCurrentProjectId()
  const key = 'creativeSession:' + pid
  const saved = await db.getMeta(key, null)
  if (saved) {
    delete saved.progress
    delete saved.resume
    await db.setMeta(key, saved)
  }
})
await page.waitForTimeout(400)

// 🔴 清完必须 reload：creativeSession 是模块级单例，页面加载时已经 hydrate 了旧 progress，
//    不重载就等于没清（实测会一直停在"等待确认"）
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6500)
await page.evaluate(() => document.querySelector('[data-project-card] button[title="打开项目"]')?.click())
await page.waitForTimeout(7000)
for (let i = 0; i < 5; i++) {
  const c = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /稍后再|稍后|知道了|跳过本页/.test((x.textContent || '').trim()))
    if (!b) return false
    b.click(); return true
  })
  if (!c) break
  await page.waitForTimeout(400)
}

await page.evaluate(() => {
  ;[...document.querySelectorAll('button')].find((x) => /创意写作/.test((x.textContent || '').trim()))?.click()
})
await page.waitForTimeout(2500)
await page.evaluate(() => {
  ;[...document.querySelectorAll('button')].filter((b) => /关闭|close/i.test((b.getAttribute('aria-label') || b.getAttribute('title') || '')))[0]?.click()
})
await page.waitForTimeout(600)

// 若上次残留「进行中」，先中止掉（真实用户也会这么干），否则「开始创作」不可用
const aborted = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /^中止$/.test((x.textContent || '').trim()))
  if (!b) return 'no-abort-btn'
  b.click(); return 'aborted'
})
console.log('处理残留状态:', aborted)
await page.waitForTimeout(1500)

// 参数：一句话 + 缩小规模（1 卷、每章 400 字）
await page.evaluate(() => {
  const ta = document.querySelector('textarea[placeholder*="吞噬他人修为"]')
  if (ta) {
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, '一个靠替人记仇的抄书人，在王朝崩塌前夜发现自己记下的每一条仇都要由他来还。')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const nums = [...document.querySelectorAll('input[type="number"]')]
  const setNum = (el, v) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  if (nums[1]) setNum(nums[1], 1)
  if (nums[2]) setNum(nums[2], 400)
})
await page.waitForTimeout(700)

console.log('开始创作:', await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /^开始创作$/.test((x.textContent || '').trim()))
  if (!b) return 'not found'
  b.click(); return 'clicked'
}))

/** 轮询：自动点「确认设定/确认大纲/继续」，并读取章节数 */
async function poke(round) {
  return page.evaluate(async () => {
    const db = await import('/src/lib/db.ts')
    const chapters = await db.getAllChapters().catch(() => [])
    const pid = db.getCurrentProjectId()
    const meta = await db.getMeta('creativeSession:' + pid, null)
    const btns = [...document.querySelectorAll('button')]
    // 🔴 只在「已勾选 > 0」时才点确认：确认成功后按钮会变成「确认设定（0）」，
    //    继续点它就是空转（实测会死循环，白白错过强杀时机）。
    let clicked = null
    if (!window.__confirmedBible) {
      const b = btns.find((x) => /^确认设定（[1-9]/.test((x.textContent || '').trim()))
      if (b) { b.click(); window.__confirmedBible = true; clicked = (b.textContent || '').trim() }
    }
    return {
      clicked,
      chapterCount: chapters?.length ?? 0,
      status: meta?.progress?.status ?? null,
      ratio: meta?.progress?.ratio ?? null,
      msg: (meta?.progress?.message ?? '').slice(0, 60),
    }
  })
}

let killed = false
let lastState = null
for (let i = 0; i < 80; i++) {
  await page.waitForTimeout(1500)
  let st
  try { st = await poke(i) } catch (e) { console.log('轮询异常:', String(e).slice(0, 80)); break }
  if (st.clicked || i % 4 === 0) console.log(`#${i}`, JSON.stringify(st))
  lastState = st
  // 强杀点：已经落库至少 1 章，且流程仍在跑（说明还有后续章要写）
  if (st.chapterCount >= 1 && st.status === 'running') {
    console.log('★ 达到强杀点：章节数', st.chapterCount, '状态', st.status)
    killed = true
    break
  }
}

if (killed) {
  await page.screenshot({ path: `${OUT}/b04-before-kill.png` }).catch(() => {})
  // 真强杀：只杀本夹具 profile 的 Edge 进程，不动用户其它窗口
  try {
    const target = path.resolve(PROFILE).replaceAll("'", "''")
    const ps = `$target = '${target}'; $pattern = '(?i)--user-data-dir=(?:"' + [regex]::Escape($target) + '"|' + [regex]::Escape($target) + '(?=\\s|$))'; $list = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern }); if ($list.Count -eq 0) { throw 'No Edge processes matched the selected profile' }; $list | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }`
    const encoded = Buffer.from(ps, 'utf16le').toString('base64')
    execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { stdio: 'pipe', timeout: 20000 })
    console.log('已强杀 Edge 进程')
  } catch (e) {
    console.log('强杀失败:', String(e).slice(0, 120))
    killed = false
  }
  if (killed) fs.writeFileSync(`${OUT}/b04-kill-state.json`, JSON.stringify({ lastState, at: new Date().toISOString() }, null, 2))
} else {
  console.log('未到达强杀点，最后状态:', JSON.stringify(lastState))
}

try { await ctx.close() } catch { /* 进程已被杀，忽略 */ }
if (!killed) process.exitCode = 1
