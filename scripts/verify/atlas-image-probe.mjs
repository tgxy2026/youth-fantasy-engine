// 3.3.3 · B-05/B-06 图鉴图片：增 / 换 / 删 + 限额（**测试脚手架**）
//
// 验什么：
//   ① readAtlasImage() 正常压缩出 dataUrl + 真实字节数；SVG 被拒；
//   ② createTableImageWriter 写入后 tableRows.atlasImage 落库；换图是替换不是叠加；删图是删字段；
//   ③ atlasImageUsageOf 跨四页累加正确；checkAtlasBudget 的 ok / warn / over 三档与负增量放行。
//
// 前置：`npm run dev`（5199）。用法：node scripts/verify/atlas-image-probe.mjs
import { chromium } from 'playwright'

const PROFILE = process.env.YFE_PROFILE
  || 'F:/软件项目/青春幻想引擎/youth-fantasy-engine开发源码/.workbuddy/tmp/edge-profile-b04g'
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

const r = await page.evaluate(async () => {
  const core = await import('/src/lib/db/core.ts')
  const image = await import('/src/lib/atlas/image.ts')
  const write = await import('/src/lib/atlas/writeImage.ts')
  const quota = await import('/src/lib/atlas/quota.ts')
  const out = { steps: [] }
  const pid = core.getCurrentProjectId()

  /** 造一张真 PNG（canvas 画几笔，保证不是空图） */
  const makePng = async (label) => {
    const c = document.createElement('canvas')
    c.width = 640; c.height = 480
    const g = c.getContext('2d')
    g.fillStyle = '#123456'; g.fillRect(0, 0, 640, 480)
    g.fillStyle = '#ffcc00'; g.font = '48px sans-serif'; g.fillText(label, 40, 240)
    const blob = await new Promise(res => c.toBlob(res, 'image/png'))
    return new File([blob], `${label}.png`, { type: 'image/png' })
  }

  // ① 压缩与格式守卫
  // 🔴 返回的是 AtlasImageResult：{ ok: true, image } 或 { ok: false, reason }（不是直接返回 image）
  const png = await makePng('B05')
  const res = await image.readAtlasImage(png)
  out.image = res.ok
    ? { ok: true, bytes: res.image.bytes, w: res.image.width, h: res.image.height, mime: res.image.mime, hasDataUrl: String(res.image.dataUrl || '').startsWith('data:image/') }
    : { ok: false, reason: res.reason }
  const img = res.ok ? res.image : null
  const svgRes = await image.readAtlasImage(new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], 'x.svg', { type: 'image/svg+xml' }))
  out.svgRejected = svgRes.ok === false && /SVG/.test(svgRes.reason || '')

  // ② 四页各造一行
  const tabs = ['races', 'items', 'nations', 'geography']
  const rowIds = {}
  for (const t of tabs) {
    const id = `row-${t}-b05`
    rowIds[t] = id
    await core.ops.put('tableRows', {
      id, projectId: pid, tabId: t, rowId: 'R0001',
      data: { name: `条目-${t}` }, updatedAt: Date.now(),
    })
  }

  const readRows = async (t) => (await core.ops.getAll('tableRows')).filter(x => x.projectId === pid && x.tabId === t)

  // writer 的 read() 必须返回真实行（它靠这个定位并算增量）
  let cache = await readRows('races')
  const winst = write.createTableImageWriter({
    projectId: pid, tabId: 'races', current: () => true,
    read: () => cache, committed: (row) => { cache = cache.map(x => x.id === row.id ? row : x) },
  })

  // ③ 写图 → 回读
  await winst(rowIds.races, img)
  let after = (await readRows('races')).find(x => x.id === rowIds.races)
  out.afterWrite = { hasImage: !!after?.atlasImage, bytes: after?.atlasImage?.bytes, mime: after?.atlasImage?.mime }

  // ④ 换图（另一张更小的）→ 应是替换
  const smallRes = await image.readAtlasImage(await makePng('B05s'))
  const small = smallRes.ok ? smallRes.image : null
  if (!small) out.smallError = smallRes.reason
  cache = await readRows('races')
  await winst(rowIds.races, small)
  after = (await readRows('races')).find(x => x.id === rowIds.races)
  out.afterReplace = { hasImage: !!after?.atlasImage, sameAsFirst: after?.atlasImage?.dataUrl === img.dataUrl }

  // ⑤ 删图 → atlasImage 字段应被删掉
  cache = await readRows('races')
  await winst(rowIds.races, null)
  after = (await readRows('races')).find(x => x.id === rowIds.races)
  out.afterRemove = { hasField: !!after && 'atlasImage' in after }

  // ⑥ 四页用量累加：给每页都写一张，再算总量
  for (const t of tabs) {
    const rows = await readRows(t)
    const w = write.createTableImageWriter({
      projectId: pid, tabId: t, current: () => true,
      read: () => rows, committed: () => {},
    })
    await w(rowIds[t], img)
  }
  const all = await core.ops.getAll('tableRows')
  const usage = quota.atlasImageUsageOf(all.filter(x => x.projectId === pid && tabs.includes(x.tabId)))
  out.usage = { used: usage.used, count: usage.count }

  // ⑦ 限额三档 + 负增量放行
  const LIMIT = 32 * 1024 * 1024
  out.budget = {
    ok: quota.checkAtlasBudget(0, 1024, LIMIT).level,
    warn: quota.checkAtlasBudget(Math.floor(LIMIT * 0.85), 1024, LIMIT).level,
    over: quota.checkAtlasBudget(LIMIT, 1024, LIMIT).level,
    negativeAllowed: quota.checkAtlasBudget(LIMIT, -1024, LIMIT).level !== 'over',
    overReason: quota.checkAtlasBudget(LIMIT, 1024, LIMIT).reason?.slice(0, 24),
  }

  return out
})

console.log(JSON.stringify(r, null, 1))
await ctx.close()
