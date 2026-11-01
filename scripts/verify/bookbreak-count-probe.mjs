// 3.3.3 · A-06 拆书 50 单元：请求计数与「只重试失败」（**测试脚手架**）
//
// 验什么：
//   ① 首次跑 50 单元 ⇒ 恰好 50 次抽取请求（第 37 个失败）；
//   ② 结果里 failedUnits 只含那 1 个，其余 49 个的实体照常在 batches 里；
//   ③ 再点「只重试失败」（retryFailed）⇒ **只再发 1 次**请求，不重跑那 49 个。
//
// 前置：
//   · `npm run dev`（5199）
//   · `MOCK_FAIL_AT=37 MOCK_DELAY_MS=50 node scripts/verify/mock-openai-endpoint.mjs`
// 用法：node scripts/verify/bookbreak-count-probe.mjs
import { chromium } from 'playwright'
import fs from 'node:fs'

const PROFILE = process.env.YFE_PROFILE
  || 'F:/软件项目/青春幻想引擎/youth-fantasy-engine开发源码/.workbuddy/tmp/edge-profile-b04g'
const MOCK_LOG = process.env.MOCK_LOG || '.workbuddy/tmp/mock-openai-requests.log'

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'msedge', viewport: { width: 1400, height: 900 }, args: ['--no-first-run'],
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6500)

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
console.log('进入作品:', await enterProject())

/** 统计 mock 日志里的抽取请求次数（用来核对「发了多少次请求」） */
/** 抽取类请求条数（含被注入失败的）——直接从 mock 日志数行，比字节增量可靠 */
function countExtract() {
  try {
    const t = fs.readFileSync(MOCK_LOG, 'utf8')
    return (t.match(/=== \S+ chat-extract ===/g) || []).length + (t.match(/=== \S+ chat-FAIL#\d+ ===/g) || []).length
  } catch { return -1 }
}

// 清掉上次跑留下的台账，否则「首次」会直接复用上次的成功结果，计数就不干净了
const cleared = await page.evaluate(async () => {
  const core = await import('/src/lib/db/core.ts')
  const pid = core.getCurrentProjectId()
  let n = 0
  for (const h of await core.ops.getAll('taskHeads').catch(() => [])) {
    if (h?.projectId === pid) { await core.ops.del('taskHeads', h.id).catch(() => {}); n++ }
  }
  for (const u of await core.ops.getAll('taskUnits').catch(() => [])) {
    if (u?.id) { await core.ops.del('taskUnits', u.id).catch(() => {}); n++ }
  }
  return n
})
console.log('清空残留台账条数:', cleared)
const before = countExtract()

const r1 = await page.evaluate(async () => {
  const run = await import('/src/lib/bookbreak/run.ts')
  // 造 50 章：每章 ~180 字（< maxUnitChars，保证 1 章 = 1 单元）
  let raw = ''
  for (let i = 1; i <= 50; i++) {
    raw += `第${i}章 测试章${i}\n` + `这是第${i}章的正文。` + '山风穿谷，火把照着断碑。'.repeat(12) + '\n\n'
  }
  const t0 = Date.now()
  const res = await run.runBookBreak(raw, {
    maxChunks: 50, maxUnits: 50, maxUnitChars: 4000,
    persistToChapters: false,          // 只抽设定，不动正文
  })
  return {
    ms: Date.now() - t0,
    unitCount: res?.split?.units?.length ?? res?.split?.chapters?.length ?? null,
    batchEntities: (res?.batches ?? []).reduce((n, b) => n + (b.entities?.length ?? 0), 0),
    failed: (res?.failedUnits ?? []).map(f => ({ index: f.index ?? null, reason: String(f.reason ?? '').slice(0, 30) })),
    raw: JSON.stringify(res?.failedUnits ?? []).slice(0, 200),
  }
})
const afterFirst = countExtract()
console.log('首次结果:', JSON.stringify(r1, null, 1))
console.log('首次抽取请求数:', afterFirst - before)

const r2 = await page.evaluate(async () => {
  const run = await import('/src/lib/bookbreak/run.ts')
  // 同一个项目/页签身份下「只重试失败」
  let raw = ''
  for (let i = 1; i <= 50; i++) {
    raw += `第${i}章 测试章${i}\n` + `这是第${i}章的正文。` + '山风穿谷，火把照着断碑。'.repeat(12) + '\n\n'
  }
  const res = await run.runBookBreak(raw, {
    maxChunks: 50, maxUnits: 50, maxUnitChars: 4000,
    persistToChapters: false,
    retryFailed: true,
  })
  return {
    failed: (res?.failedUnits ?? []).length,
    batchEntities: (res?.batches ?? []).reduce((n, b) => n + (b.entities?.length ?? 0), 0),
  }
})
const afterSecond = countExtract()
console.log('只重试失败结果:', JSON.stringify(r2))
console.log('重试抽取请求数:', afterSecond - afterFirst)

await ctx.close()
