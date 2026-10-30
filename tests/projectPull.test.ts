// 3.3.2 · P4-3 拉取 · 单测
//
// 盯五件事：
//   ① 图片引用必须还原成 dataURL（否则另一台设备上所有立绘变成一行哈希字符串）；
//   ② 某张图没下到时**删字段**，不留 `sha256:` 字符串（那等于塞一张永远加载失败的图）；
//   ③ 内容分片缺一块 ⇒ 整次拒绝（半套内容必生 bug）；
//   ④ 本地有未同步改动 ⇒ 一条 op 都不给；
//   ⑤ 取不到清单时给出可读原因，而不是崩。
import { buildPullPlan, restoreAssetRefs, pullSummary, putOpsOf, deleteOpsOf, type PullDeps } from '@/lib/sync/projectPull'
import type { SnapshotManifest } from '@/lib/sync/projectSnapshot'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const H = (c: string) => c.repeat(64)
const enc = (s: string) => new TextEncoder().encode(s)
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

function manifest(over: Partial<SnapshotManifest> = {}): SnapshotManifest & { revision: number; snapshotId: string } {
  return {
    protocol: 1, createdAt: 1, project: { name: '书', genre: '玄幻' }, counts: {},
    objects: [
      { kind: 'chapters', hash: H('a'), bytes: 10, records: 2 },
      { kind: 'cardRecords', hash: H('b'), bytes: 10, records: 1 },
    ],
    assets: [{ hash: H('i'), bytes: PNG_BYTES.length, mime: 'image/png' }],
    tombstones: [],
    revision: 4, snapshotId: 's4',
    ...over,
  }
}

/** 假依赖：按表返回字节 */
function deps(table: Record<string, Uint8Array | null>, m: unknown = manifest()): PullDeps {
  return {
    fetchManifest: async () => m,
    downloadObject: async (_pid, hash) => (hash in table ? table[hash] : null),
  }
}

const defaultTable = (): Record<string, Uint8Array | null> => ({
  [H('a')]: enc(JSON.stringify([{ id: 'c1', title: '第1章', content: '新正文' }, { id: 'c2', title: '第2章', content: '' }])),
  [H('b')]: enc(JSON.stringify([{ id: 'r1', name: '角色甲', portrait: `sha256:${H('i')}` }])),
  [H('i')]: PNG_BYTES,
})

async function main() {
  // ---------- 1. 正常拉取 ----------
  {
    const r = await buildPullPlan(deps(defaultTable()), { cloudProjectId: 'c1', localDirty: false })
    ok('计划可执行', r.plan.ok === true, r.plan.reason)
    ok('两类分片都进计划', putOpsOf(r.plan).length === 2, String(putOpsOf(r.plan).length))
    ok('revision 传递正确', r.plan.revision === 4, String(r.plan.revision))
    ok('没有下载失败', r.failed.length === 0, JSON.stringify(r.failed))
  }

  // ---------- 2. 图片还原 ----------
  {
    const r = await buildPullPlan(deps(defaultTable()), { cloudProjectId: 'c1', localDirty: false })
    const cards = putOpsOf(r.plan).find((o) => o.kind === 'cardRecords')!
    const portrait = String(cards.records[0].portrait || '')
    // 🔴 这条最关键：不还原就等于对方设备上所有立绘变成一串哈希
    ok('立绘从 sha256 引用还原成 dataURL', portrait.startsWith('data:image/png;base64,'), portrait.slice(0, 40))
    ok('还原后没有残留 sha256 前缀', !portrait.startsWith('sha256:'), portrait.slice(0, 20))
    ok('还原没有丢其他字段', cards.records[0].name === '角色甲', JSON.stringify(cards.records[0]))
  }

  // ---------- 3. 图没下到 ⇒ 删字段 ----------
  {
    const table = defaultTable()
    delete table[H('i')]
    const r = await buildPullPlan(deps(table), { cloudProjectId: 'c1', localDirty: false })
    ok('图没下到时正文仍然可以切换（不拦）', r.plan.ok === true, r.plan.reason)
    const cards = putOpsOf(r.plan).find((o) => o.kind === 'cardRecords')!
    // 🔴 留 sha256: 字符串 = 对方看到一张永远加载失败的图
    ok('缺图时删掉字段，不留 sha256 字符串', cards.records[0].portrait === undefined, JSON.stringify(cards.records[0]))
    ok('缺图计入 missingAssets', r.missingAssets === 1, String(r.missingAssets))
    ok('缺图也记进 failed 便于重试', r.failed.includes(H('i')), JSON.stringify(r.failed))
    ok('总结里说明有几张图没取到', /张图没取到/.test(pullSummary(r)), pullSummary(r))
  }

  // ---------- 4. 内容分片缺失 ⇒ 整次拒绝 ----------
  {
    const table = defaultTable()
    delete table[H('a')]
    const r = await buildPullPlan(deps(table), { cloudProjectId: 'c1', localDirty: false })
    ok('内容缺一块 ⇒ 不给任何 op', r.plan.ok === false && r.plan.ops.length === 0, JSON.stringify(r.plan.code))
    ok('缺内容的提示说的是"没下载完"', /没下载完/.test(r.plan.reason), r.plan.reason)
  }

  // ---------- 5. 本地脏 ⇒ 一条都不给 ----------
  {
    const r = await buildPullPlan(deps(defaultTable()), { cloudProjectId: 'c1', localDirty: true })
    ok('本地有改动 ⇒ 不套用云端', r.plan.ok === false && r.plan.code === 'LOCAL_DIRTY', r.plan.code)
  }

  // ---------- 6. 取不到清单 ----------
  {
    const d: PullDeps = { fetchManifest: async () => null, downloadObject: async () => null }
    const r = await buildPullPlan(d, { cloudProjectId: 'c1', localDirty: false })
    ok('取不到清单时给出可读原因', r.plan.ok === false && /取不到云端清单/.test(r.plan.reason), r.plan.reason)
    ok('取不到清单时不动本地', r.plan.ops.length === 0)
  }

  // ---------- 7. 未知 kind ⇒ 整次拒绝（交给 planApply 判）----------
  {
    const m = manifest({
      objects: [{ kind: 'futureThing', hash: H('a'), bytes: 10, records: 1 }],
      assets: [],
    })
    const r = await buildPullPlan(deps({ [H('a')]: enc('[]') }, m), { cloudProjectId: 'c1', localDirty: false })
    ok('未知类型拒绝整次（不静默丢数据）', r.plan.ok === false && r.plan.code === 'UNKNOWN_KIND', r.plan.code)
  }

  // ---------- 8. 墓碑变成 delete ----------
  {
    const m = manifest({ tombstones: [{ kind: 'chapters', id: 'gone', deletedAt: 1 }] })
    const r = await buildPullPlan(deps(defaultTable(), m), { cloudProjectId: 'c1', localDirty: false })
    const del = deleteOpsOf(r.plan)
    ok('墓碑变成 delete 指令', del.length === 1 && del[0].ids[0] === 'gone', JSON.stringify(del))
  }

  // ---------- 9. restoreAssetRefs 纯函数 ----------
  {
    const refs = new Map([[H('x'), 'data:image/webp;base64,AAA']])
    const out = restoreAssetRefs([{ id: '1', portrait: `sha256:${H('x')}` }], refs)
    ok('独立调用也能还原', out.records[0].portrait === 'data:image/webp;base64,AAA' && out.missing === 0)
    const notRef = restoreAssetRefs([{ id: '1', portrait: 'data:image/png;base64,BBB' }], refs)
    ok('本来就是 dataURL 的不动', notRef.records[0].portrait === 'data:image/png;base64,BBB')
    ok('不改原数组', (() => {
      const src = [{ id: '1', portrait: `sha256:${H('x')}` }]
      restoreAssetRefs(src, refs)
      return String(src[0].portrait).startsWith('sha256:')
    })())
    // 图鉴图缺图时整个 atlasImage 去掉，而不是留空壳
    const missingImg = restoreAssetRefs([{ id: '2', atlasImage: { dataUrl: `sha256:${H('nope')}`, mime: 'x' } }], refs)
    ok('图鉴图缺图时去掉整个 atlasImage', missingImg.records[0].atlasImage === undefined, JSON.stringify(missingImg.records[0]))
  }

  console.log(`\n▶ projectPull: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
