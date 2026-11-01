// 3.3.3 · B-08 出口隔离：真实 IFD + 真实导出/导入往返（**测试脚手架**）
//
// 验什么：
//   ① 项目包 exportProject() 的产物里**没有**任务台账（taskHeads / taskUnits）；
//   ② 云快照 buildProjectSnapshot() 的切片里**没有**任务类 kind；
//   ③ 数据文件出口的排除函数 stripLocalTaskStores() 真的删掉这两个 store；
//   ④ 导入回来后新项目可读，且旧任务不会在新项目下被激活（台账按 projectId 隔离）。
//
// 前置：`npm run dev`（5199）。用法：node scripts/verify/export-isolation-probe.mjs
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
  const projects = await import('/src/lib/db/projects.ts')
  const snap = await import('/src/lib/sync/projectSnapshot.ts')
  const sens = await import('/src/lib/storage/sensitiveMeta.ts')
  const out = { steps: [] }
  const pid = core.getCurrentProjectId()
  out.pid = pid

  // 造一条任务台账（模拟「拆书 50 单元」留下的记录）
  const put = async (store, row) => {
    try { await core.ops.put(store, row); return 'ok' } catch (e) { return String(e).slice(0, 80) }
  }
  out.steps.push('write taskHeads: ' + await put('taskHeads', { id: 'task-b08', projectId: pid, kind: 'bookbreak', createdAt: Date.now() }))
  out.steps.push('write taskUnits: ' + await put('taskUnits', { id: 'unit-b08', taskId: 'task-b08', projectId: pid, status: 'done' }))

  // 造真实业务数据：没有数据时「快照切片为空」并不能证明"有数据时也不含任务类"
  out.steps.push('write volumes: ' + await put('volumes', { id: 'v-b08', projectId: pid, title: '卷一', no: 1, createdAt: Date.now(), updatedAt: Date.now() }))
  out.steps.push('write chapters: ' + await put('chapters', {
    id: 'c-b08', projectId: pid, volumeId: 'v-b08', title: '第一章 出口测试', no: 1,
    content: '这一章用来验证导出往返。'.repeat(10), createdAt: Date.now(), updatedAt: Date.now(),
  }))
  out.steps.push('write tableRows: ' + await put('tableRows', {
    id: 'r-b08', projectId: pid, tabId: 'races', rowId: 'R0001',
    data: { name: '测试条目', custom: '值' }, updatedAt: Date.now(),
  }))

  // ① 项目包导出
  const bundle = await projects.exportProject(pid)
  const keys = Object.keys(bundle ?? {})
  const json = JSON.stringify(bundle ?? {})
  out.bundleKeys = keys
  out.hasTaskField = keys.some(k => /task/i.test(k))
  out.jsonMentionsTask = /taskHeads|taskUnits|task-b08|unit-b08/.test(json)
  out.chapterCount = (bundle?.chapters ?? []).length

  // ② 云快照
  try {
    const built = await snap.buildProjectSnapshot(bundle)
    // 正确形状是 manifest.objects[].kind + manifest.counts（不是 slices —— 猜错会得到"空数组也算通过"的假绿）
    const kinds = (built?.manifest?.objects ?? []).map(o => o.kind)
    const counts = built?.manifest?.counts ?? {}
    out.snapshotKinds = kinds
    out.snapshotCounts = counts
    out.snapshotHasTaskKind = kinds.some(k => /task/i.test(String(k)))
      || Object.keys(counts).some(k => /task/i.test(k))
  } catch (e) { out.snapshotError = String(e).slice(0, 120) }

  // ③ 数据文件出口的排除函数（纯函数，浏览器里可直接调）
  try {
    const fake = { projects: [{ id: pid }], taskHeads: [{ id: 'task-b08' }], taskUnits: [{ id: 'unit-b08' }], chapters: [] }
    const stripped = sens.stripLocalTaskStores(fake)
    out.strippedHasTasks = !!(stripped?.taskHeads || stripped?.taskUnits)
    out.strippedKeepsOthers = !!stripped?.projects
  } catch (e) { out.stripError = String(e).slice(0, 120) }

  // ④ 导入往返
  try {
    const newPid = await projects.importProject(bundle)
    out.importedPid = newPid
    out.importedIsNew = !!newPid && newPid !== pid
    const heads = await core.ops.getAll('taskHeads').catch(() => [])
    out.headsUnderNewPid = heads.filter(h => h.projectId === newPid).length
    const c = await core.ops.getAll('chapters').catch(() => [])
    out.chapterRowsTotal = c.length
  } catch (e) { out.importError = String(e).slice(0, 160) }

  return out
})

console.log(JSON.stringify(r, null, 1))
await page.screenshot({ path: '.workbuddy/tmp/b08-export.png' })
await ctx.close()
