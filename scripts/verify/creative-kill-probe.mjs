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
/**
 * 轮询直到**真正进入作品**（右侧出现「创意写作」入口）；停在项目中心就点开。
 * 🔴 这是上一轮反复失败的根因：reload 后只 waitForTimeout 就点「打开项目」，
 *    点击常常落空 ⇒ store 从未 hydrate 该项目 ⇒ 读到的是库里残留状态，看着像"修了没生效"。
 */
async function enterProject() {
  for (let i = 0; i < 20; i++) {
    const inside = await page.evaluate(() =>
      [...document.querySelectorAll('button')].some((b) => /创意写作/.test((b.textContent || '').trim())))
    if (inside) return true
    const clicked = await page.evaluate(() => {
      const b = document.querySelector('[data-project-card] button[title="打开项目"]')
      if (!b) return false
      b.click(); return true
    })
    await page.waitForTimeout(clicked ? 5000 : 1200)
  }
  return false
}

async function dismissTips() {
  for (let i = 0; i < 5; i++) {
    const c = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /稍后再|稍后|知道了|跳过本页/.test((x.textContent || '').trim()))
      if (!b) return false
      b.click(); return true
    })
    if (!c) break
    await page.waitForTimeout(400)
  }
}

await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6500)

// 新 profile 会停在首启向导：「写我的第一本书」
if (!(await enterProject())) {
  const first = page.locator('button', { hasText: '写我的第一本书' }).first()
  if (await first.count()) {
    await first.click()
    await page.waitForTimeout(600)
    const next = page.getByRole('button', { name: '下一步' })
    if (await next.count()) { await next.click(); await page.waitForTimeout(1200) }
    const nameInput = page.locator('input[type="text"]').first()
    if (await nameInput.count()) await nameInput.fill('B04强杀夹具')
    const skip = page.getByRole('button', { name: /跳过，直接开始/ }).first()
    if (await skip.count()) await skip.click()
    else await page.getByRole('button', { name: /开始|创建|完成/ }).first().click().catch(() => {})
    await page.waitForTimeout(7000)
  }
}
const inside = await enterProject()
console.log('进入作品:', inside)
if (!inside) {
  console.log('❗ 没能进入作品，终止（不要在半路跑，否则读到的是残留状态）')
  try { await ctx.close() } catch { /* 忽略 */ }
  process.exit(1)
}
await dismissTips()

// 注入假模型配置（幂等）：新 profile 的库是空的，不注入就会报"没有可用模型"
const provider = await page.evaluate(async () => {
  const db = await import('/src/lib/db.ts')
  await db.setMeta('aiProviders', [{
    id: 'mock-1', name: 'Mock 本地端点', type: 'openai',
    baseUrl: 'http://127.0.0.1:18080/v1', apiKey: 'test-key', model: 'mock-1', local: true,
  }])
  await db.setMeta('aiActiveProviderId', 'mock-1')
  return (await db.getMeta('aiProviders', [])).length
})
console.log('模型配置就绪（provider 数）:', provider)

// 上一轮若残留「进行中」，先中止（真实用户也会这么做）。
// 注：progress 的 running→cancelled 降级修复（a28b9ce）在上游生效，正常不会残留；
//     这里只是兜底，不再像上一版那样手工删 meta（删了会被退出前的持久化写回）。
const aborted = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /^中止/.test((x.textContent || '').trim()))
  if (!b) return 'no-abort-btn'
  b.click(); return 'aborted'
})
console.log('残留状态处理:', aborted)
await page.waitForTimeout(1500)

await page.evaluate(() => {
  ;[...document.querySelectorAll('button')].find((x) => /创意写作/.test((x.textContent || '').trim()))?.click()
})
await page.waitForTimeout(2500)
await dismissTips()
await page.evaluate(() => {
  ;[...document.querySelectorAll('button')].filter((b) => /关闭|close/i.test((b.getAttribute('aria-label') || b.getAttribute('title') || '')))[0]?.click()
})
await page.waitForTimeout(600)

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
      // ① 已勾选 > 0 ⇒ 直接确认；
      // ② 勾选数是 0（草稿已写过一次/默认没勾）⇒ 先「全选新建」，下一轮再确认。
      const label = (x) => (x.textContent || '').trim()
      const confirmBtn = btns.find((x) => /^确认设定（[1-9]/.test(label(x)))
      if (confirmBtn) {
        confirmBtn.click(); window.__confirmedBible = true; clicked = label(confirmBtn)
      } else {
        const selectAll = btns.find((x) => /^全选新建$/.test(label(x)))
        if (selectAll) { selectAll.click(); clicked = '全选新建' }
      }
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
