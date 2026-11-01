// 3.3.3 · B-05/B-06 备份往返：带图片的项目备份 → 破坏 → 恢复（**测试脚手架**）
//
// 验什么：
//   ① createAutoBackup 产出的载荷里含章节、表格行、**且图鉴图片（atlasImage dataURL）在位**；
//   ② 破坏本机数据（删章 / 删图 / 改标题）后 restoreBackup 能把它们全部找回来；
//   ③ 备份不含敏感 meta（aiProviders）与任务台账。
//
// 前置：`npm run dev`（5199）。用法：node scripts/verify/backup-roundtrip-probe.mjs
import { chromium } from 'playwright'

const PROFILE = process.env.YFE_PROFILE
  || 'F:/软件项目/青春幻想引擎/youth-fantasy-engine开发源码/.workbuddy/tmp/edge-profile-b08'
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

const out = await page.evaluate(async () => {
  const core = await import('/src/lib/db/core.ts')
  const bk = await import('/src/lib/db/backups.ts')
  const image = await import('/src/lib/atlas/image.ts')
  const r = { steps: [] }
  const pid = core.getCurrentProjectId()

  // 造一张真图（走真实压缩路径）
  const c = document.createElement('canvas')
  c.width = 320; c.height = 240
  const g = c.getContext('2d')
  g.fillStyle = '#224466'; g.fillRect(0, 0, 320, 240)
  const blob = await new Promise(res => c.toBlob(res, 'image/png'))
  const res = await image.readAtlasImage(new File([blob], 'bk.png', { type: 'image/png' }))
  if (!res.ok) { r.imageError = res.reason; return r }
  r.imageBytes = res.image.bytes

  // 造数据：2 章 + 1 行表格（带图）
  await core.ops.put('volumes', { id: 'bk-vol', projectId: pid, title: '备份卷', no: 1, createdAt: Date.now(), updatedAt: Date.now() })
  await core.ops.put('chapters', { id: 'bk-c1', projectId: pid, volumeId: 'bk-vol', title: '备份章一', no: 1, content: '备份前的正文一'.repeat(20), createdAt: Date.now(), updatedAt: Date.now() })
  await core.ops.put('chapters', { id: 'bk-c2', projectId: pid, volumeId: 'bk-vol', title: '备份章二', no: 2, content: '备份前的正文二'.repeat(20), createdAt: Date.now(), updatedAt: Date.now() })
  await core.ops.put('tableRows', { id: 'bk-r1', projectId: pid, tabId: 'races', rowId: 'R0001', data: { name: '备份条目' }, atlasImage: res.image, updatedAt: Date.now() })

  // ① 建备份
  const meta = await bk.createAutoBackup(pid, 'manual', 'B05 往返验证')
  r.backupId = meta?.id ?? null
  const payload = meta ? await bk.getBackupPayload(meta.id) : null
  r.payload = {
    chapters: (payload?.chapters ?? []).length,
    tableRows: (payload?.tableRows ?? []).length,
    imageInPayload: !!(payload?.tableRows ?? []).find(x => x.id === 'bk-r1')?.atlasImage?.dataUrl,
    hasAiProviders: JSON.stringify(payload ?? {}).includes('aiProviders'),
    hasTaskStores: /taskHeads|taskUnits/.test(JSON.stringify(payload ?? {})),
  }

  // ② 破坏本机数据：删一章、删图、改标题
  await core.ops.del('chapters', 'bk-c2').catch(() => {})
  const row = (await core.ops.getAll('tableRows')).find(x => x.id === 'bk-r1')
  if (row) {
    const next = { ...row }
    delete next.atlasImage
    next.data = { name: '被改过的名字' }
    await core.ops.put('tableRows', next)
  }
  const before = {
    chapters: (await core.ops.getAll('chapters')).filter(x => x.projectId === pid).length,
    hasImage: !!(await core.ops.getAll('tableRows')).find(x => x.id === 'bk-r1')?.atlasImage,
    name: (await core.ops.getAll('tableRows')).find(x => x.id === 'bk-r1')?.data?.name,
  }
  r.broken = before

  // ③ 恢复
  if (meta) await bk.restoreBackup(meta.id)
  // 🔴 恢复会**重生成所有内部 id**（backups.ts 里写明"避免与残留/冲突"）——
  //    按旧 id 查会全部落空，那是断言写错，不是数据没回来。必须按内容匹配。
  const afterChapters = (await core.ops.getAll('chapters')).filter(x => x.projectId === pid)
  const afterRows = await core.ops.getAll('tableRows')
  const byName = afterRows.find(x => x.data?.name === '备份条目') ?? afterRows.find(x => x.projectId === pid && x.atlasImage)
  r.restored = {
    chapters: afterChapters.length,
    hasChapter1: afterChapters.some(x => x.title === '备份章一'),
    hasChapter2: afterChapters.some(x => x.title === '备份章二'),
    chapter2ContentOk: (afterChapters.find(x => x.title === '备份章二')?.content ?? '').startsWith('备份前的正文二'),
    hasImage: !!byName?.atlasImage,
    imageBytes: byName?.atlasImage?.bytes ?? null,
    nameRestored: byName?.data?.name ?? null,
  }
  return r
})

console.log(JSON.stringify(out, null, 1))
await ctx.close()
