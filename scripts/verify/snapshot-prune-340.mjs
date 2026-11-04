// 3.4.0 · 命名快照 12 版裁剪 / 自动优先淘汰 / 创建后读回失败窗口
//
// 组件级夹具（真实 React + IndexedDB），不启动整页应用：
//   1. 同一章连建 13 个命名快照 → 总数保持 12，最旧的被淘汰；
//   2. 1 个自动快照 + 12 个命名快照 → 先淘汰自动快照，命名快照全部保留；
//   3. 写入成功但读回不一致 → UI 如实提示「可能已创建」，输入不清空；恢复后重试成功。
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'

const dir = await mkdtemp(path.join(process.cwd(), '.workbuddy/tmp/snapshot-prune-340-'))
const server = await createServer({ cacheDir: path.join(dir, 'vite'), logLevel: 'error', server: { host: 'localhost', port: 0 } })
let browser
const checks = []
const check = (id, ok, detail = '') => {
  checks.push({ id, ok: !!ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (ok || !detail ? '' : ` :: ${detail}`))
  if (!ok) throw new Error(`${id}${detail ? ' :: ' + detail : ''}`)
}

try {
  await server.listen()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/isolated-340.html`)
  await page.evaluate(() => { document.body.innerHTML = '<div id="fixture"></div>' })
  await page.evaluate(() => import('/tests/browser/named-snapshot-340-fixture.tsx'))
  await page.getByRole('textbox', { name: '快照名称' }).waitFor({ timeout: 30000 })

  const clearSnaps = () => page.evaluate(async () => {
    const db = await import('/src/lib/db.ts')
    const { ops } = await import('/src/lib/db/core.ts')
    const list = await db.getSnapshots('chapter')
    await ops.bulkDel('snapshots', list.map(s => s.id))
    return (await db.getSnapshots('chapter')).length
  })

  const seed = (names, source) => page.evaluate(async ({ names, source }) => {
    const db = await import('/src/lib/db.ts')
    const { ops } = await import('/src/lib/db/core.ts')
    const ch = await ops.get('chapters', 'chapter')
    for (const name of names) {
      // createdAt 按毫秒排序，隔 8ms 让「最旧」有确定顺序
      await new Promise(r => setTimeout(r, 8))
      await db.createSnapshot(
        { ...ch, content: `内容-${name}`, wordCount: 5 }, source, undefined,
        source === 'manual-named' ? { label: name, note: '' } : undefined,
      )
    }
    const list = await db.getSnapshots('chapter')
    return { count: list.length, labels: list.map(s => s.label ?? ''), sources: list.map(s => s.source ?? 'auto') }
  }, { names, source })

  // ---- 1. 13 个命名快照 → 12 ----
  await clearSnaps()
  const thirteen = await seed(Array.from({ length: 13 }, (_, i) => `命名${i + 1}`), 'manual-named')
  check('连建 13 个命名快照后总数仍为 12', thirteen.count === 12, `count=${thirteen.count}`)
  check('最新命名快照保留', thirteen.labels.includes('命名13'))
  check('最旧命名快照被淘汰', !thirteen.labels.includes('命名1'), `labels=${thirteen.labels.join(',')}`)

  // ---- 2. 1 自动 + 12 命名 → 自动先淘汰 ----
  await clearSnaps()
  await seed(['自动旧版'], 'auto')
  const mixed = await seed(Array.from({ length: 12 }, (_, i) => `混${i + 1}`), 'manual-named')
  check('混合池总数仍为 12', mixed.count === 12, `count=${mixed.count}`)
  check('自动快照被优先淘汰', !mixed.sources.includes('auto'), `sources=${mixed.sources.join(',')}`)
  check('12 个命名快照全部保留', mixed.labels.every(l => l.startsWith('混')), `labels=${mixed.labels.join(',')}`)

  // ---- 3. 读回不一致：不假装成功、输入不清空 ----
  await clearSnaps()
  await page.getByRole('textbox', { name: '快照名称' }).fill('关键节点')
  await page.getByRole('textbox', { name: '快照备注' }).fill('读回失败注入')
  await page.evaluate(async () => {
    const { ops } = await import('/src/lib/db/core.ts')
    const original = ops.get.bind(ops)
    window.restoreGet = () => { ops.get = original }
    ops.get = async (store, key) => {
      const value = await original(store, key)
      if (store === 'snapshots' && value) return { ...value, content: '读回内容被篡改' }
      return value
    }
  })
  await page.getByRole('button', { name: '保存命名快照' }).click()
  await page.getByRole('alert').getByText(/快照未能确认/).waitFor({ timeout: 15000 })
  check('读回不一致时明确提示「快照未能确认」', true)
  check('失败后名称输入未被清空', (await page.getByRole('textbox', { name: '快照名称' }).inputValue()) === '关键节点')
  check('失败后备注输入未被清空', (await page.getByRole('textbox', { name: '快照备注' }).inputValue()) === '读回失败注入')
  await page.evaluate(() => window.restoreGet())
  await page.getByRole('button', { name: '保存命名快照' }).click()
  await page.getByText('命名快照已保存。').waitFor({ timeout: 15000 })
  check('恢复读回后重试可以保存', true)

  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`\nPASS ${checks.length} checks · snapshot-prune-340`)
} finally {
  await browser?.close().catch(() => {})
  await server.close().catch(() => {})
}