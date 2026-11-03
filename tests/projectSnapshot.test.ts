// 3.3.2 · 客户端快照生成 · 单测
//
// 盯六件事：
//   ① 图片真的被抽出去了（对象里不许残留 dataURL）；
//   ② 同一份内容两次生成得到同一哈希（否则每次保存都变新版本）；
//   ③ 输入顺序不影响哈希（排序稳定）；
//   ④ 改一个字只影响对应分片（分片有效性）；
//   ⑤ 删除墓碑被带上并排序；
//   ⑥ 非法 dataURL 不静默变成空图、也不让它抛。
import type { ProjectBundle } from '@/lib/db/projects'
import { buildProjectSnapshot, snapshotBytes, SNAPSHOT_PROTOCOL } from '@/lib/sync/projectSnapshot'

// 1×1 透明 PNG（合法 base64 dataURL）
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
// 第二张**内容不同**的图（合法 base64 即可，不看像素）——用于验证「两张图 → 两个资源」
const WEBP = 'data:image/webp;base64,AAAA'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function makeBundle(over: Partial<ProjectBundle> = {}): ProjectBundle {
  return {
    app: 'youth-fantasy-engine',
    version: 3,
    exportedAt: 1700000000000,
    project: { id: 'p1', name: '样本', genre: '东方玄幻', intro: '', createdAt: 1, updatedAt: 2 } as ProjectBundle['project'],
    volumes: [{ id: 'vol_1', projectId: 'p1', order: 1, title: '第一卷', description: '' }],
    chapters: [
      { id: 'ch_b', projectId: 'p1', volumeId: 'vol_1', order: 2, title: '第二章', content: '乙' },
      { id: 'ch_a', projectId: 'p1', volumeId: 'vol_1', order: 1, title: '第一章', content: '甲' },
    ],
    formData: [{ tabId: 'races', data: { a: '1' } }],
    tableRows: [
      { id: 'r1', projectId: 'p1', tabId: 'races', order: 1, data: { 名称: '条目' }, atlasImage: { dataUrl: WEBP, mime: 'image/webp', width: 1, height: 1, bytes: 3 } },
      { id: 'r2', projectId: 'p1', tabId: 'races', order: 2, data: { 名称: '无图' } },
    ],
    cardRecords: [
      { id: 'c1', projectId: 'p1', tabId: 'characters', name: '角色', order: 1, data: {}, portrait: PNG },
    ],
    dailyStats: [{ key: 'p1::2026-10-30', projectId: 'p1', date: '2026-10-30', words: 100 }],
    settings: [{ key: 'goalDaily', value: 3000 }],
    tavernReports: [],
    aiRuns: [],
    snapshots: [],
    ...over,
  } as unknown as ProjectBundle
}

async function main() {
  const built = await buildProjectSnapshot(makeBundle(), {
    tombstones: [
      { kind: 'tableRows', id: 'r9', deletedAt: 111 },
      { kind: 'chapters', id: 'ch_0', deletedAt: 222 },
    ],
    now: 1700000000000,
  })

  const allPayload = built.objects.map((o) => o.payload).join('\n')

  ok('对象里不残留 dataURL', !allPayload.includes('data:image'), allPayload.slice(0, 120))
  ok('两张不同图都进了 assets', built.assets.length === 2, String(built.assets.length))
  ok('assets 哈希是 hex 且被记录进 manifest', built.assets.every((a) => /^[0-9a-f]{64}$/.test(a.hash))
    && built.manifest.assets.length === 2)

  const cardObj = built.objects.find((o) => o.kind === 'cardRecords')!
  const cards = JSON.parse(cardObj.payload) as { id: string; portrait?: string }[]
  const portrait = cards[0].portrait || ''
  ok('立绘字段被换成 sha256 引用', portrait.startsWith('sha256:') && built.assets.some((a) => portrait === `sha256:${a.hash}`), portrait)

  const rowObj = built.objects.find((o) => o.kind === 'tableRows')!
  const rows = JSON.parse(rowObj.payload) as { id: string; atlasImage?: { dataUrl: string; mime?: string; width?: number } }[]
  const imgRow = rows.find((r) => r.id === 'r1')!
  ok('图鉴图被换成引用且保留元信息', String(imgRow.atlasImage?.dataUrl).startsWith('sha256:')
    && imgRow.atlasImage?.mime === 'image/webp' && imgRow.atlasImage?.width === 1, JSON.stringify(imgRow.atlasImage))

  // 去重：两张**相同**的图只该产生一个资源
  const dupBundle = makeBundle()
  dupBundle.cardRecords = [
    { id: 'c1', projectId: 'p1', tabId: 'characters', name: 'A', order: 1, data: {}, portrait: PNG },
    { id: 'c2', projectId: 'p1', tabId: 'characters', name: 'B', order: 2, data: {}, portrait: PNG },
  ] as never
  const dupBuilt = await buildProjectSnapshot(dupBundle, { now: 1 })
  const dupCards = JSON.parse(dupBuilt.objects.find((o) => o.kind === 'cardRecords')!.payload) as { portrait?: string }[]
  ok('相同图片按内容去重', dupBuilt.assets.length === 2 // PNG 一份 + 图鉴那张 WEBP
    && dupCards[0].portrait === dupCards[1].portrait, JSON.stringify(dupBuilt.manifest.assets))

  ok('manifest 协议版本正确', built.manifest.protocol === SNAPSHOT_PROTOCOL)
  ok('counts 统计正确', built.manifest.counts.chapters === 2 && built.manifest.counts.tableRows === 2
    && built.manifest.counts.cardRecords === 1 && built.manifest.counts.volumes === 1, JSON.stringify(built.manifest.counts))

  // 确定性：同一输入两次
  const again = await buildProjectSnapshot(makeBundle(), { tombstones: [], now: 1700000000000 })
  const hashOf = (b: typeof built) => b.objects.map((o) => `${o.kind}:${o.hash}`).join('|')
  ok('同内容两次生成哈希一致', hashOf(built) === hashOf(again), hashOf(built))

  // 顺序无关
  const shuffled = makeBundle({
    chapters: [...makeBundle().chapters].reverse(),
    tableRows: [...makeBundle().tableRows].reverse(),
  })
  const shuffledBuilt = await buildProjectSnapshot(shuffled, { now: 1700000000000 })
  ok('输入顺序不影响哈希', hashOf(shuffledBuilt) === hashOf(built), hashOf(shuffledBuilt))

  // 分片有效性：改一章正文只影响 chapters
  const changed = makeBundle()
  changed.chapters = changed.chapters.map((c) => (c.id === 'ch_a' ? { ...c, content: '甲改' } : c))
  const changedBuilt = await buildProjectSnapshot(changed, { now: 1700000000000 })
  const objHash = (b: typeof built, kind: string) => b.objects.find((o) => o.kind === kind)!.hash
  ok('改正文只变 chapters 分片',
    objHash(changedBuilt, 'chapters') !== objHash(built, 'chapters')
    && objHash(changedBuilt, 'cardRecords') === objHash(built, 'cardRecords')
    && objHash(changedBuilt, 'tableRows') === objHash(built, 'tableRows'))

  // 墓碑
  ok('墓碑被带上并按 kind+id 排序', built.manifest.tombstones.length === 2
    && built.manifest.tombstones[0].kind === 'chapters'
    && built.manifest.tombstones[1].kind === 'tableRows', JSON.stringify(built.manifest.tombstones))

  // 空类也生成对象
  ok('空类也生成对象（清空这件事要看得到）', built.objects.some((o) => o.kind === 'tavernReports'))

  // 总量
  const sum = built.objects.reduce((n, o) => n + o.bytes, 0) + built.assets.reduce((n, a) => n + a.bytes, 0)
  ok('snapshotBytes 等于对象+资源', snapshotBytes(built) === sum, `${snapshotBytes(built)} vs ${sum}`)

  // 非法 dataURL
  const bad = makeBundle({
    cardRecords: [{ id: 'c9', projectId: 'p1', tabId: 'characters', name: 'x', order: 1, data: {}, portrait: 'not-a-data-url' }] as never,
    tableRows: [] as never,
  })
  const badBuilt = await buildProjectSnapshot(bad, { now: 1 })
  const badCards = JSON.parse(badBuilt.objects.find((o) => o.kind === 'cardRecords')!.payload) as { portrait?: string }[]
  ok('非法图片不会变成空图引用', badCards[0].portrait === undefined && badBuilt.assets.length === 0, JSON.stringify(badCards[0]))

  console.log(`\n▶ projectSnapshot: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
