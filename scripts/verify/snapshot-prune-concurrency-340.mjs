// 3.4.0 · 命名快照双窗口并发裁剪竞争（同源、共享 IndexedDB）
//
// 场景：两个页面同时对同一章创建命名快照，各自触发 pruneSnapshots（读全量→算超额→批量删除）。
// 判据：
//   1. 最终数量 **不超过 12**（上限不被并发突破）；
//   2. 最新创建的快照至少有一条保留（不会把刚写的全裁掉）；
//   3. 记录实际数量与保留标签，作为「可能多删」的观察证据，不把未承诺的精度写成需求。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'

const dir = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/snapshot-prune-concurrency-340-'))
const server = await createServer({ cacheDir: path.join(dir, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
let context
const checks = []
const check = (id, ok, detail = '') => {
  checks.push({ id, ok: !!ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok || !detail ? '' : ` :: ${detail}`))
  if (!ok) throw new Error(`${id}${detail ? ' :: ' + detail : ''}`)
}

try {
  await server.listen()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  context = await browser.newContext({ viewport: { width: 1100, height: 800 } })
  const url = `http://localhost:${server.httpServer.address().port}/tests/browser/isolated-340.html`
  const open = async () => {
    const p = await context.newPage()
    await p.goto(url)
    await p.evaluate(() => { document.body.innerHTML = '<div id="fixture"></div>' })
    await p.evaluate(() => import('/tests/browser/named-snapshot-340-fixture.tsx'))
    await p.getByRole('textbox', { name: '快照名称' }).waitFor({ timeout: 30000 })
    return p
  }
  const p1 = await open()
  const p2 = await open()

  // 清空同一章的旧快照（两页共享 IndexedDB）
  await p1.evaluate(async () => {
    const db = await import('/src/lib/db.ts')
    const { ops } = await import('/src/lib/db/core.ts')
    const list = await db.getSnapshots('chapter')
    await ops.bulkDel('snapshots', list.map(s => s.id))
  })

  const seed = (page, prefix) => page.evaluate(async prefix => {
    const db = await import('/src/lib/db.ts')
    const { ops } = await import('/src/lib/db/core.ts')
    const ch = await ops.get('chapters', 'chapter')
    for (let i = 1; i <= 8; i++) {
      await new Promise(r => setTimeout(r, 8))
      await db.createSnapshot({ ...ch, content: `并发-${prefix}-${i}`, wordCount: 5 }, 'manual-named', undefined, { label: `${prefix}${i}`, note: '' })
    }
    const list = await db.getSnapshots('chapter')
    return list.map(s => s.label ?? '')
  }, prefix)

  await Promise.all([seed(p1, '甲'), seed(p2, '乙')])
  const final = await p1.evaluate(async () => {
    const db = await import('/src/lib/db.ts')
    const list = await db.getSnapshots('chapter')
    return { count: list.length, labels: list.map(s => s.label ?? ''), sources: list.map(s => s.source ?? 'auto') }
  })

  console.log('DEBUG 并发后快照:', JSON.stringify(final))
  check('并发创建后总数不超过 12', final.count <= 12, `count=${final.count}`)
  check('并发创建后仍有快照', final.count > 0, `count=${final.count}`)
  check('最新写入的快照未被全部裁掉', final.labels.some(l => l === '甲8' || l === '乙8'), `labels=${final.labels.join(',')}`)

  const errors = []
  p1.on('pageerror', e => errors.push(String(e)))
  p2.on('pageerror', e => errors.push(String(e)))
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`\nPASS ${checks.length} checks · snapshot-prune-concurrency-340`)
} finally {
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await server.close().catch(() => {})
}