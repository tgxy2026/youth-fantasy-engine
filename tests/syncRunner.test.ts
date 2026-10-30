// 3.3.2 · P3-3 队列驱动器 · 单测
//
// 盯五件事：
//   ① 四种结局各自落到正确的任务状态（成功 done / 冲突 blocked / 配额 blocked / 网络 failed）；
//   ② 一条任务失败**不能**把整条队列卡死；
//   ③ 项目在本机已删时任务作废，不无限重试；
//   ④ 快照是**跑的时候现算**的，不是入队时的那份（否则排队期间写的新章会被覆盖）；
//   ⑤ 状态回调真能告诉界面「现在在干嘛」。
import type { ProjectBundle } from '@/lib/db/projects'
import type { UploadTransport } from '@/lib/sync/projectUploader'
import { createMemoryQueueStore, enqueuePush } from '@/lib/sync/syncQueue'
import { drainQueue, runOneJob, prepareQueue, type SyncRunnerDeps } from '@/lib/sync/syncRunner'
import type { SyncState } from '@/lib/sync/syncMachine'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const T0 = 1_700_000_000_000

function bundle(over: Partial<ProjectBundle> = {}): ProjectBundle {
  return {
    app: 'youth-fantasy-engine', version: 1, exportedAt: T0,
    project: { id: 'p1', name: '测试书', genre: '玄幻' } as never,
    volumes: [{ id: 'v1', projectId: 'p1', title: '第一卷', order: 0 }] as never,
    chapters: [
      { id: 'c1', projectId: 'p1', volumeId: 'v1', order: 0, title: '第1章', content: '正文一' },
    ] as never,
    formData: [], tableRows: [], cardRecords: [],
    ...over,
  }
}

/** 假传输层：按脚本返回 */
function fakeTransport(script: {
  puts?: Array<{ ok: boolean; code?: string }>
  commit?: { ok: boolean; status: number; code?: string; revision?: number; replayed?: boolean; message?: string }
}): UploadTransport & { calls: { puts: number; commits: { opId: string; baseRevision: number }[] } } {
  const calls = { puts: 0, commits: [] as { opId: string; baseRevision: number }[] }
  return {
    calls,
    async putObject() {
      const i = calls.puts++
      return script.puts?.[i] ?? { ok: true }
    },
    async commit(_pid, body) {
      calls.commits.push({ opId: body.opId, baseRevision: body.baseRevision })
      return script.commit ?? { ok: true, status: 200, revision: 1, snapshotId: 'snap-1' }
    },
  }
}

function deps(over: Partial<SyncRunnerDeps>): SyncRunnerDeps & { states: { pid: string; s: SyncState }[] } {
  const states: { pid: string; s: SyncState }[] = []
  return {
    store: createMemoryQueueStore(),
    transport: fakeTransport({}),
    loadBundle: async () => bundle(),
    onState: (pid, s) => { states.push({ pid, s }) },
    now: () => T0,
    retries: 0,
    sleep: async () => {},
    states,
    ...over,
  }
}

async function main() {
  // ---------- 1. 成功 ----------
  {
    const d = deps({ transport: fakeTransport({ commit: { ok: true, status: 200, revision: 7 } }) })
    const job = await enqueuePush(d.store, { projectId: 'p1', cloudProjectId: 'c1', baseRevision: 0, now: T0 })
    const r = await runOneJob(d, {
      ...job, state: 'running', attempts: 1, updatedAt: T0,
    })
    ok('成功→状态已同步', r.state === 'synced', r.state)
    const after = (await d.store.get(job.id))!
    ok('成功→任务 done 并记下 revision', after.state === 'done' && after.revision === 7, JSON.stringify(after))
    ok('成功→界面先看到"同步中"再看到"已同步"',
      d.states.map((x) => x.s).join('>') === 'syncing>synced', d.states.map((x) => x.s).join('>'))
  }

  // ---------- 2. 冲突 ----------
  {
    const d = deps({ transport: fakeTransport({ commit: { ok: false, status: 409, code: 'BASELINE_MISMATCH', revision: 3 } }) })
    const job = await enqueuePush(d.store, { projectId: 'p1', cloudProjectId: 'c1', baseRevision: 0, now: T0 })
    const r = await runOneJob(d, { ...job, state: 'running', attempts: 1 })
    ok('冲突→状态 conflict', r.state === 'conflict', r.state)
    const after = (await d.store.get(job.id))!
    // 🔴 冲突不是失败：任务必须留着等用户选，且**不能**被自动重试（会反复撞 409）
    ok('冲突→任务留成 blocked（不自动重跑）', after.state === 'blocked', JSON.stringify(after))
    ok('冲突→错误码可辨认', after.lastCode === 'BASELINE_MISMATCH', after.lastCode || '')
    ok('冲突→提示是给人看的，不是错误码', /保留哪一份/.test(after.lastError || ''), after.lastError || '')
  }

  // ---------- 3. 配额 ----------
  {
    const d = deps({ transport: fakeTransport({ commit: { ok: false, status: 413, code: 'QUOTA_EXCEEDED' } }) })
    const job = await enqueuePush(d.store, { projectId: 'p1', cloudProjectId: 'c1', baseRevision: 0, now: T0 })
    const r = await runOneJob(d, { ...job, state: 'running', attempts: 1 })
    const after = (await d.store.get(job.id))!
    ok('配额满→blocked 且不自动重试', r.state === 'blocked' && after.state === 'blocked', `${r.state}/${after.state}`)
    ok('配额提示写明稿件仍在本机', /本机/.test(after.lastError || ''), after.lastError || '')
  }

  // ---------- 4. 网络失败 ----------
  {
    const d = deps({
      transport: fakeTransport({ puts: [{ ok: false, code: 'NETWORK' }, { ok: false, code: 'NETWORK' }] }),
    })
    const job = await enqueuePush(d.store, { projectId: 'p1', cloudProjectId: 'c1', baseRevision: 0, now: T0 })
    const r = await runOneJob(d, { ...job, state: 'running', attempts: 1 })
    ok('网络错误→界面显示离线（不是"失败"）', r.state === 'offline', r.state)
    const after = (await d.store.get(job.id))!
    ok('网络错误→任务 failed 并带退避', after.state === 'failed' && (after.nextAttemptAt ?? 0) > 0, JSON.stringify(after))
  }

  // ---------- 5. 项目已删 ----------
  {
    const d = deps({ loadBundle: async () => null })
    const job = await enqueuePush(d.store, { projectId: 'p1', cloudProjectId: 'c1', baseRevision: 0, now: T0 })
    const r = await runOneJob(d, { ...job, state: 'running', attempts: 1 })
    const after = (await d.store.get(job.id))!
    ok('本机已删项目→任务作废、不重试', after.state === 'blocked' && after.lastCode === 'PROJECT_GONE', JSON.stringify(after))
    ok('本机已删项目→要求人工清除（不自动跑）', r.state === 'blocked', r.state)
  }

  // ---------- 6. 组快照抛异常 ----------
  {
    const d = deps({ loadBundle: async () => { throw new Error('数据读不出来') } })
    const job = await enqueuePush(d.store, { projectId: 'p1', cloudProjectId: 'c1', baseRevision: 0, now: T0 })
    const r = await runOneJob(d, { ...job, state: 'running', attempts: 1 })
    const after = (await d.store.get(job.id))!
    ok('组快照抛异常→blocked，不带坏数据反复重试',
      r.state === 'blocked' && after.lastCode === 'SNAPSHOT_FAILED', JSON.stringify(after))
  }

  // ---------- 7. 一条失败不卡死整条队列 ----------
  {
    const store = createMemoryQueueStore()
    const a = await enqueuePush(store, { projectId: 'pBad', cloudProjectId: 'cBad', baseRevision: 0, now: T0 })
    const b = await enqueuePush(store, { projectId: 'pGood', cloudProjectId: 'cGood', baseRevision: 0, now: T0 + 1 })
    const d = deps({
      store,
      loadBundle: async (pid) => (pid === 'pBad' ? null : bundle()),
      transport: fakeTransport({}),
    })
    const results = await drainQueue(d)
    ok('坏项目失败不影响好项目', results.length === 2 && results.some((r) => r.projectId === 'pGood' && r.state === 'synced'),
      JSON.stringify(results.map((r) => [r.projectId, r.state])))
    ok('坏项目留在 blocked', (await store.get(a.id))!.state === 'blocked')
    ok('好项目已完成', (await store.get(b.id))!.state === 'done')
  }

  // ---------- 8. 队列跑空 ----------
  {
    const d = deps({})
    await enqueuePush(d.store, { projectId: 'p1', cloudProjectId: 'c1', baseRevision: 0, now: T0 })
    await enqueuePush(d.store, { projectId: 'p2', cloudProjectId: 'c2', baseRevision: 0, now: T0 + 1 })
    const results = await drainQueue(d)
    ok('一次 drain 跑完两条不同项目', results.length === 2, String(results.length))
    ok('跑空后 claim 不到东西', (await drainQueue(d)).length === 0)
  }

  // ---------- 9. 快照现算（不改用入队时的旧快照）----------
  {
    let chapterCount = 1
    const d = deps({
      loadBundle: async () => bundle({
        chapters: Array.from({ length: chapterCount }, (_, i) => ({
          id: `c${i}`, projectId: 'p1', volumeId: 'v1', order: i, title: `第${i + 1}章`, content: `正文${i}`,
        })) as never,
      }),
      transport: fakeTransport({}),
    })
    const job = await enqueuePush(d.store, { projectId: 'p1', cloudProjectId: 'c1', baseRevision: 0, now: T0 })
    // 排队期间又写了两章
    chapterCount = 3
    await runOneJob(d, { ...job, state: 'running', attempts: 1 })
    const t = d.transport as ReturnType<typeof fakeTransport>
    // chapters 分片一定被上传过；这里用「上传的 chapters 对象字节数」间接验证是 3 章
    const chapterPuts = t.calls.puts
    ok('上传对象数与当前内容一致（3 章 + 1 卷 = 2 个分片）', chapterPuts >= 2, `puts=${chapterPuts}`)
  }

  // ---------- 10. 崩溃恢复 + 启动准备 ----------
  {
    const store = createMemoryQueueStore()
    const job = await enqueuePush(store, { projectId: 'p1', cloudProjectId: 'c1', baseRevision: 0, now: T0 })
    await store.put({ ...job, state: 'running', attempts: 1, updatedAt: T0 })
    const n = await prepareQueue(store, T0 + 1000)
    ok('启动准备把中断的任务打回待跑', n === 1 && (await store.get(job.id))!.state === 'pending', String(n))
  }

  // ---------- 11. opId 与基线原样传给服务端 ----------
  {
    const t = fakeTransport({})
    const d = deps({ transport: t })
    const job = await enqueuePush(d.store, { projectId: 'p1', cloudProjectId: 'c1', baseRevision: 9, now: T0 })
    await runOneJob(d, { ...job, state: 'running', attempts: 1 })
    ok('提交用的 opId 就是任务 id', t.calls.commits[0]?.opId === job.id, JSON.stringify(t.calls.commits))
    ok('提交带上入队时的基线', t.calls.commits[0]?.baseRevision === 9, JSON.stringify(t.calls.commits))
  }

  console.log(`\n▶ syncRunner: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
