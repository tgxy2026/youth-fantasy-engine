// ============ 「另存为新书」写库薄层契约（3.6.1 · B1 零覆盖债）============
//
// projectPullWrite 只做一件事：把云端版本装好之后**调 importProject 落库**，并把失败翻译成人话。
// 薄归薄，它守的是一句承诺：**另存不改本机现有作品**。所以这里钉四件事：
//   ① 写入目标是 importProject 生成的**新项目 id**，原项目记录一条都不动；
//   ② 本机有未同步改动（墓碑）也不影响另存 —— 因为它根本不改本机现有内容（`localDirty:false`）；
//   ③ 落库失败要给作者人话 + 如实说"原有作品未受影响"，且**不残留半成品**；
//   ④ 下载没齐（半套内容）时**根本不调 importProject**，不能落一本残缺的书。
import { saveCloudCopyAsNewProject } from '../src/lib/sync/projectPullWrite'
import type { PullDeps } from '../src/lib/sync/projectPull'
import { markDeleted, resetTombs } from '../src/lib/sync/syncTombstone'
import { __resetMockStores, memoryOps } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const H = (c: string) => c.repeat(64)
const enc = (s: string) => new TextEncoder().encode(s)
const encJson = (v: unknown) => enc(JSON.stringify(v))

interface Manifest {
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

function manifest(over: Partial<Manifest> = {}): Manifest {
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
      if (hash === H('a')) return encJson([{ id: 'c1', projectId: 'p-cloud', title: '一' }])
      if (hash === H('c')) return encJson([{ id: 'r1', projectId: 'p-cloud', portrait: `sha256:${H('b')}` }])
      if (hash === H('b')) return new Uint8Array([1, 2, 3])
      return null
    },
    ...over,
  }
}

async function main() {
  // ① 成功：写的是新项目 id，原项目记录一条不动
  {
    __resetMockStores()
    resetTombs()
    await memoryOps.put('projects', { id: 'p-local', name: '本机原书', genre: '', intro: '', createdAt: 1, updatedAt: 1 })
    const imported: { name: string; id: string | undefined; chapters: number }[] = []
    const result = await saveCloudCopyAsNewProject({ cloudProjectId: 'c-1', deps: deps() }, {
      importProject: async bundle => {
        imported.push({
          name: bundle.project?.name ?? '',
          id: bundle.project?.id,
          chapters: (bundle.chapters ?? []).length,
        })
        return 'p-new-1'
      },
    })
    ok('另存成功并返回新项目 id', result.ok === true && result.projectId === 'p-new-1', JSON.stringify(result))
    ok('新项目名沿用云端项目名（界面可直接显示）', result.name === '吞天神脉（云端副本）', String(result.name))
    ok('落库记录条数按实际算', result.records === 2, String(result.records))
    ok('交给 importProject 的包没有项目 id（落库必然生成新 id，不可能覆盖原项目）', imported.length === 1 && imported[0].id === '' && imported[0].chapters === 1, JSON.stringify(imported))
    ok('交给 importProject 的包名已带「云端副本」标识', imported.length === 1 && imported[0].name.includes('云端副本'), JSON.stringify(imported))
    const projects = await memoryOps.getAll<{ id: string; name: string }>('projects')
    ok('原项目记录未被读写（只有原来那一本）', projects.length === 1 && projects[0].id === 'p-local', JSON.stringify(projects))
  }

  // ② 本机有未同步删除墓碑：另存照样成功（本流程不改本机现有内容）
  {
    __resetMockStores()
    resetTombs()
    markDeleted('chapters', ['c-deleted-locally'])
    const result = await saveCloudCopyAsNewProject({ cloudProjectId: 'c-1', deps: deps() }, {
      importProject: async () => 'p-new-2',
    })
    ok('本机有未同步墓碑时另存不被"本机已改"拦下', result.ok === true && result.projectId === 'p-new-2', JSON.stringify(result))
    ok('另存不会碰本机项目表', (await memoryOps.getAll('projects')).length === 0)
    resetTombs()
  }

  // ③ 落库失败：人话 + 原有作品未受影响 + 不留半成品
  {
    __resetMockStores()
    await memoryOps.put('projects', { id: 'p-local', name: '本机原书', genre: '', intro: '', createdAt: 1, updatedAt: 1 })
    const result = await saveCloudCopyAsNewProject({ cloudProjectId: 'c-1', deps: deps() }, {
      importProject: async () => { throw new Error('磁盘写满了') },
    })
    ok('落库失败时不报成功', result.ok === false, JSON.stringify(result))
    ok('失败原因说清是另存失败并带上原始信息', result.reason.includes('另存失败') && result.reason.includes('磁盘写满了'), result.reason)
    ok('失败原因如实说"原有作品未受影响"', result.reason.includes('原有作品未受影响'), result.reason)
    ok('失败时记录条数为 0（不谎报写入量）', result.records === 0)
    ok('失败后没有残留新项目', (await memoryOps.getAll('projects')).length === 1)
  }

  // ④ 下载没齐：根本不调 importProject
  {
    __resetMockStores()
    let called = 0
    const result = await saveCloudCopyAsNewProject({
      cloudProjectId: 'c-1',
      deps: deps({ downloadObject: async (_id, hash) => (hash === H('a') ? encJson([{ id: 'c1' }]) : null) }),
    }, { importProject: async () => { called++; return 'p-should-not-exist' } })
    ok('内容没下齐时不落库', result.ok === false && called === 0, JSON.stringify({ result, called }))
    ok('内容没下齐时给出可读原因', result.reason.length > 0, result.reason)
    ok('失败时 omitted 原样带回（界面如实提示缺什么）', Array.isArray(result.omitted))
  }

  // ⑤ 清单取不到：同样是"没下到"，不是"格式不认识"
  {
    __resetMockStores()
    let called = 0
    const result = await saveCloudCopyAsNewProject({
      cloudProjectId: 'c-1',
      deps: deps({ fetchManifest: async () => null }),
    }, { importProject: async () => { called++; return 'p-x' } })
    ok('取不到云端清单时不落库', result.ok === false && called === 0, JSON.stringify(result))
    ok('取不到清单时说明网络/权限而非格式', result.reason.includes('云端清单'), result.reason)
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} projectPullWrite ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

await main()
