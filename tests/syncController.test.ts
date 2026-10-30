// 3.3.2 · P3-5 同步控制器 · 单测
//
// 盯四件事：
//   ① 重入保护：同步还没跑完又触发一次，不能两条流并行（状态会来回抖、revision 会撞）；
//   ② 广播顺序：入队就要先报"排队中"，否则用户按了没反应会反复点；
//   ③ `init()` 幂等：热更新/重复挂载不该反复扫库做崩溃恢复；
//   ④ 订阅方抛异常不能把同步带崩。
import type { ProjectBundle } from '@/lib/db/projects'
import type { UploadTransport } from '@/lib/sync/projectUploader'
import { createMemoryQueueStore } from '@/lib/sync/syncQueue'
import { createMemoryTombstoneStore, noteDeletes } from '@/lib/sync/projectTombstone'
import { createSyncController, installSyncController, getSyncController, resetSyncControllerForTest } from '@/lib/sync/syncController'
import type { SyncState } from '@/lib/sync/syncMachine'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const T0 = 1_700_000_000_000

function bundle(): ProjectBundle {
  return {
    app: 'youth-fantasy-engine', version: 1, exportedAt: T0,
    project: { id: 'p1', name: '书', genre: '玄幻' } as never,
    volumes: [], chapters: [{ id: 'c1', projectId: 'p1', volumeId: '', order: 0, title: '第1章', content: '正文' }] as never,
    formData: [], tableRows: [], cardRecords: [],
  }
}

/** 可控传输层：每次提交都挂起，直到手动放行 */
function gateTransport() {
  const pending: Array<() => void> = []
  let commits = 0
  const transport: UploadTransport = {
    async putObject() { return { ok: true } },
    async commit() {
      commits++
      await new Promise<void>((res) => pending.push(res))
      return { ok: true, status: 200, revision: commits, snapshotId: `s${commits}` }
    },
  }
  return {
    transport,
    commits: () => commits,
    releaseAll: () => { while (pending.length) pending.shift()!() },
  }
}

async function main() {
  // ---------- 1. 正常一轮 ----------
  {
    const store = createMemoryQueueStore()
    const seen: { pid: string; s: SyncState }[] = []
    const ctl = createSyncController({
      store,
      transport: { async putObject() { return { ok: true } }, async commit() { return { ok: true, status: 200, revision: 3 } } },
      loadBundle: async () => bundle(),
      now: () => T0,
      onState: (pid, s) => seen.push({ pid, s }),
    })
    const job = await ctl.requestPush({ projectId: 'p1', cloudProjectId: 'c1', baseRevision: 0 })
    ok('入队后拿到任务', !!job.id)
    ok('先广播"排队中"再广播"已同步"',
      seen.map((x) => x.s).join('>') === 'queued>syncing>synced', seen.map((x) => x.s).join('>'))
    ok('跑完后状态是 idle（任务已完成并可能被清理）', (await ctl.stateOf('p1')) === 'idle')
  }

  // ---------- 2. 重入保护 ----------
  {
    const store = createMemoryQueueStore()
    const g = gateTransport()
    const ctl = createSyncController({
      store, transport: g.transport, loadBundle: async () => bundle(), now: () => T0,
    })
    // 第一次：卡在 commit
    const first = ctl.requestPush({ projectId: 'p1', cloudProjectId: 'c1', baseRevision: 0 })
    await new Promise((r) => setTimeout(r, 10))
    ok('第一轮正在跑', ctl.isRunning())
    // 第二次：应当立刻返回空，不开第二条流
    const second = await ctl.drain()
    ok('重入时第二次 drain 直接返回空（不开第二条流）', second.length === 0, JSON.stringify(second.length))
    g.releaseAll()
    await first
    ok('第一轮跑完后不再标记运行中', !ctl.isRunning())
  }

  // ---------- 3. init 幂等 ----------
  {
    const store = createMemoryQueueStore()
    let calls = 0
    const ctl = createSyncController({
      store,
      transport: { async putObject() { return { ok: true } }, async commit() { return { ok: true, status: 200, revision: 1 } } },
      loadBundle: async () => bundle(),
      now: () => { calls++; return T0 },
    })
    const a = await ctl.init()
    const b = await ctl.init()
    ok('init 幂等（第二次不重跑恢复）', a === 0 && b === 0 && calls <= 2, `a=${a} b=${b} calls=${calls}`)
  }

  // ---------- 4. 订阅方抛异常不影响同步 ----------
  {
    const store = createMemoryQueueStore()
    const ctl = createSyncController({
      store,
      transport: { async putObject() { return { ok: true } }, async commit() { return { ok: true, status: 200, revision: 1 } } },
      loadBundle: async () => bundle(),
      now: () => T0,
    })
    let good = 0
    ctl.subscribe(() => { throw new Error('订阅方炸了') })
    const off = ctl.subscribe(() => { good++ })
    await ctl.requestPush({ projectId: 'p1', cloudProjectId: 'c1', baseRevision: 0 })
    ok('一个订阅方抛异常不影响其他订阅方', good >= 2, String(good))
    off()
    const before = good
    await ctl.requestPush({ projectId: 'p1', cloudProjectId: 'c1', baseRevision: 1 })
    ok('退订后不再收到通知', good === before, `${before} → ${good}`)
  }

  // ---------- 5. 墓碑随提交带走并在成功后清掉 ----------
  {
    const store = createMemoryQueueStore()
    const tombs = createMemoryTombstoneStore()
    await noteDeletes(tombs, 'p1', [{ kind: 'chapters', id: 'gone' }], T0 - 1000)
    let carried = 0
    const ctl = createSyncController({
      store, tombstones: tombs, loadBundle: async () => bundle(), now: () => T0,
      transport: {
        async putObject() { return { ok: true } },
        async commit(_pid, body) {
          const m = body.manifest as { tombstones?: unknown[] }
          carried = (m.tombstones || []).length
          return { ok: true, status: 200, revision: 1 }
        },
      },
    })
    await ctl.requestPush({ projectId: 'p1', cloudProjectId: 'c1', baseRevision: 0 })
    ok('删除墓碑被带进提交', carried === 1, String(carried))
    ok('提交成功后墓碑被清掉（不会一直带着）', (await tombs.list('p1')).length === 0,
      JSON.stringify(await tombs.list('p1')))
  }

  // ---------- 6. 单例只装一次 ----------
  {
    resetSyncControllerForTest()
    const store = createMemoryQueueStore()
    const deps = {
      store,
      transport: { async putObject() { return { ok: true } }, async commit() { return { ok: true, status: 200, revision: 1 } } },
      loadBundle: async () => bundle(),
      now: () => T0,
    }
    const a = installSyncController(deps)
    const b = installSyncController({ ...deps, store: createMemoryQueueStore() })
    ok('重复安装返回同一个控制器', a === b)
    ok('能取到已装好的单例', getSyncController() === a)
    resetSyncControllerForTest()
    ok('重置后取不到', getSyncController() === null)
  }

  console.log(`\n▶ syncController: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
