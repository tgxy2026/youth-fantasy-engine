// 3.3.2 · B3-3 云端版本装成项目包 · 单测
//
// 盯五件事：
//   ① 下载齐了才交出项目包（半套内容 = 一本残缺的书）；
//   ② 图片引用必须还原成 dataURL（否则另一台设备上立绘全是哈希字符串）；
//   ③ 某张图没下到 ⇒ 删字段 + 如实计数（不塞一个永远加载失败的引用）；
//   ④ 清单取不到 / 未知 kind / 空内容 —— 一律拒绝，并说清是网络还是格式；
//   ⑤ 导出文件名要能落地（Windows 保留字符会让浏览器改写或下载失败）。
import { loadCloudCopy, cloudCopyFileName, defaultPullDeps } from '@/lib/sync/projectPullBundle'
import type { PullDeps } from '@/lib/sync/projectPull'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const H = (c: string) => c.repeat(64)
const enc = (s: string) => new TextEncoder().encode(s)
const encJson = (v: unknown) => enc(JSON.stringify(v))

interface M {
  protocol: number
  createdAt: number
  project: { name: string; genre: string }
  counts: Record<string, number>
  objects: { kind: string; hash: string; bytes: number; records: number }[]
  assets: { hash: string; bytes: number; mime: string }[]
  tombstones: unknown[]
  revision: number
  snapshotId: string
}

function manifest(over: Partial<M> = {}): M {
  return {
    protocol: 1, createdAt: 1, project: { name: '吞天神脉', genre: '东方修真' }, counts: {},
    objects: [
      { kind: 'chapters', hash: H('a'), bytes: 10, records: 1 },
      { kind: 'cardRecords', hash: H('c'), bytes: 10, records: 1 },
    ],
    assets: [{ hash: H('b'), bytes: 3, mime: 'image/webp' }],
    tombstones: [], revision: 5, snapshotId: 'snap-5',
    ...over,
  }
}

function deps(over: Partial<PullDeps> = {}): PullDeps {
  return {
    fetchManifest: async () => manifest(),
    downloadObject: async (_id, hash) => {
      if (hash === H('a')) return encJson([{ id: 'c1', projectId: 'p', title: '一' }])
      if (hash === H('c')) return encJson([{ id: 'r1', projectId: 'p', portrait: `sha256:${H('b')}` }])
      if (hash === H('b')) return new Uint8Array([1, 2, 3])
      return null
    },
    ...over,
  }
}

async function main() {
  // ① 正常：下载齐 → 项目包；图片还原成 dataURL
  {
    const r = await loadCloudCopy({ cloudProjectId: 'c1', deps: deps() })
    ok('下载齐了才成功', r.ok && !!r.bundle, r.reason)
    ok('带出云端版本与快照身份', r.revision === 5 && r.snapshotId === 'snap-5', `${r.revision}/${r.snapshotId}`)
    ok('记录条数按实际算', r.records === 2, String(r.records))
    const card = (r.bundle!.cardRecords as unknown as { portrait?: string }[])[0]
    ok('立绘引用还原成 dataURL', typeof card.portrait === 'string' && card.portrait.startsWith('data:image/webp;base64,'), String(card.portrait))
    ok('默认名加「云端副本」', r.name === '吞天神脉（云端副本）', r.name)
  }

  // ② 缺图：删字段 + 计数，不拦正文
  {
    const d = deps({ downloadObject: async (_id, hash) => (hash === H('b') ? null : deps().downloadObject('c', hash)) })
    const r = await loadCloudCopy({ cloudProjectId: 'c1', deps: d })
    const card = (r.bundle!.cardRecords as unknown as Record<string, unknown>[])[0]
    ok('缺图时仍然成功（正文不受影响）', r.ok, r.reason)
    ok('缺图的字段被删掉而不是留哈希', !('portrait' in card), JSON.stringify(card))
    ok('缺图如实计数', r.omitted.some((s) => s.includes('1 张图片')), r.omitted.join('|'))
  }

  // ③ 缺内容：整次拒绝
  {
    const d = deps({ downloadObject: async (_id, hash) => (hash === H('a') ? null : deps().downloadObject('c', hash)) })
    const r = await loadCloudCopy({ cloudProjectId: 'c1', deps: d })
    ok('内容没下齐时拒绝并说明', !r.ok && r.reason.includes('没下到'), r.reason)
    ok('拒绝时不给项目包', r.bundle === null)
  }

  // ④ 清单取不到：网络/权限，不是"格式不认识"
  {
    const d = deps({ fetchManifest: async () => null })
    const r = await loadCloudCopy({ cloudProjectId: 'c1', deps: d })
    ok('清单取不到时如实报', !r.ok && r.reason.includes('取不到云端清单'), r.reason)
  }

  // ⑤ 未知 kind：拒绝整次，并点名
  {
    const m = manifest({ objects: [{ kind: 'mindMaps', hash: H('d'), bytes: 1, records: 1 }] })
    const d = deps({
      fetchManifest: async () => m,
      downloadObject: async () => encJson([]),
    })
    const r = await loadCloudCopy({ cloudProjectId: 'c1', deps: d })
    ok('未知 kind 拒绝并点名', !r.ok && r.reason.includes('mindMaps'), r.reason)
  }

  // ⑥ 空内容：不建空书
  {
    const m = manifest({ objects: [{ kind: 'chapters', hash: H('e'), bytes: 2, records: 0 }] })
    const d = deps({ fetchManifest: async () => m, downloadObject: async () => encJson([]) })
    const r = await loadCloudCopy({ cloudProjectId: 'c1', deps: d })
    ok('空内容时拒绝', !r.ok && r.reason.includes('没有作品内容'), r.reason)
  }

  // ⑦ 原项目元数据继承（本机有这本时）
  {
    const base = { id: 'p1', name: '本机名', genre: 'g', intro: '简介', createdAt: 1, updatedAt: 2 } as never
    const r = await loadCloudCopy({ cloudProjectId: 'c1', deps: deps(), baseProject: base, name: '副本名' })
    ok('用户指定名优先', r.ok && r.name === '副本名', r.name)
    ok('继承本机简介', r.bundle!.project.intro === '简介')
  }

  // ⑧ 导出文件名清洗
  {
    ok('去掉 Windows 保留字符', cloudCopyFileName('a/b:c*d?e', 5) === 'a_b_c_d_e-云端第5版.json', cloudCopyFileName('a/b:c*d?e', 5))
    ok('空名兜底', cloudCopyFileName('', 0).startsWith('云端副本-云端第0版'), cloudCopyFileName('', 0))
    ok('超长名截断', cloudCopyFileName('作'.repeat(200), 1).length <= 100, String(cloudCopyFileName('作'.repeat(200), 1).length))
  }

  // ⑨ 生产默认 deps 必须存在且可调用形状正确（不做真网络）
  ok('默认下载通道已装配', typeof defaultPullDeps.fetchManifest === 'function' && typeof defaultPullDeps.downloadObject === 'function')

  console.log(`\n▶ projectPullBundle: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })